const { types: { isProxy } } = require('node:util');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STORAGE_PROVIDERS = new Set(['local', 'nas', 'object']);
const MAX_EVIDENCE_JSON_BYTES = 8192;
const FIELDS = Object.freeze([
  'uid', 'assetUid', 'storageProvider', 'logicalUri', 'relativePath', 'sha256',
  'mimeType', 'width', 'height', 'durationMs', 'parentUid', 'status', 'createdAt',
]);
const DEFINE_PROPERTY = Object.defineProperty;
const GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const HAS_OWN = Object.hasOwn;
const JSON_STRINGIFY = JSON.stringify;
const OWN_KEYS = Reflect.ownKeys;
const REGEXP_TEST = RegExp.prototype.test;
const SET_HAS = Set.prototype.has;
const STRING_ENDS_WITH = String.prototype.endsWith;
const STRING_INCLUDES = String.prototype.includes;
const STRING_REPLACE = String.prototype.replace;
const STRING_SPLIT = String.prototype.split;
const STRING_STARTS_WITH = String.prototype.startsWith;
const STRING_TRIM = String.prototype.trim;

function defineValue(target, key, value) {
  Reflect.apply(DEFINE_PROPERTY, Object, [target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  }]);
}

class AssetVersionEvidenceError extends Error {
  constructor() {
    super('Asset version evidence is invalid');
    this.name = 'AssetVersionEvidenceError';
  }
}

function fail() {
  throw new AssetVersionEvidenceError();
}

function exactSnapshot(value) {
  if (value === null || typeof value !== 'object' || isProxy(value)) fail();
  let descriptors;
  let prototype;
  try {
    descriptors = Reflect.apply(GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
    prototype = Reflect.apply(GET_PROTOTYPE_OF, Object, [value]);
  } catch {
    return fail();
  }
  if (prototype !== Object.prototype && prototype !== null) fail();
  const keys = Reflect.apply(OWN_KEYS, Reflect, [descriptors]);
  if (keys.length !== FIELDS.length) fail();
  const snapshot = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] !== 'string') fail();
  }
  for (let index = 0; index < FIELDS.length; index += 1) {
    const key = FIELDS[index];
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !HAS_OWN(descriptor, 'value')) fail();
    defineValue(snapshot, key, descriptor.value);
  }
  return snapshot;
}

function canonicalUid(value) {
  if (typeof value !== 'string' || !Reflect.apply(REGEXP_TEST, UUID_V4, [value])) fail();
  return value;
}

function optionalUid(value) {
  return value === null ? null : canonicalUid(value);
}

function optionalHash(value) {
  if (value !== null && (typeof value !== 'string'
    || !Reflect.apply(REGEXP_TEST, SHA256, [value]))) fail();
  return value;
}

function optionalPositiveInteger(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) fail();
  return value;
}

function optionalDuration(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) fail();
  return value;
}

function boundedText(value, maximumBytes, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string'
    || value.length === 0
    || value !== Reflect.apply(STRING_TRIM, value, [])
    || Reflect.apply(STRING_INCLUDES, value, ['\0'])
    || Buffer.byteLength(value, 'utf8') > maximumBytes) fail();
  return value;
}

function logicalUri(value) {
  const uri = boundedText(value, 2048);
  if (!Reflect.apply(REGEXP_TEST, /^asset:\/\/[A-Za-z0-9]/u, [uri])
    || Reflect.apply(REGEXP_TEST, /[\u0000-\u0020\u007f\\]/u, [uri])) fail();
  return uri;
}

function relativePath(value) {
  const path = boundedText(value, 1024);
  const portable = Reflect.apply(STRING_REPLACE, path, [/\\/gu, '/']);
  if (Reflect.apply(STRING_STARTS_WITH, portable, ['/'])
    || Reflect.apply(REGEXP_TEST, /^[A-Za-z]:/u, [portable])
    || Reflect.apply(STRING_INCLUDES, portable, [':'])
    || Reflect.apply(STRING_INCLUDES, portable, ['//'])
    || Reflect.apply(STRING_ENDS_WITH, portable, ['/'])) fail();
  const segments = Reflect.apply(STRING_SPLIT, portable, ['/']);
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === '' || segments[index] === '.' || segments[index] === '..') fail();
  }
  return path;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length !== 24) fail();
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch) || new Date(epoch).toISOString() !== value) fail();
  return value;
}

function createAssetVersionEvidence(value) {
  const input = exactSnapshot(value);
  if (!Reflect.apply(SET_HAS, STORAGE_PROVIDERS, [input.storageProvider])
    || input.status !== 'ready') fail();
  const output = {
    uid: canonicalUid(input.uid),
    assetUid: canonicalUid(input.assetUid),
    storageProvider: input.storageProvider,
    logicalUri: logicalUri(input.logicalUri),
    relativePath: relativePath(input.relativePath),
    sha256: optionalHash(input.sha256),
    mimeType: boundedText(input.mimeType, 255, { nullable: true }),
    width: optionalPositiveInteger(input.width),
    height: optionalPositiveInteger(input.height),
    durationMs: optionalDuration(input.durationMs),
    parentUid: optionalUid(input.parentUid),
    status: input.status,
    createdAt: canonicalTimestamp(input.createdAt),
  };
  return Object.freeze(output);
}

function assetVersionEvidenceFromRow(row) {
  if (!row) fail();
  return createAssetVersionEvidence({
    uid: row.uid,
    assetUid: row.asset_uid,
    storageProvider: row.storage_provider,
    logicalUri: row.logical_uri,
    relativePath: row.relative_path,
    sha256: row.sha256,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    parentUid: row.parent_uid,
    status: row.status,
    createdAt: row.created_at,
  });
}

function assetVersionEvidenceMatches(left, right) {
  try {
    const first = createAssetVersionEvidence(left);
    const second = createAssetVersionEvidence(right);
    for (let index = 0; index < FIELDS.length; index += 1) {
      if (first[FIELDS[index]] !== second[FIELDS[index]]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function parseCanonicalAssetVersionEvidenceJson(value) {
  if (typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > MAX_EVIDENCE_JSON_BYTES) fail();
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail();
  }
  const evidence = createAssetVersionEvidence(parsed);
  const serializable = Object.create(null);
  for (let index = 0; index < FIELDS.length; index += 1) {
    defineValue(serializable, FIELDS[index], evidence[FIELDS[index]]);
  }
  if (Reflect.apply(JSON_STRINGIFY, JSON, [serializable]) !== value) fail();
  return evidence;
}

module.exports = {
  AssetVersionEvidenceError,
  assetVersionEvidenceFromRow,
  assetVersionEvidenceMatches,
  createAssetVersionEvidence,
  parseCanonicalAssetVersionEvidenceJson,
};
