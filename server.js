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

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
// Where room ledgers + accounts persist. Defaults to the app dir (local dev);
// point DATA_DIR at a mounted disk on a host so data survives redeploys.
const DATA_DIR = process.env.DATA_DIR || ROOT;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DATA_FILE = path.join(DATA_DIR, '.standoff-rooms.json');
const MAX_ROOM = 8;

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
  if (u === '/card.svg') return handleCard(req, res); // server-rendered ticket-stub image (item 22)
  if (u.startsWith('/api/')) return handleApi(req, res, u); // accounts + cloud persistence
  if (u === '/' || u.startsWith('/room/') || u.startsWith('/join')) u = '/index.html'; // pretty routes → app
  // Serve client assets only — never dotfiles (accounts + room ledgers live in
  // .standoff-*.json), the server source, tests, or tooling.
  if (u.split('/').some((s) => s.startsWith('.')) || u.startsWith('/scripts/') || /(^|\/)(server\.js|[^/]*\.test\.js)$/.test(u)) {
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
const roomCode = () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 4; i++) s += A[(Math.random() * A.length) | 0]; return s; };
const uid = () => Math.random().toString(36).slice(2, 9);

const DEFAULT_PERSON = () => ({ name: '', genres: {}, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 }, runtimeCap: 999, conviction: 'normal' });
const hasTaste = (p) => p && (Object.keys(p.genres || {}).length > 0 || (p.name || '').trim());

function roomPublic(room) {
  return {
    code: room.code, hostId: room.hostId,
    participants: [...room.clients.values()].map((c) => ({ id: c.id, name: c.name || '', avatarIndex: c.avatarIndex || 0, ready: hasTaste(c.person) })),
  };
}
function broadcast(room, obj) { for (const c of room.clients.values()) send(c.sock, obj); }
function presence(room) { broadcast(room, { t: 'presence', room: roomPublic(room) }); }

function engineCrew(room) {
  const seen = {};
  return [...room.clients.values()].map((c, i) => {
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
  if (room.clients.size < 2) { broadcast(room, { t: 'notice', msg: 'Need at least two people in the room to settle.' }); return; }
  const mem = memFor(room.code);
  if (kind === 'settle') room.exclude = new Set();
  if (kind === 'reroll' && room.result && room.result.pick) room.exclude.add(room.result.pick.id);
  if (kind === 'seen' && room.result && room.result.pick) { engine.markSeen(mem, room.result.pick.id, true); saveDb(); room.exclude = new Set(); }
  let result, analysis = null;
  try {
    const crew = engineCrew(room), cat = activeCatalog(room);
    result = engine.resolve(crew, cat, { exclude: [...room.exclude] }, mem);
    if (!result.empty) { try { analysis = engine.analyzeVerdict(crew, cat, mem, result); } catch (e) {} }
  } catch (e) { broadcast(room, { t: 'notice', msg: e.message || 'Could not settle.' }); return; }
  room.result = result;
  broadcast(room, { t: 'verdict', title: result.empty ? null : result.pick.title, result, analysis });
}

function closeClient(client) {
  const room = client.roomCode && rooms.get(client.roomCode);
  if (!room) return;
  room.clients.delete(client.id);
  if (room.clients.size === 0) { rooms.delete(room.code); return; }
  if (room.hostId === client.id) room.hostId = room.clients.keys().next().value; // promote someone
  presence(room);
}

function handle(client, msg) {
  switch (msg.t) {
    case 'create': {
      let code = roomCode(); while (rooms.has(code)) code = roomCode();
      const room = { code, hostId: client.id, clients: new Map(), pool: msg.pool || null, exclude: new Set(), result: null };
      rooms.set(code, room);
      client.name = (msg.name || '').slice(0, 18); client.avatarIndex = msg.avatarIndex | 0; client.person = msg.person || DEFAULT_PERSON(); client.roomCode = code;
      room.clients.set(client.id, client);
      send(client.sock, { t: 'joined', code, youId: client.id, host: true, room: roomPublic(room) });
      presence(room);
      break;
    }
    case 'join': {
      const room = rooms.get(String(msg.code || '').toUpperCase());
      if (!room) return send(client.sock, { t: 'error', msg: 'No room with that code.' });
      if (room.clients.size >= MAX_ROOM) return send(client.sock, { t: 'error', msg: 'That room is full.' });
      client.name = (msg.name || '').slice(0, 18); client.avatarIndex = msg.avatarIndex | 0; client.person = msg.person || DEFAULT_PERSON(); client.roomCode = room.code;
      room.clients.set(client.id, client);
      send(client.sock, { t: 'joined', code: room.code, youId: client.id, host: room.hostId === client.id, room: roomPublic(room) });
      presence(room);
      break;
    }
    case 'me': {
      const room = rooms.get(client.roomCode); if (!room) return;
      if (typeof msg.name === 'string') client.name = msg.name.slice(0, 18);
      if (typeof msg.avatarIndex === 'number') client.avatarIndex = msg.avatarIndex | 0;
      if (msg.person) client.person = msg.person;
      presence(room);
      break;
    }
    case 'pool': {
      const room = rooms.get(client.roomCode); if (!room || room.hostId !== client.id) return;
      room.pool = msg.pool || null;
      break;
    }
    case 'settle': case 'reroll': case 'seen': {
      const room = rooms.get(client.roomCode); if (!room || room.hostId !== client.id) return;
      doResolve(room, msg.t);
      break;
    }
    case 'lock': {
      const room = rooms.get(client.roomCode);
      if (!room || room.hostId !== client.id || !room.result || room.result.empty) return;
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
      const { who, genre, to } = msg;
      const crew = engineCrew(room).map((p) => ({ ...p, genres: { ...p.genres } }));
      const person = crew.find((p) => p.name === who);
      if (!person) return;
      if (!to || to === 'neutral') delete person.genres[genre]; else person.genres[genre] = to;
      let res;
      try { res = engine.resolve(crew, activeCatalog(room), { exclude: [...room.exclude] }, memFor(room.code)); }
      catch (e) { return; }
      if (res.empty) { send(client.sock, { t: 'whatif', who, genre, to, empty: true }); break; }
      const lh = [...res.explanation.perPerson].sort((a, b) => a.util - b.util)[0];
      send(client.sock, { t: 'whatif', who, genre, to, title: res.pick.title, same: res.pick.id === room.result.pick.id, leastHappy: lh ? { name: lh.name, label: lh.label } : null });
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
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.on('error', () => {});
  sock.setTimeout(0);

  const client = { id: uid(), sock, name: '', avatarIndex: 0, person: null, roomCode: null };
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      let mask;
      if (masked) { if (buf.length < off + 4) break; mask = buf.subarray(off, off + 4); off += 4; }
      if (buf.length < off + len) break; // wait for the rest of the frame
      let payload = buf.subarray(off, off + len);
      if (masked && mask) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out; }
      buf = buf.subarray(off + len);
      if (opcode === 0x8) { closeClient(client); sock.destroy(); return; }         // close
      else if (opcode === 0x9) { try { sock.write(Buffer.from([0x8a, 0])); } catch (e) {} } // ping → pong
      else if (opcode === 0x1) { try { handle(client, JSON.parse(payload.toString('utf8'))); } catch (e) {} } // text
      // (binary / continuation frames are not used by this app)
    }
  });
  sock.on('close', () => closeClient(client));
});

server.listen(PORT, () => console.log(`Standoff live — http://localhost:${PORT}`));
