const { types: { isProxy } } = require('node:util');

const DEFAULT_LIMITS = Object.freeze({
  maxArrayLength: 5000,
  maxDepth: 20,
  maxEntries: 20000,
  maxStringBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
});
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function invalid() {
  const error = new TypeError('Structured input is invalid');
  error.code = 'STRUCTURED_INPUT_INVALID';
  return error;
}

function limited() {
  const error = new RangeError('Structured input exceeds the supported limit');
  error.code = 'STRUCTURED_INPUT_LIMIT_EXCEEDED';
  return error;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function snapshotJson(value, overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const seen = new WeakSet();
  let entries = 0;
  let totalBytes = 0;

  function accountString(text) {
    const bytes = byteLength(text);
    if (bytes > limits.maxStringBytes) throw limited();
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) throw limited();
  }

  function visit(candidate, depth) {
    if (depth > limits.maxDepth) throw limited();
    if (candidate === null || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw invalid();
      return candidate;
    }
    if (typeof candidate === 'string') {
      accountString(candidate);
      return candidate;
    }
    if (typeof candidate !== 'object' || isProxy(candidate)) throw invalid();
    if (seen.has(candidate)) throw invalid();
    seen.add(candidate);

    const prototype = Object.getPrototypeOf(candidate);
    const isArray = Array.isArray(candidate);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw invalid();
    }

    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === 'symbol')) throw invalid();

    if (isArray) {
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) throw invalid();
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > limits.maxArrayLength) throw limited();
      if (keys.length !== length + 1) throw invalid();
      const result = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
        entries += 1;
        if (entries > limits.maxEntries) throw limited();
        result[index] = visit(descriptor.value, depth + 1);
      }
      return Object.freeze(result);
    }

    const result = Object.create(null);
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) throw invalid();
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
      entries += 1;
      if (entries > limits.maxEntries) throw limited();
      accountString(key);
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        value: visit(descriptor.value, depth + 1),
        writable: false,
      });
    }
    return Object.freeze(result);
  }

  return visit(value, 0);
}

function assertExactObject(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalid();
  }
  return value;
}

module.exports = { assertExactObject, snapshotJson };
