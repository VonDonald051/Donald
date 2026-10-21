'use strict';

const crypto = require('node:crypto');

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

module.exports = function legacyScryptVerify(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(res, 405, { error: 'Method not allowed.' });
  }

  const expected = process.env.LEGACY_SCRYPT_BRIDGE_SECRET || '';
  const supplied = req.headers['x-legacy-scrypt-bridge'] || '';
  if (!/^[a-f0-9]{64}$/i.test(expected) || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/i.test(supplied) || supplied.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))) {
    return reply(res, 404, { error: 'Not found.' });
  }

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const password = body.password;
  const stored = body.hash;
  if (typeof password !== 'string' || password.length > 4096 || typeof stored !== 'string' ||
      !/^s2\$[a-f0-9]{32}\$[a-f0-9]{128}$/i.test(stored)) {
    return reply(res, 400, { error: 'Invalid verification request.' });
  }

  try {
    const [, saltHex, expectedHex] = stored.split('$');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, {
      N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
    });
    const matches = crypto.timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
    return reply(res, 200, { verified: matches });
  } catch {
    return reply(res, 400, { error: 'Verification failed.' });
  }
};
