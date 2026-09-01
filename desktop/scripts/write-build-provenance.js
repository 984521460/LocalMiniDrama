'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_PROVENANCE_BYTES,
  WINDOWS_BUILD_PROVENANCE_ERROR,
  WindowsBuildProvenanceError,
  currentWindowsBuildProvenance,
  parseWindowsBuildProvenanceBytes,
  serializeWindowsBuildProvenance,
} = require('../windows-build-provenance');

const desktopRoot = path.join(__dirname, '..');
const target = path.join(desktopRoot, 'build-provenance.json');

function invalid() {
  throw new WindowsBuildProvenanceError();
}

function lstatOrNull(fsImpl, value) {
  try {
    return fsImpl.lstatSync(value, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    invalid();
  }
}

function sameIdentity(left, right) {
  return Boolean(left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.nlink === right.nlink
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs);
}

function sameNode(left, right) {
  return Boolean(left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode);
}

function sameMovedFile(left, right) {
  return Boolean(sameNode(left, right)
    && left.size === right.size
    && left.nlink === right.nlink);
}

function exactRead(fsImpl, handle, size) {
  if (typeof size !== 'bigint' || size < 2n || size > BigInt(MAX_PROVENANCE_BYTES)) invalid();
  const buffer = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < buffer.length) {
    const count = fsImpl.readSync(handle, buffer, offset, buffer.length - offset, offset);
    if (!Number.isSafeInteger(count) || count < 1) invalid();
    offset += count;
  }
  const eof = Buffer.alloc(1);
  if (fsImpl.readSync(handle, eof, 0, 1, buffer.length) !== 0) invalid();
  return buffer;
}

function inspectExisting(fsImpl, value, expectedLinks = 1n) {
  const before = lstatOrNull(fsImpl, value);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== expectedLinks) invalid();
  let handle;
  try {
    handle = fsImpl.openSync(value, 'r');
    const opened = fsImpl.fstatSync(handle, { bigint: true });
    if (!sameIdentity(before, opened)) invalid();
    const bytes = exactRead(fsImpl, handle, opened.size);
    const afterRead = fsImpl.fstatSync(handle, { bigint: true });
    const afterPath = fsImpl.lstatSync(value, { bigint: true });
    if (!sameIdentity(opened, afterRead) || !sameIdentity(afterRead, afterPath)) invalid();
    const provenance = parseWindowsBuildProvenanceBytes(bytes);
    return Object.freeze({ bytes, provenance, stat: afterPath });
  } catch (_) {
    invalid();
  } finally {
    if (handle !== undefined) {
      try { fsImpl.closeSync(handle); } catch (_) {}
    }
  }
}

function writeExclusive(fsImpl, value, bytes) {
  let handle;
  try {
    handle = fsImpl.openSync(value, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fsImpl.writeSync(handle, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count < 1) invalid();
      offset += count;
    }
    fsImpl.fsyncSync(handle);
    const stat = fsImpl.fstatSync(handle, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || stat.size !== BigInt(bytes.length)) invalid();
    return stat;
  } catch (_) {
    invalid();
  } finally {
    if (handle !== undefined) {
      try { fsImpl.closeSync(handle); } catch (_) {}
    }
  }
}

function restorePrevious(fsImpl, backup, targetPath) {
  try {
    if (lstatOrNull(fsImpl, targetPath) === null && lstatOrNull(fsImpl, backup) !== null) {
      fsImpl.renameSync(backup, targetPath);
    }
  } catch (_) {}
}

function installBuildProvenanceFile({
  provenance,
  targetPath,
  fsImpl = fs,
  nonce = crypto.randomBytes(16).toString('hex'),
}) {
  if (typeof targetPath !== 'string' || path.basename(targetPath) !== 'build-provenance.json'
    || typeof nonce !== 'string' || !/^[0-9a-f]{32}$/u.test(nonce)) invalid();
  const parent = path.dirname(targetPath);
  let parentPath;
  let parentBefore;
  try {
    parentPath = fsImpl.realpathSync(parent);
    parentBefore = fsImpl.lstatSync(parent, { bigint: true });
  } catch (_) {
    invalid();
  }
  const comparableParent = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const comparableRealParent = process.platform === 'win32' ? parentPath.toLowerCase() : parentPath;
  if (path.resolve(comparableParent) !== path.resolve(comparableRealParent)
    || !parentBefore.isDirectory() || parentBefore.isSymbolicLink()) invalid();

  const serialized = serializeWindowsBuildProvenance(provenance);
  const bytes = Buffer.from(serialized, 'utf8');
  const existing = inspectExisting(fsImpl, targetPath);
  const pending = `${targetPath}.pending-${nonce}`;
  const previous = `${targetPath}.previous-${nonce}`;
  if (lstatOrNull(fsImpl, pending) !== null || lstatOrNull(fsImpl, previous) !== null) invalid();

  let pendingExists = false;
  let previousExists = false;
  let pendingStat;
  try {
    pendingStat = writeExclusive(fsImpl, pending, bytes);
    pendingExists = true;
    if (existing) {
      fsImpl.renameSync(targetPath, previous);
      previousExists = true;
      const moved = fsImpl.lstatSync(previous, { bigint: true });
      if (!sameMovedFile(existing.stat, moved)) {
        restorePrevious(fsImpl, previous, targetPath);
        previousExists = lstatOrNull(fsImpl, previous) !== null;
        invalid();
      }
    }
    fsImpl.linkSync(pending, targetPath);
    const installed = inspectExisting(fsImpl, targetPath, 2n);
    const pendingAfterLink = fsImpl.lstatSync(pending, { bigint: true });
    if (!installed || !sameNode(pendingStat, installed.stat)
      || !sameNode(installed.stat, pendingAfterLink)
      || !installed.bytes.equals(bytes)) invalid();
    fsImpl.unlinkSync(pending);
    pendingExists = false;
    const finalRecord = inspectExisting(fsImpl, targetPath);
    if (!finalRecord || !finalRecord.bytes.equals(bytes)) invalid();
    if (previousExists) {
      fsImpl.unlinkSync(previous);
      previousExists = false;
    }
    const parentAfter = fsImpl.lstatSync(parent, { bigint: true });
    if (!sameNode(parentBefore, parentAfter)
      || fsImpl.realpathSync(parent) !== parentPath) invalid();
    return finalRecord.provenance;
  } catch (_) {
    try {
      const installed = lstatOrNull(fsImpl, targetPath);
      const pendingNow = lstatOrNull(fsImpl, pending);
      if (installed && pendingNow && sameNode(installed, pendingNow)) fsImpl.unlinkSync(targetPath);
    } catch (_) {}
    if (previousExists) restorePrevious(fsImpl, previous, targetPath);
    if (pendingExists) {
      try { fsImpl.unlinkSync(pending); } catch (_) {}
    }
    invalid();
  }
}

function writeBuildProvenance() {
  const provenance = currentWindowsBuildProvenance({
    repoRoot: path.resolve(desktopRoot, '..'),
    packageJsonPath: path.join(desktopRoot, 'package.json'),
  });
  return installBuildProvenanceFile({ provenance, targetPath: target });
}

if (require.main === module) {
  try {
    const provenance = writeBuildProvenance();
    process.stdout.write(`Windows build provenance prepared for ${provenance.sourceCommitSha}\n`);
  } catch (_) {
    process.stderr.write(`${JSON.stringify({
      code: WINDOWS_BUILD_PROVENANCE_ERROR,
      message: 'Windows build provenance invalid',
    })}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ installBuildProvenanceFile, writeBuildProvenance });
