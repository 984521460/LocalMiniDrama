const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const { migrationError } = require('./errors.js');

const MIGRATION_FILENAME = /^(\d{4})_([a-z][a-z0-9_-]*)\.sql$/;
const FORBIDDEN_SQL_WORDS = new Set([
  'ATTACH',
  'COMMIT',
  'DETACH',
  'PRAGMA',
  'RELEASE',
  'ROLLBACK',
  'SAVEPOINT',
  'VACUUM',
]);
const PROTECTED_SCHEMA_NAMES = new Set([
  'schema_migrations',
  'sqlite_master',
  'sqlite_schema',
  'sqlite_temp_master',
  'sqlite_temp_schema',
]);

function decodeUtf8(buffer, filename) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (cause) {
    throw migrationError('INVALID_MIGRATION_ENCODING', `Migration ${filename} is not valid UTF-8.`, cause);
  }
}

function readQuotedToken(sql, start, closing, type) {
  let value = '';
  for (let index = start + 1; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === closing) {
      if (next === closing) {
        value += closing;
        index += 1;
        continue;
      }
      return { token: { type, value }, end: index };
    }
    value += char;
  }
  throw migrationError('INVALID_MIGRATION_SQL', 'Migration SQL contains an unterminated quoted value.');
}

function tokenizeSql(sql) {
  const tokens = [];
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (/\s/.test(char)) continue;
    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = sql.indexOf('*/', index + 2);
      if (close < 0) {
        throw migrationError('INVALID_MIGRATION_SQL', 'Migration SQL contains an unterminated comment.');
      }
      index = close + 1;
      continue;
    }
    if (char === "'") {
      const quoted = readQuotedToken(sql, index, "'", 'string');
      tokens.push(quoted.token);
      index = quoted.end;
      continue;
    }
    if (char === '"' || char === '`') {
      const quoted = readQuotedToken(sql, index, char, 'identifier');
      tokens.push(quoted.token);
      index = quoted.end;
      continue;
    }
    if (char === '[') {
      const quoted = readQuotedToken(sql, index, ']', 'identifier');
      tokens.push(quoted.token);
      index = quoted.end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      tokens.push({ type: 'word', value: sql.slice(index, end) });
      index = end - 1;
      continue;
    }
    if (char === ';') {
      tokens.push({ type: 'semicolon', value: char });
      continue;
    }
    if (char === '.') {
      tokens.push({ type: 'dot', value: char });
      continue;
    }
    tokens.push({ type: 'symbol', value: char });
  }
  return tokens;
}

function validateMigrationSql(sql, filename) {
  if (sql.trim().length === 0) {
    throw migrationError('INVALID_MIGRATION_SQL', `Migration ${filename} is empty.`);
  }

  const tokens = tokenizeSql(sql);
  let atStatementStart = true;
  let inTriggerHeader = false;
  let inTriggerBody = false;
  let triggerComplete = false;
  let caseDepth = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const normalized = token.value.toLowerCase();
    const next = tokens[index + 1];

    if ((token.type === 'word' || token.type === 'identifier')
      && PROTECTED_SCHEMA_NAMES.has(normalized)) {
      throw migrationError(
        'INVALID_MIGRATION_SQL',
        `Migration ${filename} may not access SQLite schema internals or the migration ledger.`,
      );
    }
    if (token.type === 'string' && PROTECTED_SCHEMA_NAMES.has(normalized)) {
      throw migrationError(
        'INVALID_MIGRATION_SQL',
        `Migration ${filename} may not quote SQLite schema internals as an object name.`,
      );
    }
    if ((token.type === 'word' || token.type === 'identifier')
      && normalized === 'temp' && next?.type === 'dot') {
      throw migrationError('INVALID_MIGRATION_SQL', `Migration ${filename} may only target main.`);
    }

    if (token.type === 'semicolon') {
      if (!inTriggerBody) {
        atStatementStart = true;
        inTriggerHeader = false;
        triggerComplete = false;
        caseDepth = 0;
      }
      continue;
    }
    if (token.type !== 'word') {
      atStatementStart = false;
      continue;
    }

    const keyword = token.value.toUpperCase();
    if (keyword === 'TEMP' || keyword === 'TEMPORARY') {
      throw migrationError('INVALID_MIGRATION_SQL', `Migration ${filename} may not create temporary objects.`);
    }
    if (FORBIDDEN_SQL_WORDS.has(keyword)) {
      throw migrationError(
        'INVALID_MIGRATION_SQL',
        `Migration ${filename} contains runner-owned transaction or connection control.`,
      );
    }

    if (atStatementStart && keyword === 'CREATE') {
      const nextWord = tokens.slice(index + 1).find((candidate) => candidate.type !== 'symbol');
      inTriggerHeader = nextWord?.type === 'word' && nextWord.value.toUpperCase() === 'TRIGGER';
    }
    if (keyword === 'CASE') {
      caseDepth += 1;
    } else if (keyword === 'BEGIN') {
      if (!inTriggerHeader || inTriggerBody || triggerComplete) {
        throw migrationError('INVALID_MIGRATION_SQL', `Migration ${filename} may not control transactions.`);
      }
      inTriggerBody = true;
    } else if (keyword === 'END') {
      if (caseDepth > 0) {
        caseDepth -= 1;
      } else if (inTriggerBody) {
        inTriggerBody = false;
        inTriggerHeader = false;
        triggerComplete = true;
      } else {
        throw migrationError('INVALID_MIGRATION_SQL', `Migration ${filename} may not control transactions.`);
      }
    }
    atStatementStart = false;
  }

  if (inTriggerBody || inTriggerHeader || caseDepth > 0) {
    throw migrationError('INVALID_MIGRATION_SQL', `Migration ${filename} has an incomplete SQL block.`);
  }
}

function comparablePath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function assertTrustedDirectory(absoluteDir) {
  let stat;
  let realPath;
  try {
    stat = fs.lstatSync(absoluteDir);
    realPath = fs.realpathSync.native(absoluteDir);
  } catch (cause) {
    throw migrationError('INVALID_MIGRATION_DIRECTORY', 'The v2 migrations directory is not readable.', cause);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || comparablePath(realPath) !== comparablePath(absoluteDir)) {
    throw migrationError(
      'INVALID_MIGRATION_DIRECTORY',
      'The v2 migrations directory must be a physical directory without symbolic links or junctions.',
    );
  }
  return { stat, realPath };
}

function assertDirectoryUnchanged(absoluteDir, expected) {
  const current = assertTrustedDirectory(absoluteDir);
  if (!sameFileIdentity(current.stat, expected.stat)
    || comparablePath(current.realPath) !== comparablePath(expected.realPath)) {
    throw migrationError('INVALID_MIGRATION_DIRECTORY', 'The v2 migrations directory changed while reading.');
  }
}

function readRegularMigrationFile(absoluteDir, trustedDirectory, filename) {
  const fullPath = path.join(absoluteDir, filename);
  let before;
  let fileDescriptor;
  try {
    before = fs.lstatSync(fullPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw migrationError('INVALID_MIGRATION_FILE', `Migration ${filename} must be a physical regular file.`);
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    fileDescriptor = fs.openSync(fullPath, flags);
    const opened = fs.fstatSync(fileDescriptor);
    const realPath = fs.realpathSync.native(fullPath);
    const relative = path.relative(trustedDirectory.realPath, realPath);
    if (!opened.isFile() || !sameFileIdentity(before, opened)
      || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw migrationError('INVALID_MIGRATION_FILE', `Migration ${filename} changed identity or escaped its directory.`);
    }
    const bytes = fs.readFileSync(fileDescriptor);
    const after = fs.lstatSync(fullPath);
    if (!sameFileIdentity(opened, after)) {
      throw migrationError('INVALID_MIGRATION_FILE', `Migration ${filename} changed while reading.`);
    }
    assertDirectoryUnchanged(absoluteDir, trustedDirectory);
    return bytes;
  } catch (cause) {
    if (cause?.code && cause instanceof Error && cause.name === 'V2MigrationError') throw cause;
    throw migrationError('INVALID_MIGRATION_FILE', `Migration ${filename} is not safely readable.`, cause);
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
  }
}

function discoverV2Migrations(migrationsDir) {
  if (typeof migrationsDir !== 'string' || migrationsDir.trim().length === 0) {
    throw migrationError('INVALID_MIGRATION_DIRECTORY', 'A v2 migrations directory is required.');
  }

  const absoluteDir = path.resolve(migrationsDir);
  const trustedDirectory = assertTrustedDirectory(absoluteDir);
  let entries;
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch (cause) {
    throw migrationError('INVALID_MIGRATION_DIRECTORY', 'The v2 migrations directory is not readable.', cause);
  }

  const seenVersions = new Set();
  const migrations = [];

  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith('.sql')) {
      continue;
    }
    if (!entry.isFile()) {
      throw migrationError('INVALID_MIGRATION_FILE', `Migration ${entry.name} must be a regular file.`);
    }

    const match = MIGRATION_FILENAME.exec(entry.name);
    if (!match) {
      throw migrationError(
        'INVALID_MIGRATION_FILENAME',
        `Migration ${entry.name} must use NNNN_lowercase_name.sql.`,
      );
    }

    const version = Number.parseInt(match[1], 10);
    if (version <= 0) {
      throw migrationError('INVALID_MIGRATION_FILENAME', `Migration ${entry.name} must have a positive version.`);
    }
    if (seenVersions.has(version)) {
      throw migrationError('DUPLICATE_MIGRATION_VERSION', `Migration version ${version} is duplicated.`);
    }
    seenVersions.add(version);

    const bytes = readRegularMigrationFile(absoluteDir, trustedDirectory, entry.name);
    const sql = decodeUtf8(bytes, entry.name);
    validateMigrationSql(sql, entry.name);

    migrations.push(Object.freeze({
      version,
      name: match[2],
      filename: entry.name,
      checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
      sql,
    }));
  }

  migrations.sort((left, right) => left.version - right.version);
  for (let index = 0; index < migrations.length; index += 1) {
    const expectedVersion = index + 1;
    if (migrations[index].version !== expectedVersion) {
      throw migrationError(
        'MIGRATION_VERSION_GAP',
        `Migration versions must be contiguous from 0001; expected ${String(expectedVersion).padStart(4, '0')}.`,
      );
    }
  }
  return Object.freeze(migrations);
}

module.exports = {
  discoverV2Migrations,
  validateMigrationSql,
};
