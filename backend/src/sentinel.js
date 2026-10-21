'use strict';
/* Sentinel: lightweight authz event logger for IDOR and access-control monitoring.
 * Emits authz_denied events on any cross-user data access attempt. */
const fs = require('fs');
const path = require('path');
const dbm = require('./db');
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const alertCooldown = new Map();

const FILE = path.join(dbm.DIR, 'sentinel.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { events: [] }; }
}
function save(obj) {
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(FILE + '.tmp', FILE);
    fs.chmodSync(FILE, 0o600);
  } catch {}
}

function reset() { save({ events: [] }); }

function emit(type, req, detail) {
  const s = load();
  const evt = {
    id: (s.events.length ? s.events[s.events.length - 1].id + 1 : 1),
    type, at: new Date().toISOString(),
    userId: req && req.user ? req.user.id : null,
    userRole: req && req.user ? req.user.role : null,
    ip: req ? String(req.ip || req.socket.remoteAddress || '') : '',
    detail: String(detail || '').slice(0, 200)
  };
  s.events.push(evt);
  if (s.events.length > 5000) s.events = s.events.slice(-5000);
  save(s);
  try { dbm.audit(req && req.user, 'sentinel.' + type, evt.detail, req); } catch {}
  if (type === 'authz_denied') {
    const key = `${type}:${evt.ip}`;
    const now = Date.now();
    if (now - (alertCooldown.get(key) || 0) >= ALERT_COOLDOWN_MS) {
      alertCooldown.set(key, now);
      const detail = `Unauthorized access was denied from IP ${evt.ip}. Route/event: ${evt.detail}.`;
      require('./emailer').securityAlert('Unauthorized access attempt', detail).catch(error => {
        console.error('[security alert] Admin alert delivery failed:', error.message);
      });
    }
  }
  return evt;
}

module.exports = { emit, reset };
