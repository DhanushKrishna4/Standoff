/* =============================================================================
 * scripts/loadtest.mjs — concurrent-rooms load / stress test (item 30).
 *
 * Spins up many live rooms against the server at once — each with a host + guests
 * who set a taste, then the host settles a few times — and reports connection
 * success, settle round-trip latency (p50/p95/max) and the server's own room /
 * memory footprint under load (via /metrics). Pure Node (global WebSocket + fetch),
 * no dependencies. Spawns its own server unless TARGET is given.
 *
 *   node scripts/loadtest.mjs                       # 100 rooms × 3, 2 settles each
 *   ROOMS=400 PER_ROOM=4 SETTLES=3 node scripts/loadtest.mjs
 *   TARGET=wss://standoff-liyl.onrender.com ROOMS=50 node scripts/loadtest.mjs
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOMS = Number(process.env.ROOMS || 50);   // a healthy single-instance target; crank it up to stress
const PER_ROOM = Number(process.env.PER_ROOM || 3);
const SETTLES = Number(process.env.SETTLES || 2);
const CONCURRENCY = Number(process.env.CONCURRENCY || 40);   // rooms opened in parallel
const PORT = Number(process.env.PORT || 4210);
const HERE = dirname(fileURLToPath(import.meta.url));

const GENRES = ['Comedy', 'Drama', 'Sci-Fi', 'Action', 'Thriller', 'Romance', 'Crime', 'Animation'];
const rand = (a) => a[(Math.random() * a.length) | 0];
const person = () => ({ genres: { [rand(GENRES)]: 'love', [rand(GENRES)]: 'like' }, mood: { brain: Math.random(), intensity: Math.random(), levity: Math.random() }, runtimeCap: 999 });
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

const open = (ws) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('open timeout')), 8000); ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true }); ws.addEventListener('error', (e) => { clearTimeout(t); rej(new Error('ws error')); }, { once: true }); });
const waitFor = (ws, pred, ms = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => { ws.removeEventListener('message', h); rej(new Error('wait timeout')); }, ms);
  const h = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (pred(m)) { clearTimeout(t); ws.removeEventListener('message', h); res(m); } };
  ws.addEventListener('message', h);
});

const stats = { roomsOk: 0, roomsFail: 0, conns: 0, connFail: 0, settles: 0, settleFail: 0, latencies: [] };

async function runRoom(i, url) {
  const clients = [];
  try {
    const host = new WebSocket(url); await open(host); stats.conns++;
    clients.push(host);
    host.send(JSON.stringify({ t: 'create', clientId: `lt-${i}-h`, name: `Host${i}`, person: person() }));
    const j = await waitFor(host, (m) => m.t === 'joined');
    for (let g = 1; g < PER_ROOM; g++) {
      const gs = new WebSocket(url); await open(gs); stats.conns++; clients.push(gs);
      gs.send(JSON.stringify({ t: 'join', code: j.code, clientId: `lt-${i}-${g}`, name: `G${i}_${g}`, person: person() }));
      await waitFor(gs, (m) => m.t === 'joined');
    }
    // wait until the host sees everyone ready
    await waitFor(host, (m) => m.t === 'presence' && m.room.participants.length === PER_ROOM && m.room.participants.every((p) => p.ready), 8000).catch(() => {});
    for (let s = 0; s < SETTLES; s++) {
      const t0 = Date.now();
      const v = waitFor(host, (m) => m.t === 'verdict', 10000);
      host.send(JSON.stringify({ t: s === 0 ? 'settle' : 'reroll' }));
      await v;
      stats.latencies.push(Date.now() - t0); stats.settles++;
    }
    stats.roomsOk++;
  } catch (e) {
    stats.roomsFail++;
    if (/open|ws error/.test(e.message)) stats.connFail++;
  } finally {
    for (const c of clients) { try { c.send(JSON.stringify({ t: 'leave' })); c.close(); } catch (e) {} }
  }
}

async function pool(n, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, n) }, async () => { while (next < n) { const i = next++; await worker(i); } });
  await Promise.all(runners);
}

async function metrics(base) { try { const r = await fetch(base + '/metrics'); return await r.json(); } catch (e) { return null; } }

async function main() {
  let child = null, base, wsUrl;
  if (process.env.TARGET) { base = process.env.TARGET.replace(/^ws/, 'http'); wsUrl = process.env.TARGET; }
  else {
    child = spawn('node', ['server.js'], { cwd: join(HERE, '..'), env: { ...process.env, PORT: String(PORT), MAX_CONNS_PER_IP: '100000' } });
    child.stderr.on('data', (d) => process.stderr.write(d));
    await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('server did not start')), 6000); child.stdout.on('data', (d) => { if (String(d).includes('Standoff live')) { clearTimeout(to); res(); } }); });
    base = `http://127.0.0.1:${PORT}`; wsUrl = `ws://127.0.0.1:${PORT}`;
  }

  console.log(`\nLoad test → ${wsUrl}`);
  console.log(`${ROOMS} rooms × ${PER_ROOM} people × ${SETTLES} settles  (concurrency ${CONCURRENCY})\n`);
  const before = await metrics(base);
  const t0 = Date.now();
  await pool(ROOMS, (i) => runRoom(i, wsUrl));
  const secs = (Date.now() - t0) / 1000;
  await new Promise((r) => setTimeout(r, 300));
  const peak = await metrics(base);

  const L = stats.latencies;
  console.log('── results ──────────────────────────────────');
  console.log(`rooms:      ${stats.roomsOk} ok / ${stats.roomsFail} failed`);
  console.log(`connections:${stats.conns} ok / ${stats.connFail} failed`);
  console.log(`settles:    ${stats.settles} (${(stats.settles / secs).toFixed(1)}/s)`);
  console.log(`settle RTT: p50 ${pct(L, 50)}ms · p95 ${pct(L, 95)}ms · max ${L.length ? Math.max(...L) : 0}ms`);
  console.log(`wall time:  ${secs.toFixed(1)}s`);
  if (peak) console.log(`server:     ${peak.rooms} rooms · ${peak.clients} sockets · ${peak.rssMB}MB rss (was ${before ? before.rssMB : '?'}MB)`);
  console.log('─────────────────────────────────────────────\n');

  const healthy = stats.roomsOk >= ROOMS * 0.98 && pct(L, 95) < 5000;
  console.log(healthy ? '\x1b[32m✓ healthy under load\x1b[0m\n' : '\x1b[31m✗ degraded under load\x1b[0m\n');
  if (child) child.kill('SIGKILL');
  process.exit(healthy ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
