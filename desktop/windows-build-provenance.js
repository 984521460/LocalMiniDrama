'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { types: { isProxy } } = require('node:util');

const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BUFFER_EQUALS = Buffer.prototype.equals;
const BUFFER_FROM = Buffer.from;
const BUFFER_IS_BUFFER = Buffer.isBuffer;
const BUFFER_TO_STRING = Buffer.prototype.toString;
const REGEXP_TEST = RegExp.prototype.test;
const REFLECT_APPLY = Reflect.apply;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const STRING_TRIM = String.prototype.trim;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength',
).get;
const {
  create: OBJECT_CREATE,
  freeze: OBJECT_FREEZE,
  getOwnPropertyDescriptors: GET_OWN_PROPERTY_DESCRIPTORS,
  getPrototypeOf: GET_PROTOTYPE_OF,
  hasOwn: HAS_OWN,
} = Object;
const { ownKeys: OWN_KEYS } = Reflect;

const WINDOWS_BUILD_PROVENANCE_ERROR = 'WINDOWS_BUILD_PROVENANCE_INVALID';
const SCHEMA_VERSION = 'windows-build-provenance.v1';
const FIELD_NAMES = OBJECT_FREEZE([
  'schemaVersion',
  'sourceCommitSha',
  'sourceTreeSha',
  'packageVersion',
  'appId',
]);
const MAX_PROVENANCE_BYTES = 2048;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;

class WindowsBuildProvenanceError extends Error {
  constructor() {
    super('Windows build provenance invalid');
    this.name = 'WindowsBuildProvenanceError';
    this.code = WINDOWS_BUILD_PROVENANCE_ERROR;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

function invalid() {
  throw new WindowsBuildProvenanceError();
}

function exactDataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) invalid();
  let prototype;
  let descriptors;
  try {
    prototype = GET_PROTOTYPE_OF(value);
    descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value);
  } catch (_) {
    invalid();
  }
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = OWN_KEYS(descriptors);
  if (keys.length !== FIELD_NAMES.length) invalid();
  const result = OBJECT_CREATE(null);
  for (let index = 0; index < FIELD_NAMES.length; index += 1) {
    const key = FIELD_NAMES[index];
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !HAS_OWN(descriptor, 'value')) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function exactText(value, pattern) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, pattern, [value])) invalid();
  return value;
}

function createWindowsBuildProvenance(input) {
  const values = exactDataObject(input);
  if (values.schemaVersion !== SCHEMA_VERSION) invalid();
  const record = OBJECT_CREATE(null);
  record.schemaVersion = SCHEMA_VERSION;
  record.sourceCommitSha = exactText(values.sourceCommitSha, /^[0-9a-f]{40}$/u);
  record.sourceTreeSha = exactText(values.sourceTreeSha, /^[0-9a-f]{40}$/u);
  record.packageVersion = exactText(values.packageVersion, /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u);
  record.appId = exactText(values.appId, /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u);
  return OBJECT_FREEZE(record);
}

function serializeWindowsBuildProvenance(value) {
  const record = createWindowsBuildProvenance(value);
  const serialized = `${JSON_STRINGIFY(record)}\n`;
  if (BUFFER_BYTE_LENGTH(serialized, 'utf8') > MAX_PROVENANCE_BYTES) invalid();
  return serialized;
}

function parseWindowsBuildProvenanceBytes(value) {
  if (isProxy(value) || !BUFFER_IS_BUFFER(value)
    || GET_PROTOTYPE_OF(value) !== Buffer.prototype) invalid();
  let byteLength;
  try {
    byteLength = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH, value, []);
  } catch (_) {
    invalid();
  }
  if (byteLength < 2 || byteLength > MAX_PROVENANCE_BYTES) invalid();
  const text = REFLECT_APPLY(BUFFER_TO_STRING, value, ['utf8']);
  const roundTrip = BUFFER_FROM(text, 'utf8');
  if (!REFLECT_APPLY(BUFFER_EQUALS, roundTrip, [value])) invalid();
  let parsed;
  try {
    parsed = JSON_PARSE(text);
  } catch (_) {
    invalid();
  }
  const record = createWindowsBuildProvenance(parsed);
  if (serializeWindowsBuildProvenance(record) !== text) invalid();
  return record;
}

function provenanceSha256(value) {
  return crypto.createHash('sha256')
    .update(serializeWindowsBuildProvenance(value), 'utf8')
    .digest('hex');
}

function gitOutput(repoRoot, args, maxBuffer = 1024 * 1024) {
  try {
    return REFLECT_APPLY(STRING_TRIM, execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer,
      windowsHide: true,
    }), []);
  } catch (_) {
    invalid();
  }
}

function currentWindowsBuildProvenance({
  repoRoot = path.resolve(__dirname, '..'),
  packageJsonPath = path.join(__dirname, 'package.json'),
} = {}) {
  let resolvedRepoRoot;
  let reportedRepoRoot;
  let resolvedPackageJsonPath;
  let packageJsonRelativePath;
  let packageJson;
  try {
    resolvedRepoRoot = fs.realpathSync(repoRoot);
    reportedRepoRoot = fs.realpathSync(gitOutput(repoRoot, ['rev-parse', '--show-toplevel']));
    const packageJsonStat = fs.lstatSync(packageJsonPath);
    if (!packageJsonStat.isFile() || packageJsonStat.isSymbolicLink()
      || !Number.isSafeInteger(packageJsonStat.size) || packageJsonStat.size < 2
      || packageJsonStat.size > MAX_PACKAGE_JSON_BYTES) invalid();
    resolvedPackageJsonPath = fs.realpathSync(packageJsonPath);
  } catch (_) {
    invalid();
  }
  if (process.platform === 'win32') {
    resolvedRepoRoot = REFLECT_APPLY(STRING_TO_LOWER_CASE, resolvedRepoRoot, []);
    reportedRepoRoot = REFLECT_APPLY(STRING_TO_LOWER_CASE, reportedRepoRoot, []);
    resolvedPackageJsonPath = REFLECT_APPLY(STRING_TO_LOWER_CASE, resolvedPackageJsonPath, []);
  }
  if (resolvedRepoRoot !== reportedRepoRoot) invalid();
  if (gitOutput(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']) !== '') invalid();
  packageJsonRelativePath = path.relative(resolvedRepoRoot, resolvedPackageJsonPath);
  if (!packageJsonRelativePath || path.isAbsolute(packageJsonRelativePath)
    || packageJsonRelativePath === '..'
    || packageJsonRelativePath.startsWith(`..${path.sep}`)) invalid();
  const gitPackageJsonPath = packageJsonRelativePath.replaceAll(path.sep, '/');
  gitOutput(repoRoot, ['ls-files', '--error-unmatch', '--', gitPackageJsonPath], 4096);
  try {
    packageJson = JSON_PARSE(gitOutput(
      repoRoot,
      ['show', `HEAD:${gitPackageJsonPath}`],
      MAX_PACKAGE_JSON_BYTES,
    ));
  } catch (_) {
    invalid();
  }
  const record = createWindowsBuildProvenance({
    schemaVersion: SCHEMA_VERSION,
    sourceCommitSha: gitOutput(repoRoot, ['rev-parse', 'HEAD'], 4096),
    sourceTreeSha: gitOutput(repoRoot, ['rev-parse', 'HEAD^{tree}'], 4096),
    packageVersion: packageJson.version,
    appId: packageJson.build?.appId,
  });
  if (gitOutput(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']) !== '') invalid();
  return record;
}

module.exports = OBJECT_FREEZE({
  MAX_PROVENANCE_BYTES,
  SCHEMA_VERSION,
  WINDOWS_BUILD_PROVENANCE_ERROR,
  WindowsBuildProvenanceError,
  createWindowsBuildProvenance,
  currentWindowsBuildProvenance,
  parseWindowsBuildProvenanceBytes,
  provenanceSha256,
  serializeWindowsBuildProvenance,
});
