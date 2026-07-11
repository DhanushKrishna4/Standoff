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

  // --- host settles: both clients receive the SAME verdict ---
  const hv = next(host, (m) => m.t === 'verdict');
  const gv = next(guest, (m) => m.t === 'verdict');
  host.send(JSON.stringify({ t: 'settle' }));
  const [hVer, gVer] = await Promise.all([hv, gv]);
  assert.ok(hVer.result && hVer.result.pick && hVer.title, 'the verdict carries a pick');
  assert.strictEqual(hVer.result.pick.id, gVer.result.pick.id, 'every screen lands on the identical pick');
  assert.ok(hVer.analysis && hVer.analysis.robustness && hVer.analysis.strategy, 'the server ships the robustness + strategy analysis');
  ok('settle broadcasts one identical, fully-analysed verdict to all');

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

  // --- a disconnect updates presence for the rest ---
  const back = next(host, (m) => m.t === 'presence' && m.room.participants.length === 1);
  guest.close();
  await back;
  ok('a disconnect drops the person from presence');

  host.close();
  console.log('\n\x1b[32m' + passed + ' passing\x1b[0m\n');
}

main().then(() => { cleanup(); process.exit(0); }).catch((e) => { console.error('\n\x1b[31m✗ ' + (e && e.message) + '\x1b[0m\n'); cleanup(); process.exit(1); });
