const {
  V2RepositoryConflictError,
  V2RepositoryNotFoundError,
} = require('./errors');

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    throw new TypeError('createV2Repositories requires a synchronous SQLite database adapter');
  }
}

function assertAllowedKeys(value, allowedKeys, entity) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${entity} input must be an object`);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${entity} input has unsupported field ${key}`);
  }
}

function requiredRow(row, entity, uid) {
  if (!row) throw new V2RepositoryNotFoundError(entity, uid);
  return row;
}

function isConstraintError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT');
}

function executeWrite(entity, operation, callback) {
  try {
    return callback();
  } catch (error) {
    if (isConstraintError(error)) {
      throw new V2RepositoryConflictError(entity, operation);
    }
    throw error;
  }
}

function optimisticResult({ changes, exists, entity, uid, operation }) {
  if (changes > 0) return;
  if (!exists()) throw new V2RepositoryNotFoundError(entity, uid);
  throw new V2RepositoryConflictError(entity, operation);
}

module.exports = {
  assertAllowedKeys,
  assertDatabase,
  executeWrite,
  optimisticResult,
  requiredRow,
};
