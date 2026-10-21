'use strict';
/* Shared realtime hub singleton (used by server.js, socket.js and the chat route).
 * Stage 5 Branding: broadcast branding updates to all connected dashboards.
 * Patch 3: broadcast loan and fine updates to the borrower. */
const { Hub } = require('./ws');
const dbm = require('./db');

function broadcastBranding(data) {
  try {
    hub.broadcast('branding:updated', data);
  } catch (e) { /* no-op */ }
}
function broadcastLoan(userId, loan) {
  try {
    const event = { ...loan, userId };
    hub.emitTo(userId, 'loan:updated', event);
    const borrower = dbm.db.users.find(user => user.id === Number(userId) && !user.deleted);
    if (borrower && borrower.groupId) broadcastGroupFinance(borrower.groupId, 'loan');
  } catch (e) { /* no-op */ }
}
function broadcastGroupFinance(groupId, kind) {
  if (!groupId) return;
  const event = { kind, updatedAt: Date.now() };
  for (const admin of dbm.db.users.filter(user => !user.deleted && !user.disabled && user.role === 'group_admin' && user.groupId === groupId)) {
    hub.emitTo(admin.id, 'group:finance:updated', event);
  }
}
function broadcastSaving(userId, groupId) {
  try {
    const event = { kind: 'savings', updatedAt: Date.now() };
    hub.emitTo(userId, 'finance:updated', event);
    broadcastGroupFinance(groupId, 'savings');
  } catch (e) { /* no-op */ }
}
function broadcastFine(userId, fine) {
  try {
    hub.emitTo(userId, 'fine:updated', fine);
  } catch (e) { /* no-op */ }
}

module.exports = new Hub();
module.exports.broadcastBranding = broadcastBranding;
module.exports.broadcastLoan = broadcastLoan;
module.exports.broadcastFine = broadcastFine;
module.exports.broadcastSaving = broadcastSaving;
