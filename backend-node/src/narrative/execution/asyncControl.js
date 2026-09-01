'use strict';

const { types: { isPromise, isProxy } } = require('node:util');

const NATIVE_PROMISE = Promise;
const NATIVE_PROMISE_THEN = Object.getOwnPropertyDescriptor(
  NATIVE_PROMISE.prototype,
  'then',
).value;
const SAFE_SPECIES_HOLDER = Object.create(null);
Object.defineProperty(SAFE_SPECIES_HOLDER, Symbol.species, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: NATIVE_PROMISE,
});
Object.freeze(SAFE_SPECIES_HOLDER);

function isSafePromise(value) {
  if (!isPromise(value) || isProxy(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== NATIVE_PROMISE.prototype
      || !Object.isExtensible(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return !Object.hasOwn(descriptors, 'then')
      && (!Object.hasOwn(descriptors, 'constructor')
        || descriptors.constructor.configurable === true);
  } catch {
    return false;
  }
}

function shieldPromise(value, configurable = false) {
  Object.defineProperty(value, 'constructor', {
    configurable,
    enumerable: false,
    writable: false,
    value: SAFE_SPECIES_HOLDER,
  });
  return value;
}

function observe(value, onFulfilled, onRejected) {
  if (!isSafePromise(value)) throw new TypeError('Narrative provider promise is invalid');
  const original = Object.getOwnPropertyDescriptor(value, 'constructor');
  let shielded = false;
  try {
    shieldPromise(value, true);
    shielded = true;
    Reflect.apply(NATIVE_PROMISE_THEN, value, [onFulfilled, onRejected]);
  } finally {
    if (shielded) {
      if (original === undefined) delete value.constructor;
      else Object.defineProperty(value, 'constructor', original);
    }
  }
}

function createNarrativePromise(executor) {
  if (typeof executor !== 'function') {
    throw new TypeError('Narrative promise executor is invalid');
  }
  return shieldPromise(new NATIVE_PROMISE(executor));
}

function rejectNarrativePromise(error) {
  return createNarrativePromise((resolve, reject) => reject(error));
}

function settleNarrativeProviderPromise(value, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new TypeError('Narrative provider timeout is invalid');
  }
  return createNarrativePromise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(output);
    };
    timer = setTimeout(() => {
      finish(reject, new TypeError('Narrative provider operation timed out'));
    }, timeoutMs);
    try {
      observe(
        value,
        (output) => finish(resolve, output),
        (error) => finish(reject, error),
      );
    } catch (error) {
      finish(reject, error);
    }
  });
}

module.exports = Object.freeze({
  createNarrativePromise,
  observeNarrativePromise: observe,
  rejectNarrativePromise,
  settleNarrativeProviderPromise,
});
