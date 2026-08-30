'use strict';

const { types } = require('node:util');

const { archiveError, isProjectArchiveError } = require('./errors');
const { PROJECT_ARCHIVE_CATALOG } = require('./projectArchiveCatalog');

const PORTABLE_BINDING_SCHEMA_VERSION = 'project-archive-portable-field.v1';
const PORTABLE_BINDING_LIMITS = Object.freeze({
  arrayLength: 10_000,
  depth: 32,
  entries: 20_000,
  stringBytes: 256 * 1024,
  totalBytes: 1024 * 1024,
});
const PORTABLE_BINDING_MARKER = Object.freeze({ bindingState: 'needs_rebind' });
const ENVELOPE_FIELDS = Object.freeze([
  'schema_version', 'binding_state', 'marker_count', 'portable_value',
]);
const FORBIDDEN_OBJECT_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN_SECRET_KEYS = Object.freeze([
  'accesskey', 'accesssecret', 'apikey', 'apisecret', 'authorization', 'bearer',
  'clientkey', 'clientsecret', 'credential', 'password', 'passwd', 'privatekey',
  'refreshtoken', 'secret', 'secretkey', 'sessioncookie', 'sessiontoken', 'token',
]);
const CREDENTIAL_REFERENCE = /^credential:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CREDENTIAL_REFERENCE_ANYWHERE = /credential:v1:[0-9a-z-]{1,128}/iu;
const RAW_SECRET = /(?:-----begin [^-]{0,96}private key-----|(?:^|[^a-z0-9])(?:bearer(?:\s|%20|\+)+[a-z0-9._~+/=-]{8,}|sk-[a-z0-9_-]{8,}|akia[0-9a-z]{12,}))/iu;
const EMBEDDED_SECRET_ASSIGNMENT = /(?:^|[\s?&#;,{\[("'])["']?([a-z][a-z0-9_. \t-]{0,127})["']?\s*[:=]\s*["']?([^"'&\s},;])/giu;
const URI_PASSWORD = /[a-z][a-z0-9+.-]{0,31}:\/\/[^/?#@\s]{0,256}:[^/?#@\s]{1,256}@[^/?#\s]+/iu;

const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_SLICE = Array.prototype.slice;
const ARRAY_SORT = Array.prototype.sort;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const IS_PROXY = types.isProxy;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_GET_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_EXEC = RegExp.prototype.exec;
const STRING_ENDS_WITH = String.prototype.endsWith;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_FROM_CHAR_CODE = String.fromCharCode;
const STRING_INCLUDES = String.prototype.includes;
const WEAK_SET_HAS = WeakSet.prototype.has;
const WEAK_SET_ADD = WeakSet.prototype.add;

const FIELD_KINDS = Object.create(null);
for (let index = 0; index < PROJECT_ARCHIVE_CATALOG.needsRebindFields.length; index += 1) {
  const field = PROJECT_ARCHIVE_CATALOG.needsRebindFields[index];
  FIELD_KINDS[`${field.table}.${field.column}`] = field.kind;
}
Object.freeze(FIELD_KINDS);

function invalidManifest() {
  throw archiveError('PROJECT_ARCHIVE_MANIFEST_INVALID');
}

function secretDetected() {
  throw archiveError('PROJECT_ARCHIVE_SECRET_DETECTED');
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

function sortStrings(values) {
  Reflect.apply(ARRAY_SORT, values, []);
  return values;
}

function safeHasOwn(value, key) {
  return Reflect.apply(OBJECT_HAS_OWN, Object, [value, key]);
}

function fieldKind(table, column) {
  if (typeof table !== 'string' || typeof column !== 'string') invalidManifest();
  const identity = `${table}.${column}`;
  if (!safeHasOwn(FIELD_KINDS, identity)) invalidManifest();
  return FIELD_KINDS[identity];
}

function normalizedKey(value) {
  let normalized = '';
  for (let index = 0; index < value.length; index += 1) {
    let code = Reflect.apply(STRING_CHAR_CODE_AT, value, [index]);
    if (code >= 65 && code <= 90) code += 32;
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      normalized += Reflect.apply(STRING_FROM_CHAR_CODE, String, [code]);
    }
  }
  return normalized;
}

function isForbiddenSecretKey(value) {
  const key = normalizedKey(value);
  if (key === 'credentialref') return false;
  for (let index = 0; index < FORBIDDEN_SECRET_KEYS.length; index += 1) {
    const semantic = FORBIDDEN_SECRET_KEYS[index];
    if (key === semantic
      || Reflect.apply(STRING_ENDS_WITH, key, [semantic])
      || Reflect.apply(STRING_ENDS_WITH, key, [`${semantic}value`])) return true;
  }
  return Reflect.apply(STRING_INCLUDES, key, ['credential']) || key === 'auth';
}

function byteLength(value) {
  return Reflect.apply(BUFFER_BYTE_LENGTH, Buffer, [value, 'utf8']);
}

function regexTest(expression, value) {
  return Reflect.apply(REGEXP_EXEC, expression, [value]) !== null;
}

function hasEmbeddedSecretAssignment(value) {
  EMBEDDED_SECRET_ASSIGNMENT.lastIndex = 0;
  try {
    while (true) {
      const match = Reflect.apply(REGEXP_EXEC, EMBEDDED_SECRET_ASSIGNMENT, [value]);
      if (match === null) return false;
      if (isForbiddenSecretKey(match[1])) return true;
      EMBEDDED_SECRET_ASSIGNMENT.lastIndex = match.index + 1;
    }
  } finally {
    EMBEDDED_SECRET_ASSIGNMENT.lastIndex = 0;
  }
}

function isCredentialReference(value) {
  return typeof value === 'string' && regexTest(CREDENTIAL_REFERENCE, value);
}

function objectMetadata(value) {
  if (value === null || typeof value !== 'object' || IS_PROXY(value)) invalidManifest();
  try {
    const prototype = Reflect.apply(OBJECT_GET_PROTOTYPE, Object, [value]);
    const isArray = Reflect.apply(ARRAY_IS_ARRAY, Array, [value]);
    const descriptors = Reflect.apply(OBJECT_GET_DESCRIPTORS, Object, [value]);
    const keys = Reflect.apply(REFLECT_OWN_KEYS, Reflect, [descriptors]);
    for (let index = 0; index < keys.length; index += 1) {
      if (typeof keys[index] !== 'string') invalidManifest();
    }
    return { descriptors, isArray, keys, prototype };
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    return invalidManifest();
  }
}

function isExactBindingMarkerMetadata({ descriptors, isArray, keys, prototype }) {
  if (isArray || (prototype !== Object.prototype && prototype !== null)
    || keys.length !== 1 || keys[0] !== 'bindingState') return false;
  const descriptor = descriptors.bindingState;
  return descriptor.enumerable === true
    && safeHasOwn(descriptor, 'value')
    && descriptor.value === 'needs_rebind';
}

function isExactBindingMarker(value) {
  try {
    return isExactBindingMarkerMetadata(objectMetadata(value));
  } catch {
    return false;
  }
}

function createPortableEnvelope(bindingState, markerCount, portableValue) {
  return Object.freeze({
    schema_version: PORTABLE_BINDING_SCHEMA_VERSION,
    binding_state: bindingState,
    marker_count: markerCount,
    portable_value: portableValue,
  });
}

function readEnvelope(value) {
  const { descriptors, isArray, keys, prototype } = objectMetadata(value);
  if (isArray || (prototype !== Object.prototype && prototype !== null)
    || keys.length !== ENVELOPE_FIELDS.length) invalidManifest();
  const sorted = sortStrings(keys);
  const expected = sortStrings(Reflect.apply(ARRAY_SLICE, ENVELOPE_FIELDS, []));
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index] !== expected[index]) invalidManifest();
  }
  const output = Object.create(null);
  for (let index = 0; index < ENVELOPE_FIELDS.length; index += 1) {
    const key = ENVELOPE_FIELDS[index];
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !safeHasOwn(descriptor, 'value')) {
      invalidManifest();
    }
    output[key] = descriptor.value;
  }
  return output;
}

function transformPortableJson(value, mode) {
  const state = {
    entries: 0,
    markerCount: 0,
    seen: new WeakSet(),
    totalBytes: 0,
  };

  function accountString(text) {
    const bytes = byteLength(text);
    if (bytes > PORTABLE_BINDING_LIMITS.stringBytes) limitExceeded();
    state.totalBytes += bytes;
    if (state.totalBytes > PORTABLE_BINDING_LIMITS.totalBytes) limitExceeded();
  }

  function inspectString(text) {
    accountString(text);
    if (regexTest(CREDENTIAL_REFERENCE_ANYWHERE, text)
      || regexTest(RAW_SECRET, text)
      || hasEmbeddedSecretAssignment(text)
      || regexTest(URI_PASSWORD, text)) secretDetected();
    return text;
  }

  function visit(candidate, depth) {
    if (depth > PORTABLE_BINDING_LIMITS.depth) limitExceeded();
    if (candidate === null || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (!NUMBER_IS_FINITE(candidate)) invalidManifest();
      return candidate;
    }
    if (typeof candidate === 'string') return inspectString(candidate);
    if (candidate === null || typeof candidate !== 'object' || IS_PROXY(candidate)) {
      invalidManifest();
    }
    if (Reflect.apply(WEAK_SET_HAS, state.seen, [candidate])) invalidManifest();
    Reflect.apply(WEAK_SET_ADD, state.seen, [candidate]);

    const metadata = objectMetadata(candidate);
    const { descriptors, isArray, keys, prototype } = metadata;
    if (isExactBindingMarkerMetadata(metadata)) {
      if (mode === 'project') secretDetected();
      invalidManifest();
    }
    if (isArray) {
      if (prototype !== Array.prototype) invalidManifest();
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !safeHasOwn(lengthDescriptor, 'value')
        || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        invalidManifest();
      }
      const length = lengthDescriptor.value;
      if (length > PORTABLE_BINDING_LIMITS.arrayLength) limitExceeded();
      if (keys.length !== length + 1) invalidManifest();
      const output = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !safeHasOwn(descriptor, 'value')) {
          invalidManifest();
        }
        state.entries += 1;
        if (state.entries > PORTABLE_BINDING_LIMITS.entries) limitExceeded();
        output[index] = visit(descriptor.value, depth + 1);
      }
      return Object.freeze(output);
    }

    if (prototype !== Object.prototype && prototype !== null) invalidManifest();
    const sortedKeys = sortStrings(keys);
    const output = {};
    for (let index = 0; index < sortedKeys.length; index += 1) {
      const key = sortedKeys[index];
      if (arrayIncludes(FORBIDDEN_OBJECT_KEYS, key)) invalidManifest();
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !safeHasOwn(descriptor, 'value')) {
        invalidManifest();
      }
      state.entries += 1;
      if (state.entries > PORTABLE_BINDING_LIMITS.entries) limitExceeded();
      accountString(key);
      const normalized = normalizedKey(key);
      let child;
      if (normalized === 'credentialref') {
        if (mode === 'project') {
          if (!isCredentialReference(descriptor.value)
            && !isExactBindingMarker(descriptor.value)) secretDetected();
        } else if (!isExactBindingMarker(descriptor.value)) secretDetected();
        state.markerCount += 1;
        child = Object.freeze({ bindingState: 'needs_rebind' });
      } else {
        if (isForbiddenSecretKey(key)) secretDetected();
        child = visit(descriptor.value, depth + 1);
      }
      Reflect.apply(OBJECT_DEFINE_PROPERTY, Object, [output, key, {
        configurable: false,
        enumerable: true,
        value: child,
        writable: false,
      }]);
    }
    return Object.freeze(output);
  }

  const portableValue = visit(value, 0);
  if (portableValue === null || typeof portableValue !== 'object'
    || Reflect.apply(ARRAY_IS_ARRAY, Array, [portableValue])) {
    invalidManifest();
  }
  return { markerCount: state.markerCount, portableValue };
}

function projectProjectArchiveV21PortableField(table, column, value) {
  const kind = fieldKind(table, column);
  try {
    if (kind === 'direct-credential-ref') {
      if (!isCredentialReference(value)) secretDetected();
      return createPortableEnvelope('needs_rebind', 1, null);
    }
    const projected = transformPortableJson(value, 'project');
    return createPortableEnvelope(
      projected.markerCount === 0 ? 'not_required' : 'needs_rebind',
      projected.markerCount,
      projected.portableValue,
    );
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    return invalidManifest();
  }
}

function validateProjectArchiveV21PortableField(table, column, value) {
  const kind = fieldKind(table, column);
  try {
    const envelope = readEnvelope(value);
    if (envelope.schema_version !== PORTABLE_BINDING_SCHEMA_VERSION
      || !NUMBER_IS_SAFE_INTEGER(envelope.marker_count)
      || envelope.marker_count < 0
      || !arrayIncludes(['needs_rebind', 'not_required'], envelope.binding_state)) {
      invalidManifest();
    }
    if (kind === 'direct-credential-ref') {
      if (envelope.binding_state !== 'needs_rebind'
        || envelope.marker_count !== 1
        || envelope.portable_value !== null) invalidManifest();
      return createPortableEnvelope('needs_rebind', 1, null);
    }
    const projected = transformPortableJson(envelope.portable_value, 'validate');
    const expectedState = projected.markerCount === 0 ? 'not_required' : 'needs_rebind';
    if (envelope.binding_state !== expectedState
      || envelope.marker_count !== projected.markerCount) invalidManifest();
    return createPortableEnvelope(expectedState, projected.markerCount, projected.portableValue);
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    return invalidManifest();
  }
}

module.exports = Object.freeze({
  PORTABLE_BINDING_LIMITS,
  PORTABLE_BINDING_MARKER,
  PORTABLE_BINDING_SCHEMA_VERSION,
  projectProjectArchiveV21PortableField,
  validateProjectArchiveV21PortableField,
});
