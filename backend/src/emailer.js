'use strict';
/* Email service backed by the built-in raw SMTP client (src/smtp.js).
 * When SMTP is configured (SMTP_URL / SMTP_HOST...) real emails go out;
 * regardless, every message is mirrored to the V Super Admin "Email Outbox". */
const smtp = require('./smtp');
const dbm = require('./db');

async function sendEmail(to, subject, text) {
  return smtp.sendMail(to, subject, text);
}

async function teamsSecurityAlert(title, detail) {
  const endpoint = String(process.env.TEAMS_WEBHOOK_URL || '').trim();
  if (!endpoint) return { configured: false, sent: false };
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('TEAMS_WEBHOOK_URL must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('TEAMS_WEBHOOK_URL must be HTTPS and contain no embedded credentials');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `${String(title).slice(0, 160)}\n${String(detail).slice(0, 1000)}` }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Teams webhook returned HTTP ${response.status}`);
  return { configured: true, sent: true };
}

/* Notification feed for one user. */
function notifyUser(userId, type, title, body, context = {}) {
  const recipient = dbm.db.users.find(user => user.id === userId && !user.deleted);
  if (!recipient) return null;
  const createdAt = new Date().toISOString();
  return dbm.add('notifications', 'notification', {
    userId, recipientId: userId, recipientRole: recipient.role, groupId: recipient.groupId || null,
    senderId: Number.isInteger(context.senderId) ? context.senderId : null,
    senderRole: typeof context.senderRole === 'string' ? context.senderRole : null,
    type: String(type).slice(0, 24),
    title: String(title).slice(0, 120), body: String(body || '').slice(0, 2000),
    read: false, readAt: null, createdAt, at: createdAt
  });
}

function notifyRole(role, type, title, body, groupId = null, context = {}) {
  if (!['admin', 'group_admin', 'member'].includes(role)) throw new Error('Unsupported notification recipient role.');
  const createdAt = new Date().toISOString();
  return dbm.add('notifications', 'notification', {
    userId: null, recipientId: null, recipientRole: role,
    groupId: Number.isInteger(groupId) ? groupId : null,
    senderId: Number.isInteger(context.senderId) ? context.senderId : null,
    senderRole: typeof context.senderRole === 'string' ? context.senderRole : null,
    type: String(type).slice(0, 24), title: String(title).slice(0, 120),
    body: String(body || '').slice(0, 2000), read: false, readAt: null,
    createdAt, at: createdAt
  });
}

/* Email + in-app notification to every V Super Admin ("V super admin notification"). */
async function emailVSA(subject, text) {
  const vsas = dbm.db.users.filter(u => u.role === 'v_super_admin' && !u.deleted);
  for (const v of vsas) notifyUser(v.id, 'email', subject, `To: ${v.email}\n\n${text}`);
  let sent = 0;
  for (const v of vsas) if (await sendEmail(v.email, subject, text)) sent++;
  return sent;
}

async function securityAlert(subject, text) {
  const roles = new Set(['v_super_admin', 'super_admin', 'admin', 'group_admin']);
  const recipients = dbm.db.users.filter(user => roles.has(user.role) && !user.deleted);
  for (const user of recipients) if (user.role === 'admin') notifyUser(user.id, 'security', subject, text);
  const deliveries = await Promise.allSettled(recipients.map(user => sendEmail(user.email, `[SECURITY] ${subject}`, text)));
  const emailsSent = deliveries.filter(result => result.status === 'fulfilled' && result.value).length;
  let teamsSent = false;
  try { teamsSent = !!(await teamsSecurityAlert(subject, text)).sent; }
  catch (error) { console.error('[security alert] Teams delivery failed:', error.message); }
  return { recipients: recipients.length, emailsSent, teamsSent, smtpConfigured: smtp.mode().startsWith('SMTP live') };
}

module.exports = { sendEmail, notifyUser, notifyRole, emailVSA, teamsSecurityAlert, securityAlert, mode: smtp.mode };
