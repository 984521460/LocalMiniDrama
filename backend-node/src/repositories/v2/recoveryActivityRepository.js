'use strict';
const { randomUUID } = require('node:crypto');
const { assertDatabase } = require('./repositorySupport');

function processMayBeAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    // Permission errors and PID reuse are conservative: never delete an
    // activity's files unless the previous process is demonstrably absent.
    return error.code !== 'ESRCH';
  }
}

function createRecoveryActivityRepository(database) {
  assertDatabase(database);
  let statements;
  function sql() {
    if (!statements) statements = {
      get: database.prepare('SELECT owner_pid,owner_token FROM recovery_activity_ownership WHERE activity_key=?'),
      insert: database.prepare('INSERT OR IGNORE INTO recovery_activity_ownership VALUES (?,?,?)'),
      release: database.prepare('DELETE FROM recovery_activity_ownership WHERE activity_key=? AND owner_pid=? AND owner_token=?'),
    };
    return statements;
  }
  return Object.freeze({
    acquire(key) {
      if (typeof key !== 'string' || !/^(?:remote\/[0-9a-f-]{36}|local\/[0-9a-f-]{36}\/[0-9a-f]{64})$/u.test(key)) {
        throw new TypeError('Recovery activity key is invalid');
      }
      const token = randomUUID();
      const acquired = database.transaction(() => {
        const previous = sql().get.get(key);
        if (previous) {
          if (processMayBeAlive(previous.owner_pid)) return false;
          if (sql().release.run(key, previous.owner_pid, previous.owner_token).changes !== 1) return false;
        }
        return sql().insert.run(key, process.pid, token).changes === 1;
      }).immediate();
      if (!acquired) return null;
      let held = true;
      return Object.freeze({ release() {
        if (!held) return;
        if (sql().release.run(key, process.pid, token).changes !== 1) {
          throw new Error('Recovery activity ownership changed');
        }
        held = false;
      } });
    },
  });
}
module.exports = Object.freeze({ createRecoveryActivityRepository });
