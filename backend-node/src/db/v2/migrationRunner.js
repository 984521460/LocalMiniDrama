const { V2MigrationError, migrationError } = require('./errors.js');
const { discoverV2Migrations } = require('./migrationFiles.js');

const CREATE_LEDGER_SQL = `CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`;
const EXPECTED_LEDGER_SQL = CREATE_LEDGER_SQL
  .replace(/\s+/g, ' ')
  .replace(/\s*([(),])\s*/g, '$1')
  .trim()
  .toUpperCase();

function readPragmaValue(database, name) {
  try {
    return database.pragma(name, { simple: true });
  } catch (cause) {
    throw migrationError('UNSAFE_DATABASE_CONNECTION', `Could not verify SQLite ${name}.`, cause);
  }
}

function assertSafeConnection(database) {
  if (readPragmaValue(database, 'foreign_keys') !== 1
    || readPragmaValue(database, 'ignore_check_constraints') !== 0
    || readPragmaValue(database, 'writable_schema') !== 0) {
    throw migrationError(
      'UNSAFE_DATABASE_CONNECTION',
      'v2 migrations require foreign keys and checks enabled with writable_schema disabled.',
    );
  }

  let databases;
  try {
    databases = database.pragma('database_list');
  } catch (cause) {
    throw migrationError('UNSAFE_DATABASE_CONNECTION', 'Could not verify attached SQLite databases.', cause);
  }
  const databaseNames = databases.map((entry) => entry.name);
  if (databaseNames[0] !== 'main'
    || databaseNames.some((name) => name !== 'main' && name !== 'temp')) {
    throw migrationError(
      'UNSAFE_DATABASE_CONNECTION',
      'v2 migrations require an isolated main database with no temp or attached schemas.',
    );
  }

  if (databaseNames.includes('temp')) {
    let tempObjectCount;
    try {
      tempObjectCount = database.prepare('SELECT count(*) AS count FROM temp.sqlite_schema').get().count;
    } catch (cause) {
      throw migrationError('UNSAFE_DATABASE_CONNECTION', 'Could not verify the SQLite temp schema.', cause);
    }
    if (tempObjectCount !== 0) {
      throw migrationError(
        'UNSAFE_DATABASE_CONNECTION',
        'v2 migrations require an isolated main database with no temp or attached schemas.',
      );
    }
  }
}

function assertDatabase(database) {
  if (!database || typeof database.exec !== 'function'
    || typeof database.prepare !== 'function' || typeof database.pragma !== 'function') {
    throw migrationError('INVALID_DATABASE', 'A synchronous SQLite database connection is required.');
  }
  if (database.inTransaction) {
    throw migrationError('NESTED_MIGRATION_TRANSACTION', 'v2 migrations require ownership of the transaction.');
  }
  assertSafeConnection(database);
}

function normalizeLedgerSql(sql) {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()
    .toUpperCase();
}

function assertLedgerDefinition(database) {
  let objects;
  let columns;
  try {
    objects = database.prepare(`
      SELECT type, name, tbl_name, sql
      FROM main.sqlite_schema
      WHERE name = 'schema_migrations' OR tbl_name = 'schema_migrations'
      ORDER BY type, name
    `).all();
    columns = database.prepare('PRAGMA main.table_xinfo(schema_migrations)').all();
  } catch (cause) {
    throw migrationError('MIGRATION_HISTORY_MISMATCH', 'The schema_migrations definition is unreadable.', cause);
  }

  if (objects.length !== 1 || objects[0].type !== 'table'
    || objects[0].name !== 'schema_migrations' || objects[0].tbl_name !== 'schema_migrations'
    || typeof objects[0].sql !== 'string'
    || normalizeLedgerSql(objects[0].sql) !== EXPECTED_LEDGER_SQL) {
    throw migrationError('MIGRATION_HISTORY_MISMATCH', 'The schema_migrations definition has drifted.');
  }

  const expectedColumns = [
    { name: 'version', type: 'INTEGER', notnull: 0, pk: 1, hidden: 0 },
    { name: 'name', type: 'TEXT', notnull: 1, pk: 0, hidden: 0 },
    { name: 'checksum', type: 'TEXT', notnull: 1, pk: 0, hidden: 0 },
    { name: 'applied_at', type: 'TEXT', notnull: 1, pk: 0, hidden: 0 },
  ];
  if (columns.length !== expectedColumns.length
    || columns.some((column, index) => {
      const expected = expectedColumns[index];
      return column.cid !== index || column.name !== expected.name || column.type !== expected.type
        || column.notnull !== expected.notnull || column.pk !== expected.pk
        || column.hidden !== expected.hidden || column.dflt_value !== null;
    })) {
    throw migrationError('MIGRATION_HISTORY_MISMATCH', 'The schema_migrations columns have drifted.');
  }
}

function ensureLedger(database) {
  let existing;
  try {
    existing = database.prepare(`
      SELECT count(*) AS count
      FROM main.sqlite_schema
      WHERE type = 'table' AND name = 'schema_migrations'
    `).get().count;
  } catch (cause) {
    throw migrationError('MIGRATION_HISTORY_MISMATCH', 'Could not inspect the migration ledger.', cause);
  }
  if (existing === 0) database.exec(CREATE_LEDGER_SQL);
  assertLedgerDefinition(database);
}

function validateAppliedHistory(appliedRows, migrations) {
  if (appliedRows.length > migrations.length) {
    throw migrationError('MIGRATION_HISTORY_MISMATCH', 'Database migration history is newer than local files.');
  }

  for (let index = 0; index < appliedRows.length; index += 1) {
    const applied = appliedRows[index];
    const local = migrations[index];
    if (!local || applied.version !== local.version || applied.name !== local.name) {
      throw migrationError(
        'MIGRATION_HISTORY_MISMATCH',
        'Database migration history is not an exact prefix of local files.',
      );
    }
    if (applied.checksum !== local.checksum) {
      throw migrationError(
        'MIGRATION_CHECKSUM_MISMATCH',
        `Applied migration ${local.filename} no longer matches its recorded checksum.`,
      );
    }
  }
}

function readAppliedHistory(database) {
  try {
    return database.prepare(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    ).all();
  } catch (cause) {
    throw migrationError('MIGRATION_HISTORY_MISMATCH', 'The schema_migrations ledger is invalid.', cause);
  }
}

function rollback(database, originalError) {
  if (!database.inTransaction) {
    return originalError;
  }
  try {
    database.exec('ROLLBACK');
    return originalError;
  } catch (rollbackCause) {
    return migrationError(
      'MIGRATION_ROLLBACK_FAILED',
      'The migration failed and SQLite could not confirm rollback.',
      rollbackCause,
    );
  }
}

function beginImmediate(database) {
  try {
    database.exec('BEGIN IMMEDIATE');
  } catch (cause) {
    throw migrationError(
      'MIGRATION_LOCK_FAILED',
      'Could not acquire the SQLite migration write reservation.',
      cause,
    );
  }
}

function assertMigrationSnapshotUnchanged(migrationsDir, expectedMigrations) {
  let currentMigrations;
  try {
    currentMigrations = discoverV2Migrations(migrationsDir);
  } catch (cause) {
    throw migrationError(
      'MIGRATION_FILES_CHANGED',
      'The v2 migration files changed while the migration batch was running.',
      cause,
    );
  }

  const changed = currentMigrations.length !== expectedMigrations.length
    || currentMigrations.some((current, index) => {
      const expected = expectedMigrations[index];
      return !expected || current.version !== expected.version || current.name !== expected.name
        || current.filename !== expected.filename || current.checksum !== expected.checksum
        || current.sql !== expected.sql;
    });
  if (changed) {
    throw migrationError(
      'MIGRATION_FILES_CHANGED',
      'The v2 migration files changed while the migration batch was running.',
    );
  }
}

function runV2Migrations(database, options = {}) {
  assertDatabase(database);
  const migrations = discoverV2Migrations(options.migrationsDir);
  beginImmediate(database);

  try {
    assertSafeConnection(database);
    assertMigrationSnapshotUnchanged(options.migrationsDir, migrations);
    ensureLedger(database);
    const appliedRows = readAppliedHistory(database);
    validateAppliedHistory(appliedRows, migrations);

    const recordMigration = database.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (@version, @name, @checksum, @appliedAt)
    `);
    const appliedVersions = [];

    for (let index = appliedRows.length; index < migrations.length; index += 1) {
      const migration = migrations[index];
      try {
        database.exec(migration.sql);
        recordMigration.run({
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
          appliedAt: new Date().toISOString(),
        });
      } catch (cause) {
        throw migrationError(
          'MIGRATION_EXECUTION_FAILED',
          `Migration ${migration.filename} failed.`,
          cause,
        );
      }
      appliedVersions.push(migration.version);
    }

    assertSafeConnection(database);
    assertLedgerDefinition(database);
    const finalRows = readAppliedHistory(database);
    validateAppliedHistory(finalRows, migrations);
    if (finalRows.length !== migrations.length) {
      throw migrationError(
        'MIGRATION_HISTORY_MISMATCH',
        'The schema_migrations ledger changed while the migration batch was running.',
      );
    }
    assertMigrationSnapshotUnchanged(options.migrationsDir, migrations);

    try {
      database.exec('COMMIT');
    } catch (cause) {
      throw migrationError('MIGRATION_COMMIT_FAILED', 'SQLite could not commit the migration batch.', cause);
    }

    return Object.freeze({
      appliedVersions: Object.freeze(appliedVersions),
      currentVersion: migrations.at(-1)?.version ?? 0,
    });
  } catch (error) {
    const migrationFailure = error instanceof V2MigrationError
      ? error
      : migrationError('MIGRATION_EXECUTION_FAILED', 'The v2 migration batch failed.', error);
    throw rollback(database, migrationFailure);
  }
}

module.exports = {
  runV2Migrations,
};
