'use strict';
/* VonDonald051 Savings - hardened multi-role community/savings system.
 * Backend: pure Node.js (ZERO npm dependencies) + HTML/CSS/JS frontend.
 * Python is the independent security audit layer (security_audit.py, 16 checks).
 * Run: node backend/server.js   (Node.js >= 18, nothing else needed) */
const path = require('path');
const fs = require('fs');
const APP_ROOT = path.resolve(__dirname, '..');

process.umask(0o077);
for (const d of ['database/data', 'database/uploads']) {
  const dir = path.join(APP_ROOT, d);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

// Maintenance scripts refuse to mutate the JSON store while the server is live.
const runtimeMarker = path.join(APP_ROOT, 'database', 'data', 'server.pid');
function acquireRuntimeMarker() {
  for (;;) {
    try {
      fs.writeFileSync(runtimeMarker, String(process.pid), { mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existingPid = 0;
      try { existingPid = Number(fs.readFileSync(runtimeMarker, 'utf8').trim()); } catch {}
      if (!Number.isInteger(existingPid) || existingPid < 2) throw new Error('Invalid server runtime marker; inspect database/data/server.pid before starting.');
      try { process.kill(existingPid, 0); throw new Error(`Another server process (pid ${existingPid}) is already marked active.`); }
      catch (probeError) {
        if (probeError.message.includes('already marked active')) throw probeError;
        if (probeError.code !== 'ESRCH') throw new Error('Unable to verify existing server process; inspect data/server.pid.');
        try { fs.unlinkSync(runtimeMarker); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
      }
    }
  }
}
function releaseRuntimeMarker() {
  try { if (fs.readFileSync(runtimeMarker, 'utf8').trim() === String(process.pid)) fs.unlinkSync(runtimeMarker); } catch {}
}
acquireRuntimeMarker();
process.once('exit', releaseRuntimeMarker);

const { App, serveStatic } = require('./src/httpmini');
const dbm = require('./src/db');
const sec = require('./src/security');
const emailer = require('./src/emailer');
const hub = require('./src/hub');
const securityMonitor = require('./src/security-monitor');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
function validateRuntimeConfig() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  require('./src/db-crypto').encryptionKey();
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.TRUST_PROXY !== '1') throw new Error('Production requires TRUST_PROXY=1 behind a trusted HTTPS reverse proxy.');
  if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) throw new Error('Production must bind to loopback behind the HTTPS reverse proxy.');
  if (!emailer.mode().startsWith('SMTP live')) throw new Error('Production requires SMTP configuration so security alerts can be delivered.');
  if (process.env.LOGIN_PHONE_OTP_ENABLED !== '1') throw new Error('Production requires LOGIN_PHONE_OTP_ENABLED=1 so every password login requires phone verification.');
  try { require('./src/google-login').config(); }
  catch (error) { throw new Error(`Production requires Google OpenID Connect configuration: ${error.message}`); }
  try { require('./src/phone-verification').config(); }
  catch (error) { throw new Error(`Production requires Twilio Verify configuration: ${error.message}`); }
}
validateRuntimeConfig();

dbm.load();

if (process.env.NODE_ENV === 'production') {
  const missingOtpPhones = dbm.db.users.filter(user => !user.deleted && !/^\+[1-9]\d{7,14}$/.test(String(user.phone || ''))).length;
  if (missingOtpPhones) {
    throw new Error(`Production phone verification requires E.164 phone numbers for every active account; ${missingOtpPhones} account(s) need updating.`);
  }
}

if (process.env.SYSTEM_AGREEMENTS_V2 === '1') {
  try {
    require('./src/agreement-codes').assertConfigured();
    require('./src/agreement-pdf').assertConfigured();
    require('./src/agreement-storage').assertConfigured();
  }
  catch (error) { throw new Error(`SYSTEM_AGREEMENTS_V2 is enabled but unavailable: ${error.message}`); }
}

function ensureOwnerAccount() {
  const owners = dbm.db.users.filter(u => u.role === 'v_super_admin' && !u.deleted);
  if (owners.length > 1) throw new Error('Multiple active Owner accounts found; resolve this before starting the system.');
  if (owners.length === 1) {
    console.log(`[startup] Owner account found: ${owners[0].email} (id=${owners[0].id})`);
    return;
  }
  if (dbm.db.users.length) {
    const allOwners = dbm.db.users.filter(u => u.role === 'v_super_admin');
    const deletedOwners = allOwners.filter(u => u.deleted);
    console.error(`[startup] No active Owner account. Total users: ${dbm.db.users.length}, Owner accounts: ${allOwners.length} (${deletedOwners.length} deleted)`);
    throw new Error('No active Owner account exists. Provision one before starting the system.');
  }

  const firstName = String(process.env.OWNER_FIRST_NAME || '').trim();
  const lastName = String(process.env.OWNER_LAST_NAME || '').trim();
  const email = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const phone = String(process.env.OWNER_PHONE || '').trim();
  const password = String(process.env.OWNER_PASSWORD || '');
  if (!sec.isName(firstName) || !sec.isName(lastName) || !sec.isEmail(email) || !sec.isPhone(phone) || sec.passwordIssues(password).length) {
    throw new Error('No accounts exist. Set OWNER_FIRST_NAME, OWNER_LAST_NAME, OWNER_EMAIL, OWNER_PHONE, and a policy-compliant OWNER_PASSWORD to provision the first Owner.');
  }

  const now = new Date().toISOString();
  dbm.db.users.push({
    id: dbm.next('user'), firstName, lastName, email, phone, role: 'v_super_admin', groupId: null,
    passHash: sec.hashPassword(password), pic: null, ecdhPub: null,
    failed: 0, locked: false, disabled: false, deleted: false, createdAt: now, updatedAt: now
  });
  dbm.save();
  dbm.audit(null, 'owner.bootstrap.created', email, null);
  console.log(`[startup] Owner account provisioned: ${email}`);
}

ensureOwnerAccount();
securityMonitor.start();

const app = new App();

// ---- realtime (chat + video-call signaling) on path /rt ----
hub.attach(app.server);
require('./src/socket')(hub);

// ---- hardening middleware chain ----
app.use(sec.securityHeaders);
app.use('/api', sec.cors);
app.use('/api', sec.apiNoStore);
app.use('/api', sec.originGuard);
app.use('/api', sec.apiThrottle);

// ---- API routes ----
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/me', require('./src/routes/me'));
app.use('/api/chat', require('./src/routes/chat'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/vsa', require('./src/routes/vsa'));
app.use('/api/sa', require('./src/routes/sa'));
app.use('/api/ga', require('./src/routes/ga'));
app.use('/api/member', require('./src/routes/member'));
app.use('/api', require('./src/routes/vsa').rHealth);
app.get('/a/:token', sec.limiter(60e3, 60, 'Too many verification checks.'), require('./src/agreement-verification'));
app.use(sec.errorHandler);

// ---- static assets (public pages only) ----
const PUB = path.join(APP_ROOT, 'frontend', 'public');
const PRIV = path.join(APP_ROOT, 'frontend', 'private');
app.use(serveStatic(PUB, { maxAge: '3600' }));
app.use('/uploads', sec.uploadGuard);
app.use('/uploads', serveStatic(path.join(APP_ROOT, 'database', 'uploads'), { maxAge: '604800' }));

// ---- role-protected dashboard pages (server-side guard, never in /public) ----
const page = (file, ...roles) => (req, res) => sec.pageAuth(roles)(req, res, () => res.sendFile(path.join(PRIV, file)));
app.get('/', (req, res) => res.redirect('/login.html'));
app.get('/app/vsa', page('vsa.html', 'v_super_admin'));
app.get('/app/sa', page('sa.html', 'super_admin'));
app.get('/app/admin', page('admin.html', 'admin'));
app.get('/app/ga', page('ga.html', 'group_admin'));
app.get('/app/member', page('member.html', 'member', 'admin', 'super_admin', 'group_admin'));

// Stage 4 Finance: idempotent scheduled fine job for overdue cash loans (runs every 60 seconds)
function applyOverdueFines() {
  try {
    const db = dbm.db;
    for (const loan of db.cashLoans) {
      if (loan.status !== 'disbursed' || !loan.dueAt) continue;
      const fineKey = `fine:loan:${loan.id}`;
      const fineCents = dbm.overdueFineCents(loan);
      if (fineCents > 0) {
        dbm.appendFine(loan.userId, loan.groupId, loan.id, fineCents, fineKey);
        loan.fineCents = (loan.fineCents || 0) + fineCents;
        loan.status = 'overdue';
        loan.updatedAt = new Date().toISOString();
        dbm.save();
        dbm.audit(null, 'scheduler.fine.applied', `loan #${loan.id} fine=${dbm.fromCents(fineCents)}`, null);
        try { hub.broadcastFine(loan.userId, { id: loan.id, fineCents: loan.fineCents, status: loan.status }); } catch {}
      }
    }
  } catch (e) { console.error('[scheduler] fine job failed:', e.message); }
}
setInterval(applyOverdueFines, 60000);
setTimeout(applyOverdueFines, 5000);

const server = app.listen(PORT, HOST, () => {
  server.requestTimeout = 30000;
  server.headersTimeout = 35000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  console.log('');
  console.log('  VonDonald051 Savings System  (zero-dependency build)');
  console.log('  ----------------------------------------------------');
  console.log(`  Running:  http://${HOST}:${PORT}`);
  console.log('  No demo accounts are created. Owner bootstrap uses OWNER_* environment variables.');
  console.log(`  Email mode: ${emailer.mode()}`);
  console.log('');
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received; draining HTTP connections.`);
  const timer = setTimeout(() => {
    console.error('[server] Graceful shutdown timed out.');
    process.exit(1);
  }, 10000);
  timer.unref();
  hub.close();
  server.close(error => {
    releaseRuntimeMarker();
    clearTimeout(timer);
    if (error) { console.error('[server] Shutdown failed:', error.message); process.exitCode = 1; }
    else process.exitCode = 0;
  });
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

// A second start should fail clearly instead of producing an unhandled Node event stack.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. The system may already be running at http://127.0.0.1:${PORT}.`);
    console.error(`Stop the existing process or run this instance on another port: PORT=3001 node server.js\n`);
    process.exitCode = 1;
    releaseRuntimeMarker();
    return;
  }
  console.error('Unable to start the server:', err && err.message ? err.message : err);
  process.exitCode = 1;
  releaseRuntimeMarker();
});
