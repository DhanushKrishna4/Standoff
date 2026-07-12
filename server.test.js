/* =============================================================================
 * server.test.js — proves the live-rooms backend end-to-end.
 *
 * Spawns server.js on a test port and drives it with two real WebSocket clients
 * (Node's built-in WebSocket — the same protocol a browser speaks), exercising
 * create → join → presence(privacy) → settle → lock, plus host-only enforcement.
 *
 *   node server.test.js
 * ========================================================================== */
'use strict';
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PORT = 4199;
const URL = `ws://127.0.0.1:${PORT}`;
let passed = 0;
const ok = (name) => { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); };

const child = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT) } });
child.stderr.on('data', (d) => process.stderr.write(d));

const open = (sock) => new Promise((res, rej) => { sock.addEventListener('open', res, { once: true }); sock.addEventListener('error', rej, { once: true }); });
const next = (sock, pred) => new Promise((res) => {
  const h = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (pred(m)) { sock.removeEventListener('message', h); res(m); } };
  sock.addEventListener('message', h);
});
const cleanup = () => { try { child.kill('SIGKILL'); } catch (e) {} try { fs.unlinkSync(path.join(__dirname, '.standoff-rooms.json')); } catch (e) {} };

async function main() {
  console.log('\nserver.test.js\n');
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start in time')), 6000);
    child.stdout.on('data', (d) => { if (String(d).includes('Standoff live')) { clearTimeout(to); res(); } });
  });

  // --- host creates a room ---
  const host = new WebSocket(URL); await open(host);
  host.send(JSON.stringify({ t: 'create', name: 'Ava', person: { name: 'Ava', genres: { Comedy: 'love', Romance: 'like' }, mood: { brain: 0.4, intensity: 0.4, levity: 0.8 }, runtimeCap: 999 } }));
  const joined = await next(host, (m) => m.t === 'joined');
  assert.ok(/^[A-Z0-9]{4}$/.test(joined.code), 'a 4-char room code is issued');
  assert.strictEqual(joined.host, true, 'creator is the host');
  ok('host creates a room and gets a code');

  // --- a guest joins ---
  const guest = new WebSocket(URL); await open(guest);
  guest.send(JSON.stringify({ t: 'join', code: joined.code.toLowerCase(), name: 'Ben', person: { name: 'Ben', genres: { Thriller: 'love', 'Sci-Fi': 'love' }, mood: { brain: 0.75, intensity: 0.85, levity: 0.2 }, runtimeCap: 999 } }));
  const gj = await next(guest, (m) => m.t === 'joined');
  assert.strictEqual(gj.host, false, 'a joiner is not the host');
  assert.strictEqual(gj.code, joined.code, 'codes are case-insensitive');
  ok('a guest joins with the code');

  // --- presence reflects both, and hides tastes ---
  const pres = await next(host, (m) => m.t === 'presence' && m.room.participants.length === 2);
  assert.ok(pres.room.participants.every((p) => p.ready), 'both show ready');
  assert.ok(!('genres' in pres.room.participants[0]) && !('mood' in pres.room.participants[0]), 'presence never leaks anyone\'s taste');
  ok('presence updates for everyone and keeps tastes private');

  // --- host settles: both clients receive the SAME verdict; analysis follows ---
  const hv = next(host, (m) => m.t === 'verdict');
  const gv = next(guest, (m) => m.t === 'verdict');
  const ha = next(host, (m) => m.t === 'analysis');   // computed off the critical path, arrives after
  host.send(JSON.stringify({ t: 'settle' }));
  const [hVer, gVer] = await Promise.all([hv, gv]);
  assert.ok(hVer.result && hVer.result.pick && hVer.title, 'the verdict carries a pick');
  assert.strictEqual(hVer.result.pick.id, gVer.result.pick.id, 'every screen lands on the identical pick');
  const analysisMsg = await ha;
  assert.ok(analysisMsg.analysis && analysisMsg.analysis.robustness && analysisMsg.analysis.strategy, 'the analysis arrives as its own follow-up message');
  ok('settle broadcasts one identical verdict, then ships the analysis');

  // --- room counterfactual (item 15): the server computes "what would flip it" ---
  // Only the server holds everyone's tastes, so a member asks it directly and the
  // reply goes to just that member (never revealing others' preferences).
  const wiResp = next(guest, (m) => m.t === 'whatif');
  guest.send(JSON.stringify({ t: 'whatif', who: 'Ava', genre: 'Action', to: 'love' }));
  const wi = await wiResp;
  assert.ok(wi.empty || typeof wi.title === 'string', 'the server returns a counterfactual outcome (a title, or an empty-menu flag)');
  assert.ok(wi.empty || typeof wi.same === 'boolean', 'and reports whether the pick would still hold');
  ok('a room member can ask the server what would flip the pick (item 15)');

  // --- host-only controls: a guest cannot settle ---
  guest.send(JSON.stringify({ t: 'settle' }));
  const raced = await Promise.race([next(host, (m) => m.t === 'verdict').then(() => 'leaked'), new Promise((r) => setTimeout(() => r('ignored'), 500))]);
  assert.strictEqual(raced, 'ignored', 'a non-host settle is ignored');
  ok('host-only controls are enforced server-side');

  // --- lock persists the fairness ledger for the room code ---
  const locked = next(guest, (m) => m.t === 'locked');
  host.send(JSON.stringify({ t: 'lock' }));
  await locked;
  await new Promise((r) => setTimeout(r, 400)); // let the debounced disk write flush
  const saved = JSON.parse(fs.readFileSync(path.join(__dirname, '.standoff-rooms.json'), 'utf8'));
  assert.ok(saved[joined.code] && saved[joined.code].nights === 1 && saved[joined.code].history.length === 1, 'the room\'s ledger is persisted to disk by code');
  ok('locking persists the room\'s fairness ledger');

  // --- a deliberate leave updates presence for the rest ---
  const back = next(host, (m) => m.t === 'presence' && m.room.participants.length === 1);
  guest.send(JSON.stringify({ t: 'leave' })); guest.close();
  await back;
  ok('a deliberate leave drops the person from presence');

  /* ======================= Batch 4: hardening + room UX ==================== */

  // --- reconnect by stable clientId preserves the host role (items 27, 29) ---
  // Two members keep the room alive; the host's socket drops, then reconnects
  // with the same clientId within the grace window and resumes as host.
  const HID = 'cid-host-1', GID = 'cid-guest-1';
  const rh = new WebSocket(URL); await open(rh);
  rh.send(JSON.stringify({ t: 'create', clientId: HID, name: 'Host', person: { genres: { Comedy: 'love' } } }));
  const rhj = await next(rh, (m) => m.t === 'joined');
  assert.strictEqual(rhj.youId, HID, 'youId is the stable clientId, not the socket id');
  const rg = new WebSocket(URL); await open(rg);
  rg.send(JSON.stringify({ t: 'join', code: rhj.code, clientId: GID, name: 'Guest', person: { genres: { Drama: 'love' } } }));
  await next(rg, (m) => m.t === 'joined');
  await next(rh, (m) => m.t === 'presence' && m.room.participants.length === 2);
  rh.close(); // accidental drop (no leave) → grace-ghost keeps the seat + host
  await new Promise((r) => setTimeout(r, 150));
  const rh2 = new WebSocket(URL); await open(rh2);
  rh2.send(JSON.stringify({ t: 'join', code: rhj.code, clientId: HID, name: 'Host' }));
  const rh2j = await next(rh2, (m) => m.t === 'joined');
  assert.strictEqual(rh2j.host, true, 'reconnecting with the same clientId resumes the host role');
  ok('reconnect by stable clientId preserves host + seat');

  // --- per-room chat relays to everyone (item 28) ---
  const chatGot = next(rg, (m) => m.t === 'chat');
  rh2.send(JSON.stringify({ t: 'chat', text: 'popcorn ready?' }));
  const chat = await chatGot;
  assert.strictEqual(chat.text, 'popcorn ready?', 'chat text relays');
  assert.strictEqual(chat.from, 'Host', 'chat carries the sender name');
  ok('per-room chat relays to everyone');

  // --- live reactions relay; unknown emoji are ignored (item 28) ---
  const reactGot = next(rg, (m) => m.t === 'react');
  rh2.send(JSON.stringify({ t: 'react', emoji: '🔥' }));
  const react = await reactGot;
  assert.strictEqual(react.emoji, '🔥', 'a whitelisted reaction relays');
  ok('live reactions relay to the room');

  // --- host handoff transfers the crown (item 28) ---
  const handoff = next(rg, (m) => m.t === 'presence' && m.room.hostId === GID);
  rh2.send(JSON.stringify({ t: 'host', to: GID }));
  await handoff;
  ok('host can hand off the crown to another member');

  // --- kick removes a member and tells them (item 28) ---
  // GID is now host; have it kick the (spectating or voting) HID member.
  const kicked = next(rh2, (m) => m.t === 'kicked');
  const kickedPresence = next(rg, (m) => m.t === 'presence' && m.room.participants.length === 1);
  rg.send(JSON.stringify({ t: 'kick', id: HID }));
  await Promise.all([kicked, kickedPresence]);
  ok('host can kick a member');
  rg.close();

  // --- spectator mode: a spectator doesn't count toward the 2-needed-to-settle ---
  const sh = new WebSocket(URL); await open(sh);
  sh.send(JSON.stringify({ t: 'create', clientId: 'cid-sh', name: 'Solo', person: { genres: { Comedy: 'love' } } }));
  const shj = await next(sh, (m) => m.t === 'joined');
  const spec = new WebSocket(URL); await open(spec);
  spec.send(JSON.stringify({ t: 'join', code: shj.code, clientId: 'cid-spec', name: 'Watcher', spectator: true }));
  const specJ = await next(spec, (m) => m.t === 'joined');
  assert.strictEqual(specJ.spectator, true, 'joined as a spectator');
  const specPres = await next(sh, (m) => m.t === 'presence' && m.room.participants.length === 2);
  assert.ok(specPres.room.participants.some((p) => p.spectator), 'roster marks the spectator');
  sh.send(JSON.stringify({ t: 'settle' }));   // only 1 voter → should be refused
  const settleTry = await Promise.race([next(sh, (m) => m.t === 'verdict').then(() => 'settled'), next(sh, (m) => m.t === 'notice').then(() => 'refused'), new Promise((r) => setTimeout(() => r('nothing'), 600))]);
  assert.strictEqual(settleTry, 'refused', 'a spectator is not counted as a second voter');
  ok('spectator mode: spectators watch but don’t count as voters');
  sh.close(); spec.close();

  // --- oversized message drops the connection (item 26) ---
  const flood = new WebSocket(URL); await open(flood);
  const closedFast = await new Promise((res) => {
    flood.addEventListener('close', () => res(true), { once: true });
    setTimeout(() => res(false), 1500);
    flood.send('x'.repeat(200 * 1024));   // 200KB payload > 64KB cap
  });
  assert.strictEqual(closedFast, true, 'an oversized frame gets the peer dropped');
  ok('oversized messages are rejected (DoS guard)');

  host.close();
}

// A cross-origin WebSocket upgrade (CSWSH) must be refused (item 26). Node's
// WebSocket can't set Origin, so drive a raw HTTP upgrade over a socket.
const net = require('net');
function originRejected() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => {
      s.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:' + PORT + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + Buffer.from('sixteenbytes1234').toString('base64') + '\r\nSec-WebSocket-Version: 13\r\nOrigin: https://evil.example.com\r\n\r\n');
    });
    let buf = '';
    s.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n')) { resolve(buf.split('\r\n')[0]); s.destroy(); } });
    s.on('error', () => resolve('error'));
    setTimeout(() => { resolve(buf.split('\r\n')[0] || 'timeout'); try { s.destroy(); } catch (e) {} }, 1500);
  });
}

// Graceful restart (item 27): SIGTERM snapshots active rooms; the next boot
// restores them so clients reconnect (by clientId) into the same room + host.
function spawnServer(port, dataDir) {
  const c = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir } });
  c.stderr.on('data', (d) => process.stderr.write(d));
  return new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('server did not start')), 6000); c.stdout.on('data', (d) => { if (String(d).includes('Standoff live')) { clearTimeout(to); res(c); } }); });
}
async function restartTest() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standoff-restart-'));
  const port = 4198, url = `ws://127.0.0.1:${port}`;
  let srv = await spawnServer(port, dir);
  const a = new WebSocket(url); await open(a);
  a.send(JSON.stringify({ t: 'create', clientId: 'restart-host', name: 'Rae', person: { genres: { Comedy: 'love' } } }));
  const j = await next(a, (m) => m.t === 'joined');
  const b = new WebSocket(url); await open(b);
  b.send(JSON.stringify({ t: 'join', code: j.code, clientId: 'restart-guest', name: 'Sam', person: { genres: { Drama: 'love' } } }));
  await next(b, (m) => m.t === 'joined');
  await next(a, (m) => m.t === 'presence' && m.room.participants.length === 2);
  const exited = new Promise((res) => srv.on('exit', res));
  srv.kill('SIGTERM');
  await exited;
  assert.ok(fs.existsSync(path.join(dir, '.standoff-live-rooms.json')), 'a room snapshot is written on SIGTERM');
  srv = await spawnServer(port, dir);
  const a2 = new WebSocket(url); await open(a2);
  a2.send(JSON.stringify({ t: 'join', code: j.code, clientId: 'restart-host', name: 'Rae' }));
  const j2 = await next(a2, (m) => m.t === 'joined');
  assert.strictEqual(j2.code, j.code, 'the room survives the restart under the same code');
  assert.strictEqual(j2.host, true, 'the host resumes as host after the restart');
  ok('active rooms survive a graceful restart (item 27)');
  try { a.close(); b.close(); a2.close(); srv.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

// A tiny in-process Redis so the Redis-backed restart path (item 27) can be
// verified without a real Redis — the store persists across two server spawns.
const { createParser } = require('./redis-min.js');
function mockRedis() {
  const store = new Map(), subs = new Map();
  const bulk = (v) => (v == null ? '$-1\r\n' : '$' + Buffer.byteLength(v) + '\r\n' + v + '\r\n');
  return net.createServer((sock) => {
    const p = createParser(); sock.on('error', () => {});
    sock.on('data', (chunk) => { for (const cmd of p.feed(chunk)) { if (!Array.isArray(cmd)) continue; const n = String(cmd[0]).toUpperCase();
      if (n === 'AUTH') sock.write('+OK\r\n');
      else if (n === 'SET') { store.set(cmd[1], cmd[2]); sock.write('+OK\r\n'); }
      else if (n === 'GET') sock.write(bulk(store.has(cmd[1]) ? store.get(cmd[1]) : null));
      else if (n === 'DEL') { store.delete(cmd[1]); sock.write(':1\r\n'); }
      else if (n === 'SUBSCRIBE') { const ch = cmd[1]; (subs.get(ch) || subs.set(ch, []).get(ch)).push(sock); sock.write('*3\r\n$9\r\nsubscribe\r\n' + bulk(ch) + ':1\r\n'); }
      else if (n === 'PUBLISH') { const l = subs.get(cmd[1]) || []; for (const s of l) { try { s.write('*3\r\n' + bulk('message') + bulk(cmd[1]) + bulk(cmd[2])); } catch (e) {} } sock.write(':' + l.length + '\r\n'); }
    } });
  });
}
async function redisRestartTest() {
  const os = require('os');
  const mock = mockRedis();
  await new Promise((res) => mock.listen(0, '127.0.0.1', res));
  const REDIS_URL = `redis://127.0.0.1:${mock.address().port}`;
  const port = 4197, url = `ws://127.0.0.1:${port}`;
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'standoff-rr1-'));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'standoff-rr2-'));  // a DIFFERENT empty disk → only Redis can carry the room
  const spawnSrv = (dir) => { const c = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), DATA_DIR: dir, REDIS_URL } }); c.stderr.on('data', (d) => process.stderr.write(d)); return new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('no start')), 6000); c.stdout.on('data', (d) => { if (String(d).includes('Standoff live')) { clearTimeout(to); res(c); } }); }); };
  let srv = await spawnSrv(dir1);
  const a = new WebSocket(url); await open(a);
  a.send(JSON.stringify({ t: 'create', clientId: 'rr-host', name: 'Rae', person: { genres: { Comedy: 'love' } } }));
  const j = await next(a, (m) => m.t === 'joined');
  const b = new WebSocket(url); await open(b);
  b.send(JSON.stringify({ t: 'join', code: j.code, clientId: 'rr-guest', name: 'Sam', person: { genres: { Drama: 'love' } } }));
  await next(b, (m) => m.t === 'joined');
  await next(a, (m) => m.t === 'presence' && m.room.participants.length === 2);
  const exited = new Promise((res) => srv.on('exit', res));
  srv.kill('SIGTERM'); await exited;   // snapshot → Redis (awaited before exit)
  srv = await spawnSrv(dir2);          // fresh container / empty disk
  const a2 = new WebSocket(url); await open(a2);
  a2.send(JSON.stringify({ t: 'join', code: j.code, clientId: 'rr-host', name: 'Rae' }));
  const j2 = await next(a2, (m) => m.t === 'joined');
  assert.strictEqual(j2.code, j.code, 'room restored from Redis under the same code — disk did not carry it');
  assert.strictEqual(j2.host, true, 'host resumes after a Redis-backed redeploy');
  ok('active rooms survive a redeploy via Redis (item 27, free-tier ephemeral-disk path)');
  try { a.close(); b.close(); a2.close(); srv.kill('SIGKILL'); } catch (e) {}
  await new Promise((res) => mock.close(res));
  try { fs.rmSync(dir1, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true }); } catch (e) {}
}

main()
  .then(async () => {
    const statusLine = await originRejected();
    assert.ok(/403/.test(statusLine), 'a cross-origin upgrade is refused: ' + statusLine);
    ok('cross-origin WebSocket upgrades are refused (CSWSH guard)');
    await restartTest();
    await redisRestartTest();
    console.log('\n\x1b[32m' + passed + ' passing\x1b[0m\n');
    cleanup(); process.exit(0);
  })
  .catch((e) => { console.error('\n\x1b[31m✗ ' + (e && e.message) + '\x1b[0m\n'); cleanup(); process.exit(1); });
