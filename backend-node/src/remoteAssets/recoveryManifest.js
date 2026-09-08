'use strict';

const { types: { isProxy } } = require('node:util');

const SCHEMA_VERSION = 'remote-asset-recovery-manifest.v1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/u;
const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const STANDARD_KEYS = Object.freeze(['schemaVersion', 'remoteTaskUid', 'characterName', 'assets']);
const STANDARD_ITEM_KEYS = Object.freeze(['ordinal', 'relativePath', 'sha256', 'width', 'height']);
const LEGACY_KEYS = Object.freeze([
  'runUid', 'checkpoint', 'size', 'steps', 'cfg', 'sampler', 'scheduler', 'items',
]);
const LEGACY_ITEM_KEYS = Object.freeze([
  'name', 'slug', 'ordinal', 'seed', 'promptSha256', 'promptId', 'file', 'subfolder', 'sha256',
]);
const STORED_KEYS = Object.freeze([
  'schemaVersion', 'remoteTaskUid', 'characterName', 'sourceFormat',
  'sourceManifestSha256', 'items',
]);
const STORED_ITEM_KEYS = Object.freeze([
  'ordinal', 'remoteRelativePath', 'remoteSha256', 'width', 'height',
]);

class RemoteAssetRecoveryManifestError extends TypeError {
  constructor() {
    super('Remote asset recovery manifest is invalid');
    this.name = 'RemoteAssetRecoveryManifestError';
    Object.freeze(this);
  }
}

function invalid() {
  throw new RemoteAssetRecoveryManifestError();
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) invalid();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid();
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid();
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    output[key] = descriptor.value;
  }
  return output;
}

function denseArray(value) {
  if (!Array.isArray(value) || isProxy(value)) invalid();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return invalid(); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 16
    || Reflect.ownKeys(descriptors).length !== length + 1) invalid();
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    output[index] = descriptor.value;
  }
  return output;
}

function uid(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) invalid();
  return value;
}

function hash(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid();
  return value;
}

function dimension(value) {
  if (!Number.isSafeInteger(value) || value < 256 || value > 2048) invalid();
  return value;
}

function characterName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
    || value !== value.trim() || Buffer.byteLength(value, 'utf8') > 1024
    || /[\u0000\u007f]/u.test(value)) invalid();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) invalid();
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) invalid();
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
  return value;
}

function remotePath(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1
    || value.length > 1024 || value.includes('\0') || value.includes('\\')
    || value.includes(':') || value.startsWith('/') || value.endsWith('/')) invalid();
  const segments = value.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || !SEGMENT.test(segment))) {
    invalid();
  }
  return segments.join('/');
}

function sourceContext(value) {
  const input = exactObject(value, ['remoteTaskUid', 'sourceManifestSha256', 'characterName']);
  return Object.freeze({
    remoteTaskUid: uid(input.remoteTaskUid),
    sourceManifestSha256: hash(input.sourceManifestSha256),
    characterName: characterName(input.characterName),
  });
}

function size(value) {
  if (typeof value === 'string') {
    const match = /^(\d{3,4})x(\d{3,4})$/u.exec(value);
    if (!match) invalid();
    return Object.freeze({ width: dimension(Number(match[1])), height: dimension(Number(match[2])) });
  }
  if (Array.isArray(value) && value.length === 2) {
    return Object.freeze({ width: dimension(value[0]), height: dimension(value[1]) });
  }
  const parsed = exactObject(value, ['width', 'height']);
  return Object.freeze({ width: dimension(parsed.width), height: dimension(parsed.height) });
}

function normalizeItems(values, mapper) {
  const raw = denseArray(values);
  const items = [];
  const paths = new Set();
  for (let index = 0; index < raw.length; index += 1) {
    const item = mapper(raw[index], index);
    if (item.ordinal !== index || paths.has(item.remoteRelativePath)) invalid();
    paths.add(item.remoteRelativePath);
    items[index] = Object.freeze(item);
  }
  return Object.freeze(items);
}

function normalizeStandard(value, context) {
  const input = exactObject(value, STANDARD_KEYS);
  if (input.schemaVersion !== SCHEMA_VERSION || uid(input.remoteTaskUid) !== context.remoteTaskUid
    || characterName(input.characterName) !== context.characterName) invalid();
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    remoteTaskUid: context.remoteTaskUid,
    characterName: context.characterName,
    sourceFormat: 'standard.v1',
    sourceManifestSha256: context.sourceManifestSha256,
    items: normalizeItems(input.assets, (candidate) => {
      const item = exactObject(candidate, STANDARD_ITEM_KEYS);
      return {
        ordinal: item.ordinal,
        remoteRelativePath: remotePath(item.relativePath),
        remoteSha256: hash(item.sha256),
        width: dimension(item.width),
        height: dimension(item.height),
      };
    }),
  });
}

function normalizeLegacy(value, context) {
  const input = exactObject(value, LEGACY_KEYS);
  if (uid(input.runUid) !== context.remoteTaskUid
    || typeof input.checkpoint !== 'string' || input.checkpoint.length < 1
    || !Number.isSafeInteger(input.steps) || input.steps < 1 || input.steps > 100
    || typeof input.cfg !== 'number' || !Number.isFinite(input.cfg) || input.cfg < 0 || input.cfg > 30
    || typeof input.sampler !== 'string' || input.sampler.length < 1
    || typeof input.scheduler !== 'string' || input.scheduler.length < 1) invalid();
  const dimensions = size(input.size);
  const raw = denseArray(input.items);
  const selected = [];
  const paths = new Set();
  const identities = new Set();
  for (let index = 0; index < raw.length; index += 1) {
    const item = exactObject(raw[index], LEGACY_ITEM_KEYS);
    if (typeof item.file !== 'string' || !SEGMENT.test(item.file)
      || typeof item.subfolder !== 'string'
      || (item.subfolder !== '' && remotePath(item.subfolder) !== item.subfolder)
      || !Number.isSafeInteger(item.ordinal) || item.ordinal < 0 || item.ordinal > 15
      || !Number.isSafeInteger(item.seed) || item.seed < 0 || item.seed > 4_294_967_295
      || typeof item.slug !== 'string' || !SEGMENT.test(item.slug)
      || typeof item.promptSha256 !== 'string' || !SHA256.test(item.promptSha256)
      || typeof item.promptId !== 'string' || item.promptId.length < 1 || item.promptId.length > 128) {
      invalid();
    }
    const name = characterName(item.name);
    const itemSha256 = hash(item.sha256);
    const itemPath = remotePath(
      item.subfolder === '' ? item.file : `${item.subfolder}/${item.file}`,
    );
    const identity = `${name}\u0000${item.ordinal}`;
    if (paths.has(itemPath) || identities.has(identity)) invalid();
    paths.add(itemPath);
    identities.add(identity);
    if (name === context.characterName) {
      selected.push(Object.freeze({
        ordinal: selected.length,
        remoteRelativePath: itemPath,
        remoteSha256: itemSha256,
        width: dimensions.width,
        height: dimensions.height,
      }));
    }
  }
  if (selected.length < 1) invalid();
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    remoteTaskUid: context.remoteTaskUid,
    characterName: context.characterName,
    sourceFormat: 'legacy.character-candidates.v1',
    sourceManifestSha256: context.sourceManifestSha256,
    items: Object.freeze(selected),
  });
}

function normalizeStored(value, context) {
  const input = exactObject(value, STORED_KEYS);
  if (input.schemaVersion !== SCHEMA_VERSION || uid(input.remoteTaskUid) !== context.remoteTaskUid
    || characterName(input.characterName) !== context.characterName
    || hash(input.sourceManifestSha256) !== context.sourceManifestSha256
    || !['standard.v1', 'legacy.character-candidates.v1'].includes(input.sourceFormat)) invalid();
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    remoteTaskUid: context.remoteTaskUid,
    characterName: context.characterName,
    sourceFormat: input.sourceFormat,
    sourceManifestSha256: context.sourceManifestSha256,
    items: normalizeItems(input.items, (candidate) => {
      const item = exactObject(candidate, STORED_ITEM_KEYS);
      return {
        ordinal: item.ordinal,
        remoteRelativePath: remotePath(item.remoteRelativePath),
        remoteSha256: hash(item.remoteSha256),
        width: dimension(item.width),
        height: dimension(item.height),
      };
    }),
  });
}

function parseRemoteAssetRecoveryManifest(value, options) {
  const context = sourceContext(options);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    let schemaVersion;
    try { schemaVersion = Object.getOwnPropertyDescriptor(value, 'schemaVersion')?.value; } catch { invalid(); }
    if (schemaVersion === SCHEMA_VERSION) return normalizeStandard(value, context);
  }
  return normalizeLegacy(value, context);
}

function canonicalRemoteAssetRecoveryManifest(value) {
  const parsed = normalizeStored(value, {
    remoteTaskUid: value?.remoteTaskUid,
    sourceManifestSha256: value?.sourceManifestSha256,
    characterName: value?.characterName,
  });
  const encode = (item) => Reflect.apply(JSON_STRINGIFY, JSON, [item]);
  const items = parsed.items.map((item) => (
    `{"ordinal":${item.ordinal},"remoteRelativePath":${encode(item.remoteRelativePath)}`
    + `,"remoteSha256":${encode(item.remoteSha256)},"width":${item.width},"height":${item.height}}`
  )).join(',');
  return `{"schemaVersion":${encode(parsed.schemaVersion)}`
    + `,"remoteTaskUid":${encode(parsed.remoteTaskUid)}`
    + `,"characterName":${encode(parsed.characterName)}`
    + `,"sourceFormat":${encode(parsed.sourceFormat)}`
    + `,"sourceManifestSha256":${encode(parsed.sourceManifestSha256)}`
    + `,"items":[${items}]}`;
}

function parseRemoteAssetRecoveryManifestJson(value, options) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 256 * 1024) invalid();
  let parsed;
  try { parsed = Reflect.apply(JSON_PARSE, JSON, [value]); } catch { return invalid(); }
  return parseRemoteAssetRecoveryManifest(parsed, options);
}

function parseStoredRemoteAssetRecoveryManifestJson(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 256 * 1024) invalid();
  let parsed;
  try { parsed = Reflect.apply(JSON_PARSE, JSON, [value]); } catch { return invalid(); }
  const normalized = normalizeStored(parsed, {
    remoteTaskUid: parsed?.remoteTaskUid,
    sourceManifestSha256: parsed?.sourceManifestSha256,
    characterName: parsed?.characterName,
  });
  if (canonicalRemoteAssetRecoveryManifest(normalized) !== value) invalid();
  return normalized;
}

module.exports = Object.freeze({
  RemoteAssetRecoveryManifestError,
  SCHEMA_VERSION,
  canonicalRemoteAssetRecoveryManifest,
  parseRemoteAssetRecoveryManifest,
  parseRemoteAssetRecoveryManifestJson,
  parseStoredRemoteAssetRecoveryManifestJson,
});
