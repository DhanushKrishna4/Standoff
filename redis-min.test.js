/* =============================================================================
 * redis-min.test.js — proves the RESP wire codec (redis-min.js). No network:
 * the socket wiring is thin, the codec is where bugs hide, so that's what we pin.
 *
 *   node redis-min.test.js
 * ========================================================================== */
'use strict';
const assert = require('assert');
const net = require('net');
const { encodeCommand, createParser, RedisBus } = require('./redis-min.js');

let passed = 0;
const ok = (name) => { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); };

// A tiny in-process RESP server so the client's *network* path (auth, GET/SET,
// pub/sub relay) is exercised end-to-end — no real Redis needed, both ends ours.
function mockRedis() {
  const store = new Map(); const subs = new Map();
  const bulk = (v) => (v == null ? '$-1\r\n' : '$' + Buffer.byteLength(v) + '\r\n' + v + '\r\n');
  const arr = (parts) => '*' + parts.length + '\r\n' + parts.map((p) => bulk(String(p))).join('');
  const server = net.createServer((sock) => {
    const parser = createParser();
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      for (const cmd of parser.feed(chunk)) {
        if (!Array.isArray(cmd)) continue;
        const name = String(cmd[0]).toUpperCase();
        if (name === 'AUTH') sock.write('+OK\r\n');
        else if (name === 'SET') { store.set(cmd[1], cmd[2]); sock.write('+OK\r\n'); }
        else if (name === 'GET') sock.write(bulk(store.has(cmd[1]) ? store.get(cmd[1]) : null));
        else if (name === 'DEL') { const had = store.delete(cmd[1]); sock.write(':' + (had ? 1 : 0) + '\r\n'); }
        else if (name === 'SUBSCRIBE') { const ch = cmd[1]; (subs.get(ch) || subs.set(ch, []).get(ch)).push(sock); sock.write('*3\r\n$9\r\nsubscribe\r\n' + bulk(ch) + ':1\r\n'); }
        else if (name === 'PUBLISH') { const list = subs.get(cmd[1]) || []; for (const s of list) { try { s.write('*3\r\n' + bulk('message') + bulk(cmd[1]) + bulk(cmd[2])); } catch (e) {} } sock.write(':' + list.length + '\r\n'); }
      }
    });
  });
  return server;
}

// --- command encoding matches the RESP spec ----------------------------------
assert.strictEqual(encodeCommand(['PING']).toString(), '*1\r\n$4\r\nPING\r\n', 'PING encodes');
assert.strictEqual(encodeCommand(['SET', 'k', 'hello']).toString(), '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$5\r\nhello\r\n', 'SET encodes with lengths');
assert.strictEqual(encodeCommand(['PUBLISH', 'room:AB', '{"t":"x"}']).toString(), '*3\r\n$7\r\nPUBLISH\r\n$7\r\nroom:AB\r\n$9\r\n{"t":"x"}\r\n', 'PUBLISH with a JSON payload encodes');
ok('encodeCommand produces spec-correct RESP arrays of bulk strings');

// --- every reply type parses -------------------------------------------------
const p1 = createParser();
assert.deepStrictEqual(p1.feed(Buffer.from('+OK\r\n')), ['OK'], 'simple string');
assert.deepStrictEqual(p1.feed(Buffer.from(':42\r\n')), [42], 'integer');
assert.deepStrictEqual(p1.feed(Buffer.from('$5\r\nhello\r\n')), ['hello'], 'bulk string');
assert.deepStrictEqual(p1.feed(Buffer.from('$-1\r\n')), [null], 'null bulk string');
const errReply = p1.feed(Buffer.from('-ERR nope\r\n'));
assert.ok(errReply[0] instanceof Error && /nope/.test(errReply[0].message), 'error reply');
ok('parser handles simple strings, integers, bulk strings, nulls and errors');

// --- arrays + the pub/sub message shape --------------------------------------
const p2 = createParser();
const msg = p2.feed(Buffer.from('*3\r\n$7\r\nmessage\r\n$7\r\nroom:AB\r\n$9\r\n{"t":"x"}\r\n'));
assert.deepStrictEqual(msg, [['message', 'room:AB', '{"t":"x"}']], 'a pub/sub message parses as [message, channel, payload]');
ok('parser decodes nested arrays and the pub/sub message frame');

// --- streaming: a reply split across chunks is only emitted when complete -----
const p3 = createParser();
assert.deepStrictEqual(p3.feed(Buffer.from('$11\r\nhel')), [], 'partial bulk → nothing yet');
assert.deepStrictEqual(p3.feed(Buffer.from('lo wor')), [], 'still partial → nothing');
assert.deepStrictEqual(p3.feed(Buffer.from('ld\r\n')), ['hello world'], 'completed across three chunks');
ok('parser is incremental — no reply emitted until its bytes all arrive');

// --- several replies in one chunk, and leftover carried forward --------------
const p4 = createParser();
assert.deepStrictEqual(p4.feed(Buffer.from('+A\r\n:7\r\n$2\r\nhi')), ['A', 7], 'two complete + one partial in one chunk');
assert.deepStrictEqual(p4.feed(Buffer.from('\r\n')), ['hi'], 'the partial completes on the next chunk');
ok('parser batches multiple replies and carries leftovers between feeds');

// --- round-trip: encode a command, parse it back as if it were a reply array -
const p5 = createParser();
const roundtrip = p5.feed(encodeCommand(['SUBSCRIBE', 'standoff:bus']));
assert.deepStrictEqual(roundtrip, [['SUBSCRIBE', 'standoff:bus']], 'an encoded array round-trips through the parser');
ok('encode → parse round-trips a command as an array');

// --- integration against the mock server: the client's real network path -----
async function integration() {
  const server = mockRedis();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const url = `redis://127.0.0.1:${server.address().port}`;

  const bus = new RedisBus(url, () => {}, () => {});
  await bus.set('standoff:rooms', '[{"code":"ABCD"}]');
  assert.strictEqual(await bus.get('standoff:rooms'), '[{"code":"ABCD"}]', 'SET then GET round-trips a value over the wire');
  assert.strictEqual(await bus.get('nope'), null, 'GET of a missing key is null');
  ok('RedisBus SET/GET round-trips against a live socket');

  const received = [];
  const subBus = new RedisBus(url, (ch, msg) => received.push([ch, msg]), () => {});
  subBus.subscribe('standoff:bus');
  await new Promise((r) => setTimeout(r, 150));   // let SUBSCRIBE land
  bus.publish('standoff:bus', '{"t":"verdict"}');
  await new Promise((r) => setTimeout(r, 150));
  assert.deepStrictEqual(received, [['standoff:bus', '{"t":"verdict"}']], 'a publish is relayed to a subscriber via onMessage');
  ok('RedisBus pub/sub relays a message end-to-end');

  bus.close(); subBus.close();
  await new Promise((res) => server.close(res));
}

integration()
  .then(() => { console.log('\n\x1b[32m' + passed + ' passing\x1b[0m\n'); process.exit(0); })
  .catch((e) => { console.error('\n\x1b[31m✗ ' + (e && e.message) + '\x1b[0m\n'); process.exit(1); });
