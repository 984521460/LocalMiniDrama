'use strict';

const { types } = require('node:util');

const REDACTED = '[redacted]';
const CIRCULAR = '[circular]';
const TRUNCATED = '[truncated]';
const UNSERIALIZABLE = '[unserializable]';
const MAX_REGISTERED_SECRETS = 512;
const MAX_LOG_TEXT_CODE_UNITS = 8 * 1024;
const MAX_LOG_VALUE_STRING_CODE_UNITS = 2 * 1024;
const MAX_LOG_VALUE_ENTRIES = 64;
const MAX_LOG_VALUE_DEPTH = 6;
const registeredSecrets = new Set();
const GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const JSON_STRINGIFY = JSON.stringify;
const ARRAY_JOIN = Array.prototype.join;
const LOCAL_PATH = '[path]';
const PUBLIC_ROUTE = /^\/(?:api(?:\/|$)|v[0-9]+(?:\/|$))/u;

const SENSITIVE_KEY_MARKERS = Object.freeze([
  'accesstoken',
  'accesskey',
  'accesskeyid',
  'refreshtoken',
  'authorization',
  'proxyauthorization',
  'apikey',
  'password',
  'passwd',
  'clientsecret',
  'secretaccesskey',
  'accesskeysecret',
  'secretkey',
  'secretid',
  'privatekey',
  'credential',
  'credentials',
  'cookie',
  'setcookie',
  'sessionid',
  'signature',
  'token',
]);

const TEXT_SECRET_NAME = [
  'api[ _-]?key',
  'access[ _-]?key',
  'access[ _-]?key[ _-]?id',
  'access[ _-]?token',
  'refresh[ _-]?token',
  'authorization',
  'proxy[ _-]?authorization',
  'x[ _-]?api[ _-]?key',
  'password',
  'passwd',
  'client[ _-]?secret',
  'secret[ _-]?access[ _-]?key',
  'access[ _-]?key[ _-]?secret',
  'secret[ _-]?key',
  'secret[ _-]?id',
  'private[ _-]?key',
  'credentials?',
  'set[ _-]?cookie',
  'cookie',
  'session[ _-]?id',
  'signature',
  'token',
].join('|');

function normalizeLogKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveLogKey(key) {
  const normalized = normalizeLogKey(key);
  if (!normalized) return false;
  if (normalized === 'ak' || normalized === 'sk') return true;
  for (let index = 0; index < SENSITIVE_KEY_MARKERS.length; index += 1) {
    const marker = SENSITIVE_KEY_MARKERS[index];
    if (normalized === marker || normalized.endsWith(marker)) return true;
  }
  return false;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function registerPrimitiveSecret(value) {
  if (value == null || typeof value === 'object') return;
  const secret = String(value);
  if (!secret) return;
  registeredSecrets.delete(secret);
  registeredSecrets.add(secret);
  while (registeredSecrets.size > MAX_REGISTERED_SECRETS) {
    registeredSecrets.delete(registeredSecrets.values().next().value);
  }
}

function collectPrimitiveSecrets(value, ancestors) {
  if (value == null) return;
  if (typeof value !== 'object') {
    registerPrimitiveSecret(value);
    return;
  }
  if (ancestors.has(value)) return;
  ancestors.add(value);
  try {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      collectPrimitiveSecrets(child, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function registerLogSecrets(value, ancestors = new WeakSet()) {
  if (value == null || typeof value !== 'object' || ancestors.has(value)) return;
  ancestors.add(value);
  try {
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveLogKey(key)) collectPrimitiveSecrets(child, ancestors);
      else if (child != null && typeof child === 'object') registerLogSecrets(child, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function registerKnownLogSecrets(value) {
  collectPrimitiveSecrets(value, new WeakSet());
}

function replaceRegisteredVariant(output, variant, secret) {
  const escaped = escapeRegExp(variant);
  if (variant === secret && secret.length <= 3) {
    const bounded = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'giu');
    return output.replace(bounded, (_match, prefix) => `${prefix}${REDACTED}`);
  }
  return output.replace(new RegExp(escaped, 'gi'), REDACTED);
}

function redactSecretText(value) {
  let output = String(value ?? '');
  const quoted = new RegExp(`((?:["']?(?:${TEXT_SECRET_NAME})["']?)\\s*:\\s*)(["'])(.*?)\\2`, 'gi');
  const assigned = new RegExp(`((?:[?&]|\\b)(?:${TEXT_SECRET_NAME})\\s*=\\s*)([^&#\\s,;}\\]]+)`, 'gi');
  const header = new RegExp(`(\\b(?:authorization|proxy[ _-]?authorization|x[ _-]?api[ _-]?key)\\s*:\\s*)(?:Bearer\\s+|Basic\\s+)?([^\\r\\n,;}]+)`, 'gi');
  const colon = new RegExp(`(\\b(?:${TEXT_SECRET_NAME})\\s*:\\s*)(?:Bearer\\s+|Basic\\s+)?([^\\s,;}\\]]+)`, 'gi');
  const labelled = new RegExp(`(\\b(?:${TEXT_SECRET_NAME})\\s+(?:is|为)\\s+)([^\\s,;}\\]]+)`, 'gi');

  for (const secret of [...registeredSecrets].sort((a, b) => b.length - a.length)) {
    const encoded = encodeURIComponent(secret);
    const formEncoded = new URLSearchParams({ value: secret }).toString().slice('value='.length);
    const doubleEncoded = encodeURIComponent(encoded);
    const doubleFormEncoded = new URLSearchParams({ value: encoded }).toString().slice('value='.length);
    const variants = new Set([secret, encoded, formEncoded, doubleEncoded, doubleFormEncoded]);
    for (const variant of variants) {
      if (variant) output = replaceRegisteredVariant(output, variant, secret);
    }
  }
  output = output.replace(quoted, (_match, prefix, quote) => `${prefix}${quote}${REDACTED}${quote}`);
  output = output.replace(assigned, (_match, prefix) => `${prefix}${REDACTED}`);
  output = output.replace(header, (_match, prefix) => `${prefix}${REDACTED}`);
  output = output.replace(colon, (_match, prefix) => `${prefix}${REDACTED}`);
  output = output.replace(labelled, (_match, prefix) => `${prefix}${REDACTED}`);
  return output;
}

function redactPrivatePathText(value) {
  const source = String(value ?? '');
  const trimmed = source.trim();
  const isWebUrl = /^https?:\/\//iu.test(trimmed);
  const isPrivateWindowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(trimmed);
  const isPrivatePosixPath = trimmed.startsWith('/') && !PUBLIC_ROUTE.test(trimmed);
  if (!isWebUrl && (isPrivateWindowsPath || isPrivatePosixPath)) {
    return LOCAL_PATH;
  }
  return source
    .replace(/(^|[^A-Za-z0-9])([A-Za-z]:[\\/][^\s"'`,;}\])]+)/gu,
      (_match, prefix) => `${prefix}${LOCAL_PATH}`)
    .replace(/\\\\[^\\/\s]+[\\/][^\s"'`,;}\])]+/gu, LOCAL_PATH)
    .replace(/(^|\s)(\/(?!\/)[^\s"'`,;}\])]+)/gu,
      (_match, prefix, candidate) => (
        PUBLIC_ROUTE.test(candidate) ? `${prefix}${candidate}` : `${prefix}${LOCAL_PATH}`
      ));
}

function boundedPrimitiveText(value, maxCodeUnits = MAX_LOG_TEXT_CODE_UNITS) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' || typeof value === 'function') return UNSERIALIZABLE;
  let source;
  try {
    source = String(value);
  } catch (_) {
    return UNSERIALIZABLE;
  }
  const truncated = source.length > maxCodeUnits;
  const bounded = truncated ? source.slice(0, maxCodeUnits) : source;
  const redacted = redactSecretText(redactPrivatePathText(bounded));
  return truncated ? `${redacted}${TRUNCATED}` : redacted;
}

function quoted(value) {
  return REFLECT_APPLY(JSON_STRINGIFY, JSON, [String(value)]);
}

function boundedRedactedStringify(value) {
  const ancestors = new WeakSet();
  const budget = { entries: MAX_LOG_VALUE_ENTRIES };

  function serialize(current, depth) {
    if (typeof current === 'string') {
      return quoted(boundedPrimitiveText(current, MAX_LOG_VALUE_STRING_CODE_UNITS));
    }
    if (typeof current === 'bigint' || typeof current === 'symbol' || typeof current === 'function') {
      return quoted(boundedPrimitiveText(current, MAX_LOG_VALUE_STRING_CODE_UNITS));
    }
    if (current === null) return 'null';
    if (current === undefined) return quoted('undefined');
    if (typeof current === 'number') return Number.isFinite(current) ? String(current) : quoted(String(current));
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current !== 'object' || types.isProxy(current)) return quoted(UNSERIALIZABLE);
    if (depth >= MAX_LOG_VALUE_DEPTH || budget.entries <= 0) return quoted(TRUNCATED);
    if (ancestors.has(current)) return quoted(CIRCULAR);
    if (Buffer.isBuffer(current)) return quoted('[buffer]');
    if (types.isDate(current)) return quoted('[date]');
    if (types.isMap(current)) return quoted('[map]');
    if (types.isSet(current)) return quoted('[set]');

    if (Array.isArray(current)) {
      let lengthDescriptor;
      try {
        lengthDescriptor = REFLECT_APPLY(GET_OWN_PROPERTY_DESCRIPTOR, Object, [current, 'length']);
      } catch (_) {
        return quoted(UNSERIALIZABLE);
      }
      const length = lengthDescriptor
        && REFLECT_APPLY(HAS_OWN, Object, [lengthDescriptor, 'value'])
        && Number.isSafeInteger(lengthDescriptor.value)
        && lengthDescriptor.value >= 0
        ? lengthDescriptor.value
        : 0;
      ancestors.add(current);
      try {
        const parts = [];
        const count = Math.min(length, budget.entries);
        for (let index = 0; index < count; index += 1) {
          budget.entries -= 1;
          let descriptor;
          try {
            descriptor = REFLECT_APPLY(GET_OWN_PROPERTY_DESCRIPTOR, Object, [current, String(index)]);
          } catch (_) {
            descriptor = null;
          }
          parts[parts.length] = descriptor && REFLECT_APPLY(HAS_OWN, Object, [descriptor, 'value'])
            ? serialize(descriptor.value, depth + 1)
            : quoted('[accessor-or-hole]');
        }
        if (count < length) parts[parts.length] = quoted(TRUNCATED);
        return `[${REFLECT_APPLY(ARRAY_JOIN, parts, [','])}]`;
      } catch (_) {
        return quoted(UNSERIALIZABLE);
      } finally {
        ancestors.delete(current);
      }
    }

    let descriptors;
    try {
      descriptors = REFLECT_APPLY(GET_OWN_PROPERTY_DESCRIPTORS, Object, [current]);
    } catch (_) {
      return quoted(UNSERIALIZABLE);
    }

    ancestors.add(current);
    try {
      const parts = [];
      const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]);
      for (let index = 0; index < keys.length && budget.entries > 0; index += 1) {
        const key = keys[index];
        if (typeof key !== 'string' || key === 'stack') continue;
        const descriptor = descriptors[key];
        budget.entries -= 1;
        const child = isSensitiveLogKey(key)
          ? quoted(REDACTED)
          : descriptor && REFLECT_APPLY(HAS_OWN, Object, [descriptor, 'value'])
            ? serialize(descriptor.value, depth + 1)
            : quoted('[accessor]');
        parts[parts.length] = `${quoted(boundedPrimitiveText(key, 128))}:${child}`;
      }
      if (keys.length > parts.length && budget.entries <= 0) {
        parts[parts.length] = `${quoted('$truncated')}:true`;
      }
      return `{${REFLECT_APPLY(ARRAY_JOIN, parts, [','])}}`;
    } catch (_) {
      return quoted(UNSERIALIZABLE);
    } finally {
      ancestors.delete(current);
    }
  }

  try {
    return serialize(value, 0);
  } catch (_) {
    return quoted(UNSERIALIZABLE);
  }
}

function redactLogValue(value, ancestors = new WeakSet()) {
  if (typeof value === 'string') return redactSecretText(value);
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (value == null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `[buffer: ${value.length} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return redactSecretText(value.toString());
  if (ancestors.has(value)) return CIRCULAR;

  ancestors.add(value);
  try {
    if (value instanceof Error) {
      const result = {
        name: value.name,
        message: redactSecretText(value.message),
      };
      if (value.stack) result.stack = redactSecretText(value.stack);
      for (const [key, child] of Object.entries(value)) {
        result[key] = isSensitiveLogKey(key) ? REDACTED : redactLogValue(child, ancestors);
      }
      return result;
    }
    if (Array.isArray(value)) return value.map((child) => redactLogValue(child, ancestors));
    if (value instanceof Map) {
      return [...value.entries()].map(([key, child]) => [
        redactSecretText(key),
        isSensitiveLogKey(key) ? REDACTED : redactLogValue(child, ancestors),
      ]);
    }
    if (value instanceof Set) return [...value].map((child) => redactLogValue(child, ancestors));

    const result = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      result[key] = isSensitiveLogKey(key) ? REDACTED : redactLogValue(child, ancestors);
    }
    return result;
  } catch (_) {
    return '[unserializable]';
  } finally {
    ancestors.delete(value);
  }
}

function safeRedactedStringify(value) {
  try {
    return JSON.stringify(redactLogValue(value));
  } catch (_) {
    return JSON.stringify('[unserializable]');
  }
}

module.exports = {
  MAX_LOG_TEXT_CODE_UNITS,
  REDACTED,
  boundedPrimitiveText,
  boundedRedactedStringify,
  isSensitiveLogKey,
  registerKnownLogSecrets,
  registerLogSecrets,
  redactLogValue,
  redactPrivatePathText,
  redactSecretText,
  safeRedactedStringify,
};
