'use strict';
/* Server-authorized E2E chat. Conversation eligibility is centralized in chat-policy. */
const dbm = require('../db');
const sec = require('../security');
const hub = require('../hub');
const policy = require('../chat-policy');
const retention = require('../chat-retention');
const { Router } = require('../httpmini');

const r = new Router();
r.use(sec.auth);
const sendHits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of sendHits) if (now >= entry.reset) sendHits.delete(userId);
}, 60e3).unref();

function chatSendLimiter(req, res, next) {
  const now = Date.now();
  let entry = sendHits.get(req.user.id);
  if (!entry || now >= entry.reset) entry = { count: 0, reset: now + 60e3 };
  entry.count++;
  sendHits.set(req.user.id, entry);
  if (entry.count > 60) {
    dbm.audit(req.user, 'chat.send.rate.denied', 'per-user limit', req);
    res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
    return res.status(429).json({ error: 'Too many chat messages. Try again shortly.' });
  }
  next();
}

function isBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

r.get('/contacts', (req, res) => {
  const contacts = policy.contactsFor(req.user);
  dbm.audit(req.user, 'chat.contacts.read', `count=${contacts.length}`, req);
  res.json({ contacts });
});

r.get('/with/:id', (req, res) => {
  const peer = dbm.db.users.find(user => user.id === Number(req.params.id));
  if (!policy.pairOK(req.user, peer)) {
    dbm.audit(req.user, 'chat.read.denied', `peer #${String(req.params.id).slice(0, 24)}`, req);
    return res.status(404).json({ error: 'Conversation is unavailable.' });
  }
  const cutoff = retention.cutoff();
  const a = req.user.id, b = peer.id;
  const messages = dbm.db.messages
    .filter(message => Date.parse(message.at) >= cutoff && ((message.senderId === a && message.recipientId === b) || (message.senderId === b && message.recipientId === a)))
    .slice(-300)
    .map(message => ({ id: message.id, from: message.senderId, to: message.recipientId, iv: message.iv, ct: message.ct, at: message.at }));
  dbm.audit(req.user, 'chat.history.read', `peer #${peer.id}; count=${messages.length}`, req);
  return res.json({ peer: { id: peer.id, name: `${peer.firstName} ${peer.lastName}`, pic: peer.pic || null, role: peer.role, pub: peer.ecdhPub || null }, messages });
});

r.post('/send', chatSendLimiter, (req, res) => {
  const peer = dbm.db.users.find(user => user.id === Number((req.body || {}).peerId));
  if (!policy.pairOK(req.user, peer)) {
    dbm.audit(req.user, 'chat.send.denied', `peer #${String((req.body || {}).peerId || '').slice(0, 24)}`, req);
    return res.status(403).json({ error: 'Not an allowed chat partner.' });
  }
  const iv = String((req.body || {}).iv || '');
  const ciphertext = String((req.body || {}).ct || '');
  if (!/^[A-Za-z0-9+/]{16}$/.test(iv) || ciphertext.length < 24 || ciphertext.length > 32000 || !isBase64(ciphertext)) {
    dbm.audit(req.user, 'chat.send.denied', 'malformed encrypted payload', req);
    return res.status(400).json({ error: 'Malformed encrypted payload.' });
  }
  const message = dbm.add('messages', 'message', {
    senderId: req.user.id, recipientId: peer.id, iv, ct: ciphertext, at: new Date().toISOString()
  });
  dbm.audit(req.user, 'chat.message.sent', `peer #${peer.id}; message #${message.id}`, req);
  hub.emitTo(peer.id, 'chat:new', { from: req.user.id, id: message.id });
  hub.emitTo(req.user.id, 'chat:new', { from: req.user.id, id: message.id, echo: true });
  return res.status(201).json({ ok: true, id: message.id });
});

module.exports = r;
