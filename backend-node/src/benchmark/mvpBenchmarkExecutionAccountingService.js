'use strict';

const crypto = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { raceNativePromise } = require('../integrations/comfyui/asyncControl');
const {
  MvpBenchmarkExecutionAccountingError,
} = require('./mvpBenchmarkExecutionAccounting');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function fail(code = 'MVP_BENCHMARK_EXECUTION_ACCOUNTING_INPUT_INVALID') {
  throw new MvpBenchmarkExecutionAccountingError(code);
}

function capture(value, methods) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('MVP benchmark execution accounting service configuration is invalid');
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch {
    throw new TypeError('MVP benchmark execution accounting service configuration is invalid');
  }
  const captured = Object.create(null);
  for (let index = 0; index < methods.length; index += 1) {
    const descriptor = descriptors[methods[index]];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) {
      throw new TypeError('MVP benchmark execution accounting service configuration is invalid');
    }
    captured[methods[index]] = descriptor.value;
  }
  return Object.freeze({ target: value, methods: Object.freeze(captured) });
}

function configuration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('MVP benchmark execution accounting service configuration is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = Object.freeze([
    'repositories', 'costFinalizer', 'releaseVerifier', 'createUid', 'nowEpochMs', 'timeoutMs',
  ]);
  const descriptorKeys = Reflect.ownKeys(descriptors);
  for (let keyIndex = 0; keyIndex < descriptorKeys.length; keyIndex += 1) {
    const key = descriptorKeys[keyIndex];
    let found = false;
    for (let allowedIndex = 0; allowedIndex < allowed.length; allowedIndex += 1) {
      if (allowed[allowedIndex] === key) { found = true; break; }
    }
    if (typeof key !== 'string' || !found) {
      throw new TypeError('MVP benchmark execution accounting service configuration is invalid');
    }
  }
  const repositories = descriptors.repositories?.value;
  const createUid = descriptors.createUid?.value ?? crypto.randomUUID;
  const nowEpochMs = descriptors.nowEpochMs?.value ?? Date.now;
  const timeoutMs = descriptors.timeoutMs?.value ?? DEFAULT_TIMEOUT_MS;
  if (!repositories?.mvpBenchmarkExecutionAccounting
    || typeof createUid !== 'function' || isProxy(createUid)
    || typeof nowEpochMs !== 'function' || isProxy(nowEpochMs)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new TypeError('MVP benchmark execution accounting service configuration is invalid');
  }
  return Object.freeze({
    repositories,
    accounting: repositories.mvpBenchmarkExecutionAccounting,
    costFinalizer: capture(descriptors.costFinalizer?.value, ['finalizeH3', 'finalizeTts']),
    releaseVerifier: capture(descriptors.releaseVerifier?.value, ['inspect']),
    createUid,
    nowEpochMs,
    timeoutMs,
  });
}

function uid(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail();
  return value;
}

function now(configured) {
  let value;
  try { value = Reflect.apply(configured.nowEpochMs, undefined, []); } catch {
    return fail('MVP_BENCHMARK_EXECUTION_ACCOUNTING_UNAVAILABLE');
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) {
    fail('MVP_BENCHMARK_EXECUTION_ACCOUNTING_UNAVAILABLE');
  }
  return value;
}

function nextUid(configured) {
  let value;
  try { value = Reflect.apply(configured.createUid, undefined, []); } catch {
    return fail('MVP_BENCHMARK_EXECUTION_ACCOUNTING_UNAVAILABLE');
  }
  return uid(value);
}

function exactResult(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('MVP_BENCHMARK_EXECUTION_ACCOUNTING_UNAVAILABLE');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail('MVP_BENCHMARK_EXECUTION_ACCOUNTING_UNAVAILABLE');
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) {
    fail('MVP_BENCHMARK_EXECUTION_ACCOUNTING_UNAVAILABLE');
  }
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = descriptors[keys[index]];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('MVP_BENCHMARK_EXECUTION_ACCOUNTING_UNAVAILABLE');
    }
    output[keys[index]] = descriptor.value;
  }
  return output;
}

async function call(configured, binding, method, argument) {
  let pending;
  try { pending = Reflect.apply(binding.methods[method], binding.target, [argument]); } catch {
    return fail('MVP_BENCHMARK_EXECUTION_ACCOUNTING_UNAVAILABLE');
  }
  try {
    return await raceNativePromise(pending, { timeoutMs: configured.timeoutMs });
  } catch {
    return fail('MVP_BENCHMARK_EXECUTION_ACCOUNTING_UNAVAILABLE');
  }
}

function createMvpBenchmarkExecutionAccountingService(value) {
  const configured = configuration(value);

  return Object.freeze({
    async settle(reservationUid) {
      const canonicalReservationUid = uid(reservationUid);
      const existing = configured.accounting.getSettlementByReservation(canonicalReservationUid);
      if (existing) return existing;
      const terminal = configured.accounting.inspectTerminalReservation(canonicalReservationUid);
      const method = terminal.reservation.itemKind === 'h3' ? 'finalizeH3' : 'finalizeTts';
      const result = exactResult(await call(
        configured,
        configured.costFinalizer,
        method,
        Object.freeze({
          reservation: terminal.reservation,
          outcome: terminal.outcome,
          terminalEvidenceSha256: terminal.terminalEvidenceSha256,
        }),
      ), ['actualCostCnyFen', 'billingEvidenceSha256']);
      if (!Number.isSafeInteger(result.actualCostCnyFen)
        || result.actualCostCnyFen < 0
        || result.actualCostCnyFen > terminal.reservation.estimatedCostCnyFen
        || typeof result.billingEvidenceSha256 !== 'string'
        || !SHA256.test(result.billingEvidenceSha256)) {
        fail('MVP_BENCHMARK_EXECUTION_ACCOUNTING_UNAVAILABLE');
      }
      return configured.accounting.settle({
        uid: nextUid(configured),
        reservationUid: canonicalReservationUid,
        actualCostCnyFen: result.actualCostCnyFen,
        billingEvidenceSha256: result.billingEvidenceSha256,
      }, { nowEpochMs: now(configured) });
    },
    async release(authorizationUid) {
      const canonicalAuthorizationUid = uid(authorizationUid);
      const current = configured.accounting.getReleaseObligation(canonicalAuthorizationUid);
      if (current.receipt) return current.receipt;
      const result = exactResult(await call(
        configured,
        configured.releaseVerifier,
        'inspect',
        current.obligation,
      ), ['released', 'releaseEvidenceSha256']);
      if (result.released !== true
        || typeof result.releaseEvidenceSha256 !== 'string'
        || !SHA256.test(result.releaseEvidenceSha256)) {
        fail('MVP_BENCHMARK_RESOURCE_RELEASE_REQUIRED');
      }
      return configured.accounting.confirmRelease({
        authorizationUid: canonicalAuthorizationUid,
        releaseEvidenceSha256: result.releaseEvidenceSha256,
      }, { nowEpochMs: now(configured) });
    },
    recoverOpen() {
      return configured.accounting.recoverOpen();
    },
  });
}

module.exports = Object.freeze({ createMvpBenchmarkExecutionAccountingService });
