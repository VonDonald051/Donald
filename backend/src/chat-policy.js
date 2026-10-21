'use strict';

const dbm = require('./db');

const ALLOWED_ROLES = new Set(['member', 'group_admin', 'admin']);

function activeUser(user, groups = (dbm.db && dbm.db.groups) || []) {
  if (!user || user.deleted || user.disabled || !ALLOWED_ROLES.has(user.role)) return false;
  if (['member', 'group_admin'].includes(user.role)) {
    const group = groups.find(entry => entry.id === user.groupId);
    return !!(group && !group.suspended && !group.isStaffChama);
  }
  return true;
}

function pairOK(a, b, groups = (dbm.db && dbm.db.groups) || []) {
  if (!activeUser(a, groups) || !activeUser(b, groups) || a.id === b.id) return false;
  if (a.role === 'admin' && b.role === 'admin') return true;
  if ((a.role === 'admin' && b.role === 'group_admin') || (a.role === 'group_admin' && b.role === 'admin')) return true;
  const member = a.role === 'member' ? a : b.role === 'member' ? b : null;
  const groupAdmin = a.role === 'group_admin' ? a : b.role === 'group_admin' ? b : null;
  return !!(member && groupAdmin && member.groupId === groupAdmin.groupId);
}

function contactsFor(user) {
  if (!activeUser(user)) return [];
  const candidates = dbm.db.users.filter(candidate => candidate.id !== user.id && pairOK(user, candidate));
  return candidates.map(candidate => ({
    id: candidate.id,
    name: `${candidate.firstName} ${candidate.lastName}`,
    pic: candidate.pic || null,
    role: candidate.role,
    pub: candidate.ecdhPub || null
  }));
}

module.exports = { activeUser, pairOK, contactsFor };
