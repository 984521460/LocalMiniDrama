const crypto = require('node:crypto');

class JsonSnapshotError extends Error {
  constructor(limitExceeded = false) {
    super('JSON snapshot failed');
    this.name = 'JsonSnapshotError';
    this.limitExceeded = limitExceeded;
  }
}

function fail(limitExceeded = false) {
  throw new JsonSnapshotError(limitExceeded);
}

function snapshotJson(value, options = {}) {
  const maxDepth = options.maxDepth ?? 32;
  const maxNodes = options.maxNodes ?? 20000;
  const maxStringBytes = options.maxStringBytes ?? (16 * 1024 * 1024);
  let nodes = 0;
  let stringBytes = 0;

  function visit(current, depth) {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) fail(true);
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') {
      stringBytes += Buffer.byteLength(current, 'utf8');
      if (stringBytes > maxStringBytes) fail(true);
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail();
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== 'object') fail();

    let descriptors;
    let prototype;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current);
      prototype = Object.getPrototypeOf(current);
    } catch {
      return fail();
    }

    if (Array.isArray(current)) {
      if (prototype !== Array.prototype
        || !descriptors.length
        || !Object.hasOwn(descriptors.length, 'value')
        || !Number.isSafeInteger(descriptors.length.value)
        || descriptors.length.value < 0) fail();
      const length = descriptors.length.value;
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== 'string'
        || (key !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(key)))) fail();
      const output = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
        output[index] = visit(descriptor.value, depth + 1);
      }
      return output;
    }

    if (prototype !== Object.prototype && prototype !== null) fail();
    const output = {};
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string'
      || !Object.hasOwn(descriptors[key], 'value'))) fail();
    keys.sort();
    for (const key of keys) {
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: visit(descriptors[key].value, depth + 1),
        writable: true,
      });
    }
    return output;
  }

  return visit(value, 0);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function sha256Canonical(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

module.exports = {
  JsonSnapshotError,
  deepFreeze,
  sha256Canonical,
  snapshotJson,
};
