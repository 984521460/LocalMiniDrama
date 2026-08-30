'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMP_WORKSPACE_ERROR = 'TEMP_WORKSPACE_INVALID';
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

class TempWorkspaceError extends Error {
  constructor() {
    super('Temporary workspace invalid');
    this.name = 'TempWorkspaceError';
    this.code = TEMP_WORKSPACE_ERROR;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

function invalid() {
  throw new TempWorkspaceError();
}

function comparable(value, pathImpl) {
  const resolved = pathImpl.resolve(value);
  return pathImpl.sep === '\\' ? resolved.toLowerCase() : resolved;
}

function physicalDirectorySnapshot(directory, fsImpl, pathImpl) {
  const resolved = pathImpl.resolve(directory);
  const stat = fsImpl.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  const real = fsImpl.realpathSync.native
    ? fsImpl.realpathSync.native(resolved)
    : fsImpl.realpathSync(resolved);
  if (comparable(real, pathImpl) !== comparable(resolved, pathImpl)) invalid();
  return Object.freeze({ resolved, dev: stat.dev, ino: stat.ino, mode: stat.mode });
}

function assertDirectorySnapshot(snapshot, fsImpl, pathImpl) {
  const current = physicalDirectorySnapshot(snapshot.resolved, fsImpl, pathImpl);
  if (current.dev !== snapshot.dev || current.ino !== snapshot.ino || current.mode !== snapshot.mode) {
    invalid();
  }
}

function createTempWorkspace(kind, {
  fsImpl = fs,
  pathImpl = path,
  tempRoot = os.tmpdir(),
} = {}) {
  if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) invalid();
  const temp = physicalDirectorySnapshot(tempRoot, fsImpl, pathImpl);
  const prefix = pathImpl.join(temp.resolved, `localminidrama-${kind}-`);
  let root;
  let task;
  try {
    root = fsImpl.mkdtempSync(prefix);
    task = physicalDirectorySnapshot(root, fsImpl, pathImpl);
    if (comparable(pathImpl.dirname(task.resolved), pathImpl) !== comparable(temp.resolved, pathImpl)) invalid();
    if (!pathImpl.basename(task.resolved).startsWith(`localminidrama-${kind}-`)) invalid();
    assertDirectorySnapshot(temp, fsImpl, pathImpl);
    assertDirectorySnapshot(task, fsImpl, pathImpl);

    let closed = false;
    const failureRollbacks = [];
    function resolveFile(fileName) {
      if (closed || typeof fileName !== 'string' || !FILE_PATTERN.test(fileName)
        || fileName === '.' || fileName === '..') invalid();
      assertDirectorySnapshot(temp, fsImpl, pathImpl);
      assertDirectorySnapshot(task, fsImpl, pathImpl);
      const candidate = pathImpl.resolve(task.resolved, fileName);
      if (comparable(pathImpl.dirname(candidate), pathImpl) !== comparable(task.resolved, pathImpl)) invalid();
      return candidate;
    }

    function cleanup() {
      if (closed) return true;
      try {
        assertDirectorySnapshot(temp, fsImpl, pathImpl);
        assertDirectorySnapshot(task, fsImpl, pathImpl);
        fsImpl.rmSync(task.resolved, { recursive: true, force: false, maxRetries: 0 });
        try {
          fsImpl.lstatSync(task.resolved);
          return false;
        } catch (error) {
          if (!error || error.code !== 'ENOENT') return false;
        }
        closed = true;
        return true;
      } catch (_) {
        return false;
      }
    }

    function registerFailureRollback(handler) {
      if (closed || typeof handler !== 'function') invalid();
      failureRollbacks.push(handler);
    }

    function rollbackFailures() {
      let ok = true;
      for (let index = failureRollbacks.length - 1; index >= 0; index -= 1) {
        try {
          failureRollbacks[index]();
        } catch (_) {
          ok = false;
        }
      }
      failureRollbacks.length = 0;
      return ok;
    }

    function clearFailureRollbacks() {
      failureRollbacks.length = 0;
    }

    return Object.freeze({
      clearFailureRollbacks,
      cleanup,
      kind,
      registerFailureRollback,
      resolveFile,
      rollbackFailures,
      root: task.resolved,
    });
  } catch (error) {
    if (root && task) {
      try {
        assertDirectorySnapshot(temp, fsImpl, pathImpl);
        assertDirectorySnapshot(task, fsImpl, pathImpl);
        fsImpl.rmSync(task.resolved, { recursive: true, force: false, maxRetries: 0 });
      } catch (_) {}
    }
    if (error instanceof TempWorkspaceError) throw error;
    invalid();
  }
}

async function withTempWorkspace(kind, log, operation, workspaceFactory = createTempWorkspace) {
  if (typeof operation !== 'function' || typeof workspaceFactory !== 'function') invalid();
  const workspace = workspaceFactory(kind);
  let result;
  let operationError = null;
  try {
    result = await operation(workspace);
  } catch (error) {
    operationError = error;
  }
  if (operationError !== null) {
    try { workspace.rollbackFailures?.(); } catch (_) {}
  }
  if (!workspace.cleanup()) {
    try { workspace.rollbackFailures?.(); } catch (_) {}
    try {
      log?.warn?.('temporary workspace cleanup failed', { kind });
    } catch (_) {}
    if (operationError === null) invalid();
  }
  if (operationError !== null) throw operationError;
  try { workspace.clearFailureRollbacks?.(); } catch (_) { invalid(); }
  return result;
}

function commitWorkspaceTransaction(database, workspace, operation) {
  if (!database || typeof database.transaction !== 'function'
    || !workspace || typeof workspace.cleanup !== 'function'
    || typeof workspace.rollbackFailures !== 'function'
    || typeof operation !== 'function') invalid();
  let commit;
  try {
    commit = database.transaction(() => {
      const result = operation();
      if (!workspace.cleanup()) {
        workspace.rollbackFailures();
        invalid();
      }
      return result;
    });
  } catch (error) {
    if (error instanceof TempWorkspaceError) throw error;
    throw error;
  }
  if (typeof commit !== 'function') invalid();
  return commit();
}

module.exports = Object.freeze({
  TEMP_WORKSPACE_ERROR,
  TempWorkspaceError,
  commitWorkspaceTransaction,
  createTempWorkspace,
  withTempWorkspace,
});
