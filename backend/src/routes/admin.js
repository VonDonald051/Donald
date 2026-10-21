'use strict';
const { Router } = require('../httpmini');
const dbm = require('../db');
const sec = require('../security');
const agreementViews = require('../system-agreement-views');

const r = new Router();
r.use(sec.auth, sec.requireRole('admin'));
r.use((req, res, next) => {
  if (/^\/(?:groups|members)(?:\/|$)/.test(req.url)) {
    dbm.audit(req.user, 'admin.restricted_api.denied', 'retired report endpoint', req);
    return res.status(410).json({ error: 'Report endpoints are retired for this role. Use the read-only agreement and audit views.' });
  }
  next();
});

r.get('/system-agreements', (req, res) => agreementViews.listSystemAgreements(req, res));

r.get('/audit', (req, res) => {
  const entries = dbm.db.audit.slice(-300).reverse().map(entry => ({
    id: entry.id, actor: entry.actor, actorRole: entry.actorRole, action: entry.action,
    ip: entry.ip, at: entry.at, prevHash: entry.prevHash, hash: entry.hash
  }));
  dbm.audit(req.user, 'audit.read', `count=${entries.length}`, req);
  return res.json({ entries });
});

module.exports = r;
