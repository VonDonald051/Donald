'use strict';
/* Zero-dependency SMTP client (AUTH LOGIN, optional STARTTLS or implicit TLS)
 * so email notifications work without nodemailer. If SMTP is not configured,
 * messages are silently skipped (they still land in the VSA Email Outbox). */
const net = require('net');
const tls = require('tls');

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

function readLine(sock) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString('utf8');
      const idx = buf.indexOf('\r\n');
      if (idx >= 0) { sock.off('data', onData); resolve(buf.slice(0, idx)); }
    };
    const onErr = (e) => { sock.off('data', onData); reject(e); };
    sock.on('data', onData);
    sock.once('error', onErr);
  });
}

async function smtpReply(sock, write) {
  if (write != null) sock.write(write + '\r\n');
  // SMTP replies can be multi-line: "250-..." until "250 text"
  let line, all = '';
  for (;;) {
    line = await readLine(sock);
    all += line + '\n';
    if (/^\d{3} /.test(line)) return { code: Number(line.slice(0, 3)), text: all.trim() };
  }
}

function dotStuff(text) {
  return String(text).split(/\r?\n/).map(l => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
}

async function sendSmtp({ host, port, secure, requireTls = false, user, pass, from, to, subject, text, timeoutMs = 12000 }) {
  return new Promise((resolve) => {
    let sock;
    const done = (ok, info) => { try { sock && sock.destroy(); } catch {} resolve({ ok, info }); };
    const timer = setTimeout(() => done(false, 'smtp timeout'), timeoutMs);
    const finish = (ok, info) => { clearTimeout(timer); done(ok, info); };

    try {
      sock = secure
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });
    } catch (e) { return finish(false, e.message); }
    sock.once('error', (e) => finish(false, e.message));

    const run = async () => {
      let r = await smtpReply(sock);                       // 220 banner
      if (r.code !== 220) throw new Error('banner ' + r.text);
      r = await smtpReply(sock, `EHLO vondonald.local`);
      if (r.code !== 250) throw new Error('EHLO ' + r.text);

      if (!secure && /STARTTLS/i.test(r.text)) {
        r = await smtpReply(sock, 'STARTTLS');
        if (r.code === 220) {
          sock = tls.connect({ socket: sock, servername: host });
          r = await smtpReply(sock, `EHLO vondonald.local`);
        } else if (requireTls) throw new Error('SMTP server refused STARTTLS; refusing plaintext delivery');
      } else if (!secure && requireTls) {
        throw new Error('SMTP server does not advertise STARTTLS; refusing plaintext delivery');
      }
      if (user) {
        r = await smtpReply(sock, 'AUTH LOGIN');
        if (r.code !== 334) throw new Error('AUTH ' + r.text);
        r = await smtpReply(sock, b64(user));
        if (r.code !== 334) throw new Error('user ' + r.text);
        r = await smtpReply(sock, b64(pass || ''));
        if (r.code !== 235) throw new Error('auth failed: ' + r.text);
      }
      const fromAddr = (from.match(/<(.+?)>/) || [null, from])[1];
      r = await smtpReply(sock, `MAIL FROM:<${fromAddr}>`);
      if (r.code !== 250) throw new Error('MAIL FROM ' + r.text);
      r = await smtpReply(sock, `RCPT TO:<${to}>`);
      if (r.code !== 250 && r.code !== 251) throw new Error('RCPT ' + r.text);
      r = await smtpReply(sock, 'DATA');
      if (r.code !== 354) throw new Error('DATA ' + r.text);
      const msg =
        `From: ${from}\r\nTo: ${to}\r\nSubject: =?UTF-8?B?${b64(subject)}?=\r\n` +
        `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n` +
        `Content-Transfer-Encoding: 8bit\r\nDate: ${new Date().toUTCString()}\r\n\r\n` +
        dotStuff(text) + '\r\n.';
      r = await smtpReply(sock, msg);
      if (r.code !== 250) throw new Error('body ' + r.text);
      try { await smtpReply(sock, 'QUIT'); } catch {}
      return true;
    };

    run().then(() => finish(true, 'sent')).catch((e) => finish(false, e.message));
  });
}

/* config from env: SMTP_URL (smtp[s]://user:pass@host:port) or discrete SMTP_HOST/PORT/SECURE/USER/PASS */
function smtpConfig() {
  const from = process.env.MAIL_FROM || 'VonDonald051 Savings <no-reply@vondonald.local>';
  try {
    if (process.env.SMTP_URL) {
      const u = new URL(process.env.SMTP_URL);
      return {
        host: u.hostname, port: Number(u.port || (u.protocol === 'smtps:' ? 465 : 587)),
        secure: u.protocol === 'smtps:',
        user: decodeURIComponent(u.username || ''), pass: decodeURIComponent(u.password || ''), from
      };
    }
    if (process.env.SMTP_HOST) {
      return {
        host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === '1',
        user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '', from
      };
    }
  } catch (e) { console.error('[mail] config error:', e.message); }
  return null;
}

async function sendMail(to, subject, text) {
  const cfg = smtpConfig();
  if (!cfg) return { ok: false, info: 'no SMTP configured' };
  const r = await sendSmtp({ ...cfg, requireTls: process.env.NODE_ENV === 'production', to, subject, text });
  if (!r.ok) console.error('[mail] send failed:', r.info);
  return r.ok;
}

function mode() {
  const cfg = smtpConfig();
  return cfg ? `SMTP live (${cfg.host}:${cfg.port})` : 'no SMTP configured — emails captured in V Super Admin Email Outbox';
}

module.exports = { sendMail, mode };
