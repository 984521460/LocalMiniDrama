'use strict';

const fs = require('fs');
const path = require('path');
const {
  LEGACY_USER_DATA_DIRECTORIES,
  USER_DATA_DIRECTORY,
} = require('./product-identity');

function isDirectory(fsImpl, targetPath) {
  try {
    return fsImpl.existsSync(targetPath) && fsImpl.statSync(targetPath).isDirectory();
  } catch (_) {
    return false;
  }
}

function isEmptyDirectory(fsImpl, targetPath) {
  try {
    return isDirectory(fsImpl, targetPath) && fsImpl.readdirSync(targetPath).length === 0;
  } catch (_) {
    return false;
  }
}

function resolveUserDataPath({
  appDataPath,
  fsImpl = fs,
  pathImpl = path,
  currentDirectory = USER_DATA_DIRECTORY,
  legacyDirectories = LEGACY_USER_DATA_DIRECTORIES,
} = {}) {
  if (!appDataPath) throw new TypeError('appDataPath is required');

  const currentPath = pathImpl.join(appDataPath, currentDirectory);
  const currentExists = fsImpl.existsSync(currentPath);
  if (currentExists && !isEmptyDirectory(fsImpl, currentPath)) {
    return { path: currentPath, migratedFrom: null, migrationError: null };
  }

  for (const legacyDirectory of legacyDirectories) {
    const legacyPath = pathImpl.join(appDataPath, legacyDirectory);
    if (!isDirectory(fsImpl, legacyPath)) continue;

    if (currentExists) {
      try {
        fsImpl.rmdirSync(currentPath);
      } catch (migrationError) {
        return { path: legacyPath, migratedFrom: null, migrationError };
      }
    }

    try {
      fsImpl.renameSync(legacyPath, currentPath);
      return { path: currentPath, migratedFrom: legacyPath, migrationError: null };
    } catch (migrationError) {
      // Keep using the legacy directory for this launch so an upgrade failure
      // never looks like lost projects. A later launch can retry the rename.
      return { path: legacyPath, migratedFrom: null, migrationError };
    }
  }

  return { path: currentPath, migratedFrom: null, migrationError: null };
}

module.exports = { resolveUserDataPath };
