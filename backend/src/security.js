'use strict';
/* Central security module: hashing, encryption vault, sessions, headers, rate limits, validation.
 * Stage 4 Finance + Stage 5 Branding/Agreements/Exports. */
const crypto = require('crypto');
const dbm = require('./db');
let bcrypt = null;
try { bcrypt = require('bcrypt'); } catch { /* Legacy installs can still verify scrypt records. */ }

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64);
  return `s2$${salt.toString('hex')}$${h.toString('hex')}`;
}
function hashOwnerInitialPassword(pw) {
  if (!bcrypt) throw new Error('bcrypt is required for owner reset password hashing; install the declared production dependency first.');
  return bcrypt.hashSync(String(pw), 12);
}
function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  if (/^\$2[aby]\$/.test(stored)) return !!bcrypt && bcrypt.compareSync(String(pw), stored);
  const [m, s, h] = stored.split('$');
  if (m !== 's2' || !s || !h) return false;
  const calc = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64);
  const ref = Buffer.from(h, 'hex');
  return calc.length === ref.length && crypto.timingSafeEqual(calc, ref);
}
const POLICY = [
  [p => p.length >= 9, 'at least 9 characters'],
  [p => /[a-z]/.test(p), 'one lowercase letter'],
  [p => /[A-Z]/.test(p), 'one uppercase letter'],
  [p => /[0-9]/.test(p), 'one number'],
  [p => /[^A-Za-z0-9]/.test(p), 'one symbol']
];
function passwordIssues(pw) { pw = String(pw || ''); return POLICY.filter(([f]) => !f(pw)).map(([, m]) => m); }
function genPassword() { let p; do { p = 'Vd!' + crypto.randomBytes(9).toString('base64url'); } while (passwordIssues(p).length); return p; }

const isEmail = v => typeof v === 'string' && v.length >= 5 && v.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const isPhone = v => typeof v === 'string' && /^\+?[0-9 ()-]{7,20}$/.test(v);
const isName = v => typeof v === 'string' && v.trim().length >= 2 && v.trim().length <= 60 && /^[A-Za-z][A-Za-z' -]*$/.test(v.trim());
const isSafeCode = v => typeof v === 'string' && /^[A-Z0-9-]{6,32}$/i.test(v.trim());
function clean(v, max = 200) { return String(v == null ? '' : v).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max); }

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) {
      const key = p.slice(0, i).trim();
      const value = p.slice(i + 1).trim();
      try { out[key] = decodeURIComponent(value); } catch { out[key] = ''; }
    }
  });
  return out;
}
function sessionCookieSecure(req) {
  if (req && req.protocol === 'https') return true;
  if (process.env.NODE_ENV !== 'production') return false;
  try {
    const hostname = new URL(`http://${req && req.headers.host || ''}`).hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]') return false;
  } catch { /* Missing or malformed request context defaults to production-secure. */ }
  return true;
}
function setSessionCookie(res, token, maxAgeMs, req) {
  const secure = sessionCookieSecure(req) ? '; Secure' : '';
  const cookie = `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? [...(Array.isArray(existing) ? existing : [existing]), cookie] : cookie);
}
function clearSessionCookie(res, req) {
  const secure = sessionCookieSecure(req) ? '; Secure' : '';
  const cookie = `sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? [...(Array.isArray(existing) ? existing : [existing]), cookie] : cookie);
}
function getSession(req) {
  const sid = parseCookies(req).sid;
  if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return null;
  const s = dbm.db.sessions.find(x => x.token === sid);
  if (!s) return null;
  if (s.expires < Date.now()) {
    dbm.db.sessions = dbm.db.sessions.filter(x => x.token !== sid); dbm.save();
    try { require('./hub').revokeSession(sid); } catch {}
    return null;
  }
  return s;
}
function auth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Authentication required' });
  const u = dbm.db.users.find(x => x.id === s.userId && !x.deleted);
  if (!u) return res.status(401).json({ error: 'Authentication required' });
  if (u.disabled) return res.status(423).json({ error: 'Account disabled by V Super Admin' });
  const group = u.groupId && dbm.db.groups.find(g => g.id === u.groupId);
  if (group && group.suspended && !isOwner(u)) return res.status(423).json({ error: 'This group is suspended. Contact the system Owner.' });
  req.session = s; req.user = u; next();
}
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!roles.includes(req.user.role)) { sentinelAuthzDenied(req, 'auth.forbidden ' + req.originalUrl); return res.status(403).json({ error: 'Forbidden: insufficient role', code: 'FORBIDDEN_ROLE' }); }
  next();
};
function pageAuth(roles) {
  return (req, res, next) => {
    const s = getSession(req);
    const u = s && dbm.db.users.find(x => x.id === s.userId && !x.deleted);
    if (!u || u.disabled) return res.redirect('/login.html');
    const group = u.groupId && dbm.db.groups.find(g => g.id === u.groupId);
    if (group && group.suspended && !isOwner(u)) return res.status(423).send('<h1 style="font-family:sans-serif">423 - Group suspended</h1>');
    if (roles.length && !roles.includes(u.role)) return res.status(403).send('<h1 style="font-family:sans-serif">403 - Forbidden</h1>');
    req.user = u; next();
  };
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https://images.unsplash.com", "media-src 'self' blob: mediastream:", "connect-src 'self' ws: wss:", "font-src 'self' data:", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"].join('; '));
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}
function parseAllowedOrigins(value = process.env.CORS_ALLOWED_ORIGINS || '') {
  const origins = new Set();
  for (const entry of value.split(',')) {
    const candidate = entry.trim();
    if (!candidate) continue;
    let parsed;
    try { parsed = new URL(candidate); } catch { throw new Error(`Invalid CORS_ALLOWED_ORIGINS entry: ${candidate}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`CORS_ALLOWED_ORIGINS must contain exact http(s) origins without paths: ${candidate}`);
    }
    origins.add(parsed.origin);
  }
  return origins;
}
const allowedOrigins = parseAllowedOrigins();
function sourceOrigin(value) {
  try { return new URL(value).origin; } catch { return ''; }
}
function originAllowed(originValue, host, protocol) {
  const origin = sourceOrigin(originValue);
  if (!origin) return false;
  if (allowedOrigins.has(origin)) return true;
  try { return origin === new URL(`${protocol}://${host}`).origin; } catch { return false; }
}
function isAllowedOrigin(origin, req) {
  return originAllowed(origin, req.headers.host, req.protocol || (req.socket && req.socket.encrypted ? 'https' : 'http'));
}
function cors(req, res, next) {
  const origin = req.headers.origin ? sourceOrigin(req.headers.origin) : '';
  if (req.headers.origin && !isAllowedOrigin(origin, req)) {
    return res.status(403).json({ error: 'Forbidden (origin not allowed)', code: 'ORIGIN_MISMATCH' });
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '600');
    res.statusCode = 204;
    return res.end();
  }
  next();
}
function uploadGuard(req, res, next) { res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'none'"); next(); }
function apiNoStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}
function originGuard(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const src = req.headers.origin || req.headers.referer;
    if (!src) return res.status(403).json({ error: 'Forbidden (request origin required)', code: 'ORIGIN_REQUIRED' });
    const origin = sourceOrigin(src);
    if (!origin) return res.status(403).json({ error: 'Forbidden (bad origin)', code: 'BAD_ORIGIN' });
    if (!isAllowedOrigin(origin, req)) return res.status(403).json({ error: 'Forbidden (origin mismatch)', code: 'ORIGIN_MISMATCH' });
  }
  next();
}

function limiter(windowMs, max, message) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip + '|' + req.path;
    const now = Date.now();
    let e = hits.get(key);
    if (!e || now > e.reset) e = { n: 0, reset: now + windowMs };
    e.n++;
    hits.set(key, e);
    if (e.n > max) { res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000)); return res.status(429).json({ error: message || 'Too many requests. Please slow down.' }); }
    next();
  };
}
// Allow normal dashboard bursts while limiting abusive clients. Login and public
// endpoints have dedicated, stricter limits below.
const configuredApiRateLimit = Number.parseInt(process.env.API_RATE_LIMIT_PER_MINUTE || '300', 10);
const apiThrottle = limiter(60e3, Number.isFinite(configuredApiRateLimit) && configuredApiRateLimit > 0 ? configuredApiRateLimit : 300);
const loginLimiter = limiter(10 * 60e3, 12, 'Too many login attempts from this network. Try again later.');
const publicLimiter = limiter(60 * 60e3, 30, 'Too many requests. Try again later.');

function reauthOK(req) { const cur = String((req.body || {}).currentPassword || ''); return req.user && verifyPassword(cur, req.user.passHash); }

function isOwner(u) { return u && u.role === 'v_super_admin'; }
function isStaffRole(u) { return u && ['super_admin', 'admin', 'group_admin'].includes(u.role); }
function isMemberRole(u) { return u && u.role === 'member'; }

function getLoanApprover(loan) {
  if (!loan) return null;
  const borrower = dbm.db.users.find(u => u.id === loan.userId);
  if (!borrower) return null;
  if (isOwner(borrower)) return null;
  if (isStaffRole(borrower)) return dbm.db.users.find(u => u.role === 'v_super_admin' && !u.deleted) || null;
  if (isMemberRole(borrower)) return dbm.db.users.find(u => u.role === 'group_admin' && u.groupId === borrower.groupId && !u.deleted) || null;
  return null;
}

function canVerifyLoan(req, loan) {
  if (!req.user || !loan) return false;
  if (loan.userId === req.user.id) return false;
  if (loan.status !== 'pending') return false;
  const approver = getLoanApprover(loan);
  return approver && approver.id === req.user.id;
}
function canDisburseLoan(req, loan) {
  if (!req.user || !loan) return false;
  if (loan.userId === req.user.id) return false;
  if (loan.status !== 'verified') return false;
  const approver = getLoanApprover(loan);
  return approver && approver.id === req.user.id;
}
function canClearLoan(req, loan) {
  if (!req.user || !loan) return false;
  if (loan.userId === req.user.id) return false;
  if (!['disbursed', 'overdue'].includes(loan.status)) return false;
  const approver = getLoanApprover(loan);
  return approver && approver.id === req.user.id;
}
function canRepayLoan(req, loan) {
  return req.user && loan && loan.userId === req.user.id && ['disbursed', 'overdue'].includes(loan.status);
}

function generateIdempotencyKey(prefix, ...parts) {
  return `${prefix}:${crypto.randomBytes(16).toString('hex')}`;
}

function ensureMemberProfile(userId) {
  let mp = dbm.memberProfileFor(userId);
  if (!mp) {
    const user = dbm.db.users.find(x => x.id === userId);
    mp = { id: dbm.next('memberProfile'), userId, groupId: user ? (user.groupId || null) : null, registrationFeePaid: false, registrationFeePaidAt: null, agreementSigned: false, agreementSignedAt: null, weeklySavingTarget: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    dbm.db.memberProfiles.push(mp); dbm.save();
  }
  return mp;
}
function isSelfServiceAction(req) {
  if (req.user.role !== 'super_admin') return false;
  const body = req.body || {};
  const targetUserId = Number(body.userId || body.memberId || req.params.id);
  return targetUserId === req.user.id;
}

// Branding helpers
function sanitizeBrandName(name) {
  return String(name || '').replace(/[<>"'&]/g, '').trim().slice(0, 60);
}
function validateBrandName(name) {
  const n = sanitizeBrandName(name);
  if (n.length < 2) return 'System name must be at least 2 characters';
  return null;
}

// Export scoping
function canExportGroup(req, groupId) {
  if (!req.user) return false;
  if (isOwner(req.user)) return true;
  if (req.user.role === 'super_admin') return true;
  if (req.user.role === 'group_admin' && req.user.groupId === groupId) return true;
  return false;
}
function canExportMember(req, userId) {
  if (!req.user) return false;
  if (isOwner(req.user)) return true;
  if (req.user.role === 'super_admin') return true;
  if (req.user.role === 'group_admin') {
    const target = dbm.db.users.find(u => u.id === userId && !u.deleted);
    return target && target.groupId === req.user.groupId;
  }
  return req.user.id === userId;
}

function errorHandler(err, req, res, next) {
  console.error('[error]', err.message);
  if (res.headersSent) return;
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : String(err.message || 'Error').slice(0, 120) });
}

// Sentinel: IDOR / cross-user access detection
function sentinelAuthzDenied(req, context) {
  try { require('./sentinel').emit('authz_denied', req, context || ''); } catch {}
}

const ROLE_HOME = { v_super_admin: '/app/vsa', super_admin: '/app/sa', admin: '/app/admin', group_admin: '/app/ga', member: '/app/member' };

module.exports = {
  hashPassword, hashOwnerInitialPassword, verifyPassword, passwordIssues, genPassword, POLICY,
  isEmail, isPhone, isName, isSafeCode, clean,
  parseCookies, setSessionCookie, clearSessionCookie, getSession,
  auth, requireRole, pageAuth,
  securityHeaders, cors, uploadGuard, apiNoStore, originGuard, originAllowed,
  limiter, apiThrottle, loginLimiter, publicLimiter,
  reauthOK, errorHandler, ROLE_HOME,
  isOwner, isStaffRole, isMemberRole,
  getLoanApprover, canVerifyLoan, canDisburseLoan, canClearLoan, canRepayLoan,
  generateIdempotencyKey,
  ensureMemberProfile, isSelfServiceAction,
  sanitizeBrandName, validateBrandName,
  canExportGroup, canExportMember,
  sentinelAuthzDenied
};
