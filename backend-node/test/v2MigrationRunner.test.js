const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const {
  V2MigrationError,
  discoverV2Migrations,
  runV2Migrations,
} = require('../src/db/v2');

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-v2-migrations-'));
  const migrationsDir = path.join(root, 'migrations');
  const databases = new Set();
  fs.mkdirSync(migrationsDir);
  t.after(() => {
    for (const database of databases) {
      if (!database.open) continue;
      if (database.inTransaction) database.exec('ROLLBACK');
      database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, migrationsDir, databases };
}

function writeMigration(migrationsDir, filename, sql) {
  fs.writeFileSync(path.join(migrationsDir, filename), sql, 'utf8');
}

function openDatabase(workspace, filename) {
  const database = new Database(filename);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 0');
  workspace.databases.add(database);
  return database;
}

function assertMigrationError(error, code) {
  assert.equal(error instanceof V2MigrationError, true);
  assert.equal(error.code, code);
  return true;
}

function wrapDatabase(database, hooks = {}) {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          const result = target.exec(sql);
          hooks.afterExec?.(sql);
          return result;
        };
      }
      if (property === 'prepare') {
        return (sql) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === 'all') {
                return (...parameters) => {
                  const result = statementTarget.all(...parameters);
                  hooks.afterAll?.(sql, result);
                  return result;
                };
              }
              const value = Reflect.get(statementTarget, statementProperty, statementTarget);
              return typeof value === 'function' ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('discovers strict filenames and orders migrations by numeric version', (t) => {
  const { migrationsDir } = createWorkspace(t);
  writeMigration(migrationsDir, '0002_seed_notes.sql', 'INSERT INTO v2_notes (body) VALUES (\'second\');');
  writeMigration(migrationsDir, '0001_create_notes.sql', 'CREATE TABLE v2_notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);');

  const migrations = discoverV2Migrations(migrationsDir);

  assert.deepEqual(migrations.map(({ version, name }) => ({ version, name })), [
    { version: 1, name: 'create_notes' },
    { version: 2, name: 'seed_notes' },
  ]);
  assert.match(migrations[0].checksum, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(migrations), true);
  assert.equal(Object.isFrozen(migrations[0]), true);
});

test('applies migrations once in version order and records immutable checksums', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  writeMigration(migrationsDir, '0002_seed_notes.sql', 'INSERT INTO v2_notes (body) VALUES (\'second\');');
  writeMigration(migrationsDir, '0001_create_notes.sql', 'CREATE TABLE v2_notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);');
  const database = openDatabase(workspace, path.join(root, 'project.sqlite'));

  const first = runV2Migrations(database, { migrationsDir });
  const ledgerAfterFirstRun = database.prepare(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  ).all();
  const second = runV2Migrations(database, { migrationsDir });

  assert.deepEqual(first.appliedVersions, [1, 2]);
  assert.equal(first.currentVersion, 2);
  assert.deepEqual(second.appliedVersions, []);
  assert.equal(second.currentVersion, 2);
  assert.deepEqual(database.prepare('SELECT body FROM v2_notes ORDER BY id').all(), [
    { body: 'second' },
  ]);
  assert.deepEqual(
    database.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all(),
    ledgerAfterFirstRun,
  );
});

test('fails closed when an applied migration file checksum changes', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  const filename = '0001_create_notes.sql';
  writeMigration(migrationsDir, filename, 'CREATE TABLE v2_notes (id INTEGER PRIMARY KEY);');
  const database = openDatabase(workspace, path.join(root, 'project.sqlite'));
  runV2Migrations(database, { migrationsDir });
  const before = database.prepare('SELECT * FROM schema_migrations').all();

  writeMigration(migrationsDir, filename, 'CREATE TABLE v2_notes (id INTEGER PRIMARY KEY);\n-- drift');

  assert.throws(
    () => runV2Migrations(database, { migrationsDir }),
    (error) => assertMigrationError(error, 'MIGRATION_CHECKSUM_MISMATCH'),
  );
  assert.deepEqual(database.prepare('SELECT * FROM schema_migrations').all(), before);
  assert.equal(database.inTransaction, false);
});

test('rolls back when migration files drift after discovery or during execution', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  const filename = '0001_create_shape.sql';
  const oldSql = 'CREATE TABLE old_shape (id INTEGER PRIMARY KEY);';
  const newSql = 'CREATE TABLE new_shape (id INTEGER PRIMARY KEY);';
  writeMigration(migrationsDir, filename, oldSql);

  const afterLock = openDatabase(workspace, path.join(root, 'after-lock.sqlite'));
  let changedAfterLock = false;
  const afterLockProxy = wrapDatabase(afterLock, {
    afterExec(sql) {
      if (sql === 'BEGIN IMMEDIATE' && !changedAfterLock) {
        changedAfterLock = true;
        writeMigration(migrationsDir, filename, newSql);
      }
    },
  });
  assert.throws(
    () => runV2Migrations(afterLockProxy, { migrationsDir }),
    (error) => assertMigrationError(error, 'MIGRATION_FILES_CHANGED'),
  );
  assert.equal(afterLock.inTransaction, false);
  assert.equal(afterLock.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'",
  ).get().count, 0);

  writeMigration(migrationsDir, filename, oldSql);
  const duringExecution = openDatabase(workspace, path.join(root, 'during-execution.sqlite'));
  let changedDuringExecution = false;
  const duringExecutionProxy = wrapDatabase(duringExecution, {
    afterExec(sql) {
      if (sql === oldSql && !changedDuringExecution) {
        changedDuringExecution = true;
        writeMigration(migrationsDir, filename, newSql);
      }
    },
  });
  assert.throws(
    () => runV2Migrations(duringExecutionProxy, { migrationsDir }),
    (error) => assertMigrationError(error, 'MIGRATION_FILES_CHANGED'),
  );
  assert.equal(duringExecution.inTransaction, false);
  assert.equal(duringExecution.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'",
  ).get().count, 0);

  writeMigration(migrationsDir, filename, oldSql);
  const beforeCommit = openDatabase(workspace, path.join(root, 'before-commit.sqlite'));
  let historyReads = 0;
  const beforeCommitProxy = wrapDatabase(beforeCommit, {
    afterAll(sql) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();
      if (normalizedSql !== 'SELECT version, name, checksum FROM schema_migrations ORDER BY version') return;
      historyReads += 1;
      if (historyReads === 2) writeMigration(migrationsDir, filename, newSql);
    },
  });
  assert.throws(
    () => runV2Migrations(beforeCommitProxy, { migrationsDir }),
    (error) => assertMigrationError(error, 'MIGRATION_FILES_CHANGED'),
  );
  assert.equal(historyReads, 2);
  assert.equal(beforeCommit.inTransaction, false);
  assert.equal(beforeCommit.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'",
  ).get().count, 0);
});

test('rolls back the complete pending batch and leaves a copied legacy fixture reopenable', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  const legacyPath = path.join(root, 'legacy.sqlite');
  const candidatePath = path.join(root, 'candidate.sqlite');
  const legacy = openDatabase(workspace, legacyPath);
  legacy.exec('CREATE TABLE legacy_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  legacy.prepare('INSERT INTO legacy_items (value) VALUES (?)').run('preserved');
  legacy.close();
  fs.copyFileSync(legacyPath, candidatePath);

  writeMigration(migrationsDir, '0001_create_probe.sql', 'CREATE TABLE v2_probe (id INTEGER PRIMARY KEY);');
  writeMigration(migrationsDir, '0002_fail_mid_batch.sql', 'INSERT INTO missing_table (id) VALUES (1);');
  const candidate = openDatabase(workspace, candidatePath);

  assert.throws(
    () => runV2Migrations(candidate, { migrationsDir }),
    (error) => assertMigrationError(error, 'MIGRATION_EXECUTION_FAILED'),
  );
  assert.equal(candidate.inTransaction, false);
  assert.equal(candidate.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('schema_migrations', 'v2_probe')",
  ).get().count, 0);
  assert.deepEqual(candidate.prepare('SELECT value FROM legacy_items').all(), [{ value: 'preserved' }]);
  candidate.close();

  const reopened = openDatabase(workspace, candidatePath);
  assert.deepEqual(reopened.prepare('SELECT value FROM legacy_items').all(), [{ value: 'preserved' }]);
  reopened.close();

  const original = openDatabase(workspace, legacyPath);
  assert.deepEqual(original.prepare('SELECT value FROM legacy_items').all(), [{ value: 'preserved' }]);
  original.close();
});

test('acquires a SQLite write reservation before touching the migration ledger', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  const databasePath = path.join(root, 'locked.sqlite');
  writeMigration(migrationsDir, '0001_create_probe.sql', 'CREATE TABLE v2_probe (id INTEGER PRIMARY KEY);');
  const locker = openDatabase(workspace, databasePath);
  const contender = openDatabase(workspace, databasePath);

  locker.exec('BEGIN IMMEDIATE');
  assert.throws(
    () => runV2Migrations(contender, { migrationsDir }),
    (error) => assertMigrationError(error, 'MIGRATION_LOCK_FAILED'),
  );
  assert.equal(contender.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get().count, 0);

  locker.exec('ROLLBACK');
  assert.deepEqual(runV2Migrations(contender, { migrationsDir }).appliedVersions, [1]);
});

test('rejects a migration history that is not an exact prefix of local files', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  writeMigration(migrationsDir, '0001_create_notes.sql', 'CREATE TABLE v2_notes (id INTEGER PRIMARY KEY);');
  writeMigration(migrationsDir, '0002_add_body.sql', 'ALTER TABLE v2_notes ADD COLUMN body TEXT;');
  const database = openDatabase(workspace, path.join(root, 'project.sqlite'));
  runV2Migrations(database, { migrationsDir });
  database.prepare('DELETE FROM schema_migrations WHERE version = 1').run();

  assert.throws(
    () => runV2Migrations(database, { migrationsDir }),
    (error) => assertMigrationError(error, 'MIGRATION_HISTORY_MISMATCH'),
  );
  assert.equal(database.inTransaction, false);
});

test('rejects SQL that can escape the runner-owned transaction before database mutation', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  writeMigration(
    migrationsDir,
    '0001_escape_transaction.sql',
    'CREATE TABLE v2_probe (id INTEGER PRIMARY KEY); COMMIT;',
  );
  const database = openDatabase(workspace, path.join(root, 'project.sqlite'));

  assert.throws(
    () => runV2Migrations(database, { migrationsDir }),
    (error) => assertMigrationError(error, 'INVALID_MIGRATION_SQL'),
  );
  assert.equal(database.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'",
  ).get().count, 0);
});

test('does not adopt or roll back a caller-owned transaction', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  writeMigration(migrationsDir, '0001_create_probe.sql', 'CREATE TABLE v2_probe (id INTEGER PRIMARY KEY);');
  const database = openDatabase(workspace, path.join(root, 'project.sqlite'));
  database.exec('BEGIN');

  assert.throws(
    () => runV2Migrations(database, { migrationsDir }),
    (error) => assertMigrationError(error, 'NESTED_MIGRATION_TRANSACTION'),
  );
  assert.equal(database.inTransaction, true);
  database.exec('ROLLBACK');
});

test('rejects migration SQL that targets the runner-owned ledger', (t) => {
  const { migrationsDir } = createWorkspace(t);
  writeMigration(
    migrationsDir,
    '0001_tamper_ledger.sql',
    'DELETE FROM "schema_migrations";',
  );

  assert.throws(
    () => discoverV2Migrations(migrationsDir),
    (error) => assertMigrationError(error, 'INVALID_MIGRATION_SQL'),
  );
});

test('revalidates the complete ledger before commit and rolls back indirect trigger tampering', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  writeMigration(
    migrationsDir,
    '0001_create_sink.sql',
    'CREATE TABLE legacy_sink (id INTEGER PRIMARY KEY);',
  );
  const database = openDatabase(workspace, path.join(root, 'project.sqlite'));
  runV2Migrations(database, { migrationsDir });
  database.exec(`
    CREATE TRIGGER tamper_migration_ledger
    AFTER INSERT ON legacy_sink
    BEGIN
      DELETE FROM schema_migrations WHERE version = 1;
    END
  `);
  writeMigration(
    migrationsDir,
    '0002_activate_legacy_trigger.sql',
    'INSERT INTO legacy_sink DEFAULT VALUES;',
  );

  assert.throws(
    () => runV2Migrations(database, { migrationsDir }),
    (error) => assertMigrationError(error, 'MIGRATION_HISTORY_MISMATCH'),
  );
  assert.deepEqual(database.prepare('SELECT version FROM schema_migrations').all(), [{ version: 1 }]);
  assert.equal(database.prepare('SELECT count(*) AS count FROM legacy_sink').get().count, 0);
});

test('requires foreign keys and check constraints before any durable mutation', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  writeMigration(migrationsDir, '0001_create_probe.sql', 'CREATE TABLE v2_probe (id INTEGER PRIMARY KEY);');
  const foreignKeysOff = openDatabase(workspace, path.join(root, 'foreign-keys-off.sqlite'));
  foreignKeysOff.pragma('foreign_keys = OFF');

  assert.throws(
    () => runV2Migrations(foreignKeysOff, { migrationsDir }),
    (error) => assertMigrationError(error, 'UNSAFE_DATABASE_CONNECTION'),
  );
  assert.equal(foreignKeysOff.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE name = 'schema_migrations'",
  ).get().count, 0);

  const checksOff = openDatabase(workspace, path.join(root, 'checks-off.sqlite'));
  checksOff.pragma('ignore_check_constraints = ON');
  assert.throws(
    () => runV2Migrations(checksOff, { migrationsDir }),
    (error) => assertMigrationError(error, 'UNSAFE_DATABASE_CONNECTION'),
  );
  assert.equal(checksOff.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE name = 'schema_migrations'",
  ).get().count, 0);
});

test('rejects writable schema mode and direct sqlite schema access', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  writeMigration(
    migrationsDir,
    '0001_rewrite_schema.sql',
    "UPDATE sqlite_schema SET sql = 'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)' WHERE name = 'schema_migrations';",
  );
  assert.throws(
    () => discoverV2Migrations(migrationsDir),
    (error) => assertMigrationError(error, 'INVALID_MIGRATION_SQL'),
  );

  fs.rmSync(path.join(migrationsDir, '0001_rewrite_schema.sql'));
  writeMigration(migrationsDir, '0001_create_probe.sql', 'CREATE TABLE v2_probe (id INTEGER PRIMARY KEY);');
  const database = openDatabase(workspace, path.join(root, 'writable-schema.sqlite'));
  database.unsafeMode(true);
  database.pragma('writable_schema = ON');
  assert.throws(
    () => runV2Migrations(database, { migrationsDir }),
    (error) => assertMigrationError(error, 'UNSAFE_DATABASE_CONNECTION'),
  );
  assert.equal(database.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE name = 'schema_migrations'",
  ).get().count, 0);
  database.pragma('writable_schema = OFF');
  database.unsafeMode(false);
});

test('rejects a previously corrupted ledger definition after the database reopens', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  const databasePath = path.join(root, 'corrupted-ledger.sqlite');
  writeMigration(migrationsDir, '0001_create_probe.sql', 'CREATE TABLE v2_probe (id INTEGER PRIMARY KEY);');
  const database = openDatabase(workspace, databasePath);
  runV2Migrations(database, { migrationsDir });
  database.unsafeMode(true);
  database.pragma('writable_schema = ON');
  database.prepare(`
    UPDATE sqlite_schema
    SET sql = 'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)'
    WHERE type = 'table' AND name = 'schema_migrations'
  `).run();
  database.pragma('writable_schema = OFF');
  database.unsafeMode(false);
  database.close();

  const reopened = openDatabase(workspace, databasePath);
  assert.throws(
    () => runV2Migrations(reopened, { migrationsDir }),
    (error) => assertMigrationError(error, 'MIGRATION_HISTORY_MISMATCH'),
  );
  assert.equal(reopened.inTransaction, false);
});

test('rejects temporary migrations and pre-attached sidecar databases', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  writeMigration(migrationsDir, '0001_temp_probe.sql', 'CREATE TEMP TABLE ephemeral_v2 (id INTEGER PRIMARY KEY);');
  assert.throws(
    () => discoverV2Migrations(migrationsDir),
    (error) => assertMigrationError(error, 'INVALID_MIGRATION_SQL'),
  );

  fs.rmSync(path.join(migrationsDir, '0001_temp_probe.sql'));
  writeMigration(migrationsDir, '0001_quoted_temp_probe.sql', 'CREATE TABLE "temp".ephemeral_v2 (id INTEGER);');
  assert.throws(
    () => discoverV2Migrations(migrationsDir),
    (error) => assertMigrationError(error, 'INVALID_MIGRATION_SQL'),
  );

  fs.rmSync(path.join(migrationsDir, '0001_quoted_temp_probe.sql'));
  writeMigration(migrationsDir, '0001_create_probe.sql', 'CREATE TABLE main.v2_probe (id INTEGER PRIMARY KEY);');
  const database = openDatabase(workspace, path.join(root, 'main.sqlite'));
  const sidecarPath = path.join(root, 'sidecar.sqlite').replaceAll("'", "''");
  database.exec(`ATTACH DATABASE '${sidecarPath}' AS aux`);
  assert.throws(
    () => runV2Migrations(database, { migrationsDir }),
    (error) => assertMigrationError(error, 'UNSAFE_DATABASE_CONNECTION'),
  );
  assert.equal(database.prepare(
    "SELECT count(*) AS count FROM main.sqlite_master WHERE name = 'schema_migrations'",
  ).get().count, 0);
  database.exec('DETACH DATABASE aux');
});

test('allows SQLite to materialize an empty temp schema during a main-table rename', (t) => {
  const workspace = createWorkspace(t);
  writeMigration(workspace.migrationsDir, '0001_rename_legacy_table.sql', `
    CREATE TABLE legacy_items (id INTEGER PRIMARY KEY);
    ALTER TABLE legacy_items RENAME TO archived_items;
  `);
  const database = openDatabase(workspace, path.join(workspace.root, 'rename.sqlite'));

  const result = runV2Migrations(database, { migrationsDir: workspace.migrationsDir });

  assert.deepEqual(result.appliedVersions, [1]);
  assert.equal(database.prepare(`
    SELECT count(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name = 'archived_items'
  `).get().count, 1);
  assert.equal(database.prepare('SELECT count(*) AS count FROM temp.sqlite_schema').get().count, 0);
});

test('rejects a migrations directory reached through a symbolic link or junction', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  writeMigration(migrationsDir, '0001_create_probe.sql', 'CREATE TABLE v2_probe (id INTEGER PRIMARY KEY);');
  const linkedDir = path.join(root, 'linked-migrations');
  fs.symlinkSync(migrationsDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(
    () => discoverV2Migrations(linkedDir),
    (error) => assertMigrationError(error, 'INVALID_MIGRATION_DIRECTORY'),
  );
});

test('requires migration versions to start at one and remain contiguous', (t) => {
  const { migrationsDir } = createWorkspace(t);
  writeMigration(migrationsDir, '0002_first.sql', 'SELECT 2;');
  assert.throws(
    () => discoverV2Migrations(migrationsDir),
    (error) => assertMigrationError(error, 'MIGRATION_VERSION_GAP'),
  );

  fs.rmSync(path.join(migrationsDir, '0002_first.sql'));
  writeMigration(migrationsDir, '0001_first.sql', 'SELECT 1;');
  writeMigration(migrationsDir, '0003_third.sql', 'SELECT 3;');
  assert.throws(
    () => discoverV2Migrations(migrationsDir),
    (error) => assertMigrationError(error, 'MIGRATION_VERSION_GAP'),
  );
});

test('accepts trigger bodies and quoted identifiers containing semicolons or keywords', (t) => {
  const workspace = createWorkspace(t);
  const { root, migrationsDir } = workspace;
  writeMigration(migrationsDir, '0001_create_trigger.sql', `
    CREATE TABLE main.trigger_source (id INTEGER PRIMARY KEY);
    CREATE TABLE main.trigger_audit (source_id INTEGER NOT NULL);
    CREATE TRIGGER main.audit_source_insert
    AFTER INSERT ON trigger_source
    BEGIN
      INSERT INTO trigger_audit (source_id) VALUES (NEW.id);
    END;
    CREATE TABLE main."safe; COMMIT; identifier" (id INTEGER PRIMARY KEY);
  `);
  writeMigration(migrationsDir, '0002_activate_trigger.sql', 'INSERT INTO main.trigger_source DEFAULT VALUES;');
  const database = openDatabase(workspace, path.join(root, 'project.sqlite'));

  assert.deepEqual(runV2Migrations(database, { migrationsDir }).appliedVersions, [1, 2]);
  assert.deepEqual(database.prepare('SELECT source_id FROM trigger_audit').all(), [{ source_id: 1 }]);
  assert.equal(database.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE name = 'safe; COMMIT; identifier'",
  ).get().count, 1);
});

test('rejects invalid filenames and duplicate numeric versions', (t) => {
  const { migrationsDir } = createWorkspace(t);
  writeMigration(migrationsDir, '1_bad.sql', 'SELECT 1;');
  assert.throws(
    () => discoverV2Migrations(migrationsDir),
    (error) => assertMigrationError(error, 'INVALID_MIGRATION_FILENAME'),
  );

  fs.rmSync(path.join(migrationsDir, '1_bad.sql'));
  writeMigration(migrationsDir, '0001_first.sql', 'SELECT 1;');
  writeMigration(migrationsDir, '0001_second.sql', 'SELECT 2;');
  assert.throws(
    () => discoverV2Migrations(migrationsDir),
    (error) => assertMigrationError(error, 'DUPLICATE_MIGRATION_VERSION'),
  );
});
