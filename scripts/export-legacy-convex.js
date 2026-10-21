'use strict';

// Export the local encrypted JSON store as Convex JSONLines. Session rows are
// deliberately omitted: they contain bearer credentials and users can sign in
// again after migration. The export is written outside the repository.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dbm = require('../backend/src/db');

const output = path.join(os.tmpdir(), `vondonald-convex-import-${process.pid}.jsonl`);
const omit = new Set(['sessions']);
const records = [];

dbm.load();
for (const [collection, rows] of Object.entries(dbm.db)) {
  if (!Array.isArray(rows) || omit.has(collection)) continue;
  for (const row of rows) {
    const data = JSON.parse(JSON.stringify(row));
    records.push({
      collection,
      legacyId: Number.isSafeInteger(data.id) ? data.id : records.length + 1,
      data,
      ...(typeof data.email === 'string' ? { email: data.email.toLowerCase() } : {}),
      ...(Number.isSafeInteger(data.groupId) ? { groupId: data.groupId } : {}),
      ...(Number.isSafeInteger(data.userId) ? { userId: data.userId } : {}),
      ...(typeof data.status === 'string' ? { status: data.status } : {}),
    });
  }
}

records.push({
  collection: 'metadata', legacyId: 0,
  data: {
    meta: dbm.db.meta,
    counters: dbm.db.counters,
    settings: { safe_code_required: dbm.db.settings.safe_code_required ?? '1' },
  },
});

fs.writeFileSync(output, records.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
const counts = {};
for (const row of records) counts[row.collection] = (counts[row.collection] || 0) + 1;
console.log(JSON.stringify({ output, records: records.length, omittedCollections: [...omit], counts }));
