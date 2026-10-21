'use strict';

const dbm = require('./db');

function listSystemAgreements(req, res, options = {}) {
  if (process.env.SYSTEM_AGREEMENTS_V2 !== '1' || !Array.isArray(dbm.db.systemAgreements)) {
    return res.status(404).json({ error: 'System agreements are unavailable.' });
  }
  const groupId = options.groupOnly ? Number(req.user.groupId) : null;
  const rows = dbm.db.systemAgreements
    .filter(agreement => groupId == null || agreement.groupId === groupId)
    .slice(-500).reverse().map(agreement => {
      const group = dbm.db.groups.find(entry => entry.id === agreement.groupId);
      return {
        agreementCode: agreement.agreementCode,
        groupId: agreement.groupId,
        groupName: group ? group.name : 'Deleted group',
        status: agreement.status,
        createdAt: agreement.createdAt,
        expiresAt: agreement.expiresAt,
        signedAt: agreement.signedAt,
        version: agreement.version
      };
    });
  dbm.audit(req.user, 'agreement.records.read', options.groupOnly ? `group #${groupId}` : `count=${rows.length}`, req);
  return res.json({ agreements: rows });
}

module.exports = { listSystemAgreements };
