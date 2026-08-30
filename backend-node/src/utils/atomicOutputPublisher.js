'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OUTPUT_PUBLICATION_FAILED = 'OUTPUT_PUBLICATION_FAILED';

class OutputPublicationError extends Error {
  constructor() {
    super('Output publication failed');
    this.name = 'OutputPublicationError';
    this.code = OUTPUT_PUBLICATION_FAILED;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

function invalid() {
  throw new OutputPublicationError();
}

function comparable(value, pathImpl) {
  const resolved = pathImpl.resolve(value);
  return pathImpl.sep === '\\' ? resolved.toLowerCase() : resolved;
}

function directorySnapshot(directory, fsImpl, pathImpl) {
  const resolved = pathImpl.resolve(directory);
  const stat = fsImpl.lstatSync(resolved, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  const real = fsImpl.realpathSync.native
    ? fsImpl.realpathSync.native(resolved)
    : fsImpl.realpathSync(resolved);
  if (comparable(real, pathImpl) !== comparable(resolved, pathImpl)) invalid();
  return Object.freeze({ resolved, dev: stat.dev, ino: stat.ino, mode: stat.mode });
}

function assertDirectoryUnchanged(expected, fsImpl, pathImpl) {
  const current = directorySnapshot(expected.resolved, fsImpl, pathImpl);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.mode !== expected.mode) invalid();
}

function fileSnapshot(filePath, fsImpl) {
  const stat = fsImpl.lstatSync(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0n) invalid();
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    ctimeNs: stat.ctimeNs,
    mtimeNs: stat.mtimeNs,
  });
}

function sameFile(left, right, { compareLinkCount = true } = {}) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs
    && (!compareLinkCount || left.nlink === right.nlink);
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size;
}

function sameCleanupIdentity(left, right) {
  return sameIdentity(left, right) && left.mtimeNs === right.mtimeNs;
}

function hashStableFile(filePath, expected, fsImpl) {
  const handle = fsImpl.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let position = 0;
    for (;;) {
      const read = fsImpl.readSync(handle, buffer, 0, buffer.length, position);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    if (BigInt(position) !== expected.size) invalid();
  } finally {
    fsImpl.closeSync(handle);
  }
  const after = fileSnapshot(filePath, fsImpl);
  if (!sameFile(after, expected)) invalid();
  return hash.digest('hex');
}

function assertMissing(filePath, fsImpl) {
  try {
    fsImpl.lstatSync(filePath);
    invalid();
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function unlinkOwned(filePath, expected, fsImpl) {
  try {
    const current = fileSnapshot(filePath, fsImpl);
    if (!sameCleanupIdentity(current, expected)) invalid();
    fsImpl.unlinkSync(filePath);
    assertMissing(filePath, fsImpl);
  } catch (error) {
    if (error instanceof OutputPublicationError) throw error;
    invalid();
  }
}

function publishWorkspaceFiles(workspace, entries, {
  fsImpl = fs,
  pathImpl = path,
  randomUUIDImpl = crypto.randomUUID,
} = {}) {
  if (!workspace || typeof workspace.root !== 'string'
    || !Array.isArray(entries) || entries.length < 1 || entries.length > 4) invalid();

  const installed = [];
  const candidates = [];
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || typeof entry.sourcePath !== 'string' || typeof entry.targetPath !== 'string') invalid();
      const sourcePath = pathImpl.resolve(entry.sourcePath);
      const targetPath = pathImpl.resolve(entry.targetPath);
      if (comparable(pathImpl.dirname(sourcePath), pathImpl) !== comparable(workspace.root, pathImpl)) invalid();
      if (sourcePath === targetPath) invalid();

      const sourceBefore = fileSnapshot(sourcePath, fsImpl);
      const targetParent = pathImpl.dirname(targetPath);
      fsImpl.mkdirSync(targetParent, { recursive: true });
      const parent = directorySnapshot(targetParent, fsImpl, pathImpl);
      assertMissing(targetPath, fsImpl);

      const candidatePath = pathImpl.join(
        parent.resolved,
        `.localminidrama-${randomUUIDImpl()}-${pathImpl.basename(targetPath)}.tmp`,
      );
      assertMissing(candidatePath, fsImpl);
      fsImpl.copyFileSync(sourcePath, candidatePath, fsImpl.constants.COPYFILE_EXCL);
      const candidateBefore = fileSnapshot(candidatePath, fsImpl);
      candidates.push({ path: candidatePath, snapshot: candidateBefore });
      const handle = fsImpl.openSync(candidatePath, 'r+');
      try {
        fsImpl.fsyncSync(handle);
      } finally {
        fsImpl.closeSync(handle);
      }

      const sourceHash = hashStableFile(sourcePath, sourceBefore, fsImpl);
      const candidateHash = hashStableFile(candidatePath, candidateBefore, fsImpl);
      if (sourceHash !== candidateHash) invalid();
      assertDirectoryUnchanged(parent, fsImpl, pathImpl);

      fsImpl.linkSync(candidatePath, targetPath);
      const linked = fileSnapshot(targetPath, fsImpl);
      const candidateLinked = fileSnapshot(candidatePath, fsImpl);
      if (!sameFile(linked, candidateLinked) || linked.nlink !== 2n) invalid();
      candidates[candidates.length - 1] = { path: candidatePath, snapshot: candidateLinked };
      installed.push({ path: targetPath, snapshot: linked });
      fsImpl.unlinkSync(candidatePath);
      assertMissing(candidatePath, fsImpl);
      candidates.pop();

      const final = fileSnapshot(targetPath, fsImpl);
      if (final.nlink !== 1n || !sameIdentity(final, linked)) invalid();
      assertDirectoryUnchanged(parent, fsImpl, pathImpl);
      installed[installed.length - 1] = { path: targetPath, snapshot: final };
    }
    if (typeof workspace.registerFailureRollback !== 'function') invalid();
    const rollbackSnapshot = installed.map((item) => ({
      path: item.path,
      snapshot: item.snapshot,
    }));
    workspace.registerFailureRollback(() => {
      let rollbackFailed = false;
      for (let index = rollbackSnapshot.length - 1; index >= 0; index -= 1) {
        try {
          unlinkOwned(rollbackSnapshot[index].path, rollbackSnapshot[index].snapshot, fsImpl);
        } catch (_) {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) invalid();
    });
    return Object.freeze(installed.map((item) => Object.freeze({
      path: item.path,
      bytes: Number(item.snapshot.size),
    })));
  } catch (_) {
    let cleanupFailed = false;
    for (let index = installed.length - 1; index >= 0; index -= 1) {
      try {
        unlinkOwned(installed[index].path, installed[index].snapshot, fsImpl);
      } catch (_) {
        cleanupFailed = true;
      }
    }
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      try {
        unlinkOwned(candidates[index].path, candidates[index].snapshot, fsImpl);
      } catch (_) {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) invalid();
    invalid();
  }
}

module.exports = Object.freeze({
  OUTPUT_PUBLICATION_FAILED,
  OutputPublicationError,
  publishWorkspaceFiles,
});
