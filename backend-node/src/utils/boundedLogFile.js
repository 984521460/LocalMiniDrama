'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { acquireDirectoryLease } = require('./logDirectoryLease');

const DEFAULT_MAX_LINE_BYTES = 32 * 1024;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 2;
const TRUNCATION_MARKER = '[truncated]';

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function boundedUtf8Line(value, maxBytes) {
  const raw = typeof value === 'string' ? value : '[invalid-log-line]';
  const oneLine = raw.replaceAll('\0', '\uFFFD').replace(/\r\n|\r|\n/gu, '\\n');
  const withNewline = `${oneLine}\n`;
  if (Buffer.byteLength(withNewline, 'utf8') <= maxBytes) return withNewline;

  const marker = `${TRUNCATION_MARKER}\n`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const available = Math.max(0, maxBytes - markerBytes);
  const source = Buffer.from(oneLine, 'utf8');
  let prefix = source.subarray(0, available).toString('utf8');
  while (prefix.length > 0 && Buffer.byteLength(`${prefix}${marker}`, 'utf8') > maxBytes) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${marker}`;
}

function comparable(value, pathImpl) {
  const resolved = pathImpl.resolve(value);
  return pathImpl.sep === '\\' ? resolved.toLowerCase() : resolved;
}

function physicalDirectorySnapshot(directory, fsImpl, pathImpl) {
  const resolved = pathImpl.resolve(directory);
  const stat = fsImpl.lstatSync(resolved, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid log directory');
  const real = fsImpl.realpathSync.native
    ? fsImpl.realpathSync.native(resolved)
    : fsImpl.realpathSync(resolved);
  if (comparable(real, pathImpl) !== comparable(resolved, pathImpl)) {
    throw new Error('invalid log directory');
  }
  return Object.freeze({ resolved, dev: stat.dev, ino: stat.ino, mode: stat.mode });
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function assertDirectoryUnchanged(expected, fsImpl, pathImpl) {
  const current = physicalDirectorySnapshot(expected.resolved, fsImpl, pathImpl);
  if (!sameDirectoryIdentity(current, expected)) throw new Error('log directory changed');
}

function ensurePhysicalDirectory(directory, fsImpl, pathImpl) {
  return physicalDirectorySnapshot(pathImpl.resolve(directory), fsImpl, pathImpl);
}

function createBoundedLogWriter({
  filePath,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxBackups = DEFAULT_MAX_BACKUPS,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('bounded log file path is required');
  }
  const resolvedPath = pathImpl.resolve(filePath);
  const lineLimit = positiveInteger(maxLineBytes, DEFAULT_MAX_LINE_BYTES);
  const fileLimit = positiveInteger(maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const backupLimit = nonNegativeInteger(maxBackups, DEFAULT_MAX_BACKUPS);
  if (lineLimit > fileLimit) throw new TypeError('bounded log line limit exceeds file limit');

  function write(line) {
    let lease = null;
    let succeeded = false;
    try {
      const boundedLine = boundedUtf8Line(line, lineLimit);
      const buffer = Buffer.from(boundedLine, 'utf8');
      const parent = pathImpl.dirname(resolvedPath);
      const parentSnapshot = ensurePhysicalDirectory(parent, fsImpl, pathImpl);
      lease = acquireDirectoryLease(parentSnapshot.resolved, parentSnapshot);
      assertDirectoryUnchanged(parentSnapshot, fsImpl, pathImpl);
      if (!lease.appendBoundedLog(
        pathImpl.basename(resolvedPath),
        buffer,
        fileLimit,
        backupLimit,
      )) throw new Error('log write failed');
      assertDirectoryUnchanged(parentSnapshot, fsImpl, pathImpl);
      succeeded = true;
    } catch (_) {}
    if (lease) {
      try {
        if (!lease.release()) succeeded = false;
      } catch (_) {
        succeeded = false;
      }
    }
    return succeeded;
  }

  return Object.freeze({
    filePath: resolvedPath,
    maxBackups: backupLimit,
    maxFileBytes: fileLimit,
    maxLineBytes: lineLimit,
    write,
  });
}

module.exports = Object.freeze({
  DEFAULT_MAX_BACKUPS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_LINE_BYTES,
  TRUNCATION_MARKER,
  boundedUtf8Line,
  createBoundedLogWriter,
});
