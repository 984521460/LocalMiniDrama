'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { fail } = require('../audio/audioContract');

const CODE = 'MEDIA_PROBE_FAILED';

function invalid() {
  fail(CODE);
}

function safeRelativeSegments(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
    || value !== value.trim() || value.includes('\0') || value.includes('\\')
    || value.startsWith('/') || value.endsWith('/')) invalid();
  const segments = value.split('/');
  if (segments.length > 64 || segments.some((segment) => (
    segment.length < 1 || segment.length > 128 || segment === '.' || segment === '..'
      || !/^[A-Za-z0-9._-]+$/u.test(segment)
  ))) invalid();
  return segments;
}

function fileIdentity(stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function rootIdentity(localRoot) {
  const stats = await fs.promises.lstat(localRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) invalid();
  return Object.freeze({
    real: await fs.promises.realpath(localRoot),
    identity: fileIdentity(stats),
  });
}

async function resolveStableLocalMediaFile(config, relativePath) {
  try {
    const root = await rootIdentity(config.localRoot);
    const segments = safeRelativeSegments(relativePath);
    let cursor = root.real;
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      const stats = await fs.promises.lstat(cursor);
      if (stats.isSymbolicLink()) invalid();
    }
    const candidate = path.resolve(root.real, ...segments);
    if (!candidate.startsWith(`${root.real}${path.sep}`)) invalid();
    const stats = await fs.promises.lstat(candidate);
    if (!stats.isFile() || stats.isSymbolicLink()
      || stats.size < 1 || stats.size > config.maxFileBytes) invalid();
    const real = await fs.promises.realpath(candidate);
    if (!real.startsWith(`${root.real}${path.sep}`)) invalid();
    return Object.freeze({ root, real, identity: fileIdentity(stats) });
  } catch {
    return invalid();
  }
}

async function hashLocalMediaFile(file, maximumBytes) {
  try {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for await (const chunk of fs.createReadStream(file)) {
      bytes += chunk.length;
      if (bytes > maximumBytes) invalid();
      hash.update(chunk);
    }
    if (bytes < 1) invalid();
    return Object.freeze({ bytes, sha256: hash.digest('hex') });
  } catch {
    return invalid();
  }
}

async function assertLocalMediaFileUnchanged(config, resolved, expectedHash) {
  try {
    const root = await rootIdentity(config.localRoot);
    if (root.real !== resolved.root.real || !sameIdentity(root.identity, resolved.root.identity)) invalid();
    const stats = await fs.promises.lstat(resolved.real);
    if (!stats.isFile() || stats.isSymbolicLink()
      || !sameIdentity(fileIdentity(stats), resolved.identity)) invalid();
    const current = await hashLocalMediaFile(resolved.real, config.maxFileBytes);
    if (current.bytes !== expectedHash.bytes || current.sha256 !== expectedHash.sha256) invalid();
  } catch {
    return invalid();
  }
}

module.exports = Object.freeze({
  assertLocalMediaFileUnchanged,
  hashLocalMediaFile,
  resolveStableLocalMediaFile,
});
