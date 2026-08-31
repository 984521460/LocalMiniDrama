'use strict';

const { types: { isPromise, isProxy } } = require('node:util');

const NATIVE_PROMISE = Promise;
const NATIVE_PROMISE_THEN = Object.getOwnPropertyDescriptor(
  NATIVE_PROMISE.prototype, 'then',
).value;
const ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const SAFE_SPECIES_HOLDER = Object.create(null);
Object.defineProperty(SAFE_SPECIES_HOLDER, Symbol.species, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: NATIVE_PROMISE,
});
Object.freeze(SAFE_SPECIES_HOLDER);

function isSafePromiseCandidate(value) {
  if (!isPromise(value) || isProxy(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== NATIVE_PROMISE.prototype
      || !Object.isExtensible(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.hasOwn(descriptors, 'then')) return false;
    if (!Object.hasOwn(descriptors, 'constructor')) return true;
    const constructor = descriptors.constructor;
    return (constructor.configurable === true)
      || (constructor.configurable === false && Object.hasOwn(constructor, 'value')
        && constructor.value === SAFE_SPECIES_HOLDER);
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
  if (!isSafePromiseCandidate(value)) throw new TypeError('TTS asynchronous value is invalid');
  const original = Object.getOwnPropertyDescriptor(value, 'constructor');
  if (original && original.configurable === false) {
    Reflect.apply(NATIVE_PROMISE_THEN, value, [onFulfilled, onRejected]);
    return;
  }
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

function settleTtsPromise(value, { signal, timeoutMs, onAbort, onTimeout } = {}) {
  const result = new NATIVE_PROMISE((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, output) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (signal) {
        try { Reflect.apply(REMOVE_EVENT_LISTENER, signal, ['abort', handleAbort]); } catch { /* fixed */ }
      }
      callback(output);
    };
    const hook = (callback) => {
      try { callback?.(); } catch { /* cleanup must not replace fixed failure */ }
    };
    const handleAbort = () => {
      hook(onAbort);
      finish(reject, new TypeError('TTS asynchronous operation aborted'));
    };
    try {
      if ((onAbort !== undefined && typeof onAbort !== 'function')
        || (onTimeout !== undefined && typeof onTimeout !== 'function')) {
        finish(reject, new TypeError('TTS asynchronous value is invalid'));
        return;
      }
      if (signal) {
        if (typeof signal !== 'object' || isProxy(signal)) {
          finish(reject, new TypeError('TTS asynchronous value is invalid'));
          return;
        }
        if (Object.getPrototypeOf(signal) !== AbortSignal.prototype
          || ABORTED_GETTER.call(signal)) {
          handleAbort();
          return;
        }
        Reflect.apply(ADD_EVENT_LISTENER, signal, ['abort', handleAbort, { once: true }]);
      }
      if (timeoutMs !== undefined) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
          finish(reject, new TypeError('TTS asynchronous value is invalid'));
          return;
        }
        timer = setTimeout(() => {
          hook(onTimeout);
          finish(reject, new TypeError('TTS asynchronous operation timed out'));
        }, timeoutMs);
      }
      observe(
        value,
        (output) => finish(resolve, output),
        (error) => finish(reject, error),
      );
    } catch (error) {
      finish(reject, error);
    }
  });
  return shieldPromise(result);
}

function ignoreTtsPromise(value) {
  try { observe(value, () => {}, () => {}); } catch { /* unsupported cleanup */ }
}

module.exports = Object.freeze({ ignoreTtsPromise, settleTtsPromise });
