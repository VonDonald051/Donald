'use strict';
/* Zero-dependency WebSocket (RFC 6455) server for realtime chat delivery +
 * video-call signaling. JSON envelopes {e: event, d: data}, auth middleware
 * on the upgrade handshake, per-user routing (hub.emitTo / hub.to('u:id').emit). */
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptKey = (key) => crypto.createHash('sha1').update(key + GUID).digest('base64');
const MAX_PAYLOAD = 64 * 1024;

class WSSock {
  constructor(socket, hub) {
    this.socket = socket;
    this.hub = hub;
    this.handlers = {};
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragBytes = 0;
    this.closed = false;
    this.revoking = false;
    this.user = null;
    this.sessionToken = null;
    this.chatSnapshot = null;
    this.messageWindow = { start: Date.now(), count: 0 };
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._close());
    socket.on('error', () => this._close());
    socket.setNoDelay(true);
  }

  on(event, fn) { this.handlers[event] = fn; }
  send(event, data) { this._frame(0x1, Buffer.from(JSON.stringify({ e: event, d: data == null ? null : data }), 'utf8')); }
  close() {
    if (this.closed || this.revoking) return;
    this.revoking = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(1001, 0);
    this._frame(0x8, payload);
    this.socket.end();
    const timer = setTimeout(() => this._close(), 1000);
    timer.unref();
  }
  revoke(reason = 'access changed') {
    this.send('auth:revoked', { reason });
    this.close();
  }

  _frame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.from([0x80 | op, len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([header, payload])); } catch { this._close(); }
  }

  _onData(d) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80);
      if (b[0] & 0x70) return this._close();
      const op = b[0] & 0x0f;
      const masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_PAYLOAD) return this._close();
      if (!masked || ((op & 0x08) && (!fin || len > 125))) return this._close();
      if (this.fragBytes + len > MAX_PAYLOAD) return this._close();
      const maskOff = off;
      if (masked) off += 4;
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (masked) {
        const m = b.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload.map((x, i) => x ^ m[i % 4]));
      }
      this.buf = b.subarray(off + len);

      if (op === 0x8) { this._frame(0x8, Buffer.alloc(0)); return this._close(); } // close
      if (op === 0x9) { this._frame(0xA, payload); continue; }                   // ping -> pong
      if (op === 0xA) continue;                                                  // pong
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.frags.push(payload);
        this.fragBytes += payload.length;
        if (fin) { this._message(Buffer.concat(this.frags)); this.frags = []; this.fragBytes = 0; }
      }
    }
  }

  _message(payload) {
    const now = Date.now();
    if (now - this.messageWindow.start >= 60e3) this.messageWindow = { start: now, count: 0 };
    this.messageWindow.count++;
    if (this.messageWindow.count > 180) {
      if (this.handlers.rateLimit) { try { this.handlers.rateLimit(this.messageWindow.count); } catch {} }
      if (this.messageWindow.count > 360) this.close();
      return;
    }
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (!msg || typeof msg.e !== 'string') return;
    const fn = this.handlers[msg.e];
    if (fn) { try { fn(msg.d); } catch (e) { console.error('[ws]', e.message); } }
    else if (this.handlers.unknown) { try { this.handlers.unknown(msg.e, msg.d); } catch {} }
  }

  _close() {
    if (this.closed) return;
    this.closed = true; this.revoking = true;
    const fn = this.handlers.disconnect;
    if (fn) { try { fn(); } catch { } }
    try { this.socket.destroy(); } catch { }
    this.hub._drop(this);
  }
}

class Hub {
  constructor() {
    this.socks = new Set();
    this.byUser = new Map(); // userId -> Set(WSSock)
    this.useFns = [];
    this.connFn = null;
  }
  use(fn) { this.useFns.push(fn); }
  onConnection(fn) { this.connFn = fn; }

  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      const reject = () => {
        try {
          socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nunauthorized');
          socket.destroy();
        } catch { }
      };
      if (req.url.split('?')[0] !== '/rt') return reject();
      if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return reject();
      if (!String(req.headers.connection || '').toLowerCase().split(/\s*,\s*/).includes('upgrade')) return reject();
      if (String(req.headers['sec-websocket-version'] || '') !== '13') return reject();
      const key = req.headers['sec-websocket-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) return reject();

      const stub = { handshake: { headers: req.headers }, user: null };
      let i = 0;
      const runMW = (err) => {
        if (err) return reject();
        const fn = this.useFns[i++];
        if (!fn) return accept();
        try { fn(stub, runMW); } catch { reject(); }
      };
      const accept = () => {
        try {
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n');
        } catch { return; }
        const ws = new WSSock(socket, this);
        ws.user = stub.user;
        ws.sessionToken = stub.sessionToken;
        ws.chatSnapshot = stub.chatSnapshot;
        this.socks.add(ws);
        if (ws.user) {
          const id = ws.user.id;
          let set = this.byUser.get(id);
          if (!set) { set = new Set(); this.byUser.set(id, set); }
          set.add(ws);
        }
        if (head && head.length) ws._onData(head);
        if (this.connFn) { try { this.connFn(ws); } catch (e) { console.error('[ws]', e.message); } }
      };
      runMW();
    });
  }

  emitTo(userId, event, data) {
    const set = this.byUser.get(Number(userId));
    if (set) for (const s of set) s.send(event, data);
  }
  revokeSession(token) {
    for (const socket of Array.from(this.socks)) if (socket.sessionToken === token) socket.revoke('session ended');
  }
  revokeUser(userId) {
    const set = this.byUser.get(Number(userId));
    if (set) for (const socket of Array.from(set)) socket.revoke('account access changed');
  }
  revokeGroup(groupId) {
    for (const socket of Array.from(this.socks)) if (socket.chatSnapshot && Number(socket.chatSnapshot.groupId) === Number(groupId)) socket.revoke('group access changed');
  }
  revokeUserExceptSession(userId, token) {
    const set = this.byUser.get(Number(userId));
    if (set) for (const socket of Array.from(set)) if (socket.sessionToken !== token) socket.revoke('session ended');
  }
  broadcast(event, data) { for (const socket of this.socks) socket.send(event, data); }
  close() { for (const socket of this.socks) socket.close(); }
  to(room) { const id = Number(String(room).replace(/^u:/, '')); return { emit: (e, d) => this.emitTo(id, e, d) }; }
  _drop(ws) {
    this.socks.delete(ws);
    if (ws.user) {
      const set = this.byUser.get(ws.user.id);
      if (set) { set.delete(ws); if (!set.size) this.byUser.delete(ws.user.id); }
    }
  }
}

module.exports = { Hub };
