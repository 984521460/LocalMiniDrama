'use strict';

const { spawn } = require('node:child_process');
const { types: { isPromise, isProxy } } = require('node:util');

const { fail } = require('../audio/audioContract');

const CODE = 'MEDIA_PROBE_FAILED';
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const NATIVE_PROMISE = Promise;
const NATIVE_PROMISE_THEN = Object.getOwnPropertyDescriptor(
  NATIVE_PROMISE.prototype, 'then',
).value;
const SAFE_SPECIES_HOLDER = Object.create(null);
Object.defineProperty(SAFE_SPECIES_HOLDER, Symbol.species, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: NATIVE_PROMISE,
});
Object.freeze(SAFE_SPECIES_HOLDER);

function invalid() {
  fail(CODE);
}

function runBoundedMediaProcess(command, args, { timeoutMs, maxOutputBytes, cwd }) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const kill = () => {
      try { child?.kill(); } catch { /* fixed process failure below */ }
    };
    const append = (target, chunk, currentBytes) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (currentBytes + bytes.length > maxOutputBytes) {
        kill();
        finish(reject, new Error('bounded media process output exceeded'));
        return null;
      }
      target.push(bytes);
      return currentBytes + bytes.length;
    };
    const timer = setTimeout(() => {
      kill();
      finish(reject, new Error('bounded media process timeout'));
    }, timeoutMs);
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => {
        const next = append(stdout, chunk, stdoutBytes);
        if (next !== null) stdoutBytes = next;
      });
      child.stderr.on('data', (chunk) => {
        const next = append(stderr, chunk, stderrBytes);
        if (next !== null) stderrBytes = next;
      });
      child.once('error', (error) => finish(reject, error));
      child.once('close', (exitCode) => finish(resolve, {
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }));
    } catch (error) {
      finish(reject, error);
    }
  });
}

function isSafePromiseCandidate(value) {
  if (!isPromise(value) || isProxy(value)) return false;
  try {
    if (!Object.isExtensible(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const constructor = Object.hasOwn(descriptors, 'constructor')
      ? descriptors.constructor
      : undefined;
    return constructor === undefined || constructor.configurable === true;
  } catch {
    return false;
  }
}

function shieldInternalPromise(value) {
  Object.defineProperty(value, 'constructor', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: NATIVE_PROMISE,
  });
  return value;
}

function settleNativePromise(value, timeoutMs) {
  return shieldInternalPromise(new NATIVE_PROMISE((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(result);
    };
    const timer = setTimeout(() => finish(reject, new Error('process promise timeout')), timeoutMs);
    if (!isSafePromiseCandidate(value)) {
      finish(reject, new Error('unsupported process promise'));
      return;
    }
    const originalConstructor = Object.getOwnPropertyDescriptor(value, 'constructor');
    let constructorShielded = false;
    try {
      Object.defineProperty(value, 'constructor', {
        configurable: true,
        enumerable: false,
        writable: false,
        value: SAFE_SPECIES_HOLDER,
      });
      constructorShielded = true;
      Reflect.apply(NATIVE_PROMISE_THEN, value, [
        (result) => finish(resolve, Object.freeze({ value: result })),
        () => finish(reject, new Error('process promise failed')),
      ]);
    } catch {
      finish(reject, new Error('process promise invalid'));
    } finally {
      if (constructorShielded) {
        if (originalConstructor === undefined) delete value.constructor;
        else Object.defineProperty(value, 'constructor', originalConstructor);
      }
    }
  }));
}

function boundedProcessResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) invalid();
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return invalid();
  }
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(descriptors);
  const expected = ['exitCode', 'stderr', 'stdout'];
  if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string')
    || [...keys].sort().some((key, index) => key !== expected[index])) invalid();
  const result = Object.create(null);
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    result[key] = descriptor.value;
  }
  if (!Number.isSafeInteger(result.exitCode)
    || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
    || Buffer.byteLength(result.stdout, 'utf8') > MAX_PROCESS_OUTPUT_BYTES
    || Buffer.byteLength(result.stderr, 'utf8') > MAX_PROCESS_OUTPUT_BYTES) invalid();
  return result;
}

async function executeBoundedMediaProcess(config, command, args) {
  try {
    const options = {
      timeoutMs: config.timeoutMs,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    };
    if (config.cwd !== undefined) options.cwd = config.cwd;
    const pending = config.runProcess(command, Object.freeze([...args]), Object.freeze(options));
    const settled = await settleNativePromise(pending, config.timeoutMs);
    const result = boundedProcessResult(settled.value);
    if (result.exitCode !== 0) invalid();
    return result;
  } catch {
    return invalid();
  }
}

module.exports = Object.freeze({
  executeBoundedMediaProcess,
  runBoundedMediaProcess,
});
