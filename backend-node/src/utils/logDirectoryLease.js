'use strict';

const path = require('node:path');
const { types } = require('node:util');

const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;

const LOG_DIRECTORY_LEASE_INVALID = 'LOG_DIRECTORY_LEASE_INVALID';

class LogDirectoryLeaseError extends Error {
  constructor() {
    super('Log directory lease invalid');
    this.name = 'LogDirectoryLeaseError';
    this.code = LOG_DIRECTORY_LEASE_INVALID;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

let attempted = false;
let nativeBinding = null;

function invalid() {
  throw new LogDirectoryLeaseError();
}

function binding() {
  if (process.platform !== 'win32' || process.arch !== 'x64') invalid();
  if (!attempted) {
    attempted = true;
    try {
      const candidate = path.join(
        __dirname,
        '..',
        '..',
        'native',
        'build',
        `${process.versions.electron ? 'electron' : 'node'}-${process.platform}-${process.arch}`,
        'log-directory-lease.node',
      );
      const loaded = require(candidate);
      if (loaded
          && typeof loaded.acquireDirectoryLease === 'function'
          && typeof loaded.appendBoundedLog === 'function'
          && typeof loaded.releaseDirectoryLease === 'function') {
        nativeBinding = loaded;
      }
    } catch (_) {
      nativeBinding = null;
    }
  }
  if (!nativeBinding) invalid();
  return nativeBinding;
}

function acquireDirectoryLease(directory, identity) {
  if (typeof directory !== 'string' || directory.length === 0
      || !identity || typeof identity !== 'object' || types.isProxy(identity)) invalid();
  let descriptors;
  try {
    descriptors = getOwnPropertyDescriptors(identity);
  } catch (_) {
    invalid();
  }
  const dev = descriptors?.dev;
  const ino = descriptors?.ino;
  if (!dev || !ino || typeof dev.value !== 'bigint' || typeof ino.value !== 'bigint'
      || typeof dev.get === 'function' || typeof dev.set === 'function'
      || typeof ino.get === 'function' || typeof ino.set === 'function') invalid();
  let token;
  try {
    token = binding().acquireDirectoryLease(directory, dev.value, ino.value);
  } catch (_) {
    invalid();
  }
  let active = true;
  return Object.freeze({
    appendBoundedLog(fileName, buffer, maxFileBytes, maxBackups) {
      if (!active || typeof fileName !== 'string' || fileName.length === 0
          || !Buffer.isBuffer(buffer) || buffer.length === 0
          || !Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0
          || !Number.isSafeInteger(maxBackups) || maxBackups < 0) invalid();
      try {
        return binding().appendBoundedLog(
          token,
          fileName,
          buffer,
          maxFileBytes,
          maxBackups,
        ) === true;
      } catch (_) {
        invalid();
      }
    },
    release() {
      if (!active) return false;
      active = false;
      try {
        return binding().releaseDirectoryLease(token) === true;
      } catch (_) {
        return false;
      }
    },
  });
}

function nativeLeaseAvailable() {
  try {
    binding();
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = Object.freeze({
  LOG_DIRECTORY_LEASE_INVALID,
  LogDirectoryLeaseError,
  acquireDirectoryLease,
  nativeLeaseAvailable,
});
