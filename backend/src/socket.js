'use strict';
/* Authenticated and policy-checked WebSocket chat/call signaling. */
const dbm = require('./db');
const sec = require('./security');
const policy = require('./chat-policy');
const chatRetention = require('./chat-retention');

function parseCookies(header) {
  const out = {};
  for (const item of String(header || '').split(';')) {
    const index = item.indexOf('=');
    if (index > 0) {
      try { out[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim()); } catch {}
    }
  }
  return out;
}

function originAllowed(headers) {
  const host = String(headers.host || '').toLowerCase();
  const proto = String(headers['x-forwarded-proto'] || (process.env.NODE_ENV === 'production' ? 'https' : 'http')).split(',')[0].trim().toLowerCase();
  if (!host || !['https', 'http'].includes(proto)) return false;
  if (process.env.NODE_ENV === 'production' && proto !== 'https') return false;
  return sec.originAllowed(headers.origin, host, proto);
}

function logDenied(user, action, target = '') {
  dbm.audit(user || null, action, String(target).slice(0, 80), null);
}

function socketAccountActive(user) {
  if (!user || user.deleted || user.disabled) return false;
  const group = user.groupId && dbm.db.groups.find(entry => entry.id === user.groupId);
  return !(group && group.suspended && user.role !== 'v_super_admin');
}

module.exports = function attachChatSocket(hub) {
  const calls = new Map();
  const userEventCounters = new Map();
  const typingAt = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of userEventCounters) if (now - entry.start >= 60e3) userEventCounters.delete(key);
    for (const [id, time] of typingAt) if (now - time >= 60e3) typingAt.delete(id);
  }, 60e3).unref();
  const callKey = (a, b) => [Number(a), Number(b)].sort((x, y) => x - y).join(':');

  hub.use((socket, next) => {
    const headers = socket.handshake.headers;
    if (!originAllowed(headers)) {
      logDenied(null, 'chat.ws.origin.denied');
      return next(new Error('origin denied'));
    }
    const sid = parseCookies(headers.cookie).sid;
    if (!sid || !/^[0-9a-f]{64}$/.test(sid)) {
      logDenied(null, 'chat.ws.auth.denied');
      return next(new Error('unauthorized'));
    }
    const session = dbm.db.sessions.find(entry => entry.token === sid && entry.expires > Date.now());
    const user = session && dbm.db.users.find(entry => entry.id === session.userId && !entry.deleted && !entry.disabled);
    if (!session || !socketAccountActive(user)) {
      logDenied(user, 'chat.ws.auth.denied');
      return next(new Error('unauthorized'));
    }
    const maxConnections = Number(process.env.WS_MAX_CONNECTIONS || 1000);
    if (!Number.isInteger(maxConnections) || maxConnections < 1 || hub.socks.size >= maxConnections) {
      logDenied(user, 'chat.ws.server.connection.limit');
      return next(new Error('connection limit'));
    }
    const existing = hub.byUser.get(user.id);
    if (existing && existing.size >= 4) {
      logDenied(user, 'chat.ws.connection.limit');
      return next(new Error('connection limit'));
    }
    socket.sessionToken = sid;
    socket.user = user;
    socket.chatSnapshot = { userId: user.id, role: user.role, groupId: user.groupId || null };
    next();
  });

  hub.onConnection(socket => {
    const initial = socket.chatSnapshot;
    const setTimeoutWindow = 60e3;
    function liveUser() {
      const session = dbm.db.sessions.find(entry => entry.token === socket.sessionToken && entry.expires > Date.now());
      const user = dbm.db.users.find(entry => entry.id === initial.userId && !entry.deleted && !entry.disabled);
      const unchanged = user && user.role === initial.role && (user.groupId || null) === initial.groupId;
      if (!session || !unchanged || !socketAccountActive(user)) {
        if (!socket.closed && !socket.revoking) {
          logDenied(user, 'chat.ws.access.revoked', `user #${initial.userId}`);
          socket.revoke('access changed');
        }
        return null;
      }
      socket.user = user;
      return user;
    }

    function rateAllowed(event, max) {
      const now = Date.now();
      const key = `${initial.userId}:${event}`;
      let bucket = userEventCounters.get(key);
      if (!bucket || now - bucket.start >= setTimeoutWindow) { bucket = { start: now, count: 0 }; userEventCounters.set(key, bucket); }
      bucket.count++;
      if (bucket.count <= max) return true;
      logDenied(socket.user, 'chat.ws.rate.denied', event);
      socket.send('chat:error', { error: 'Too many realtime events. Slow down.' });
      if (bucket.count > max * 2) socket.close();
      return false;
    }

    socket.on('rateLimit', count => {
      logDenied(socket.user, 'chat.ws.rate.denied', `events=${count}`);
      socket.send('chat:error', { error: 'Too many realtime events.' });
    });
    socket.on('unknown', event => {
      if (!rateAllowed('chat:unknown', 20)) return;
      logDenied(liveUser(), 'chat.ws.event.denied', String(event).slice(0, 48));
      socket.send('chat:error', { error: 'Unsupported realtime event.' });
    });

    function peerFor(id, event) {
      const me = liveUser();
      if (!me) return null;
      const peer = dbm.db.users.find(user => user.id === Number(id));
      if (!policy.pairOK(me, peer)) {
        logDenied(me, `chat.ws.${event}.denied`, `peer #${String(id || '').slice(0, 24)}`);
        return null;
      }
      return peer;
    }

    socket.on('chat:typing', data => {
      if (!rateAllowed('chat:typing', 40)) return;
      const peer = peerFor(data && data.to, 'typing');
      if (!peer) return;
      const now = Date.now();
      if (now - (typingAt.get(socket.user.id) || 0) < 1500) return;
      typingAt.set(socket.user.id, now);
      hub.emitTo(peer.id, 'chat:typing', { from: socket.user.id });
    });

    socket.on('call:invite', data => {
      if (!rateAllowed('call:invite', 20)) return;
      const peer = peerFor(data && data.to, 'call.invite');
      if (!peer) return socket.send('call:error', { error: 'That contact is not available.' });
      const key = callKey(socket.user.id, peer.id);
      if (calls.has(key)) return socket.send('call:error', { error: 'A call is already active.' });
      calls.set(key, { a: socket.user.id, b: peer.id, startedAt: Date.now() });
      hub.emitTo(peer.id, 'call:incoming', { from: { id: socket.user.id, name: `${socket.user.firstName} ${socket.user.lastName}`, pic: socket.user.pic || null } });
      dbm.audit(socket.user, 'call.invite', `peer #${peer.id}`, null);
    });

    function relay(data, event, payload) {
      if (!rateAllowed(event, event.startsWith('call:ice') ? 120 : 30)) return;
      const peer = peerFor(data && data.to, event.replace(':', '.'));
      if (!peer) return;
      const key = callKey(socket.user.id, peer.id);
      if (!calls.has(key)) {
        logDenied(socket.user, 'call.signal.denied', `peer #${peer.id}`);
        return;
      }
      const call = calls.get(key);
      if (Date.now() - call.startedAt > 20 * 60e3) {
        calls.delete(key);
        logDenied(socket.user, 'call.signal.expired', `peer #${peer.id}`);
        return;
      }
      const content = payload(data || {});
      if (!content) {
        logDenied(socket.user, 'call.signal.malformed', `peer #${peer.id}`);
        socket.send('call:error', { error: 'Invalid call signal.' });
        return;
      }
      hub.emitTo(peer.id, event, { from: socket.user.id, ...content });
    }

    socket.on('call:accept', data => relay(data, 'call:accepted', () => ({})));
    socket.on('call:offer', data => relay(data, 'call:offer', input => typeof input.sdp === 'string' && input.sdp.length <= 32768 && input.sdp.startsWith('v=0') ? { sdp: input.sdp } : null));
    socket.on('call:answer', data => relay(data, 'call:answer', input => typeof input.sdp === 'string' && input.sdp.length <= 32768 && input.sdp.startsWith('v=0') ? { sdp: input.sdp } : null));
    socket.on('call:ice', data => relay(data, 'call:ice', input => {
      const candidate = input.candidate;
      return candidate && typeof candidate === 'object' && JSON.stringify(candidate).length <= 4096 ? { candidate } : null;
    }));

    function endCall(otherId, reason) {
      if (!liveUser()) return;
      const peer = dbm.db.users.find(user => user.id === Number(otherId));
      const key = peer ? callKey(socket.user.id, peer.id) : null;
      if (!key || !calls.has(key)) {
        logDenied(socket.user, 'call.end.denied', `peer #${String(otherId || '').slice(0, 24)}`);
        return;
      }
      calls.delete(key);
      socket.send('call:ended', { reason });
      if (policy.pairOK(socket.user, peer)) hub.emitTo(peer.id, 'call:ended', { reason });
      dbm.audit(socket.user, 'call.end', `peer #${peer.id}`, null);
    }
    socket.on('call:decline', data => endCall(data && data.to, 'declined'));
    socket.on('call:end', data => endCall(data && data.to, 'ended'));
    socket.on('disconnect', () => {
      for (const [key, call] of Array.from(calls)) {
        if (call.a === initial.userId || call.b === initial.userId) {
          calls.delete(key);
          const otherId = call.a === initial.userId ? call.b : call.a;
          const other = dbm.db.users.find(user => user.id === otherId);
          if (other && policy.pairOK(socket.user, other)) hub.emitTo(otherId, 'call:ended', { reason: 'peer disconnected' });
        }
      }
    });
  });

  const revalidate = setInterval(() => {
    for (const socket of Array.from(hub.socks)) {
      const snapshot = socket.chatSnapshot;
      if (!snapshot) continue;
      const session = dbm.db.sessions.find(entry => entry.token === socket.sessionToken && entry.expires > Date.now());
      const user = dbm.db.users.find(entry => entry.id === snapshot.userId && !entry.deleted && !entry.disabled);
      if (!session || !socketAccountActive(user) || user.role !== snapshot.role || (user.groupId || null) !== snapshot.groupId) {
        if (!socket.closed && !socket.revoking) {
          logDenied(user, 'chat.ws.access.revoked', `user #${snapshot.userId}`);
          socket.revoke('access changed');
        }
      }
    }
  }, 2000);
  revalidate.unref();

  chatRetention.days();
  const retention = setInterval(() => {
    try { chatRetention.purge(); } catch (error) { console.error('[chat retention] purge failed:', error.message); }
  }, 24 * 60 * 60e3);
  retention.unref();
};
