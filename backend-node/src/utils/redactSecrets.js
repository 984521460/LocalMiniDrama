'use strict';

const REDACTED = '[redacted]';
const CIRCULAR = '[circular]';
const MAX_REGISTERED_SECRETS = 512;
const registeredSecrets = new Set();

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
  return SENSITIVE_KEY_MARKERS.some((marker) => (
    normalized === marker || normalized.endsWith(marker)
  ));
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
  REDACTED,
  isSensitiveLogKey,
  registerKnownLogSecrets,
  registerLogSecrets,
  redactLogValue,
  redactSecretText,
  safeRedactedStringify,
};
