'use strict';

const { types: { isProxy } } = require('node:util');

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'length',
).get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer',
).get;
const TYPED_ARRAY_SET = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'set').value;
const FORBIDDEN_OWN_PROPERTIES = Object.freeze([
  'length', 'buffer', 'byteLength', 'byteOffset', 'constructor', 'valueOf', Symbol.iterator,
]);

function snapshotExactBytes(value, {
  expectedPrototype, maxBytes, errorFactory, limitErrorFactory, requireBuffer,
}) {
  const fail = () => { throw errorFactory(); };
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1
    || value === null || typeof value !== 'object' || isProxy(value)) fail();

  let prototype;
  try { prototype = Object.getPrototypeOf(value); } catch { fail(); }
  if (prototype !== expectedPrototype) fail();

  for (const property of FORBIDDEN_OWN_PROPERTIES) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, property); } catch { fail(); }
    if (descriptor !== undefined) fail();
  }
  if (requireBuffer && !Buffer.isBuffer(value)) fail();

  let length;
  let backingBuffer;
  let backingPrototype;
  try {
    length = TYPED_ARRAY_LENGTH_GETTER.call(value);
    backingBuffer = TYPED_ARRAY_BUFFER_GETTER.call(value);
    backingPrototype = Object.getPrototypeOf(backingBuffer);
  } catch {
    fail();
  }
  if (!Number.isSafeInteger(length) || length < 1 || backingPrototype !== ArrayBuffer.prototype) fail();
  if (length > maxBytes) throw (limitErrorFactory || errorFactory)();

  const snapshot = Buffer.alloc(length);
  try { Reflect.apply(TYPED_ARRAY_SET, snapshot, [value]); } catch { fail(); }
  return snapshot;
}

function snapshotBuffer(value, maxBytes, errorFactory, limitErrorFactory = errorFactory) {
  return snapshotExactBytes(value, {
    expectedPrototype: Buffer.prototype,
    maxBytes,
    errorFactory,
    limitErrorFactory,
    requireBuffer: true,
  });
}

function snapshotUint8Array(value, maxBytes, errorFactory) {
  return snapshotExactBytes(value, {
    expectedPrototype: Uint8Array.prototype,
    maxBytes,
    errorFactory,
    limitErrorFactory: errorFactory,
    requireBuffer: false,
  });
}

module.exports = Object.freeze({ snapshotBuffer, snapshotUint8Array });
