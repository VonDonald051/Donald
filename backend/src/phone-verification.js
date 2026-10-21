'use strict';

// Twilio Verify keeps generated OTPs and attempt counters out of our database.
// The short-lived app challenge is process-local because this service is single-process.
const crypto = require('crypto');
const challenges = new Map();

function config() {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
  const verifyServiceSid = String(process.env.TWILIO_VERIFY_SERVICE_SID || '').trim();
  if (!/^AC[a-f0-9]{32}$/i.test(accountSid) || !authToken || !/^VA[a-f0-9]{32}$/i.test(verifyServiceSid)) {
    throw new Error('Phone verification is not configured.');
  }
  return { accountSid, authToken, verifyServiceSid };
}

async function verifyRequest(operation, fields) {
  const cfg = config();
  const url = `https://verify.twilio.com/v2/Services/${cfg.verifyServiceSid}/${operation}`;
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('The phone verification service could not complete the request.');
  return body;
}

async function begin(user, remember, ip, googleSubject = null) {
  if (!user || !/^\+[1-9]\d{7,14}$/.test(String(user.phone || ''))) {
    throw new Error('Your account needs a phone number in international format (for example, +2547…). Ask an administrator to update it.');
  }
  const now = Date.now();
  for (const [id, item] of challenges) if (item.expires <= now) challenges.delete(id);
  if (challenges.size >= 5000) throw new Error('Phone sign-in is busy. Try again shortly.');
  await verifyRequest('Verifications', { To: user.phone, Channel: 'sms' });
  const id = crypto.randomBytes(32).toString('base64url');
  challenges.set(id, { userId: user.id, phone: user.phone, googleSubject, remember: !!remember, ip: String(ip || '').slice(0, 80), expires: now + 10 * 60 * 1000, attempts: 0 });
  return { id, expires: now + 10 * 60 * 1000 };
}

async function consume(id, code, ip) {
  const item = challenges.get(String(id || ''));
  if (!item || item.expires <= Date.now() || item.ip !== String(ip || '').slice(0, 80) || item.attempts >= 5) {
    if (id) challenges.delete(String(id));
    return null;
  }
  item.attempts++;
  if (!/^\d{4,10}$/.test(String(code || ''))) return null;
  const result = await verifyRequest('VerificationCheck', { Code: String(code), To: item.phone });
  if (result.status !== 'approved') return null;
  challenges.delete(String(id));
  return item;
}

module.exports = { config, begin, consume, _challenges: challenges };
