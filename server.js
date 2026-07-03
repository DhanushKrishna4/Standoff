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
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DATA_FILE = path.join(ROOT, '.standoff-rooms.json');
const MAX_ROOM = 8;

// ---- per-room fairness memory, persisted to disk -----------------------------
let db = {};
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {}; } catch (e) {}
let saveTimer = null;
const saveDb = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) {} }, 200); };
const memFor = (code) => (db[code] = db[code] || { cumulative: {}, debt: {}, history: [], seen: [], nights: 0 });

// ---- static files (no-cache, path-guarded) -----------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.py': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/' || u.startsWith('/room/') || u.startsWith('/join')) u = '/index.html'; // pretty routes → app
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

const DEFAULT_PERSON = () => ({ name: '', genres: {}, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 }, runtimeCap: 999 });
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
    return { name: n, genres: p.genres || {}, mood: p.mood || DEFAULT_PERSON().mood, runtimeCap: p.runtimeCap == null ? 999 : p.runtimeCap };
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
