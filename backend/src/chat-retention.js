'use strict';

const dbm = require('./db');

function days() {
  const value = Number(process.env.CHAT_RETENTION_DAYS || 365);
  if (!Number.isInteger(value) || value < 1 || value > 3650) throw new Error('CHAT_RETENTION_DAYS must be an integer from 1 to 3650.');
  return value;
}

function cutoff(now = Date.now()) { return now - days() * 86400000; }

function purge(now = Date.now()) {
  const threshold = cutoff(now);
  const before = dbm.db.messages.length;
  dbm.db.messages = dbm.db.messages.filter(message => Date.parse(message.at) >= threshold);
  const removed = before - dbm.db.messages.length;
  if (removed) { dbm.save(); dbm.audit(null, 'chat.retention.purged', `count=${removed}`, null); }
  return removed;
}

module.exports = { days, cutoff, purge };
