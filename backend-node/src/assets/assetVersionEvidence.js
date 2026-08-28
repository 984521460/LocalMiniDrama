const { types: { isProxy } } = require('node:util');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STORAGE_PROVIDERS = new Set(['local', 'nas', 'object']);
const MAX_EVIDENCE_JSON_BYTES = 8192;
const FIELDS = Object.freeze([
  'uid', 'assetUid', 'storageProvider', 'logicalUri', 'relativePath', 'sha256',
  'mimeType', 'width', 'height', 'durationMs', 'parentUid', 'status', 'createdAt',
]);

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
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return fail();
  }
  if (prototype !== Object.prototype && prototype !== null) fail();
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== FIELDS.length) fail();
  const actual = [];
  const snapshot = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string'
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')) fail();
    actual.push(key);
    snapshot[key] = descriptor.value;
  }
  actual.sort();
  const expected = [...FIELDS].sort();
  if (actual.some((field, index) => field !== expected[index])) fail();
  return snapshot;
}

function canonicalUid(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail();
  return value;
}

function optionalUid(value) {
  return value === null ? null : canonicalUid(value);
}

function optionalHash(value) {
  if (value !== null && (typeof value !== 'string' || !SHA256.test(value))) fail();
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
    || value !== value.trim()
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > maximumBytes) fail();
  return value;
}

function logicalUri(value) {
  const uri = boundedText(value, 2048);
  if (!/^asset:\/\/[A-Za-z0-9]/u.test(uri) || /[\u0000-\u0020\u007f\\]/u.test(uri)) fail();
  return uri;
}

function relativePath(value) {
  const path = boundedText(value, 1024);
  const portable = path.replace(/\\/gu, '/');
  if (portable.startsWith('/')
    || /^[A-Za-z]:/u.test(portable)
    || portable.includes(':')
    || portable.includes('//')
    || portable.endsWith('/')
    || portable.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) fail();
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
  if (!STORAGE_PROVIDERS.has(input.storageProvider) || input.status !== 'ready') fail();
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
    return FIELDS.every((field) => first[field] === second[field]);
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
  if (JSON.stringify(evidence) !== value) fail();
  return evidence;
}

module.exports = {
  AssetVersionEvidenceError,
  assetVersionEvidenceFromRow,
  assetVersionEvidenceMatches,
  createAssetVersionEvidence,
  parseCanonicalAssetVersionEvidenceJson,
};
