/* =============================================================================
 * server.js — Standoff live rooms. Pure Node stdlib, no dependencies.
 *
 * Serves the static app AND runs a hand-rolled WebSocket server (RFC 6455) so
 * two-to-eight people can each join a room on their own device, set their taste
 * privately, and watch the split-flap verdict land on every screen at once. The
 * decision engine (engine.js) runs here, server-side, as the single source of
 * truth; each room's fairness ledger is persisted to disk keyed by its code, so
 * a recurring crew that reuses a code keeps its history.
 *
 *   node server.js            # then open http://localhost:4173
 *   PORT=8080 node server.js  # custom port
 *
 * The static solo experience is unchanged — this just adds the "live room" mode.
 * ========================================================================== */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const engine = require('./engine.js');
const { CATALOG } = require('./catalog.js');
const { RedisBus } = require('./redis-min.js');

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
// Where room ledgers + accounts persist. Defaults to the app dir (local dev);
// point DATA_DIR at a mounted disk on a host so data survives redeploys.
const DATA_DIR = process.env.DATA_DIR || ROOT;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DATA_FILE = path.join(DATA_DIR, '.standoff-rooms.json');
const ROOMS_SNAPSHOT = path.join(DATA_DIR, '.standoff-live-rooms.json'); // active rooms across restarts (item 27)
const SNAP_KEY = 'standoff:rooms:snapshot'; // same, in Redis — survives a cross-container redeploy on an ephemeral disk
const MAX_ROOM = 8;

// ---- abuse / DoS limits (item 26). All overridable via env for tuning. -------
const LIMITS = {
  maxMsgBytes: Number(process.env.WS_MAX_MSG || 64 * 1024),      // reject frames larger than this
  maxBufferBytes: Number(process.env.WS_MAX_BUF || 256 * 1024),  // cap the unparsed read buffer
  maxRooms: Number(process.env.MAX_ROOMS || 5000),               // global room ceiling
  maxConnsPerIp: Number(process.env.MAX_CONNS_PER_IP || 40),     // concurrent sockets per IP
  msgRefillPerSec: Number(process.env.WS_MSG_RATE || 25),        // token-bucket refill
  msgBurst: Number(process.env.WS_MSG_BURST || 50),              // token-bucket ceiling
  heartbeatMs: 30000,                                            // server → client ping cadence
  idleTimeoutMs: 75000,                                          // no traffic within → reap the socket
  maxNameLen: 18, maxChatLen: 280, maxReactions: 1,
};
// Origin allow-list for the WebSocket upgrade (CSWSH protection). Browsers always
// send Origin; a matching same-origin or an allow-listed one passes. Non-browser
// clients (no Origin header) are allowed — they can't be tricked cross-site.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { if (new URL(origin).host === req.headers.host) return true; } catch (e) {}
  return ALLOWED_ORIGINS.includes(origin);
}
const clientIp = (req) => ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || (req.socket && req.socket.remoteAddress) || 'unknown';
const connsByIp = new Map(); // ip -> count

// ---- input validation (item 26) ----------------------------------------------
const isStr = (v) => typeof v === 'string';
const clampStr = (v, n) => (isStr(v) ? v.slice(0, n) : '');
const KNOWN_STANCE = new Set(['love', 'like', 'dislike', 'veto', 'neutral']);
// A person blob from an untrusted client — take only known fields, clamp sizes,
// and drop anything malformed so a hostile payload can't bloat memory or poison
// the engine.
function sanitizePerson(p) {
  if (!p || typeof p !== 'object') return DEFAULT_PERSON();
  const genres = {};
  if (p.genres && typeof p.genres === 'object') {
    let n = 0;
    for (const k of Object.keys(p.genres)) { if (n++ >= 20) break; if (isStr(k) && KNOWN_STANCE.has(p.genres[k])) genres[k.slice(0, 24)] = p.genres[k]; }
  }
  const mood = {};
  if (p.mood && typeof p.mood === 'object') {
    for (const k of ['brain', 'intensity', 'levity', 'pace', 'darkness', 'dialogue', 'novelty']) {
      const v = p.mood[k]; if (typeof v === 'number' && isFinite(v)) mood[k] = Math.max(0, Math.min(1, v));
    }
  }
  const rc = Number(p.runtimeCap);
  return {
    name: clampStr(p.name, LIMITS.maxNameLen),
    genres, mood: Object.keys(mood).length ? mood : DEFAULT_PERSON().mood,
    runtimeCap: isFinite(rc) ? Math.max(5, Math.min(999, rc)) : 999,
    conviction: ['easy', 'normal', 'care'].includes(p.conviction) ? p.conviction : 'normal',
  };
}
// A host-supplied pool — cap the custom list and disabled list, sanitise custom
// candidates so they can't inject arbitrary huge objects into the engine.
function sanitizePool(pool) {
  if (!pool || typeof pool !== 'object') return null;
  const disabled = Array.isArray(pool.disabled) ? pool.disabled.filter(isStr).slice(0, 400).map((s) => s.slice(0, 60)) : [];
  const custom = Array.isArray(pool.custom) ? pool.custom.slice(0, 60).map((c) => ({
    id: clampStr(c && c.id, 60) || 'x', title: clampStr(c && c.title, 80) || 'Untitled',
    genres: Array.isArray(c && c.genres) ? c.genres.filter(isStr).slice(0, 3) : ['Drama'],
    runtime: Math.max(5, Math.min(600, Number(c && c.runtime) || 100)),
    brain: 0.5, intensity: 0.5, levity: 0.5,
    kind: c && c.kind === 'Series' ? 'Series' : 'Film', year: Number(c && c.year) || undefined,
    hook: clampStr(c && c.hook, 120),
  })) : [];
  return { disabled, custom };
}

// ---- per-room fairness memory, persisted to disk -----------------------------
let db = {};
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {}; } catch (e) {}
let saveTimer = null;
const saveDb = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) {} }, 200); };
const memFor = (code) => (db[code] = db[code] || { cumulative: {}, debt: {}, history: [], seen: [], nights: 0 });

// ---- accounts + cloud persistence (item 3) -----------------------------------
// A real backend with lightweight auth, built on this same zero-dependency Node
// server (crypto for hashed passphrases + tokens; JSON on disk) rather than a
// third-party DB — so the app stays a single dependency-free page. An account
// stores one blob (crews, ledgers, seen-lists, custom titles); accounts are
// opt-in and the app keeps working with no account at all.
const ACC_FILE = path.join(DATA_DIR, '.standoff-accounts.json');
let accounts = {};
try { accounts = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')) || {}; } catch (e) {}
let accTimer = null;
const saveAccounts = () => { clearTimeout(accTimer); accTimer = setTimeout(() => { try { fs.writeFileSync(ACC_FILE, JSON.stringify(accounts)); } catch (e) {} }, 200); };
const normEmail = (e) => String(e || '').trim().toLowerCase();
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const sameHash = (a, b) => { try { return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); } catch (e) { return false; } };
const accountFor = (token) => token && Object.keys(accounts).find((e) => (accounts[e].tokens || []).includes(token));

function readJson(req, cb) {
  let body = '', over = false;
  req.on('data', (c) => { body += c; if (body.length > 1024 * 1024) { over = true; req.destroy(); } });
  req.on('end', () => { if (over) return cb(null); try { cb(JSON.parse(body || '{}')); } catch (e) { cb(null); } });
  req.on('error', () => cb(null));
}
const sendJson = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

function handleApi(req, res, u) {
  const m = req.method;
  if (u === '/api/signup' && m === 'POST') return readJson(req, (b) => {
    if (!b) return sendJson(res, 400, { error: 'Bad request.' });
    const email = normEmail(b.email), pass = String(b.pass || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'Enter a valid email.' });
    if (pass.length < 8) return sendJson(res, 400, { error: 'Passphrase must be at least 8 characters.' });
    if (accounts[email]) return sendJson(res, 409, { error: 'That email already has an account — log in instead.' });
    const salt = crypto.randomBytes(16).toString('hex'), token = newToken();
    accounts[email] = { salt, hash: hashPass(pass, salt), tokens: [token], data: null };
    saveAccounts();
    return sendJson(res, 200, { token, email, data: null });
  });
  if (u === '/api/login' && m === 'POST') return readJson(req, (b) => {
    if (!b) return sendJson(res, 400, { error: 'Bad request.' });
    const email = normEmail(b.email), a = accounts[email];
    if (!a || !sameHash(a.hash, hashPass(b.pass, a.salt))) return sendJson(res, 401, { error: 'Wrong email or passphrase.' });
    const token = newToken(); a.tokens = (a.tokens || []).concat(token).slice(-10); saveAccounts();
    return sendJson(res, 200, { token, email, data: a.data });
  });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const email = accountFor(token);
  if (!email) return sendJson(res, 401, { error: 'Not signed in.' });
  const a = accounts[email];
  if (u === '/api/data' && m === 'GET') return sendJson(res, 200, { email, data: a.data });
  if (u === '/api/data' && m === 'PUT') return readJson(req, (b) => { if (!b) return sendJson(res, 400, { error: 'Bad request.' }); a.data = b.data; saveAccounts(); return sendJson(res, 200, { ok: true }); });
  if (u === '/api/logout' && m === 'POST') { a.tokens = (a.tokens || []).filter((t) => t !== token); saveAccounts(); return sendJson(res, 200, { ok: true }); }
  return sendJson(res, 404, { error: 'Not found.' });
}

// ---- static files (no-cache, path-guarded) -----------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.py': 'text/plain; charset=utf-8' };
// Server-rendered verdict card (item 22) — a ticket-stub + clapperboard SVG built
// from query params, matching the in-app card so it can back an OG image or a
// direct share. SVG keeps it dependency-free; the client also renders a PNG.
function handleCard(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const esc = (s) => String(s || '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  const title = (q.get('title') || 'Tonight’s pick').slice(0, 64);
  const hook = (q.get('hook') || '').slice(0, 84);
  const meta = (q.get('meta') || '').slice(0, 80);
  const conf = (q.get('confidence') || 'Settled').slice(0, 22);
  // crude two-line wrap for the title (SVG has no auto-wrap)
  const words = title.split(' '); const lines = ['', ''];
  const limit = 22; let li = 0;
  for (const w of words) { if ((lines[li] + ' ' + w).trim().length > limit && li === 0) li = 1; lines[li] = (lines[li] ? lines[li] + ' ' : '') + w; }
  const clap = Array.from({ length: 22 }, (_, i) => `<rect x="${24 + i * 52.4}" y="24" width="53" height="16" fill="${i % 2 ? '#0d0b08' : '#f3b23e'}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#191007"/><stop offset="1" stop-color="#0d0b08"/></linearGradient></defs>
    <rect width="1200" height="630" fill="url(#bg)"/>
    <rect x="22" y="22" width="1156" height="586" rx="20" fill="none" stroke="rgba(243,178,62,0.55)" stroke-width="2"/>
    ${clap}
    <line x1="900" y1="60" x2="900" y2="586" stroke="rgba(255,240,220,0.14)" stroke-width="2" stroke-dasharray="6 8"/>
    <text x="60" y="118" font-family="'JetBrains Mono',monospace" font-size="20" font-weight="600" fill="#f3b23e" letter-spacing="1">TONIGHT’S PICK</text>
    <text x="60" y="196" font-family="'Fraunces',Georgia,serif" font-size="60" font-weight="600" fill="#f6efe2">${esc(lines[0])}</text>
    ${lines[1] ? `<text x="60" y="260" font-family="'Fraunces',Georgia,serif" font-size="60" font-weight="600" fill="#f6efe2">${esc(lines[1])}</text>` : ''}
    <text x="60" y="${lines[1] ? 312 : 250}" font-family="'Inter',system-ui,sans-serif" font-size="22" fill="#a99885">${esc(meta)}</text>
    ${hook ? `<text x="60" y="${lines[1] ? 372 : 310}" font-family="'Fraunces',Georgia,serif" font-style="italic" font-size="26" fill="#ffd88a">“${esc(hook)}”</text>` : ''}
    <text x="942" y="118" font-family="'JetBrains Mono',monospace" font-size="15" font-weight="600" fill="#776d5f">VERDICT</text>
    <text x="942" y="152" font-family="'Fraunces',Georgia,serif" font-size="26" font-weight="600" fill="#f6efe2">${esc(conf)}</text>
    <text x="60" y="582" font-family="'Inter',system-ui,sans-serif" font-size="18" fill="#776d5f">Settled fairly with Standoff · standoff-liyl.onrender.com</text>
  </svg>`;
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  res.end(svg);
}

const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok'); } // deploy health check
  if (u === '/metrics') { const mu = process.memoryUsage(); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ rooms: rooms.size, clients: allClients.size, ips: connsByIp.size, rssMB: Math.round(mu.rss / 1048576), heapMB: Math.round(mu.heapUsed / 1048576), uptime: Math.round(process.uptime()) })); } // ops + load-test observability
  if (u === '/card.svg') return handleCard(req, res); // server-rendered ticket-stub image (item 22)
  if (u.startsWith('/api/')) return handleApi(req, res, u); // accounts + cloud persistence
  if (u === '/' || u.startsWith('/room/') || u.startsWith('/join')) u = '/index.html'; // pretty routes → app
  // Serve client assets only — never dotfiles (accounts + room ledgers live in
  // .standoff-*.json), the server source, tests, or tooling.
  if (u.split('/').some((s) => s.startsWith('.')) || u.startsWith('/scripts/') || u.startsWith('/node_modules/') || u.startsWith('/e2e/')
    || /(^|\/)(server\.js|redis-min\.js|package(-lock)?\.json|playwright\.config\.js|[^/]*\.test\.js)$/.test(u)) {
    res.writeHead(404); return res.end('not found');
  }
  const fp = path.normalize(path.join(ROOT, u));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(d);
  });
});

// ---- rooms -------------------------------------------------------------------
const rooms = new Map(); // code -> { code, hostId, clients: Map(id -> client), pool, exclude:Set, result }
const allClients = new Set(); // every live socket, for heartbeat + graceful shutdown
const GRACE_MS = Number(process.env.WS_GRACE_MS || 30000); // keep a seat this long after a drop, for reconnect

// Event-loop lag gauge + a bound on how many verdict analyses may be queued at
// once. The analysis is CPU-heavy and optional; under heavy concurrent load we
// shed it (the verdict still lands instantly) so it can't starve connection
// handshakes or other verdicts. Found + tuned via the load test (item 30).
let elLagMs = 0, lagRef = Date.now();
setInterval(() => { const now = Date.now(); elLagMs = now - lagRef - 100; lagRef = now; }, 100).unref();
let analysisQueue = 0;
const ANALYSIS_MAX_QUEUE = Number(process.env.ANALYSIS_MAX_QUEUE || 4);

// ---- optional cross-instance scale-out (item 27) -----------------------------
// With REDIS_URL set, every room broadcast is also published to a shared Redis
// channel; sibling instances relay it to *their* local members of that room, so a
// verdict / chat / presence fans out across a horizontally-scaled fleet. Without
// it, broadcasts stay purely in-memory (single instance) — the dependency-free
// default. (Render's free tier is a single instance, so this is opt-in headroom.)
const INSTANCE = crypto.randomBytes(4).toString('hex');
let bus = null;
if (process.env.REDIS_URL) {
  bus = new RedisBus(process.env.REDIS_URL, (channel, payload) => {
    if (channel !== 'standoff:bus') return;
    let m; try { m = JSON.parse(payload); } catch (e) { return; }
    if (!m || m.from === INSTANCE || !m.code) return;   // ignore our own echoes
    const room = rooms.get(m.code);
    if (room) for (const c of room.clients.values()) send(c.sock, m.obj);
  }, (s) => console.log(s));
  bus.subscribe('standoff:bus');
  console.log('Scale-out: Redis pub/sub bus connected (instance ' + INSTANCE + ').');
}
const roomCode = () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 4; i++) s += A[(Math.random() * A.length) | 0]; return s; };
const uid = () => Math.random().toString(36).slice(2, 9);

const DEFAULT_PERSON = () => ({ name: '', genres: {}, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 }, runtimeCap: 999, conviction: 'normal' });
const hasTaste = (p) => p && (Object.keys(p.genres || {}).length > 0 || (p.name || '').trim());

const mkey = (c) => c.clientId || c.id;                 // stable membership key (survives reconnects)
const voters = (room) => [...room.clients.values()].filter((c) => !c.spectator);
const REACTIONS = new Set(['🎉', '😂', '🔥', '❤️', '👍', '👎', '😱', '🍿', '💯', '🙌']);

function roomPublic(room) {
  return {
    code: room.code, hostId: room.hostId,
    participants: [...room.clients.values()].map((c) => ({ id: mkey(c), name: c.name || '', avatarIndex: c.avatarIndex || 0, ready: hasTaste(c.person), spectator: !!c.spectator, deciding: !!c.deciding })),
    nights: (db[room.code] && db[room.code].nights) || 0,
  };
}
function broadcast(room, obj) {
  for (const c of room.clients.values()) send(c.sock, obj);
  if (bus) bus.publish('standoff:bus', JSON.stringify({ from: INSTANCE, code: room.code, obj })); // fan out to sibling instances
}
function presence(room) { broadcast(room, { t: 'presence', room: roomPublic(room) }); }

function engineCrew(room) {
  const seen = {};
  return voters(room).map((c, i) => {
    let n = (c.name || '').trim() || `Guest ${i + 1}`;
    let k = n.toLowerCase(); if (seen[k]) { n = `${n} ${i + 1}`; k = n.toLowerCase(); } seen[k] = true;
    const p = c.person || DEFAULT_PERSON();
    return { name: n, genres: p.genres || {}, mood: p.mood || DEFAULT_PERSON().mood, runtimeCap: p.runtimeCap == null ? 999 : p.runtimeCap, conviction: p.conviction || 'normal' };
  });
}
function activeCatalog(room) {
  const pool = room.pool || { disabled: [], custom: [] };
  const off = new Set(pool.disabled || []);
  return CATALOG.filter((c) => !off.has(c.id)).concat(pool.custom || []);
}

function doResolve(room, kind) {
  if (voters(room).length < 2) { broadcast(room, { t: 'notice', msg: 'Need at least two people in the room to settle.' }); return; }
  const mem = memFor(room.code);
  if (kind === 'settle') room.exclude = new Set();
  if (kind === 'reroll' && room.result && room.result.pick) room.exclude.add(room.result.pick.id);
  if (kind === 'seen' && room.result && room.result.pick) { engine.markSeen(mem, room.result.pick.id, true); saveDb(); room.exclude = new Set(); }
  let result;
  try {
    result = engine.resolve(engineCrew(room), activeCatalog(room), { exclude: [...room.exclude] }, mem);
  } catch (e) { broadcast(room, { t: 'notice', msg: e.message || 'Could not settle.' }); return; }
  room.result = result;
  broadcast(room, { t: 'verdict', title: result.empty ? null : result.pick.title, result, analysis: null });
  // The robustness / strategyproofness analysis is CPU-heavy; compute it OFF the
  // settle's critical path (setImmediate) so the verdict lands instantly and many
  // concurrent rooms don't queue behind each other's analysis — a bottleneck the
  // load test (item 30) surfaced. It arrives moments later as its own message.
  if (!result.empty) {
    if (analysisQueue >= ANALYSIS_MAX_QUEUE || elLagMs > 200) { broadcast(room, { t: 'analysis', analysis: null, skipped: true }); return; } // shed under pressure
    analysisQueue++;
    setImmediate(() => {
      analysisQueue--;
      if (room.result !== result) return;   // a re-roll superseded this verdict
      let analysis = null;
      try { analysis = engine.analyzeVerdict(engineCrew(room), activeCatalog(room), memFor(room.code), result); } catch (e) {}
      if (analysis && room.result === result) broadcast(room, { t: 'analysis', analysis });
      else if (!analysis) broadcast(room, { t: 'analysis', analysis: null, skipped: true });
    });
  }
}

function removeMember(room, key) {
  const m = room.clients.get(key);
  if (m && m.ghostTimer) clearTimeout(m.ghostTimer);
  room.clients.delete(key);
  if (room.clients.size === 0) { rooms.delete(room.code); return; }
  if (room.hostId === key) room.hostId = mkey(voters(room)[0] || [...room.clients.values()][0]); // promote a voter (or anyone left)
  presence(room);
}
// A socket close is treated as an *accidental* drop: keep the seat as a "ghost"
// for a grace window so a wifi blip / phone lock can reconnect into the same seat
// (and host role). A deliberate exit sends {t:'leave'} first, which removes at once.
function closeClient(client) {
  const room = client.roomCode && rooms.get(client.roomCode);
  if (!room) return;
  const key = mkey(client);
  const member = room.clients.get(key);
  if (member !== client) return;                        // already replaced by a reconnect — leave the member be
  member.sock = null; member.disconnected = true;
  member.ghostTimer = setTimeout(() => { if (room.clients.get(key) === member && !member.sock) removeMember(room, key); }, GRACE_MS);
  presence(room);
}

function handle(client, msg) {
  switch (msg.t) {
    case 'create': {
      if (rooms.size >= LIMITS.maxRooms) return send(client.sock, { t: 'error', msg: 'The server is at capacity — try again shortly.' });
      if (client.roomsCreated >= 8) return send(client.sock, { t: 'error', msg: 'Too many rooms from this connection.' });
      client.clientId = clampStr(msg.clientId, 40) || client.id;
      let code = roomCode(); while (rooms.has(code)) code = roomCode();
      const room = { code, hostId: client.clientId, clients: new Map(), pool: sanitizePool(msg.pool), exclude: new Set(), result: null, chat: [], createdAt: Date.now() };
      rooms.set(code, room);
      client.roomsCreated++;
      client.name = clampStr(msg.name, LIMITS.maxNameLen); client.avatarIndex = (msg.avatarIndex | 0) & 15; client.person = sanitizePerson(msg.person); client.roomCode = code; client.spectator = false;
      room.clients.set(client.clientId, client);
      send(client.sock, { t: 'joined', code, youId: client.clientId, host: true, spectator: false, room: roomPublic(room), chat: [] });
      presence(room);
      break;
    }
    case 'join': {
      const room = rooms.get(clampStr(msg.code, 8).toUpperCase());
      if (!room) return send(client.sock, { t: 'error', msg: 'No room with that code.' });
      client.clientId = clampStr(msg.clientId, 40) || client.id;
      const existing = room.clients.get(client.clientId);
      const wasHost = room.hostId === client.clientId;                 // a reconnecting host keeps the crown
      const spectator = !!msg.spectator && !wasHost;
      if (!spectator && !existing && voters(room).length >= MAX_ROOM) return send(client.sock, { t: 'error', msg: 'That room is full — join as a spectator?' });
      client.name = clampStr(msg.name, LIMITS.maxNameLen); client.avatarIndex = (msg.avatarIndex | 0) & 15; client.person = sanitizePerson(msg.person); client.roomCode = room.code; client.spectator = spectator;
      const old = existing && existing.sock;
      if (existing && existing.ghostTimer) clearTimeout(existing.ghostTimer);   // cancel pending eviction
      room.clients.set(client.clientId, client);                       // reconnect: replace the member's socket, keep identity
      if (old && old !== client.sock) { try { old.destroy(); } catch (e) {} }
      send(client.sock, { t: 'joined', code: room.code, youId: client.clientId, host: wasHost, spectator, room: roomPublic(room), chat: room.chat.slice(-40) });
      presence(room);
      break;
    }
    case 'me': {
      const room = rooms.get(client.roomCode); if (!room) return;
      if (isStr(msg.name)) client.name = clampStr(msg.name, LIMITS.maxNameLen);
      if (typeof msg.avatarIndex === 'number') client.avatarIndex = (msg.avatarIndex | 0) & 15;
      if (msg.person) client.person = sanitizePerson(msg.person);
      if (typeof msg.deciding === 'boolean') client.deciding = msg.deciding;   // live "still deciding…" indicator
      presence(room);
      break;
    }
    case 'pool': {   // host syncs their custom pool to the room
      const room = rooms.get(client.roomCode); if (!room || room.hostId !== mkey(client)) return;
      room.pool = sanitizePool(msg.pool);
      break;
    }
    case 'settle': case 'reroll': case 'seen': {
      const room = rooms.get(client.roomCode); if (!room || room.hostId !== mkey(client)) return;
      doResolve(room, msg.t);
      break;
    }
    case 'lock': {
      const room = rooms.get(client.roomCode);
      if (!room || room.hostId !== mkey(client) || !room.result || room.result.empty) return;
      db[room.code] = engine.commit(memFor(room.code), room.result.pick, room.result._committable.normForPick);
      saveDb();
      broadcast(room, { t: 'locked' });
      break;
    }
    // Interactive counterfactual in a live room (item 15). Only the server holds
    // everyone's private tastes, so it computes "what would flip it" and returns the
    // alternate outcome to just the asker — nobody else's preferences are revealed.
    case 'whatif': {
      const room = rooms.get(client.roomCode);
      if (!room || !room.result || room.result.empty) return;
      const who = clampStr(msg.who, 40), genre = clampStr(msg.genre, 24), to = KNOWN_STANCE.has(msg.to) ? msg.to : 'neutral';
      const crew = engineCrew(room).map((p) => ({ ...p, genres: { ...p.genres } }));
      const person = crew.find((p) => p.name === who);
      if (!person) return;
      if (to === 'neutral' || to === 'veto') { if (to === 'veto') person.genres[genre] = 'veto'; else delete person.genres[genre]; } else person.genres[genre] = to;
      let res;
      try { res = engine.resolve(crew, activeCatalog(room), { exclude: [...room.exclude] }, memFor(room.code)); }
      catch (e) { return; }
      if (res.empty) { send(client.sock, { t: 'whatif', who, genre, to, empty: true }); break; }
      const lh = [...res.explanation.perPerson].sort((a, b) => a.util - b.util)[0];
      send(client.sock, { t: 'whatif', who, genre, to, title: res.pick.title, same: res.pick.id === room.result.pick.id, leastHappy: lh ? { name: lh.name, label: lh.label } : null });
      break;
    }
    case 'chat': {   // per-room chat (item 28)
      const room = rooms.get(client.roomCode); if (!room) return;
      const text = clampStr(msg.text, LIMITS.maxChatLen).replace(/\s+/g, ' ').trim(); if (!text) return;
      const entry = { id: mkey(client), from: client.name || 'Guest', text, at: Date.now() };
      room.chat.push(entry); if (room.chat.length > 200) room.chat.shift();
      broadcast(room, { t: 'chat', id: entry.id, from: entry.from, text: entry.text, at: entry.at });
      break;
    }
    case 'react': {  // live reactions during the reveal (item 28)
      const room = rooms.get(client.roomCode); if (!room || !REACTIONS.has(msg.emoji)) return;
      broadcast(room, { t: 'react', id: mkey(client), from: client.name || 'Guest', emoji: msg.emoji });
      break;
    }
    case 'host': {   // host handoff (item 28)
      const room = rooms.get(client.roomCode); if (!room || room.hostId !== mkey(client)) return;
      const to = clampStr(msg.to, 40); const target = room.clients.get(to);
      if (target && !target.spectator) { room.hostId = to; presence(room); }
      break;
    }
    case 'kick': {   // host removes a member (item 28)
      const room = rooms.get(client.roomCode); if (!room || room.hostId !== mkey(client)) return;
      const id = clampStr(msg.id, 40); if (id === room.hostId) return;
      const target = room.clients.get(id);
      if (target) { send(target.sock, { t: 'kicked' }); target.roomCode = null; room.clients.delete(id); if (target.sock) { try { target.sock.destroy(); } catch (e) {} } presence(room); }
      break;
    }
    case 'spectate': {  // toggle spectator mode (item 28)
      const room = rooms.get(client.roomCode); if (!room || room.hostId === mkey(client)) return;
      const on = !!msg.on;
      if (!on && voters(room).length >= MAX_ROOM) return send(client.sock, { t: 'notice', msg: 'The couch is full — staying a spectator.' });
      client.spectator = on; presence(room);
      break;
    }
    case 'leave': {   // deliberate exit — remove at once (vs an accidental drop, which grace-ghosts)
      const room = rooms.get(client.roomCode); if (!room) return;
      removeMember(room, mkey(client)); client.roomCode = null;
      break;
    }
    case 'ping': send(client.sock, { t: 'pong' }); break;
  }
}

// ---- WebSocket framing (RFC 6455) --------------------------------------------
function send(sock, obj) {
  if (!sock || sock.destroyed) return;
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  try { sock.write(Buffer.concat([header, payload])); } catch (e) {}
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  if (!originOk(req)) { try { sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch (e) {} sock.destroy(); return; } // CSWSH guard
  const ip = clientIp(req);
  const nConns = connsByIp.get(ip) || 0;
  if (nConns >= LIMITS.maxConnsPerIp) { try { sock.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); } catch (e) {} sock.destroy(); return; }
  connsByIp.set(ip, nConns + 1);

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.on('error', () => {});
  sock.setTimeout(0);

  const client = { id: uid(), sock, ip, name: '', avatarIndex: 0, person: null, roomCode: null, clientId: null, spectator: false,
    tokens: LIMITS.msgBurst, last: Date.now(), alive: true, roomsCreated: 0 };
  allClients.add(client);
  let released = false;
  const release = () => { if (released) return; released = true; allClients.delete(client); const c = (connsByIp.get(ip) || 1) - 1; if (c <= 0) connsByIp.delete(ip); else connsByIp.set(ip, c); };

  // token-bucket rate limiter (item 26)
  function allow() {
    const now = Date.now();
    client.tokens = Math.min(LIMITS.msgBurst, client.tokens + ((now - client.last) / 1000) * LIMITS.msgRefillPerSec);
    client.last = now;
    if (client.tokens < 1) return false;
    client.tokens -= 1; return true;
  }

  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    client.alive = true;
    if (buf.length + chunk.length > LIMITS.maxBufferBytes) { closeClient(client); sock.destroy(); release(); return; } // buffer DoS guard
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > LIMITS.maxMsgBytes) { closeClient(client); sock.destroy(); release(); return; }   // oversized frame → drop the peer
      if (!masked) { closeClient(client); sock.destroy(); release(); return; }                      // clients MUST mask (RFC 6455)
      if (buf.length < off + 4) break;
      const mask = buf.subarray(off, off + 4); off += 4;
      if (buf.length < off + len) break; // wait for the rest of the frame
      let payload = buf.subarray(off, off + len);
      const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out;
      buf = buf.subarray(off + len);
      if (opcode === 0x8) { closeClient(client); sock.destroy(); release(); return; }               // close
      else if (opcode === 0x9) { try { sock.write(Buffer.from([0x8a, 0])); } catch (e) {} }          // ping → pong
      else if (opcode === 0xa) { client.alive = true; }                                             // pong (heartbeat reply)
      else if (opcode === 0x1) {                                                                     // text
        if (!allow()) continue;                                                                      // rate-limited → silently drop
        let m; try { m = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
        if (m && typeof m === 'object' && isStr(m.t)) { try { handle(client, m); } catch (e) {} }
      }
    }
  });
  sock.on('close', () => { closeClient(client); release(); });
});

// Heartbeat: ping every client on a cadence; reap any that hasn't produced traffic
// (data or a pong) since the last sweep — clears zombie sockets a proxy dropped.
const PING_FRAME = Buffer.from([0x89, 0]);
const heartbeat = setInterval(() => {
  for (const c of allClients) {
    if (!c.sock || c.sock.destroyed) { allClients.delete(c); continue; }
    if (!c.alive) { try { c.sock.destroy(); } catch (e) {} closeClient(c); allClients.delete(c); continue; }
    c.alive = false;
    try { c.sock.write(PING_FRAME); } catch (e) {}
  }
}, LIMITS.heartbeatMs);
heartbeat.unref();

// ---- graceful restart that PRESERVES active rooms (item 27) -------------------
// On SIGTERM (Render sends one before every redeploy) we snapshot each live room's
// membership to disk. On the next boot we restore them as "ghost" members with no
// socket; when their clients reconnect (by stable clientId) they slot back into the
// same room, same host — the night survives a deploy. A TTL sweep clears rooms
// nobody rejoins.
function snapshotRooms() {
  const out = [];
  for (const room of rooms.values()) {
    const members = [...room.clients.values()].map((c) => ({ clientId: mkey(c), name: c.name, avatarIndex: c.avatarIndex, person: c.person, spectator: !!c.spectator }));
    if (!members.length) continue;
    out.push({ code: room.code, hostId: room.hostId, pool: room.pool, exclude: [...(room.exclude || [])], chat: (room.chat || []).slice(-40), createdAt: room.createdAt, members });
  }
  return out;
}
function loadRoomsFromJson(text) {
  let snap = [];
  try { snap = JSON.parse(text) || []; } catch (e) { return; }
  const now = Date.now();
  for (const r of snap) {
    if (!r || !r.code || !Array.isArray(r.members) || rooms.has(r.code)) continue;
    const room = { code: r.code, hostId: r.hostId, clients: new Map(), pool: r.pool || null, exclude: new Set(r.exclude || []), result: null, chat: r.chat || [], createdAt: r.createdAt || now, restoredAt: now };
    for (const m of r.members) {
      // ghost member: no socket until its client reconnects. send() no-ops on null sockets.
      room.clients.set(m.clientId, { id: m.clientId, clientId: m.clientId, sock: null, name: m.name || '', avatarIndex: m.avatarIndex || 0, person: m.person || DEFAULT_PERSON(), spectator: !!m.spectator, roomCode: r.code, deciding: false, disconnected: true });
    }
    if (room.clients.size) rooms.set(r.code, room);
  }
}
function loadRooms() {
  let text = null;
  try { text = fs.readFileSync(ROOMS_SNAPSHOT, 'utf8'); } catch (e) { return; }
  try { fs.unlinkSync(ROOMS_SNAPSHOT); } catch (e) {}   // consume it — don't resurrect on the boot after this
  loadRoomsFromJson(text);
}
// Reap restored rooms that nobody reconnected to, and stale empty rooms.
const roomSweep = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const live = [...room.clients.values()].some((c) => c.sock && !c.sock.destroyed);
    if (!live && room.restoredAt && now - room.restoredAt > 10 * 60 * 1000) rooms.delete(code);
  }
}, 60 * 1000);
roomSweep.unref();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  const json = JSON.stringify(snapshotRooms());
  try { fs.writeFileSync(ROOMS_SNAPSHOT, json); } catch (e) {}                    // disk snapshot (same-machine restart)
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) {}          // flush debounced writes
  try { fs.writeFileSync(ACC_FILE, JSON.stringify(accounts)); } catch (e) {}
  for (const room of rooms.values()) broadcast(room, { t: 'notice', msg: 'Server updating — reconnecting you…' });
  // Redis snapshot (survives a fresh-container redeploy) — AWAIT it so it flushes
  // to Redis before we tear down, then drop the client sockets so they reconnect.
  const hardStop = setTimeout(() => process.exit(0), 3000); hardStop.unref();
  if (bus) { try { await Promise.race([bus.set(SNAP_KEY, json, 900), new Promise((r) => setTimeout(r, 2000))]); } catch (e) {} }
  for (const c of allClients) { try { c.sock && c.sock.destroy(); } catch (e) {} }
  try { server.close(() => process.exit(0)); } catch (e) { process.exit(0); }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function boot() {
  if (bus) {
    // Prefer the Redis snapshot (survives a fresh-container redeploy); else disk.
    try {
      const snap = await Promise.race([bus.get(SNAP_KEY), new Promise((res) => setTimeout(() => res(null), 2000))]);
      if (snap) { loadRoomsFromJson(snap); bus.del(SNAP_KEY); }
    } catch (e) {}
  }
  loadRooms();   // disk snapshot (merges any codes Redis didn't have; skips dupes)
  if (rooms.size) console.log(`Restored ${rooms.size} live room(s) from the last shutdown.`);
  server.listen(PORT, () => console.log(`Standoff live — http://localhost:${PORT}`));
}
boot();
