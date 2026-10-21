'use strict';

const ID = '001-system-agreements';

function up(db) {
  if (!db.meta || typeof db.meta !== 'object') db.meta = {};
  if (!Array.isArray(db.meta.appliedMigrations)) db.meta.appliedMigrations = [];
  if (db.meta.appliedMigrations.includes(ID)) return db;
  if (Object.prototype.hasOwnProperty.call(db, 'systemAgreements') && !Array.isArray(db.systemAgreements)) {
    throw new Error('systemAgreements exists with an invalid shape; migration stopped.');
  }
  if (!Array.isArray(db.systemAgreements)) db.systemAgreements = [];
  if (!db.counters || typeof db.counters !== 'object') db.counters = {};
  if (!Number.isFinite(db.counters.systemAgreement)) db.counters.systemAgreement = 0;
  db.meta.appliedMigrations.push(ID);
  return db;
}

function down(db) {
  if (!db.meta || !Array.isArray(db.meta.appliedMigrations) || !db.meta.appliedMigrations.includes(ID)) return db;
  if (!Array.isArray(db.systemAgreements)) throw new Error('systemAgreements collection is missing; rollback stopped.');
  if (db.systemAgreements.length) throw new Error('Cannot roll back while system agreements exist. Export and resolve those records first.');
  db.meta.appliedMigrations = db.meta.appliedMigrations.filter(id => id !== ID);
  delete db.systemAgreements;
  if (db.counters) delete db.counters.systemAgreement;
  return db;
}

module.exports = { ID, up, down };
