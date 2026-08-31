'use strict';

const { types: { isPromise, isProxy } } = require('node:util');

const NATIVE_PROMISE = Promise;
const promiseThen = Object.getOwnPropertyDescriptor(NATIVE_PROMISE.prototype, 'then').value;
const SAFE_SPECIES_HOLDER = Object.create(null);
Object.defineProperty(SAFE_SPECIES_HOLDER, Symbol.species, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: NATIVE_PROMISE,
});
Object.freeze(SAFE_SPECIES_HOLDER);
const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const trustedErrors = new WeakSet();

function shieldInternalPromise(value) {
  Object.defineProperty(value, 'constructor', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: NATIVE_PROMISE,
  });
  return value;
}

class ComfyAsyncControlError extends Error {
  constructor(code) {
    super('ComfyUI asynchronous operation did not settle safely');
    this.name = 'ComfyAsyncControlError';
    this.code = code;
    trustedErrors.add(this);
    Object.freeze(this);
  }
}

function controlError(code) {
  return new ComfyAsyncControlError(code);
}

function isComfyAsyncControlError(error, code) {
  return trustedErrors.has(error) && (code === undefined || error.code === code);
}

function isExactNativePromise(value) {
  if (!isPromise(value) || isProxy(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== NATIVE_PROMISE.prototype || !Object.isExtensible(value)) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return !Object.hasOwn(descriptors, 'then') && !Object.hasOwn(descriptors, 'constructor');
  } catch {
    return false;
  }
}

function observeNativePromise(value, onFulfilled, onRejected) {
  if (!isExactNativePromise(value)) throw controlError('COMFY_ASYNC_VALUE_INVALID');
  let shielded = false;
  try {
    Object.defineProperty(value, 'constructor', {
      configurable: true,
      enumerable: false,
      writable: false,
      value: SAFE_SPECIES_HOLDER,
    });
    shielded = true;
    Reflect.apply(promiseThen, value, [onFulfilled, onRejected]);
  } finally {
    if (shielded) delete value.constructor;
  }
}

function raceNativePromise(value, { signal, timeoutMs, onAbort, onTimeout } = {}) {
  return shieldInternalPromise(new NATIVE_PROMISE((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (signal) removeEventListener.call(signal, 'abort', handleAbort);
      callback(result);
    };
    const runHook = (hook) => {
      try { hook?.(); } catch { /* internal cleanup hooks must not replace the fixed result */ }
    };
    const handleAbort = () => {
      runHook(onAbort);
      finish(reject, controlError('COMFY_ASYNC_ABORTED'));
    };

    try {
      if ((onAbort !== undefined && typeof onAbort !== 'function')
        || (onTimeout !== undefined && typeof onTimeout !== 'function')) {
        finish(reject, controlError('COMFY_ASYNC_VALUE_INVALID'));
        return;
      }
      if (signal) {
        if (abortedGetter.call(signal)) {
          handleAbort();
          return;
        }
        addEventListener.call(signal, 'abort', handleAbort, { once: true });
      }
      if (timeoutMs !== undefined) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000) {
          finish(reject, controlError('COMFY_ASYNC_VALUE_INVALID'));
          return;
        }
        timer = setTimeout(
          () => {
            runHook(onTimeout);
            finish(reject, controlError('COMFY_ASYNC_TIMEOUT'));
          },
          timeoutMs,
        );
      }
      observeNativePromise(
        value,
        (result) => finish(resolve, result),
        (error) => finish(reject, error),
      );
    } catch (error) {
      finish(reject, error);
    }
  }));
}

function ignoreNativePromise(value) {
  try { observeNativePromise(value, () => {}, () => {}); } catch { /* unsupported cleanup */ }
}

module.exports = {
  ignoreNativePromise,
  isComfyAsyncControlError,
  raceNativePromise,
};
