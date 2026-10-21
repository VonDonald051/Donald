'use strict';

const dbm = require('./db');
const codes = require('./agreement-codes');

module.exports = function verifyAgreement(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (process.env.SYSTEM_AGREEMENTS_V2 !== '1') return res.status(404).json({ error: 'Not found' });
  const records = dbm.db && dbm.db.systemAgreements;
  if (!Array.isArray(records)) return res.status(404).json({ error: 'Agreement verification unavailable.' });
  const token = String((req.params || {}).token || '');
  const agreement = records.find(row => codes.verifyToken(row.agreementCode, token));
  if (!agreement || !codes.verifyCode(agreement.agreementCode)) {
    dbm.audit(null, 'agreement.verification.denied', 'unknown agreement token', req);
    return res.status(404).json({ verified: false, error: 'Agreement not found.' });
  }
  if (agreement.status === 'PENDING' && Date.parse(agreement.expiresAt) <= Date.now()) {
    agreement.status = 'EXPIRED';
    dbm.save();
  }
  dbm.audit(null, 'agreement.verification.read', `system agreement #${agreement.id}`, req);
  return res.json({
    verified: true, agreementCode: agreement.agreementCode,
    status: agreement.status, version: agreement.version,
    createdAt: agreement.createdAt, expiresAt: agreement.expiresAt, signedAt: agreement.signedAt
  });
};
