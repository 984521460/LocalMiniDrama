'use strict';

const crypto = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { raceNativePromise } = require('../integrations/comfyui/asyncControl');
const {
  MvpBenchmarkExecutionPreflightError,
  assertMvpBenchmarkLiveEnvironmentAttestationFresh,
  createMvpBenchmarkCostEstimate,
  createMvpBenchmarkLiveEnvironmentObservation,
} = require('./mvpBenchmarkExecutionPreflight');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function fail(code = 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID') {
  throw new MvpBenchmarkExecutionPreflightError(code);
}

function capture(target, methods) {
  if (!target || typeof target !== 'object' || Array.isArray(target) || isProxy(target)) {
    throw new TypeError('MVP benchmark execution preflight service configuration is invalid');
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(target); } catch {
    throw new TypeError('MVP benchmark execution preflight service configuration is invalid');
  }
  const captured = Object.create(null);
  for (let index = 0; index < methods.length; index += 1) {
    const method = methods[index];
    const descriptor = descriptors[method];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) {
      throw new TypeError('MVP benchmark execution preflight service configuration is invalid');
    }
    captured[method] = descriptor.value;
  }
  return Object.freeze({ target, methods: Object.freeze(captured) });
}

function configuration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('MVP benchmark execution preflight service configuration is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([
    'repositories', 'liveEnvironmentVerifier', 'costEstimator', 'createUid', 'nowEpochMs',
    'timeoutMs',
  ]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('MVP benchmark execution preflight service configuration is invalid');
  }
  const repositories = descriptors.repositories?.value;
  const createUid = descriptors.createUid?.value ?? crypto.randomUUID;
  const nowEpochMs = descriptors.nowEpochMs?.value ?? Date.now;
  const timeoutMs = descriptors.timeoutMs?.value ?? DEFAULT_TIMEOUT_MS;
  if (!repositories || typeof repositories !== 'object' || isProxy(repositories)
    || !repositories.mvpBenchmarkExternalAuthorizations
    || !repositories.mvpBenchmarkExecutionPreflights
    || typeof createUid !== 'function' || isProxy(createUid)
    || typeof nowEpochMs !== 'function' || isProxy(nowEpochMs)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new TypeError('MVP benchmark execution preflight service configuration is invalid');
  }
  return Object.freeze({
    repositories,
    liveEnvironmentVerifier: capture(descriptors.liveEnvironmentVerifier?.value, ['inspect']),
    costEstimator: capture(descriptors.costEstimator?.value, ['estimateH3', 'estimateTts']),
    createUid,
    nowEpochMs,
    timeoutMs,
  });
}

function canonicalUid(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail();
  return value;
}

function sha256(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail();
  return value;
}

function now(configured) {
  let value;
  try { value = Reflect.apply(configured.nowEpochMs, undefined, []); } catch {
    return fail('MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE');
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) {
    fail('MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE');
  }
  return value;
}

function nextUid(configured) {
  let value;
  try { value = Reflect.apply(configured.createUid, undefined, []); } catch {
    return fail('MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE');
  }
  return canonicalUid(value);
}

function resultObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail('MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE');
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) {
    fail('MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE');
  }
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = descriptors[keys[index]];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE');
    }
    output[keys[index]] = descriptor.value;
  }
  return output;
}

async function call(configured, binding, method, argument) {
  let pending;
  try {
    pending = Reflect.apply(binding.methods[method], binding.target, [argument]);
  } catch {
    return fail('MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE');
  }
  try {
    return await raceNativePromise(pending, { timeoutMs: configured.timeoutMs });
  } catch {
    return fail('MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE');
  }
}

function createMvpBenchmarkExecutionPreflightService(value) {
  const configured = configuration(value);
  const authorizations = configured.repositories.mvpBenchmarkExternalAuthorizations;
  const preflights = configured.repositories.mvpBenchmarkExecutionPreflights;

  async function attest(authorizationUid) {
    const authorization = authorizations.requireActive(
      canonicalUid(authorizationUid), now(configured),
    );
    const raw = await call(configured, configured.liveEnvironmentVerifier, 'inspect', Object.freeze({
      authorizationUid: authorization.uid,
      sessionUid: authorization.sessionUid,
      connectionUid: authorization.connectionUid,
      connectionEvidenceSha256: authorization.connectionEvidenceSha256,
      approvedEnvironmentSha256: authorization.requiredEnvironmentSha256,
    }));
    const observation = createMvpBenchmarkLiveEnvironmentObservation(raw);
    const currentTime = now(configured);
    return preflights.attest({
      uid: nextUid(configured),
      authorizationUid: authorization.uid,
      observation,
    }, { nowEpochMs: currentTime });
  }

  async function reserve(itemKind, value) {
    const input = resultObject(value, [
      'authorizationUid', 'attestationUid', 'itemUid', 'requestSha256',
    ]);
    const authorizationUid = canonicalUid(input.authorizationUid);
    const attestationUid = canonicalUid(input.attestationUid);
    const itemUid = canonicalUid(input.itemUid);
    const requestSha256 = sha256(input.requestSha256);
    const authorization = authorizations.requireActive(authorizationUid, now(configured));
    const attestation = assertMvpBenchmarkLiveEnvironmentAttestationFresh(
      preflights.getAttestation(attestationUid),
      now(configured),
    );
    if (attestation.authorizationUid !== authorization.uid) fail();
    const method = itemKind === 'h3' ? 'estimateH3' : 'estimateTts';
    const rawEstimate = resultObject(
      await call(configured, configured.costEstimator, method, Object.freeze({
        authorizationUid, attestationUid, itemUid, requestSha256,
      })),
      ['estimatedCostCnyFen', 'policyUid'],
    );
    const estimate = createMvpBenchmarkCostEstimate({
      schemaVersion: 'mvp-benchmark-cost-estimate.v1',
      itemKind,
      itemUid,
      requestSha256,
      estimatedCostCnyFen: rawEstimate.estimatedCostCnyFen,
      policyUid: rawEstimate.policyUid,
    });
    const currentTime = now(configured);
    return preflights.reserve({
      uid: nextUid(configured),
      authorizationUid,
      attestationUid,
      itemKind,
      itemUid,
      requestSha256,
      estimate,
    }, { nowEpochMs: currentTime });
  }

  return Object.freeze({
    attest,
    reserveH3: (value) => reserve('h3', value),
    reserveTts: (value) => reserve('tts', value),
  });
}

module.exports = Object.freeze({ createMvpBenchmarkExecutionPreflightService });
