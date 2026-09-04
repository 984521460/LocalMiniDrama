'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { RTX_4090_GPU_CLASS } = require('../h3/gpuClasses');
const {
  MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256,
} = require('./mvpBenchmarkApprovedEnvironment');

const REQUEST_SCHEMA_VERSION = 'mvp-benchmark-external-authorization-request.v1';
const AUTHORIZATION_SCHEMA_VERSION = 'mvp-benchmark-external-authorization.v1';
const MAXIMUM_COST_CNY_FEN = 1_000_000;
const MINIMUM_VALIDITY_DURATION_MS = 60_000;
const MAXIMUM_VALIDITY_DURATION_MS = 24 * 60 * 60 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REQUEST_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'sessionUid', 'dramaUid', 'sessionPlanSha256',
  'connectionUid', 'connectionEvidenceSha256', 'maximumCostCnyFen',
  'validityDurationMs',
]);
const CREATE_KEYS = Object.freeze([
  'request', 'h3SubmissionLimit', 'ttsSubmissionLimit', 'authorizedAtEpochMs',
]);
const AUTHORIZATION_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'sessionUid', 'dramaUid', 'sessionPlanSha256',
  'connectionUid', 'connectionEvidenceSha256', 'requiredGpuClass',
  'requiredEnvironmentSha256', 'liveEnvironmentCheck',
  'maximumCostCnyFen', 'dataScope', 'h3SubmissionLimit', 'ttsSubmissionLimit',
  'perItemAttemptLimit', 'instanceDisposition', 'authorizedAtEpochMs',
  'expiresAtEpochMs', 'authorizationSha256',
]);
const ARRAY_IS_ARRAY = Array.isArray;
const JSON_STRINGIFY = JSON.stringify;
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_TEST = RegExp.prototype.test;

class MvpBenchmarkExternalAuthorizationError extends Error {
  constructor(code) {
    const messages = {
      MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_DATA_INVALID:
        'MVP benchmark external authorization data is invalid',
      MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_EXPIRED:
        'MVP benchmark external authorization has expired',
      MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID:
        'MVP benchmark external authorization input is invalid',
      MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE:
        'MVP benchmark external execution is unavailable',
    };
    super(messages[code] ?? messages.MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID);
    this.name = 'MvpBenchmarkExternalAuthorizationError';
    this.code = code;
  }
}

function fail(code) {
  throw new MvpBenchmarkExternalAuthorizationError(code);
}

function exactObject(value, keys, code) {
  try {
    if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) fail(code);
    const prototype = OBJECT_GET_PROTOTYPE_OF(value);
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    const actualKeys = REFLECT_OWN_KEYS(descriptors);
    if ((prototype !== Object.prototype && prototype !== null)
      || actualKeys.length !== keys.length) fail(code);
    const output = OBJECT_CREATE(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!OBJECT_HAS_OWN(descriptors, key)) fail(code);
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) fail(code);
      REFLECT_APPLY(OBJECT_DEFINE_PROPERTY, Object, [output, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      }]);
    }
    return output;
  } catch (error) {
    if (error instanceof MvpBenchmarkExternalAuthorizationError) throw error;
    return fail(code);
  }
}

function uid(value, code) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, UUID_V4, [value])) fail(code);
  return value;
}

function sha256(value, code) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, SHA256, [value])) fail(code);
  return value;
}

function safeInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function serializeMvpBenchmarkExternalAuthorizationJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return REFLECT_APPLY(JSON_STRINGIFY, JSON, [value]);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value)) {
    throw new TypeError('MVP benchmark external authorization JSON is invalid');
  }
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
  const keys = REFLECT_OWN_KEYS(descriptors);
  let output = '{';
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor?.enumerable
      || !OBJECT_HAS_OWN(descriptor, 'value')) {
      throw new TypeError('MVP benchmark external authorization JSON is invalid');
    }
    if (index > 0) output += ',';
    output += `${REFLECT_APPLY(JSON_STRINGIFY, JSON, [key])}:${serializeMvpBenchmarkExternalAuthorizationJson(descriptor.value)}`;
  }
  return `${output}}`;
}

function parseMvpBenchmarkExternalAuthorizationRequest(
  value,
  code = 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID',
) {
  const input = exactObject(value, REQUEST_KEYS, code);
  if (input.schemaVersion !== REQUEST_SCHEMA_VERSION) fail(code);
  return OBJECT_FREEZE({
    schemaVersion: REQUEST_SCHEMA_VERSION,
    uid: uid(input.uid, code),
    sessionUid: uid(input.sessionUid, code),
    dramaUid: uid(input.dramaUid, code),
    sessionPlanSha256: sha256(input.sessionPlanSha256, code),
    connectionUid: uid(input.connectionUid, code),
    connectionEvidenceSha256: sha256(input.connectionEvidenceSha256, code),
    maximumCostCnyFen: safeInteger(input.maximumCostCnyFen, 1, MAXIMUM_COST_CNY_FEN, code),
    validityDurationMs: safeInteger(
      input.validityDurationMs,
      MINIMUM_VALIDITY_DURATION_MS,
      MAXIMUM_VALIDITY_DURATION_MS,
      code,
    ),
  });
}

function parseMvpBenchmarkExternalAuthorizationUid(
  value,
  code = 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID',
) {
  return uid(value, code);
}

function baseAuthorization(value, code) {
  const input = exactObject(value, AUTHORIZATION_KEYS, code);
  if (input.schemaVersion !== AUTHORIZATION_SCHEMA_VERSION
    || input.requiredGpuClass !== RTX_4090_GPU_CLASS
    || input.requiredEnvironmentSha256 !== MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256
    || input.liveEnvironmentCheck !== 'required-before-execution'
    || input.dataScope !== 'single-benchmark-session'
    || input.perItemAttemptLimit !== 1
    || input.instanceDisposition !== 'return-after-terminal-or-expiry') fail(code);
  const authorizedAtEpochMs = safeInteger(input.authorizedAtEpochMs, 0, 253402300799999, code);
  const expiresAtEpochMs = safeInteger(input.expiresAtEpochMs, 0, 253402300799999, code);
  if (expiresAtEpochMs <= authorizedAtEpochMs
    || expiresAtEpochMs - authorizedAtEpochMs < MINIMUM_VALIDITY_DURATION_MS
    || expiresAtEpochMs - authorizedAtEpochMs > MAXIMUM_VALIDITY_DURATION_MS) fail(code);
  return OBJECT_FREEZE({
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    uid: uid(input.uid, code),
    sessionUid: uid(input.sessionUid, code),
    dramaUid: uid(input.dramaUid, code),
    sessionPlanSha256: sha256(input.sessionPlanSha256, code),
    connectionUid: uid(input.connectionUid, code),
    connectionEvidenceSha256: sha256(input.connectionEvidenceSha256, code),
    requiredGpuClass: input.requiredGpuClass,
    requiredEnvironmentSha256: input.requiredEnvironmentSha256,
    liveEnvironmentCheck: input.liveEnvironmentCheck,
    maximumCostCnyFen: safeInteger(input.maximumCostCnyFen, 1, MAXIMUM_COST_CNY_FEN, code),
    dataScope: input.dataScope,
    h3SubmissionLimit: safeInteger(input.h3SubmissionLimit, 4, 6, code),
    ttsSubmissionLimit: safeInteger(input.ttsSubmissionLimit, 1, 32, code),
    perItemAttemptLimit: input.perItemAttemptLimit,
    instanceDisposition: input.instanceDisposition,
    authorizedAtEpochMs,
    expiresAtEpochMs,
    authorizationSha256: sha256(input.authorizationSha256, code),
  });
}

function digest(value) {
  return createHash('sha256')
    .update(serializeMvpBenchmarkExternalAuthorizationJson(value), 'utf8')
    .digest('hex');
}

function createMvpBenchmarkExternalAuthorization(
  value,
  code = 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID',
) {
  const input = exactObject(value, CREATE_KEYS, code);
  const request = parseMvpBenchmarkExternalAuthorizationRequest(input.request, code);
  const authorizedAtEpochMs = safeInteger(input.authorizedAtEpochMs, 0, 253402300799999, code);
  const expiresAtEpochMs = authorizedAtEpochMs + request.validityDurationMs;
  if (!Number.isSafeInteger(expiresAtEpochMs) || expiresAtEpochMs > 253402300799999) fail(code);
  const placeholder = baseAuthorization({
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    uid: request.uid,
    sessionUid: request.sessionUid,
    dramaUid: request.dramaUid,
    sessionPlanSha256: request.sessionPlanSha256,
    connectionUid: request.connectionUid,
    connectionEvidenceSha256: request.connectionEvidenceSha256,
    requiredGpuClass: RTX_4090_GPU_CLASS,
    requiredEnvironmentSha256: MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256,
    liveEnvironmentCheck: 'required-before-execution',
    maximumCostCnyFen: request.maximumCostCnyFen,
    dataScope: 'single-benchmark-session',
    h3SubmissionLimit: input.h3SubmissionLimit,
    ttsSubmissionLimit: input.ttsSubmissionLimit,
    perItemAttemptLimit: 1,
    instanceDisposition: 'return-after-terminal-or-expiry',
    authorizedAtEpochMs,
    expiresAtEpochMs,
    authorizationSha256: '0'.repeat(64),
  }, code);
  return OBJECT_FREEZE({ ...placeholder, authorizationSha256: digest(placeholder) });
}

function parseMvpBenchmarkExternalAuthorization(
  value,
  code = 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_DATA_INVALID',
) {
  const input = exactObject(value, AUTHORIZATION_KEYS, code);
  const authorizedAtEpochMs = safeInteger(input.authorizedAtEpochMs, 0, 253402300799999, code);
  const expiresAtEpochMs = safeInteger(input.expiresAtEpochMs, 0, 253402300799999, code);
  const expected = createMvpBenchmarkExternalAuthorization({
    request: {
      schemaVersion: REQUEST_SCHEMA_VERSION,
      uid: input.uid,
      sessionUid: input.sessionUid,
      dramaUid: input.dramaUid,
      sessionPlanSha256: input.sessionPlanSha256,
      connectionUid: input.connectionUid,
      connectionEvidenceSha256: input.connectionEvidenceSha256,
      maximumCostCnyFen: input.maximumCostCnyFen,
      validityDurationMs: expiresAtEpochMs - authorizedAtEpochMs,
    },
    h3SubmissionLimit: input.h3SubmissionLimit,
    ttsSubmissionLimit: input.ttsSubmissionLimit,
    authorizedAtEpochMs,
  }, code);
  const parsed = baseAuthorization(input, code);
  if (parsed.authorizationSha256 !== expected.authorizationSha256) fail(code);
  return expected;
}

function assertMvpBenchmarkExternalAuthorizationActive(value, nowEpochMs) {
  const authorization = parseMvpBenchmarkExternalAuthorization(value);
  const now = safeInteger(
    nowEpochMs,
    0,
    253402300799999,
    'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID',
  );
  if (now < authorization.authorizedAtEpochMs || now >= authorization.expiresAtEpochMs) {
    fail('MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_EXPIRED');
  }
  return authorization;
}

function isMvpBenchmarkExternalAuthorizationError(error) {
  return error instanceof MvpBenchmarkExternalAuthorizationError;
}

module.exports = OBJECT_FREEZE({
  AUTHORIZATION_SCHEMA_VERSION,
  MAXIMUM_COST_CNY_FEN,
  MAXIMUM_VALIDITY_DURATION_MS,
  MINIMUM_VALIDITY_DURATION_MS,
  MvpBenchmarkExternalAuthorizationError,
  REQUEST_SCHEMA_VERSION,
  assertMvpBenchmarkExternalAuthorizationActive,
  createMvpBenchmarkExternalAuthorization,
  isMvpBenchmarkExternalAuthorizationError,
  parseMvpBenchmarkExternalAuthorization,
  parseMvpBenchmarkExternalAuthorizationRequest,
  parseMvpBenchmarkExternalAuthorizationUid,
  serializeMvpBenchmarkExternalAuthorizationJson,
});
