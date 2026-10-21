'use strict';
/* Realtime verification (zero dependencies): raw WebSocket client + raw HTTP login.
 * Run with the server up:  node socket-test.js
 * Verifies: unauth refused, auth connects, member->VSA call refused, member->GA
 * invite/accept/offer/answer/ice/end signaling. */
const http = require('http');
const crypto = require('crypto');

const HOST = '127.0.0.1', PORT = Number(process.env.PORT || 3000);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let PASS = 0, FAIL = 0;
const T = (n, c, x = '') => { c ? PASS++ : FAIL++; console.log(c ? 'PASS' : 'FAIL', n, x); };

function login(email, password) {
  return new Promise((res) => {
    const r = http.request({
      host: HOST, port: PORT, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    }, (resp) => {
      let d = ''; resp.on('data', (c) => d += c);
      resp.on('end', () => {
        const sc = (resp.headers['set-cookie'] || [])[0];
        res(resp.statusCode === 200 && sc ? sc.split(';')[0] : null);
      });
    });
    r.on('error', () => res(null));
    r.end(JSON.stringify({ email, password }));
  });
}

class MiniWS {
  constructor(cookie) {
    this.cookie = cookie;
    this.handlers = {};
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fail = null;
  }
  on(e, f) { this.handlers[e] = f; }
  connect() {
    return new Promise((resolve) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: HOST, port: PORT, path: '/rt',
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13,
          ...(this.cookie ? { Cookie: this.cookie } : {})
        }
      });
      req.on('upgrade', (res, socket) => {
        const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
        if (res.statusCode !== 101 || res.headers['sec-websocket-accept'] !== expect) {
          this.fail = 'bad handshake'; return resolve(false);
        }
        this.sock = socket;
        socket.on('data', (d) => this._data(d));
        socket.on('close', () => this.handlers.close && this.handlers.close());
        resolve(true);
      });
      req.on('response', (res) => { res.resume(); this.fail = 'HTTP ' + res.statusCode; resolve(false); });
      req.on('error', (e) => { this.fail = e.message; resolve(false); });
      req.end();
    });
  }
  send(e, d) {
    const payload = Buffer.from(JSON.stringify({ e, d: d == null ? null : d }), 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    const len = payload.length;
    if (len < 126) { header = Buffer.from([0x81, 0x80 | len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const masked = Buffer.from(payload.map((x, i) => x ^ mask[i % 4]));
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const payload = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);
      if (op === 8) { this.handlers.close && this.handlers.close(); return; }
      if (op === 9) { continue; }
      if (op === 1 || op === 0) {
        this.frags.push(payload);
        if (fin) {
          try {
            const msg = JSON.parse(Buffer.concat(this.frags).toString('utf8'));
            this.frags = [];
            if (msg && this.handlers[msg.e]) this.handlers[msg.e](msg.d);
          } catch { this.frags = []; }
        }
      }
    }
  }
  close() { try { this.sock && this.sock.destroy(); } catch { } }
}

const wait = (fn, ms = 2500) => new Promise((res) => { let done = false; fn((v) => { if (!done) { done = true; res(v); } }); setTimeout(() => { if (!done) { done = true; res(null); } }, ms); });

(async () => {
  // 1. unauthenticated upgrade must be refused
  const anon = new MiniWS(null);
  const anonOK = await anon.connect();
  T('unauth socket refused', !anonOK, anon.fail || '');

  const memCk = await login(process.env.TEST_MEMBER_EMAIL || '', process.env.TEST_MEMBER_PW || '');
  const gaCk = await login(process.env.TEST_GA_EMAIL || '', process.env.TEST_GA_PW || '');
  const vsaCk = await login(process.env.TEST_VSA_EMAIL || '', process.env.TEST_VSA_PW || '');
  if (!memCk || !gaCk || !vsaCk) {
    console.log('\nSet TEST_MEMBER_EMAIL/TEST_MEMBER_PW, TEST_GA_EMAIL/TEST_GA_PW, and TEST_VSA_EMAIL/TEST_VSA_PW for provisioned accounts.');
    process.exit(2);
  }

  const sMem = new MiniWS(memCk), sGa = new MiniWS(gaCk), sVsa = new MiniWS(vsaCk);
  T('authenticated sockets connect', (await sMem.connect()) && (await sGa.connect()) && (await sVsa.connect()));

  const refuse = await wait((done) => {
    sMem.on('call:error', (d) => done(d && d.error));
    sMem.send('call:invite', { to: 1 });
  });
  T('member -> VSA call refused', /only work between/.test(refuse || ''), refuse || '');

  const incoming = await wait((done) => {
    sGa.on('call:incoming', (d) => done(d));
    sMem.send('call:invite', { to: 3 });
  });
  T('member -> GA invite delivered', !!(incoming && incoming.from && incoming.from.id === 4));

  const accepted = await wait((done) => { sMem.on('call:accepted', () => done(true)); sGa.send('call:accept', { to: 4 }); });
  const gotOffer = await wait((done) => { sGa.on('call:offer', (d) => done(!!d.sdp)); sMem.send('call:offer', { to: 3, sdp: { type: 'offer', sdp: 'x' } }); });
  const gotAnswer = await wait((done) => { sMem.on('call:answer', (d) => done(!!d.sdp)); sGa.send('call:answer', { to: 4, sdp: { type: 'answer', sdp: 'x' } }); });
  const gotIce = await wait((done) => { sGa.on('call:ice', (d) => done(!!d.candidate)); sMem.send('call:ice', { to: 3, candidate: { candidate: 'c' } }); });
  T('accept/offer/answer/ice signaling', !!(accepted && gotOffer && gotAnswer && gotIce),
    `accept=${accepted} offer=${gotOffer} answer=${gotAnswer} ice=${gotIce}`);

  const ended = await wait((done) => { sGa.on('call:ended', (d) => done(d && d.reason)); sMem.send('call:end', { to: 3 }); });
  T('call end relayed', ended === 'ended', ended || '');

  [sMem, sGa, sVsa].forEach((s) => s.close());
  console.log(`\nSOCKET TESTS: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
})();
