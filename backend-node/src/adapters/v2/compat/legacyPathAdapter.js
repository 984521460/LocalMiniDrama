const fs = require('node:fs');
const path = require('node:path');

const { createAssetLocator } = require('@local-mini-drama/storage');

const { createCompatibilityError } = require('./errors');
const { readExactDataObject } = require('./safeInput');

function mappingFailure() {
  throw createCompatibilityError();
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePath(left, right) {
  return path.relative(left, right) === '' && path.relative(right, left) === '';
}

function relativeSegmentsWithin(root, candidate) {
  const relativePath = path.relative(root, candidate);
  if (
    !relativePath
    || path.isAbsolute(relativePath)
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
  ) mappingFailure();
  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) mappingFailure();
  return segments;
}

function hasAmbiguousAbsolutePathSyntax(value) {
  if (value.includes('\0')) return true;
  if (process.platform === 'win32' && (/^\\\\[?.]\\/.test(value) || /^\/\/[?.]\//.test(value))) return true;
  const root = path.parse(value).root;
  if (!root) return true;
  const remainder = value.slice(root.length);
  const segments = process.platform === 'win32'
    ? remainder.split(/[\\/]/)
    : remainder.split('/');
  return segments.some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || (process.platform === 'win32' && segment.includes(':'))
  ));
}

function createLegacyPathAdapter(projectRoot) {
  let rootPath;
  let rootRealPath;
  let rootIdentity;
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) mappingFailure();
  rootPath = path.resolve(projectRoot);
  try {
    rootIdentity = fs.lstatSync(rootPath, { bigint: true });
    rootRealPath = fs.realpathSync.native(rootPath);
  } catch {
    mappingFailure();
  }
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) mappingFailure();
  if (!samePath(rootPath, rootRealPath)) mappingFailure();

  function assertRootStable() {
    let currentIdentity;
    let currentRealPath;
    try {
      currentIdentity = fs.lstatSync(rootPath, { bigint: true });
      currentRealPath = fs.realpathSync.native(rootPath);
    } catch {
      mappingFailure();
    }
    if (
      !currentIdentity.isDirectory()
      || currentIdentity.isSymbolicLink()
      || !sameIdentity(rootIdentity, currentIdentity)
      || !samePath(currentRealPath, rootRealPath)
    ) mappingFailure();
  }

  function mapLegacyAbsolutePath(value) {
    const input = readExactDataObject(value, ['absolutePath', 'logicalSegments']);
    if (
      typeof input.absolutePath !== 'string'
      || !path.isAbsolute(input.absolutePath)
      || hasAmbiguousAbsolutePathSyntax(input.absolutePath)
    ) mappingFailure();
    assertRootStable();

    const absolutePath = path.resolve(input.absolutePath);
    const lexicalSegments = relativeSegmentsWithin(rootPath, absolutePath);
    let currentPath = rootPath;
    let finalIdentity;
    for (const segment of lexicalSegments) {
      currentPath = path.join(currentPath, segment);
      try {
        finalIdentity = fs.lstatSync(currentPath, { bigint: true });
      } catch {
        mappingFailure();
      }
      if (finalIdentity.isSymbolicLink()) mappingFailure();
    }
    if (!finalIdentity?.isFile()) mappingFailure();

    let realPath;
    try {
      realPath = fs.realpathSync.native(absolutePath);
    } catch {
      mappingFailure();
    }
    const relativeSegments = relativeSegmentsWithin(rootRealPath, realPath);
    assertRootStable();
    try {
      return createAssetLocator({
        storageProvider: 'local',
        logicalSegments: input.logicalSegments,
        relativeSegments,
      });
    } catch {
      mappingFailure();
    }
  }

  return Object.freeze({ mapLegacyAbsolutePath });
}

module.exports = {
  createLegacyPathAdapter,
};
