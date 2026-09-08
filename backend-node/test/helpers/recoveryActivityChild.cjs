'use strict';
const Database = require('better-sqlite3');
const { createRecoveryActivityRepository } = require('../../src/repositories/v2/recoveryActivityRepository');
const database = new Database(process.argv[2]);
const lease = createRecoveryActivityRepository(database).acquire(process.argv[3]);
if (!lease) throw Error('Child failed to own activity');
process.send('held');
process.on('message', () => {
  // Simulate termination without releasing the persistent ownership record.
  database.close();
  process.exit(0);
});
