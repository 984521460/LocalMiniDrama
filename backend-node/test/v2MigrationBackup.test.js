const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  ensurePreV2MigrationBackup,
  getMigrationBackupPaths,
} = require('../src/db/v2/migrationBackup');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-v2-backup-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

test('startup creates and verifies a recoverable pre-v2 database backup before mutation', (t) => {
  const root = tempRoot(t);
  const databasePath = path.join(root, 'legacy.sqlite');
  let database = new Database(databasePath);
  database.exec('CREATE TABLE legacy_probe (value TEXT NOT NULL); INSERT INTO legacy_probe VALUES (\'before-v2\')');

  runMigrationsAndEnsure(database);
  const paths = getMigrationBackupPaths(databasePath);
  assert.equal(fs.existsSync(paths.database), true);
  assert.equal(fs.existsSync(paths.manifest), true);
  const recovery = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
  assert.equal(recovery.schemaVersion, '1.0.0');
  assert.equal(recovery.sourceFile, path.basename(databasePath));
  assert.equal(recovery.backupFile, path.basename(paths.database));
  assert.match(recovery.generationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(recovery.sha256, /^[0-9a-f]{64}$/);
  assert.equal(recovery.integrity, 'ok');

  const backup = new Database(paths.database, { readonly: true, fileMustExist: true });
  assert.equal(backup.prepare('SELECT value FROM legacy_probe').pluck().get(), 'before-v2');
  assert.equal(backup.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'").pluck().get(), 0);
  backup.close();
  assert.equal(database.prepare('SELECT count(*) FROM schema_migrations').pluck().get(), 32);

  const firstBackupStat = fs.statSync(paths.database);
  runMigrationsAndEnsure(database);
  assert.equal(fs.statSync(paths.database).mtimeMs, firstBackupStat.mtimeMs);
  database.close();
  database = null;
});

test('backup creation fails closed on inconsistent pre-existing recovery artifacts and exempts memory databases', (t) => {
  const memory = new Database(':memory:');
  t.after(() => memory.close());
  assert.deepEqual(ensurePreV2MigrationBackup(memory), { status: 'not-required', reason: 'memory-database' });

  const root = tempRoot(t);
  const databasePath = path.join(root, 'legacy.sqlite');
  const database = new Database(databasePath);
  database.exec('CREATE TABLE legacy_probe (value TEXT NOT NULL)');
  const paths = getMigrationBackupPaths(databasePath);
  fs.writeFileSync(paths.database, Buffer.from('corrupt-existing-backup'));
  fs.writeFileSync(paths.manifest, JSON.stringify({ schemaVersion: '1.0.0' }));
  assert.throws(
    () => ensurePreV2MigrationBackup(database),
    (error) => error.code === 'V2_MIGRATION_BACKUP_INVALID' && !error.message.includes(databasePath),
  );
  assert.equal(database.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'").pluck().get(), 0);
  database.close();
});

test('a recovery point is bound to its database generation and rejects same-path replacement', (t) => {
  const root = tempRoot(t);
  const databasePath = path.join(root, 'project.sqlite');
  const displacedPath = path.join(root, 'project-a.sqlite');
  const replacementPath = path.join(root, 'project-b.sqlite');
  const first = new Database(databasePath);
  first.exec("CREATE TABLE project_identity (value TEXT NOT NULL); INSERT INTO project_identity VALUES ('database-a')");
  assert.equal(ensurePreV2MigrationBackup(first, { latestVersion: 2 }).status, 'verified');
  first.close();

  const replacement = new Database(replacementPath);
  replacement.exec("CREATE TABLE project_identity (value TEXT NOT NULL); INSERT INTO project_identity VALUES ('database-b')");
  replacement.close();
  fs.renameSync(databasePath, displacedPath);
  fs.renameSync(replacementPath, databasePath);

  const second = new Database(databasePath);
  assert.throws(
    () => ensurePreV2MigrationBackup(second, { latestVersion: 2 }),
    (error) => error.code === 'V2_MIGRATION_BACKUP_INVALID',
  );
  assert.equal(second.prepare('SELECT value FROM project_identity').pluck().get(), 'database-b');
  second.close();
});

test('an exact recovery database can be restored and rebound to its recovery point', (t) => {
  const root = tempRoot(t);
  const databasePath = path.join(root, 'project.sqlite');
  const database = new Database(databasePath);
  database.exec("CREATE TABLE project_identity (value TEXT NOT NULL); INSERT INTO project_identity VALUES ('recoverable')");
  const verified = ensurePreV2MigrationBackup(database, { latestVersion: 2 });
  database.close();

  fs.copyFileSync(verified.paths.database, databasePath);
  const restored = new Database(databasePath);
  assert.equal(ensurePreV2MigrationBackup(restored, { latestVersion: 2 }).status, 'verified');
  assert.equal(restored.prepare('SELECT value FROM project_identity').pluck().get(), 'recoverable');
  assert.equal(
    restored.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='v2_migration_recovery'").pluck().get(),
    1,
  );
  restored.close();
});
