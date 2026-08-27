const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

const BACKUP_SCHEMA_VERSION = '1.0.0';
const ERROR_MESSAGE = 'A verified pre-v2 migration backup could not be prepared';
const GENERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECOVERY_TABLE = 'v2_migration_recovery';

class V2MigrationBackupError extends Error {
  constructor() {
    super(ERROR_MESSAGE);
    this.name = 'V2MigrationBackupError';
    Object.defineProperty(this, 'code', {
      configurable: false,
      enumerable: true,
      value: 'V2_MIGRATION_BACKUP_INVALID',
      writable: false,
    });
    Object.freeze(this);
  }
}

function backupError() {
  return new V2MigrationBackupError();
}

function getMigrationBackupPaths(databasePath) {
  const resolved = path.resolve(databasePath);
  return Object.freeze({
    database: `${resolved}.pre-v2.sqlite`,
    manifest: `${resolved}.pre-v2.manifest.json`,
  });
}

function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function fsyncFile(filename) {
  const handle = fs.openSync(filename, 'r+');
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function removeCreatedFile(filename) {
  try {
    fs.unlinkSync(filename);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function readManifest(filename) {
  const text = fs.readFileSync(filename, 'utf8');
  const value = JSON.parse(text);
  const keys = Object.keys(value).sort();
  const expected = ['backupFile', 'bytes', 'createdAt', 'generationId', 'integrity', 'schemaVersion', 'sha256', 'sourceFile'].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw backupError();
  return value;
}

function verifyBackup(databasePath, paths) {
  if (!fs.existsSync(paths.database) || !fs.existsSync(paths.manifest)) throw backupError();
  const manifest = readManifest(paths.manifest);
  const stat = fs.statSync(paths.database);
  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION
    || manifest.sourceFile !== path.basename(databasePath)
    || manifest.backupFile !== path.basename(paths.database)
    || manifest.integrity !== 'ok'
    || typeof manifest.generationId !== 'string'
    || !GENERATION_ID.test(manifest.generationId)
    || !Number.isSafeInteger(manifest.bytes)
    || manifest.bytes !== stat.size
    || typeof manifest.createdAt !== 'string'
    || !Number.isFinite(Date.parse(manifest.createdAt))
    || !/^[0-9a-f]{64}$/.test(manifest.sha256)
    || hashFile(paths.database) !== manifest.sha256) throw backupError();

  const backup = new Database(paths.database, { readonly: true, fileMustExist: true });
  try {
    if (backup.pragma('integrity_check', { simple: true }) !== 'ok') throw backupError();
  } finally {
    backup.close();
  }
  return Object.freeze({ status: 'verified', paths, generationId: manifest.generationId });
}

function readRecoveryGeneration(database) {
  const exists = database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(RECOVERY_TABLE);
  if (!exists) return null;
  try {
    const row = database.prepare(`SELECT generation_id FROM ${RECOVERY_TABLE} WHERE singleton = 1`).get();
    return typeof row?.generation_id === 'string' && GENERATION_ID.test(row.generation_id)
      ? row.generation_id
      : null;
  } catch {
    return null;
  }
}

function installRecoveryGeneration(database, generationId) {
  const install = database.transaction(() => {
    database.exec(`
      CREATE TABLE ${RECOVERY_TABLE} (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )
    `);
    database.prepare(`
      INSERT INTO ${RECOVERY_TABLE} (singleton, generation_id, created_at)
      VALUES (1, ?, ?)
    `).run(generationId, new Date().toISOString());
  });
  install.immediate();
  if (readRecoveryGeneration(database) !== generationId) throw backupError();
}

function bindExistingBackup(database, databasePath, verified) {
  const currentGeneration = readRecoveryGeneration(database);
  if (currentGeneration === verified.generationId) return verified;
  if (currentGeneration !== null) throw backupError();
  if (hashFile(databasePath) !== hashFile(verified.paths.database)) throw backupError();
  installRecoveryGeneration(database, verified.generationId);
  return verified;
}

function hasUserSchema(database) {
  return database.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get() !== undefined;
}

function hasCurrentV2Ledger(database, latestVersion) {
  if (!Number.isSafeInteger(latestVersion) || latestVersion < 1) return false;
  const ledgerExists = database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  if (!ledgerExists) return false;
  try {
    return database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version >= latestVersion;
  } catch {
    return false;
  }
}

function ensurePreV2MigrationBackup(database, { latestVersion } = {}) {
  const databasePath = database?.name;
  if (typeof databasePath !== 'string' || databasePath === ':memory:' || databasePath.length === 0) {
    return Object.freeze({ status: 'not-required', reason: 'memory-database' });
  }
  if (!hasUserSchema(database)) return Object.freeze({ status: 'not-required', reason: 'empty-database' });

  const resolvedDatabasePath = path.resolve(databasePath);
  const paths = getMigrationBackupPaths(resolvedDatabasePath);
  const databaseExists = fs.existsSync(paths.database);
  const manifestExists = fs.existsSync(paths.manifest);
  if (databaseExists || manifestExists) {
    try {
      return bindExistingBackup(database, resolvedDatabasePath, verifyBackup(resolvedDatabasePath, paths));
    } catch {
      throw backupError();
    }
  }
  const currentGeneration = readRecoveryGeneration(database);
  if (hasCurrentV2Ledger(database, latestVersion)) {
    if (currentGeneration !== null) throw backupError();
    return Object.freeze({ status: 'not-required', reason: 'v2-current' });
  }
  if (currentGeneration !== null) throw backupError();

  const suffix = `${process.pid}-${crypto.randomUUID()}`;
  const tempDatabase = `${paths.database}.${suffix}.tmp`;
  const tempManifest = `${paths.manifest}.${suffix}.tmp`;
  let installedDatabase = false;
  let installedManifest = false;
  try {
    const generationId = crypto.randomUUID();
    const sqlPath = tempDatabase.replace(/'/g, "''");
    database.exec(`VACUUM INTO '${sqlPath}'`);
    fsyncFile(tempDatabase);
    const verify = new Database(tempDatabase, { readonly: true, fileMustExist: true });
    try {
      if (verify.pragma('integrity_check', { simple: true }) !== 'ok') throw backupError();
    } finally {
      verify.close();
    }

    const recovery = Object.freeze({
      schemaVersion: BACKUP_SCHEMA_VERSION,
      sourceFile: path.basename(resolvedDatabasePath),
      backupFile: path.basename(paths.database),
      createdAt: new Date().toISOString(),
      generationId,
      bytes: fs.statSync(tempDatabase).size,
      sha256: hashFile(tempDatabase),
      integrity: 'ok',
    });
    fs.writeFileSync(tempManifest, `${JSON.stringify(recovery, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fsyncFile(tempManifest);
    fs.copyFileSync(tempDatabase, paths.database, fs.constants.COPYFILE_EXCL);
    installedDatabase = true;
    fsyncFile(paths.database);
    fs.copyFileSync(tempManifest, paths.manifest, fs.constants.COPYFILE_EXCL);
    installedManifest = true;
    fsyncFile(paths.manifest);
    fsyncDirectory(path.dirname(paths.database));
    const verified = verifyBackup(resolvedDatabasePath, paths);
    installRecoveryGeneration(database, generationId);
    return verified;
  } catch (error) {
    try {
      if (installedManifest) removeCreatedFile(paths.manifest);
      if (installedDatabase) removeCreatedFile(paths.database);
      removeCreatedFile(tempManifest);
      removeCreatedFile(tempDatabase);
    } catch {
      // A partial recovery artifact is deliberately left visible; the next run fails closed.
    }
    if (error instanceof V2MigrationBackupError) throw error;
    throw backupError();
  } finally {
    try { removeCreatedFile(tempManifest); } catch {}
    try { removeCreatedFile(tempDatabase); } catch {}
  }
}

module.exports = {
  V2MigrationBackupError,
  ensurePreV2MigrationBackup,
  getMigrationBackupPaths,
};
