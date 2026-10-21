'use strict';
/* Public auth routes: register (requires safe code), login (4-strike lockout), logout,
 * forgot/reset password, access requests for people without accounts. */
const crypto = require('crypto');
const dbm = require('../db');
const sec = require('../security');
const emailer = require('../emailer');
const hub = require('../hub');
const securityMonitor = require('../security-monitor');
const agreementCodes = require('../agreement-codes');
const googleLogin = require('../google-login');
const phoneVerification = require('../phone-verification');
const { Router } = require('../httpmini');

const r = new Router();
const now = () => new Date().toISOString();

function createSession(req, res, user, remember, loginMethod) {
  user.failed = 0;
  dbm.save();
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = remember ? 30 * 86400e3 : 8 * 3600e3;
  dbm.add('sessions', 'session', {
    token, userId: user.id, remember: !!remember, loginMethod,
    ua: sec.clean(req.headers['user-agent'], 150), ip: req.ip,
    createdAt: Date.now(), expires: Date.now() + ttl
  });
  sec.setSessionCookie(res, token, ttl, req);
  dbm.audit(user, `login.success.${loginMethod}`, user.email, req);
  return { ok: true, role: user.role, home: sec.ROLE_HOME[user.role] || '/login.html', passwordChangeRequired: !!user.passwordChangeRequired };
}

function startPhoneChallenge(req, res, user, remember, googleSubject = null) {
  return phoneVerification.begin(user, remember, req.ip, googleSubject).then(challenge => {
    googleLogin.setCookie(res, 'phone_challenge', challenge.id, 600);
    return { phoneVerification: true, expires: challenge.expires, phone: sec.maskPhone(user.phone) };
  });
}

// Google OAuth is enabled only after deployment supplies the exact callback and credentials.
r.get('/google/config', (req, res) => {
  try { googleLogin.config(); phoneVerification.config(); return res.json({ available: true }); }
  catch { return res.json({ available: false }); }
});

r.get('/google', sec.loginLimiter, (req, res) => {
  try { phoneVerification.config(); return res.redirect(googleLogin.makeAuthorizationUrl(res)); }
  catch { return res.redirect('/login.html?auth_error=google_unavailable'); }
});

r.get('/google/callback', sec.loginLimiter, async (req, res) => {
  googleLogin.clearCookie(res, 'google_state');
  if (req.query.error) return res.redirect('/login.html?auth_error=google_cancelled');
  try {
    const identity = await googleLogin.complete(req);
    const user = dbm.db.users.find(entry => entry.email === identity.email && !entry.deleted);
    if (!user || user.disabled || user.locked || (user.googleSub && user.googleSub !== identity.subject)) {
      return res.redirect('/login.html?auth_error=account_unavailable');
    }
    await startPhoneChallenge(req, res, user, false, identity.subject);
    return res.redirect('/login.html?phone_verification=1');
  } catch {
    return res.redirect('/login.html?auth_error=google_failed');
  }
});

r.post('/phone/verify', sec.loginLimiter, async (req, res) => {
  const challengeId = googleLogin.cookieValue(req, 'phone_challenge');
  try {
    const challenge = await phoneVerification.consume(challengeId, (req.body || {}).code, req.ip);
    if (!challenge) return res.status(401).json({ error: 'That passcode is invalid or expired. Check it and try again.' });
    googleLogin.clearCookie(res, 'phone_challenge');
    const user = dbm.db.users.find(entry => entry.id === challenge.userId && !entry.deleted);
    if (!user || user.disabled || user.locked || (challenge.googleSubject && user.googleSub && user.googleSub !== challenge.googleSubject)) {
      return res.status(423).json({ error: 'This account is unavailable. Contact the V Super Admin.' });
    }
    if (challenge.googleSubject) user.googleSub = challenge.googleSubject;
    return res.json(createSession(req, res, user, challenge.remember, challenge.googleSubject ? 'google_phone' : 'password_phone'));
  } catch {
    return res.status(503).json({ error: 'Phone verification is temporarily unavailable. Please try again.' });
  }
});

// ---- groups dropdown for the public request page (names only) ----
r.get('/groups', sec.publicLimiter, (req, res) => {
  res.json({ groups: dbm.db.groups.filter(g => !g.isStaffChama && !g.suspended).map(g => ({ id: g.id, name: g.name })) });
});

// ---- public branding (no auth) ----
r.get('/branding', (req, res) => {
  const b = dbm.currentBranding();
  res.json({ branding: b ? { name: b.name, logo: b.logo || null, colors: b.colors || null } : { name: 'VonDonald051 Savings', logo: null, colors: null } });
});

// ---- REGISTER: First Name, Last Name, Email, Phone, Password, Confirm Password + Safe Code ----
r.post('/register', sec.publicLimiter, (req, res) => {
  const b = req.body || {};
  const firstName = sec.clean(b.firstName, 60).trim();
  const lastName = sec.clean(b.lastName, 60).trim();
  const email = sec.clean(b.email, 120).trim().toLowerCase();
  const phone = sec.clean(b.phone, 30).trim();
  const password = String(b.password || '');
  const confirm = String(b.confirmPassword || '');
  const code = sec.clean(b.safeCode, 40).trim().toUpperCase();

  const errors = {};
  if (!sec.isName(firstName)) errors.firstName = 'Valid first name required (letters, 2-60 chars)';
  if (!sec.isName(lastName)) errors.lastName = 'Valid last name required (letters, 2-60 chars)';
  if (!sec.isEmail(email)) errors.email = 'Valid email required';
  else if (dbm.db.users.some(u => u.email === email && !u.deleted)) errors.email = 'Email already registered';
  if (!sec.isPhone(phone)) errors.phone = 'Valid phone number required';
  const issues = sec.passwordIssues(password);
  if (issues.length) errors.password = 'Password needs ' + issues.join(', ');
  if (password !== confirm) errors.confirmPassword = 'Passwords do not match';

  // Safe code gate (can be toggled by the V Super Admin, default ON)
  let sc = null;
  if (dbm.db.settings.safe_code_required === '1' || process.env.SYSTEM_AGREEMENTS_V2 === '1') {
    if (!code) errors.safeCode = 'Safe code required - request one from your Group Admin';
    else {
      sc = dbm.db.safeCodes.find(c => c.code === code && c.active && !c.usedBy);
      if (!sc) errors.safeCode = 'Invalid, revoked or already-used safe code';
    }
  }
  if (sc) {
    const group = dbm.db.groups.find(g => g.id === sc.groupId);
    if (process.env.SYSTEM_AGREEMENTS_V2 === '1' && (!group || group.isStaffChama)) errors.safeCode = 'A valid savings group is required for agreement issuance';
    if (group && !group.isStaffChama) {
      if (group.suspended) errors.safeCode = 'This group is suspended and cannot accept new members';
      // Regular groups: max 30 members (including Group Admin)
      const memberCount = dbm.getGroupParticipantCount(sc.groupId);
      if (memberCount >= 30) errors.safeCode = 'This group has reached its maximum of 30 members';
    }
  }
  if (Object.keys(errors).length) {
    dbm.audit(null, 'register.failed', email, req);
    return res.status(400).json({ errors });
  }

  const ts = now();
  const u = {
    id: dbm.next('user'), firstName, lastName, email, phone,
    role: 'member', groupId: sc ? sc.groupId : null,
    passHash: sec.hashPassword(password),
    pic: null, ecdhPub: null, failed: 0, locked: false, disabled: false, deleted: false,
    createdAt: ts, updatedAt: ts
  };
  let systemAgreement;
  try { systemAgreement = agreementCodes.maybeCreateForMember(u, u.groupId); }
  catch { return res.status(503).json({ error: 'System agreement issuance is temporarily unavailable.' }); }
  dbm.db.users.push(u);
  // Create member profile for new member
  dbm.db.memberProfiles.push({
    id: dbm.next('memberProfile'), userId: u.id,
    groupId: sc ? sc.groupId : null,
    registrationFeePaid: false, registrationFeePaidAt: null,
    agreementSigned: false, agreementSignedAt: null,
    weeklySavingTarget: 0,
    createdAt: ts, updatedAt: ts
  });
  if (systemAgreement) dbm.db.systemAgreements.push(systemAgreement);
  if (sc) { sc.usedBy = u.id; sc.usedAt = ts; }
  dbm.save();
  dbm.audit(u, 'register.success', email, req);
  if (systemAgreement) dbm.audit(u, 'agreement.created', `system agreement #${systemAgreement.id}`, req);
  emailer.emailVSA('New member registered', `${firstName} ${lastName} <${email}> registered${sc ? ` into group #${sc.groupId}` : ''} at ${ts}.`);
  res.status(201).json({ ok: true });
});

// ---- LOGIN: Email + Password; 4 wrong passwords => locked; VSA must unlock ----
r.post('/login', sec.loginLimiter, async (req, res) => {
  const db = dbm.db;
  const email = sec.clean(req.body && req.body.email, 120).trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  const remember = !!(req.body || {}).remember;

  const u = db.users.find(x => x.email === email && !x.deleted);
  if (!u) {
    dbm.audit(null, 'login.failed.unknown', email, req);
    securityMonitor.recordFailedLogin(req, email);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (u.disabled) return res.status(423).json({ error: 'This account has been disabled. Contact the V Super Admin.' });
  if (u.locked) return res.status(423).json({ error: 'Account locked after 4 failed attempts. Ask the V Super Admin to re-enable it.' });

  if (!sec.verifyPassword(password, u.passHash)) {
    u.failed = (u.failed || 0) + 1;
    const locked = u.failed >= 4;
    if (locked) u.locked = true;
    dbm.save();
    dbm.audit(u, locked ? 'login.locked' : 'login.failed', email, req);
    securityMonitor.recordFailedLogin(req, email, locked);
    if (locked) {
      return res.status(423).json({ error: 'Account locked after 4 failed attempts. Ask the V Super Admin to re-enable it.' });
    }
    return res.status(401).json({ error: `Invalid email or password (${4 - u.failed} attempt(s) left before lockout)` });
  }

  if (process.env.LOGIN_PHONE_OTP_ENABLED === '1' || process.env.NODE_ENV === 'production') {
    try { return res.json(await startPhoneChallenge(req, res, u, remember)); }
    catch { return res.status(503).json({ error: 'Phone verification is unavailable. Contact the system administrator.' }); }
  }
  return res.json(createSession(req, res, u, remember, 'password'));
});

r.post('/logout', (req, res) => {
  const s = sec.getSession(req);
  if (s) {
    dbm.db.sessions = dbm.db.sessions.filter(x => x.token !== s.token);
    dbm.save();
    hub.revokeSession(s.token);
    const u = dbm.db.users.find(x => x.id === s.userId);
    if (u) dbm.audit(u, 'logout', '', req);
  }
  sec.clearSessionCookie(res, req);
  res.json({ ok: true });
});

// ---- FORGOT / RESET PASSWORD ----
r.post('/forgot', sec.publicLimiter, (req, res) => {
  const email = sec.clean(req.body && req.body.email, 120).trim().toLowerCase();
  const u = dbm.db.users.find(x => x.email === email && !x.deleted);
  if (u) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = Date.now() + 60 * 60 * 1000;
    dbm.add('resets', 'reset', {
      userId: u.id, tokenHash, expires, used: false, pendingApproval: true, approvedAt: null, at: now()
    });
    emailer.emailVSA('Password reset approval required', `A password reset was requested for ${email} at ${now()}. Approve it from the V Super Admin dashboard.\nReset token: ${token}`);
    dbm.audit(u, 'password.reset.requested', email, req);
  }
  res.json({ ok: true, message: 'If that email exists, the V Super Admin has been asked to approve the reset.' });
});

r.post('/reset', sec.publicLimiter, (req, res) => {
  const token = String((req.body || {}).token || '');
  const password = String((req.body || {}).password || '');
  const confirm = String((req.body || {}).confirmPassword || '');
  const issues = sec.passwordIssues(password);
  if (issues.length) return res.status(400).json({ error: 'Password needs ' + issues.join(', ') });
  if (password !== confirm) return res.status(400).json({ error: 'Passwords do not match' });
  const h = crypto.createHash('sha256').update(token).digest('hex');
  const rec = dbm.db.resets.find(x => x.tokenHash === h && !x.used && x.expires > Date.now());
  if (!rec) return res.status(400).json({ error: 'Reset link is invalid or expired' });
  const u = dbm.db.users.find(x => x.id === rec.userId && !x.deleted);
  if (!u) return res.status(400).json({ error: 'Account not found' });
  rec.used = true;
  u.passHash = sec.hashPassword(password);
  u.passwordChangeRequired = false;
  u.failed = 0; u.locked = false; u.updatedAt = now();
  dbm.save();
  dbm.killSessions(u.id);
  dbm.audit(u, 'password.reset.completed', u.email, req);
  emailer.emailVSA('Password reset completed', `Password was reset for ${u.email} at ${now()}.`);
  res.json({ ok: true });
});

// ---- ACCESS REQUEST (people without accounts ask the Group Admin for a safe code) ----
r.post('/request-access', sec.publicLimiter, (req, res) => {
  const b = req.body || {};
  const firstName = sec.clean(b.firstName, 60).trim();
  const lastName = sec.clean(b.lastName, 60).trim();
  const email = sec.clean(b.email, 120).trim().toLowerCase();
  const phone = sec.clean(b.phone, 30).trim();
  const groupId = Number(b.groupId) || null;
  const note = sec.clean(b.note, 300);

  const errors = {};
  if (!sec.isName(firstName)) errors.firstName = 'Valid first name required';
  if (!sec.isName(lastName)) errors.lastName = 'Valid last name required';
  if (!sec.isEmail(email)) errors.email = 'Valid email required';
  else if (dbm.db.users.some(u => u.email === email && !u.deleted)) errors.email = 'An account already exists for this email - just log in';
  else if (dbm.db.requests.some(q => q.email === email && q.status === 'pending')) errors.email = 'You already have a pending request';
  if (!sec.isPhone(phone)) errors.phone = 'Valid phone number required';
  const group = dbm.db.groups.find(g => g.id === groupId && !g.isStaffChama && !g.suspended);
  if (!group) errors.groupId = 'Please choose a valid group';
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const reqRec = dbm.add('requests', 'request', {
    firstName, lastName, email, phone, groupId, note,
    status: 'pending', codeIssued: null, at: now(), handledAt: null, handledBy: null
  });
  dbm.audit(null, 'access.requested', `${email} -> group #${groupId}`, req);
  const gas = dbm.db.users.filter(u => u.role === 'group_admin' && u.groupId === groupId && !u.deleted);
  for (const g of gas) emailer.notifyUser(g.id, 'request', 'New safe-code request',
    `A request to join ${group.name} needs review. Open Group Admin > Requests to process it.`);
  emailer.emailVSA('New access request', `${firstName} ${lastName} <${email}> requested a safe code for "${group.name}".`);
  res.status(201).json({ ok: true, requestId: reqRec.id });
});

module.exports = r;
