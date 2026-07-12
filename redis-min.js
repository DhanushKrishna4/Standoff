/* =============================================================================
 * redis-min.js — a tiny, dependency-free Redis (RESP) client for cross-instance
 * scale-out (item 27). Pure Node net/tls — no npm client — in keeping with the
 * rest of the server (which hand-rolls its own WebSocket).
 *
 * It provides exactly what the live-rooms layer needs to fan a broadcast out to
 * sibling instances behind a load balancer: PUBLISH / SUBSCRIBE, plus small
 * key ops (SET/GET/DEL/EXPIRE) for shared bookkeeping. It is OPT-IN: the server
 * only uses it when REDIS_URL is set, and falls back to pure in-memory rooms
 * otherwise, so the single-instance deploy is unchanged and dependency-free.
 *
 * The RESP wire codec (the bug-prone part) is exported and unit-tested against
 * the protocol spec in redis-min.test.js; the socket wiring is deliberately thin.
 * ========================================================================== */
'use strict';
const net = require('net');
let tls; try { tls = require('tls'); } catch (e) { tls = null; }

// ---- RESP codec --------------------------------------------------------------
// Encode a command as a RESP array of bulk strings: *N\r\n$len\r\narg\r\n…
function encodeCommand(args) {
  const parts = ['*' + args.length + '\r\n'];
  for (const a of args) {
    const s = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
    parts.push('$' + s.length + '\r\n', s, '\r\n');
  }
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
}

// A streaming reply parser. feed(chunk) returns an array of the complete replies
// that chunk finished (simple strings, errors, integers, bulk strings, arrays).
function createParser() {
  let buf = Buffer.alloc(0);
  function parseAt(b, i) {
    if (i >= b.length) return null;
    const type = b[i];
    const idx = b.indexOf('\r\n', i + 1);
    if (idx === -1) return null;
    const head = b.subarray(i + 1, idx).toString();
    const afterLine = idx + 2;
    if (type === 0x2b) return { val: head, next: afterLine };              // +simple string
    if (type === 0x2d) return { val: new Error(head), next: afterLine };   // -error
    if (type === 0x3a) return { val: Number(head), next: afterLine };      // :integer
    if (type === 0x24) {                                                   // $bulk string
      const len = Number(head);
      if (len === -1) return { val: null, next: afterLine };
      if (b.length < afterLine + len + 2) return null;
      return { val: b.subarray(afterLine, afterLine + len).toString(), next: afterLine + len + 2 };
    }
    if (type === 0x2a) {                                                   // *array
      const n = Number(head);
      if (n === -1) return { val: null, next: afterLine };
      const arr = []; let cur = afterLine;
      for (let k = 0; k < n; k++) { const r = parseAt(b, cur); if (!r) return null; arr.push(r.val); cur = r.next; }
      return { val: arr, next: cur };
    }
    return { val: null, next: afterLine };
  }
  return {
    feed(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const out = [];
      for (;;) { const r = parseAt(buf, 0); if (!r) break; out.push(r.val); buf = buf.subarray(r.next); }
      return out;
    },
  };
}

// ---- the bus -----------------------------------------------------------------
// Two connections (Redis requires a dedicated one for SUBSCRIBE mode): `pub` for
// request/reply commands (PUBLISH + GET/SET/DEL), `sub` for the message stream.
// The pub connection is a proper request/reply client — replies resolve pending
// commands in FIFO order (Redis guarantees reply order) — so GET returns a value.
// Both connections auto-reconnect with backoff; pending commands reject on a drop.
class RedisBus {
  constructor(url, onMessage, log) {
    this.url = url;
    this.onMessage = onMessage || (() => {});
    this.log = log || (() => {});
    this.channels = new Set();
    this.pending = [];      // FIFO of {resolve,reject} awaiting a pub-connection reply
    this.preConnect = [];   // commands queued before the pub socket is ready
    this.pub = this._open(false);
    this.sub = this._open(true);
  }
  _endpoint() {
    const u = new URL(this.url);
    return { host: u.hostname, port: Number(u.port) || 6379, tls: u.protocol === 'rediss:', user: decodeURIComponent(u.username || ''), pass: decodeURIComponent(u.password || '') };
  }
  _open(isSub) {
    const ep = this._endpoint();
    const conn = { sock: null, parser: createParser(), retries: 0, closed: false, connected: false };
    const dial = () => {
      if (conn.closed) return;
      const sock = ep.tls && tls ? tls.connect({ host: ep.host, port: ep.port, servername: ep.host }) : net.connect({ host: ep.host, port: ep.port });
      conn.sock = sock;
      sock.setNoDelay(true);
      sock.on(ep.tls ? 'secureConnect' : 'connect', () => {
        conn.retries = 0; conn.connected = true;
        if (!isSub) {
          if (ep.pass) { this.pending.push({ resolve: () => {}, reject: () => {} }); sock.write(encodeCommand(ep.user ? ['AUTH', ep.user, ep.pass] : ['AUTH', ep.pass])); }
          const q = this.preConnect.splice(0);
          for (const item of q) { this.pending.push({ resolve: item.resolve, reject: item.reject }); try { sock.write(encodeCommand(item.args)); } catch (e) { item.reject(e); } }
        } else {
          if (ep.pass) sock.write(encodeCommand(ep.user ? ['AUTH', ep.user, ep.pass] : ['AUTH', ep.pass]));
          for (const ch of this.channels) sock.write(encodeCommand(['SUBSCRIBE', ch]));
        }
      });
      sock.on('data', (chunk) => {
        for (const reply of conn.parser.feed(chunk)) {
          if (isSub) { if (Array.isArray(reply) && reply[0] === 'message') this.onMessage(reply[1], reply[2]); }
          else { const p = this.pending.shift(); if (p) { reply instanceof Error ? p.reject(reply) : p.resolve(reply); } }
        }
      });
      const retry = () => {
        conn.connected = false;
        if (!isSub) { const drop = this.pending.splice(0); for (const p of drop) p.reject(new Error('redis connection lost')); }
        if (conn.closed) return;
        conn.retries++;
        setTimeout(dial, Math.min(500 * conn.retries, 5000));
      };
      sock.on('error', (e) => { this.log('redis error: ' + (e && e.message)); });
      sock.on('close', retry);
    };
    dial();
    return conn;
  }
  // request/reply on the pub connection
  cmd(args) {
    return new Promise((resolve, reject) => {
      const conn = this.pub;
      if (conn.connected && conn.sock && conn.sock.writable) { this.pending.push({ resolve, reject }); try { conn.sock.write(encodeCommand(args)); } catch (e) { this.pending.pop(); reject(e); } }
      else this.preConnect.push({ args, resolve, reject });
    });
  }
  publish(channel, message) { this.cmd(['PUBLISH', channel, message]).catch(() => {}); }
  set(key, val, ttlSec) { return this.cmd(ttlSec ? ['SET', key, val, 'EX', String(ttlSec)] : ['SET', key, val]).catch(() => null); }
  get(key) { return this.cmd(['GET', key]).catch(() => null); }
  del(key) { return this.cmd(['DEL', key]).catch(() => null); }
  subscribe(channel) { this.channels.add(channel); try { if (this.sub.sock && this.sub.connected) this.sub.sock.write(encodeCommand(['SUBSCRIBE', channel])); } catch (e) {} }
  close() { this.pub.closed = this.sub.closed = true; try { this.pub.sock && this.pub.sock.destroy(); } catch (e) {} try { this.sub.sock && this.sub.sock.destroy(); } catch (e) {} }
}

module.exports = { encodeCommand, createParser, RedisBus };
