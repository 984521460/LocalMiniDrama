'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');

const { archiveError, isProjectArchiveError } = require('./errors');

const MEDIA_LIMITS = Object.freeze({
  bindings: 100_000,
  entries: 2_048,
  fileBytes: 256 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  pathBytes: 1_024,
  pathSegments: 64,
  segmentBytes: 255,
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTENT_PATH = /^v2\/media\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/u;
const STORAGE_PROVIDERS = new Set(['local', 'nas', 'object']);
const VERSION_STATUSES = new Set(['pending', 'ready', 'failed', 'archived']);
const BINDING_STATES = new Set(['content_addressed', 'needs_rebind', 'not_required']);
const VERSION_FIELDS = Object.freeze([
  'uid', 'asset_uid', 'storage_provider', 'logical_uri', 'relative_path', 'sha256',
  'mime_type', 'width', 'height', 'duration_ms', 'parent_uid', 'status', 'created_at',
]);
const BINDING_FIELDS = Object.freeze([
  'asset_version_uid', 'binding_state', 'archive_path', 'byte_length', 'sha256',
]);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MAP_HAS = Map.prototype.has;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const MAP_SIZE = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
const MAP_ENTRIES = Map.prototype.entries;
const MAP_ITERATOR_NEXT = Object.getPrototypeOf(new Map().entries()).next;
const SET_HAS = Set.prototype.has;
const SET_ADD = Set.prototype.add;
const SET_SIZE = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
const ARRAY_SORT = Array.prototype.sort;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength',
).get;

function invalidExport() {
  throw archiveError('PROJECT_ARCHIVE_INVALID');
}

function invalidManifest() {
  throw archiveError('PROJECT_ARCHIVE_MANIFEST_INVALID');
}

function limitExceeded() {
  throw archiveError('PROJECT_ARCHIVE_LIMIT_EXCEEDED');
}

function arrayIncludes(values, expected) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function sortArray(values, compare) {
  Reflect.apply(ARRAY_SORT, values, [compare]);
  return values;
}

function mapHas(value, key) {
  return Reflect.apply(MAP_HAS, value, [key]);
}

function mapGet(value, key) {
  return Reflect.apply(MAP_GET, value, [key]);
}

function mapSet(value, key, item) {
  Reflect.apply(MAP_SET, value, [key, item]);
}

function mapSize(value) {
  return Reflect.apply(MAP_SIZE, value, []);
}

function setHas(value, key) {
  return Reflect.apply(SET_HAS, value, [key]);
}

function setAdd(value, key) {
  Reflect.apply(SET_ADD, value, [key]);
}

function setSize(value) {
  return Reflect.apply(SET_SIZE, value, []);
}

function exactObjectValues(value, fields, fail) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail();
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
  if (keys.length !== fields.length) fail();
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !arrayIncludes(fields, key) || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')) fail();
    output[key] = descriptor.value;
  }
  for (let index = 0; index < fields.length; index += 1) {
    if (!Object.hasOwn(output, fields[index])) fail();
  }
  return output;
}

function denseArrayValues(value, fail, maximum = MEDIA_LIMITS.bindings) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value)) fail();
  let prototype;
  let lengthDescriptor;
  try {
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    return fail();
  }
  if (prototype !== Array.prototype || !lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) fail();
  const length = lengthDescriptor.value;
  if (length > maximum) limitExceeded();
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail();
  }
  if (Reflect.ownKeys(descriptors).length !== length + 1) fail();
  const output = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    output[index] = descriptor.value;
  }
  return output;
}

function boundedString(value, maximumBytes, fail, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maximumBytes) fail();
  return value;
}

function canonicalTimestamp(value, fail) {
  if (typeof value !== 'string' || value.length !== 24) fail();
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch) || new Date(epoch).toISOString() !== value) fail();
  return value;
}

function safeRelativeSegments(value, fail) {
  const portable = boundedString(value, MEDIA_LIMITS.pathBytes, fail);
  if (portable.includes('\\') || portable.includes(':') || portable.startsWith('/')
    || portable.endsWith('/') || /[\u0000-\u001f\u007f]/u.test(portable)) fail();
  const segments = portable.split('/');
  if (segments.length > MEDIA_LIMITS.pathSegments) fail();
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.length === 0 || segment === '.' || segment === '..'
      || Buffer.byteLength(segment, 'utf8') > MEDIA_LIMITS.segmentBytes
      || segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_RESERVED.test(segment)) fail();
  }
  return segments;
}

function validateVersion(value, fail) {
  const row = exactObjectValues(value, VERSION_FIELDS, fail);
  if (typeof row.uid !== 'string' || !UUID_V4.test(row.uid)
    || typeof row.asset_uid !== 'string' || !UUID_V4.test(row.asset_uid)
    || !setHas(STORAGE_PROVIDERS, row.storage_provider)
    || typeof row.logical_uri !== 'string' || !row.logical_uri.startsWith('asset://')
    || row.logical_uri.length > 2_048 || /[\u0000-\u0020\u007f\\]/u.test(row.logical_uri)
    || (row.sha256 !== null && (typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)))
    || (row.mime_type !== null && (typeof row.mime_type !== 'string'
      || row.mime_type.length > 255 || row.mime_type !== row.mime_type.trim()))
    || (row.width !== null && (!Number.isSafeInteger(row.width) || row.width < 1))
    || (row.height !== null && (!Number.isSafeInteger(row.height) || row.height < 1))
    || (row.duration_ms !== null && (!Number.isSafeInteger(row.duration_ms) || row.duration_ms < 0))
    || (row.parent_uid !== null && (typeof row.parent_uid !== 'string'
      || !UUID_V4.test(row.parent_uid) || row.parent_uid === row.uid))
    || !setHas(VERSION_STATUSES, row.status)) fail();
  safeRelativeSegments(row.relative_path, fail);
  canonicalTimestamp(row.created_at, fail);
  return row;
}

function bindingFor(row, byteLength = null) {
  const contentAddressed = row.storage_provider === 'local' && row.status === 'ready';
  const needsRebind = row.storage_provider !== 'local' && row.status === 'ready';
  return Object.freeze({
    asset_version_uid: row.uid,
    binding_state: contentAddressed ? 'content_addressed' : (needsRebind ? 'needs_rebind' : 'not_required'),
    archive_path: contentAddressed
      ? `v2/media/sha256/${row.sha256.slice(0, 2)}/${row.sha256}`
      : null,
    byte_length: contentAddressed ? byteLength : null,
    sha256: row.sha256,
  });
}

function samePath(left, right) {
  return path.relative(left, right) === '' && path.relative(right, left) === '';
}

function fileIdentity(stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function captureRoot(storageRoot) {
  try {
    if (typeof storageRoot !== 'string' || storageRoot.includes('\0') || !path.isAbsolute(storageRoot)) invalidExport();
    const resolved = path.resolve(storageRoot);
    const stats = fs.lstatSync(resolved, { bigint: true });
    const real = fs.realpathSync.native(resolved);
    if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(resolved, real)) invalidExport();
    return Object.freeze({ path: resolved, real, identity: fileIdentity(stats) });
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    return invalidExport();
  }
}

function assertRootStable(root) {
  try {
    const stats = fs.lstatSync(root.path, { bigint: true });
    const real = fs.realpathSync.native(root.path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(real, root.real)
      || !sameIdentity(fileIdentity(stats), root.identity)) invalidExport();
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    invalidExport();
  }
}

function resolveSafeFile(root, relativePath) {
  const segments = safeRelativeSegments(relativePath, invalidExport);
  assertRootStable(root);
  let cursor = root.path;
  let finalStats;
  try {
    for (let index = 0; index < segments.length; index += 1) {
      cursor = path.join(cursor, segments[index]);
      const stats = fs.lstatSync(cursor, { bigint: true });
      const real = fs.realpathSync.native(cursor);
      const relative = path.relative(root.real, real);
      if (stats.isSymbolicLink() || path.isAbsolute(relative) || relative === '..'
        || relative.startsWith(`..${path.sep}`)) invalidExport();
      if (index < segments.length - 1 && !stats.isDirectory()) invalidExport();
      if (index === segments.length - 1) finalStats = stats;
    }
    if (!finalStats?.isFile() || finalStats.isSymbolicLink()) invalidExport();
    return Object.freeze({ filename: cursor, identity: fileIdentity(finalStats) });
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    return invalidExport();
  }
}

function readStableFile(root, resolved) {
  const size = Number(resolved.identity.size);
  if (!Number.isSafeInteger(size) || size < 1) invalidExport();
  if (size > MEDIA_LIMITS.fileBytes) limitExceeded();
  let descriptor;
  try {
    descriptor = fs.openSync(resolved.filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fileIdentity(fs.fstatSync(descriptor, { bigint: true }));
    if (!sameIdentity(opened, resolved.identity)) invalidExport();
    const buffer = fs.readFileSync(descriptor);
    if (buffer.length !== size || buffer.length > MEDIA_LIMITS.fileBytes) invalidExport();
    const after = fileIdentity(fs.fstatSync(descriptor, { bigint: true }));
    if (!sameIdentity(after, opened)) invalidExport();
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertRootStable(root);
    const final = resolveSafeFile(root, path.relative(root.path, resolved.filename).replace(/\\/gu, '/'));
    if (!sameIdentity(final.identity, opened)) invalidExport();
    return buffer;
  } catch (error) {
    try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch {}
    if (isProjectArchiveError(error)) throw error;
    return invalidExport();
  }
}

function hashBuffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function exactBufferLength(value, fail) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)
    || !Buffer.isBuffer(value)) fail();
  let prototype;
  let byteLength;
  try {
    prototype = Object.getPrototypeOf(value);
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []);
  } catch {
    return fail();
  }
  if (prototype !== Buffer.prototype || !Number.isSafeInteger(byteLength) || byteLength < 1) fail();
  return byteLength;
}

function mapEntries(value, fail) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) fail();
  let prototype;
  let size;
  try {
    prototype = Object.getPrototypeOf(value);
    size = Reflect.apply(MAP_SIZE, value, []);
  } catch {
    return fail();
  }
  if (prototype !== Map.prototype || !Number.isSafeInteger(size) || size < 0) fail();
  if (size > MEDIA_LIMITS.entries) limitExceeded();
  const output = [];
  try {
    const iterator = Reflect.apply(MAP_ENTRIES, value, []);
    while (true) {
      const step = Reflect.apply(MAP_ITERATOR_NEXT, iterator, []);
      if (step.done) break;
      const pair = step.value;
      if (types.isProxy(pair) || !Array.isArray(pair)) fail();
      const descriptors = Object.getOwnPropertyDescriptors(pair);
      if (Object.getPrototypeOf(pair) !== Array.prototype
        || Reflect.ownKeys(descriptors).length !== 3
        || descriptors.length?.value !== 2
        || !descriptors['0']?.enumerable || !Object.hasOwn(descriptors['0'], 'value')
        || !descriptors['1']?.enumerable || !Object.hasOwn(descriptors['1'], 'value')) fail();
      output[output.length] = Object.freeze({
        key: descriptors['0'].value,
        value: descriptors['1'].value,
      });
    }
  } catch {
    return fail();
  }
  if (output.length !== size) fail();
  return output;
}

function createProjectArchiveV21MediaCollector(storageRoot) {
  const root = captureRoot(storageRoot);
  return Object.freeze({
    collect(assetVersions) {
      const inputRows = denseArrayValues(assetVersions, invalidExport);
      const rows = new Array(inputRows.length);
      for (let index = 0; index < inputRows.length; index += 1) {
        rows[index] = validateVersion(inputRows[index], invalidExport);
      }
      const seenUids = new Set();
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (setHas(seenUids, row.uid)) invalidExport();
        setAdd(seenUids, row.uid);
      }
      sortArray(rows, (left, right) => left.uid < right.uid ? -1 : 1);
      const contents = new Map();
      const bindings = [];
      let totalBytes = 0;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (row.storage_provider !== 'local' || row.status !== 'ready') {
          bindings[bindings.length] = bindingFor(row);
          continue;
        }
        if (row.sha256 === null) invalidExport();
        const bytes = readStableFile(root, resolveSafeFile(root, row.relative_path));
        if (hashBuffer(bytes) !== row.sha256) invalidExport();
        if (!mapHas(contents, row.sha256)) {
          if (mapSize(contents) >= MEDIA_LIMITS.entries) limitExceeded();
          totalBytes += bytes.length;
          if (totalBytes > MEDIA_LIMITS.totalBytes) limitExceeded();
          mapSet(contents, row.sha256, Buffer.from(bytes));
        }
        bindings[bindings.length] = bindingFor(row, bytes.length);
      }
      const frozenBindings = Object.freeze(bindings);
      return Object.freeze({
        bindings: frozenBindings,
        totalBytes,
        archiveEntries() {
          const pairs = mapEntries(contents, invalidExport);
          sortArray(pairs, (left, right) => left.key < right.key ? -1 : 1);
          const entries = new Array(pairs.length);
          for (let index = 0; index < pairs.length; index += 1) {
            const hash = pairs[index].key;
            entries[index] = Object.freeze({
              archivePath: `v2/media/sha256/${hash.slice(0, 2)}/${hash}`,
              buffer: Buffer.from(pairs[index].value),
            });
          }
          return entries;
        },
      });
    },
  });
}

function validateBinding(value) {
  const binding = exactObjectValues(value, BINDING_FIELDS, invalidManifest);
  if (typeof binding.asset_version_uid !== 'string' || !UUID_V4.test(binding.asset_version_uid)
    || !setHas(BINDING_STATES, binding.binding_state)
    || (binding.archive_path !== null && typeof binding.archive_path !== 'string')
    || (binding.byte_length !== null && (!Number.isSafeInteger(binding.byte_length)
      || binding.byte_length < 1 || binding.byte_length > MEDIA_LIMITS.fileBytes))
    || (binding.sha256 !== null && (typeof binding.sha256 !== 'string' || !SHA256.test(binding.sha256)))) {
    invalidManifest();
  }
  if (binding.binding_state === 'content_addressed') {
    const match = CONTENT_PATH.exec(binding.archive_path);
    if (!match || match[1] !== binding.sha256.slice(0, 2) || match[2] !== binding.sha256
      || binding.byte_length === null) invalidManifest();
  } else if (binding.archive_path !== null || binding.byte_length !== null) invalidManifest();
  return binding;
}

function validateProjectArchiveV21Media({ assetVersions, bindings, files } = {}) {
  try {
    const inputRows = denseArrayValues(assetVersions, invalidManifest);
    const inputBindings = denseArrayValues(bindings, invalidManifest);
    const rows = new Array(inputRows.length);
    const bindingRows = new Array(inputBindings.length);
    for (let index = 0; index < inputRows.length; index += 1) {
      rows[index] = validateVersion(inputRows[index], invalidManifest);
    }
    for (let index = 0; index < inputBindings.length; index += 1) {
      bindingRows[index] = validateBinding(inputBindings[index]);
    }
    if (rows.length !== bindingRows.length) invalidManifest();
    sortArray(rows, (left, right) => left.uid < right.uid ? -1 : 1);
    const seen = new Set();
    const expectedPaths = new Set();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const binding = bindingRows[index];
      if (setHas(seen, row.uid) || binding.asset_version_uid !== row.uid) invalidManifest();
      setAdd(seen, row.uid);
      const expectedState = row.storage_provider === 'local' && row.status === 'ready'
        ? 'content_addressed'
        : (row.storage_provider !== 'local' && row.status === 'ready' ? 'needs_rebind' : 'not_required');
      if (binding.binding_state !== expectedState || binding.sha256 !== row.sha256) invalidManifest();
      if (expectedState === 'content_addressed') {
        if (row.sha256 === null) invalidManifest();
        setAdd(expectedPaths, binding.archive_path);
      }
    }

    const entries = mapEntries(files, invalidManifest);
    if (entries.length !== setSize(expectedPaths)) invalidManifest();
    let totalBytes = 0;
    const actualPaths = new Set();
    const sizeByPath = new Map();
    for (let index = 0; index < entries.length; index += 1) {
      const archivePath = entries[index].key;
      const buffer = entries[index].value;
      if (typeof archivePath !== 'string' || !CONTENT_PATH.test(archivePath)
        || setHas(actualPaths, archivePath) || !setHas(expectedPaths, archivePath)) invalidManifest();
      const byteLength = exactBufferLength(buffer, invalidManifest);
      totalBytes += byteLength;
      if (totalBytes > MEDIA_LIMITS.totalBytes || hashBuffer(buffer) !== CONTENT_PATH.exec(archivePath)[2]) {
        invalidManifest();
      }
      setAdd(actualPaths, archivePath);
      mapSet(sizeByPath, archivePath, byteLength);
    }
    if (setSize(actualPaths) !== setSize(expectedPaths)) invalidManifest();
    for (let index = 0; index < bindingRows.length; index += 1) {
      const binding = bindingRows[index];
      if (binding.binding_state === 'content_addressed'
        && mapGet(sizeByPath, binding.archive_path) !== binding.byte_length) invalidManifest();
    }
    return bindings;
  } catch (error) {
    if (isProjectArchiveError(error)
      && (error.code === 'PROJECT_ARCHIVE_LIMIT_EXCEEDED'
        || error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID')) throw error;
    return invalidManifest();
  }
}

module.exports = Object.freeze({
  MEDIA_LIMITS,
  createProjectArchiveV21MediaCollector,
  validateProjectArchiveV21Media,
});
