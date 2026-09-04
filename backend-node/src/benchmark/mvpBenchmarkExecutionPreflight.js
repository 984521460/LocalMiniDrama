'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const {
  APPROVED_LIVE_ENVIRONMENT,
  MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256,
} = require('./mvpBenchmarkApprovedEnvironment');

const OBSERVATION_SCHEMA_VERSION = 'mvp-benchmark-live-environment-observation.v1';
const ATTESTATION_SCHEMA_VERSION = 'mvp-benchmark-live-environment-attestation.v1';
const COST_ESTIMATE_SCHEMA_VERSION = 'mvp-benchmark-cost-estimate.v1';
const RESERVATION_SCHEMA_VERSION = 'mvp-benchmark-execution-reservation.v1';
const BATCH_SCHEMA_VERSION = 'mvp-benchmark-execution-preflight-batch.v1';
const MAX_LIVE_ENVIRONMENT_AGE_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const MAXIMUM_COST_CNY_FEN = 1_000_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ITEM_KINDS = Object.freeze(['h3', 'tts']);
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
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_DELETE = WeakSet.prototype.delete;
const WEAK_SET_HAS = WeakSet.prototype.has;

class MvpBenchmarkExecutionPreflightError extends Error {
  constructor(code) {
    const messages = {
      MVP_BENCHMARK_EXECUTION_PREFLIGHT_DATA_INVALID:
        'MVP benchmark execution preflight data is invalid',
      MVP_BENCHMARK_EXECUTION_PREFLIGHT_EXPIRED:
        'MVP benchmark execution preflight has expired',
      MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID:
        'MVP benchmark execution preflight input is invalid',
      MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE:
        'MVP benchmark execution preflight is unavailable',
    };
    super(messages[code] ?? messages.MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID);
    this.name = 'MvpBenchmarkExecutionPreflightError';
    this.code = code;
  }
}

function fail(code) {
  throw new MvpBenchmarkExecutionPreflightError(code);
}

function deepFreeze(value) {
  if (ARRAY_IS_ARRAY(value)) {
    for (let index = 0; index < value.length; index += 1) deepFreeze(value[index]);
  } else if (value && typeof value === 'object') {
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    const keys = REFLECT_OWN_KEYS(descriptors);
    for (let index = 0; index < keys.length; index += 1) {
      const descriptor = descriptors[keys[index]];
      if (descriptor && OBJECT_HAS_OWN(descriptor, 'value')) deepFreeze(descriptor.value);
    }
  }
  return OBJECT_FREEZE(value);
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
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) fail(code);
      REFLECT_APPLY(OBJECT_DEFINE_PROPERTY, Object, [output, key, {
        configurable: true, enumerable: true, value: descriptor.value, writable: true,
      }]);
    }
    return output;
  } catch (error) {
    if (error instanceof MvpBenchmarkExecutionPreflightError) throw error;
    return fail(code);
  }
}

function denseArray(value, length, code) {
  try {
    if (!ARRAY_IS_ARRAY(value) || isProxy(value)
      || OBJECT_GET_PROTOTYPE_OF(value) !== Array.prototype) fail(code);
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    if (descriptors.length?.value !== length
      || REFLECT_OWN_KEYS(descriptors).length !== length + 1) fail(code);
    const output = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) fail(code);
      REFLECT_APPLY(OBJECT_DEFINE_PROPERTY, Object, [output, String(index), {
        configurable: true, enumerable: true, value: descriptor.value, writable: true,
      }]);
    }
    return output;
  } catch (error) {
    if (error instanceof MvpBenchmarkExecutionPreflightError) throw error;
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

function exactString(value, expected, code) {
  if (value !== expected) fail(code);
  return value;
}

function exactInteger(value, expected, code) {
  if (value !== expected) fail(code);
  return value;
}

function invalidJson() {
  throw new TypeError('MVP benchmark execution preflight JSON is invalid');
}

function serializeJsonValue(value, ancestors) {
  if (value === null) return 'null';
  if (typeof value === 'string') return REFLECT_APPLY(JSON_STRINGIFY, JSON, [value]);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (!value || typeof value !== 'object' || isProxy(value)) return invalidJson();
  if (REFLECT_APPLY(WEAK_SET_HAS, ancestors, [value])) return invalidJson();
  REFLECT_APPLY(WEAK_SET_ADD, ancestors, [value]);
  let output;
  if (ARRAY_IS_ARRAY(value)) {
    if (OBJECT_GET_PROTOTYPE_OF(value) !== Array.prototype) return invalidJson();
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0
      || REFLECT_OWN_KEYS(descriptors).length !== length + 1) return invalidJson();
    output = '[';
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) return invalidJson();
      if (index > 0) output += ',';
      output += serializeJsonValue(descriptor.value, ancestors);
    }
    output += ']';
  } else {
    const prototype = OBJECT_GET_PROTOTYPE_OF(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidJson();
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    const keys = REFLECT_OWN_KEYS(descriptors);
    output = '{';
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !descriptor?.enumerable
        || !OBJECT_HAS_OWN(descriptor, 'value')) return invalidJson();
      if (index > 0) output += ',';
      output += `${REFLECT_APPLY(JSON_STRINGIFY, JSON, [key])}:${serializeJsonValue(descriptor.value, ancestors)}`;
    }
    output += '}';
  }
  REFLECT_APPLY(WEAK_SET_DELETE, ancestors, [value]);
  return output;
}

function serializeMvpBenchmarkExecutionPreflightJson(value) {
  try {
    return serializeJsonValue(value, new WeakSet());
  } catch (error) {
    if (error instanceof TypeError
      && error.message === 'MVP benchmark execution preflight JSON is invalid') throw error;
    return invalidJson();
  }
}

function digest(value) {
  return createHash('sha256')
    .update(serializeMvpBenchmarkExecutionPreflightJson(value), 'utf8')
    .digest('hex');
}

function approvedGpu(value, code) {
  const input = exactObject(value, ['gpuClass', 'name', 'vramMiB', 'driverVersion'], code);
  return OBJECT_FREEZE({
    gpuClass: exactString(input.gpuClass, APPROVED_LIVE_ENVIRONMENT.gpu.gpuClass, code),
    name: exactString(input.name, APPROVED_LIVE_ENVIRONMENT.gpu.name, code),
    vramMiB: exactInteger(input.vramMiB, APPROVED_LIVE_ENVIRONMENT.gpu.vramMiB, code),
    driverVersion: exactString(
      input.driverVersion, APPROVED_LIVE_ENVIRONMENT.gpu.driverVersion, code,
    ),
  });
}

function approvedComfy(value, code) {
  const input = exactObject(value, ['version', 'revision', 'listenScope'], code);
  return OBJECT_FREEZE({
    version: exactString(input.version, APPROVED_LIVE_ENVIRONMENT.comfyUI.version, code),
    revision: exactString(input.revision, APPROVED_LIVE_ENVIRONMENT.comfyUI.revision, code),
    listenScope: exactString(
      input.listenScope, APPROVED_LIVE_ENVIRONMENT.comfyUI.listenScope, code,
    ),
  });
}

function approvedRuntime(value, code) {
  const input = exactObject(value, ['pythonVersion', 'pytorchVersion', 'ffmpegVersion'], code);
  return OBJECT_FREEZE({
    pythonVersion: exactString(
      input.pythonVersion, APPROVED_LIVE_ENVIRONMENT.runtime.pythonVersion, code,
    ),
    pytorchVersion: exactString(
      input.pytorchVersion, APPROVED_LIVE_ENVIRONMENT.runtime.pytorchVersion, code,
    ),
    ffmpegVersion: exactString(
      input.ffmpegVersion, APPROVED_LIVE_ENVIRONMENT.runtime.ffmpegVersion, code,
    ),
  });
}

function approvedModels(value, code) {
  const input = denseArray(value, APPROVED_LIVE_ENVIRONMENT.models.length, code);
  const output = [];
  for (let index = 0; index < input.length; index += 1) {
    const expected = APPROVED_LIVE_ENVIRONMENT.models[index];
    const model = exactObject(input[index], ['role', 'fileName', 'sha256', 'bytes'], code);
    output[index] = OBJECT_FREEZE({
      role: exactString(model.role, expected.role, code),
      fileName: exactString(model.fileName, expected.fileName, code),
      sha256: exactString(model.sha256, expected.sha256, code),
      bytes: exactInteger(model.bytes, expected.bytes, code),
    });
  }
  return OBJECT_FREEZE(output);
}

const OBSERVATION_INPUT_KEYS = Object.freeze([
  'schemaVersion', 'connectionUid', 'connectionEvidenceSha256', 'observedAtEpochMs',
  'approvedEnvironmentSha256', 'gpu', 'comfyUI', 'runtime', 'models',
]);
const OBSERVATION_KEYS = Object.freeze([...OBSERVATION_INPUT_KEYS, 'observationSha256']);

function baseObservation(value, keys, code) {
  const input = exactObject(value, keys, code);
  if (input.schemaVersion !== OBSERVATION_SCHEMA_VERSION
    || input.approvedEnvironmentSha256
      !== MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256) fail(code);
  return OBJECT_FREEZE({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    connectionUid: uid(input.connectionUid, code),
    connectionEvidenceSha256: sha256(input.connectionEvidenceSha256, code),
    observedAtEpochMs: safeInteger(input.observedAtEpochMs, 0, 253402300799999, code),
    approvedEnvironmentSha256: input.approvedEnvironmentSha256,
    gpu: approvedGpu(input.gpu, code),
    comfyUI: approvedComfy(input.comfyUI, code),
    runtime: approvedRuntime(input.runtime, code),
    models: approvedModels(input.models, code),
  });
}

function createMvpBenchmarkLiveEnvironmentObservation(
  value,
  code = 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID',
) {
  const base = baseObservation(value, OBSERVATION_INPUT_KEYS, code);
  return OBJECT_FREEZE({ ...base, observationSha256: digest(base) });
}

function parseMvpBenchmarkLiveEnvironmentObservation(
  value,
  code = 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_DATA_INVALID',
) {
  const input = exactObject(value, OBSERVATION_KEYS, code);
  const expected = createMvpBenchmarkLiveEnvironmentObservation({
    schemaVersion: input.schemaVersion,
    connectionUid: input.connectionUid,
    connectionEvidenceSha256: input.connectionEvidenceSha256,
    observedAtEpochMs: input.observedAtEpochMs,
    approvedEnvironmentSha256: input.approvedEnvironmentSha256,
    gpu: input.gpu,
    comfyUI: input.comfyUI,
    runtime: input.runtime,
    models: input.models,
  }, code);
  if (sha256(input.observationSha256, code) !== expected.observationSha256) fail(code);
  return expected;
}

const COST_INPUT_KEYS = Object.freeze([
  'schemaVersion', 'itemKind', 'itemUid', 'requestSha256',
  'estimatedCostCnyFen', 'policyUid',
]);
const COST_KEYS = Object.freeze([...COST_INPUT_KEYS, 'estimateSha256']);

function itemKind(value, code) {
  if (value !== ITEM_KINDS[0] && value !== ITEM_KINDS[1]) fail(code);
  return value;
}

function createMvpBenchmarkCostEstimate(
  value,
  code = 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID',
) {
  const input = exactObject(value, COST_INPUT_KEYS, code);
  if (input.schemaVersion !== COST_ESTIMATE_SCHEMA_VERSION) fail(code);
  const base = OBJECT_FREEZE({
    schemaVersion: COST_ESTIMATE_SCHEMA_VERSION,
    itemKind: itemKind(input.itemKind, code),
    itemUid: uid(input.itemUid, code),
    requestSha256: sha256(input.requestSha256, code),
    estimatedCostCnyFen: safeInteger(input.estimatedCostCnyFen, 0, MAXIMUM_COST_CNY_FEN, code),
    policyUid: uid(input.policyUid, code),
  });
  return OBJECT_FREEZE({ ...base, estimateSha256: digest(base) });
}

function parseMvpBenchmarkCostEstimate(
  value,
  code = 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_DATA_INVALID',
) {
  const input = exactObject(value, COST_KEYS, code);
  const expected = createMvpBenchmarkCostEstimate({
    schemaVersion: input.schemaVersion,
    itemKind: input.itemKind,
    itemUid: input.itemUid,
    requestSha256: input.requestSha256,
    estimatedCostCnyFen: input.estimatedCostCnyFen,
    policyUid: input.policyUid,
  }, code);
  if (sha256(input.estimateSha256, code) !== expected.estimateSha256) fail(code);
  return expected;
}

const ATTESTATION_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'authorizationUid', 'sessionUid', 'dramaUid',
  'connectionUid', 'connectionEvidenceSha256', 'approvedEnvironmentSha256',
  'observation', 'attestedAtEpochMs', 'expiresAtEpochMs', 'attestationSha256',
]);

function createMvpBenchmarkLiveEnvironmentAttestation(
  value,
  code = 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID',
) {
  const input = exactObject(value, [
    'uid', 'authorization', 'observation', 'attestedAtEpochMs',
  ], code);
  const authorization = input.authorization;
  if (!authorization || typeof authorization !== 'object' || isProxy(authorization)) fail(code);
  const observation = parseMvpBenchmarkLiveEnvironmentObservation(input.observation, code);
  const attestedAtEpochMs = safeInteger(input.attestedAtEpochMs, 0, 253402300799999, code);
  const authorizationUid = uid(authorization.uid, code);
  const sessionUid = uid(authorization.sessionUid, code);
  const dramaUid = uid(authorization.dramaUid, code);
  const connectionUid = uid(authorization.connectionUid, code);
  const connectionEvidenceSha256 = sha256(authorization.connectionEvidenceSha256, code);
  const authorizedEnvironmentSha256 = sha256(authorization.requiredEnvironmentSha256, code);
  const authorizationExpiresAt = safeInteger(
    authorization.expiresAtEpochMs, 0, 253402300799999, code,
  );
  if (observation.connectionUid !== connectionUid
    || observation.connectionEvidenceSha256 !== connectionEvidenceSha256
    || observation.approvedEnvironmentSha256 !== authorizedEnvironmentSha256
    || observation.observedAtEpochMs > attestedAtEpochMs + MAX_CLOCK_SKEW_MS
    || attestedAtEpochMs - observation.observedAtEpochMs > MAX_LIVE_ENVIRONMENT_AGE_MS
    || attestedAtEpochMs >= authorizationExpiresAt) fail(code);
  const expiresAtEpochMs = Math.min(
    observation.observedAtEpochMs + MAX_LIVE_ENVIRONMENT_AGE_MS,
    authorizationExpiresAt,
  );
  if (expiresAtEpochMs <= attestedAtEpochMs) fail(code);
  const base = OBJECT_FREEZE({
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    uid: uid(input.uid, code),
    authorizationUid,
    sessionUid,
    dramaUid,
    connectionUid,
    connectionEvidenceSha256,
    approvedEnvironmentSha256: authorizedEnvironmentSha256,
    observation,
    attestedAtEpochMs,
    expiresAtEpochMs,
  });
  return OBJECT_FREEZE({ ...base, attestationSha256: digest(base) });
}

function parseMvpBenchmarkLiveEnvironmentAttestation(
  value,
  code = 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_DATA_INVALID',
) {
  const input = exactObject(value, ATTESTATION_KEYS, code);
  if (input.schemaVersion !== ATTESTATION_SCHEMA_VERSION) fail(code);
  const parsed = OBJECT_FREEZE({
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    uid: uid(input.uid, code),
    authorizationUid: uid(input.authorizationUid, code),
    sessionUid: uid(input.sessionUid, code),
    dramaUid: uid(input.dramaUid, code),
    connectionUid: uid(input.connectionUid, code),
    connectionEvidenceSha256: sha256(input.connectionEvidenceSha256, code),
    approvedEnvironmentSha256: sha256(input.approvedEnvironmentSha256, code),
    observation: parseMvpBenchmarkLiveEnvironmentObservation(input.observation, code),
    attestedAtEpochMs: safeInteger(input.attestedAtEpochMs, 0, 253402300799999, code),
    expiresAtEpochMs: safeInteger(input.expiresAtEpochMs, 0, 253402300799999, code),
  });
  if (parsed.observation.connectionUid !== parsed.connectionUid
    || parsed.observation.connectionEvidenceSha256 !== parsed.connectionEvidenceSha256
    || parsed.observation.approvedEnvironmentSha256 !== parsed.approvedEnvironmentSha256
    || parsed.expiresAtEpochMs <= parsed.attestedAtEpochMs
    || parsed.expiresAtEpochMs > parsed.observation.observedAtEpochMs + MAX_LIVE_ENVIRONMENT_AGE_MS
    || sha256(input.attestationSha256, code) !== digest(parsed)) fail(code);
  return OBJECT_FREEZE({ ...parsed, attestationSha256: input.attestationSha256 });
}

const RESERVATION_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'authorizationUid', 'attestationUid', 'sessionUid',
  'dramaUid', 'itemKind', 'itemUid', 'requestSha256', 'estimate',
  'estimatedCostCnyFen', 'attemptNumber', 'reservedAtEpochMs', 'reservationSha256',
]);

function createMvpBenchmarkExecutionReservation(
  value,
  code = 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID',
) {
  const input = exactObject(value, [
    'uid', 'authorization', 'attestation', 'session', 'itemKind', 'itemUid',
    'requestSha256', 'estimate', 'reservedAtEpochMs',
  ], code);
  const authorization = input.authorization;
  const session = input.session;
  if (!authorization || typeof authorization !== 'object' || isProxy(authorization)
    || !session || typeof session !== 'object' || isProxy(session)) fail(code);
  const attestation = parseMvpBenchmarkLiveEnvironmentAttestation(input.attestation, code);
  const estimate = parseMvpBenchmarkCostEstimate(input.estimate, code);
  const kind = itemKind(input.itemKind, code);
  const selectedUid = uid(input.itemUid, code);
  const requestSha256 = sha256(input.requestSha256, code);
  const reservedAtEpochMs = safeInteger(input.reservedAtEpochMs, 0, 253402300799999, code);
  const authorizationUid = uid(authorization.uid, code);
  const sessionUid = uid(authorization.sessionUid, code);
  const dramaUid = uid(authorization.dramaUid, code);
  const authorizationExpiresAt = safeInteger(
    authorization.expiresAtEpochMs, 0, 253402300799999, code,
  );
  if (attestation.authorizationUid !== authorizationUid
    || attestation.sessionUid !== sessionUid || attestation.dramaUid !== dramaUid
    || session.uid !== sessionUid || session.dramaUid !== dramaUid
    || reservedAtEpochMs < authorization.authorizedAtEpochMs
    || reservedAtEpochMs >= authorizationExpiresAt
    || reservedAtEpochMs < attestation.attestedAtEpochMs
    || reservedAtEpochMs >= attestation.expiresAtEpochMs
    || estimate.itemKind !== kind || estimate.itemUid !== selectedUid
    || estimate.requestSha256 !== requestSha256) fail(code);
  const items = kind === 'h3' ? session.h3Tasks : session.audioIntents;
  let membershipCount = 0;
  let expectedRequestSha256 = null;
  for (let index = 0; index < items.length; index += 1) {
    const candidate = kind === 'h3' ? items[index].taskUid : items[index].intentUid;
    if (candidate === selectedUid) {
      membershipCount += 1;
      expectedRequestSha256 = kind === 'h3'
        ? items[index].planEvidenceSha256 : items[index].planSha256;
    }
  }
  if (membershipCount !== 1 || requestSha256 !== expectedRequestSha256) fail(code);
  const base = OBJECT_FREEZE({
    schemaVersion: RESERVATION_SCHEMA_VERSION,
    uid: uid(input.uid, code),
    authorizationUid,
    attestationUid: attestation.uid,
    sessionUid,
    dramaUid,
    itemKind: kind,
    itemUid: selectedUid,
    requestSha256,
    estimate,
    estimatedCostCnyFen: estimate.estimatedCostCnyFen,
    attemptNumber: 1,
    reservedAtEpochMs,
  });
  return OBJECT_FREEZE({ ...base, reservationSha256: digest(base) });
}

function parseMvpBenchmarkExecutionReservation(
  value,
  code = 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_DATA_INVALID',
) {
  const input = exactObject(value, RESERVATION_KEYS, code);
  if (input.schemaVersion !== RESERVATION_SCHEMA_VERSION) fail(code);
  const estimate = parseMvpBenchmarkCostEstimate(input.estimate, code);
  const base = OBJECT_FREEZE({
    schemaVersion: RESERVATION_SCHEMA_VERSION,
    uid: uid(input.uid, code),
    authorizationUid: uid(input.authorizationUid, code),
    attestationUid: uid(input.attestationUid, code),
    sessionUid: uid(input.sessionUid, code),
    dramaUid: uid(input.dramaUid, code),
    itemKind: itemKind(input.itemKind, code),
    itemUid: uid(input.itemUid, code),
    requestSha256: sha256(input.requestSha256, code),
    estimate,
    estimatedCostCnyFen: safeInteger(
      input.estimatedCostCnyFen, 0, MAXIMUM_COST_CNY_FEN, code,
    ),
    attemptNumber: exactInteger(input.attemptNumber, 1, code),
    reservedAtEpochMs: safeInteger(input.reservedAtEpochMs, 0, 253402300799999, code),
  });
  if (base.estimatedCostCnyFen !== estimate.estimatedCostCnyFen
    || base.itemKind !== estimate.itemKind || base.itemUid !== estimate.itemUid
    || base.requestSha256 !== estimate.requestSha256
    || sha256(input.reservationSha256, code) !== digest(base)) fail(code);
  return OBJECT_FREEZE({ ...base, reservationSha256: input.reservationSha256 });
}

function createMvpBenchmarkExecutionPreflightBatch(
  value,
  code = 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID',
) {
  const input = exactObject(value, [
    'authorization', 'session', 'attestation', 'reservations',
  ], code);
  const authorization = input.authorization;
  const session = input.session;
  if (!authorization || typeof authorization !== 'object' || isProxy(authorization)
    || !session || typeof session !== 'object' || isProxy(session)) fail(code);
  const attestation = parseMvpBenchmarkLiveEnvironmentAttestation(input.attestation, code);
  const authorizationUid = uid(authorization.uid, code);
  const sessionUid = uid(authorization.sessionUid, code);
  const dramaUid = uid(authorization.dramaUid, code);
  if (session.uid !== sessionUid || session.dramaUid !== dramaUid
    || attestation.authorizationUid !== authorizationUid
    || attestation.sessionUid !== sessionUid || attestation.dramaUid !== dramaUid) fail(code);
  const h3Length = safeInteger(session.h3Tasks?.length, 1, 64, code);
  const ttsLength = safeInteger(session.audioIntents?.length, 1, 64, code);
  const reservations = denseArray(input.reservations, h3Length + ttsLength, code);
  const parsedReservations = [];
  let estimatedCostCnyFen = 0;
  let preparedAtEpochMs = null;
  for (let index = 0; index < reservations.length; index += 1) {
    const reservation = parseMvpBenchmarkExecutionReservation(reservations[index], code);
    const h3 = index < h3Length;
    const item = h3 ? session.h3Tasks[index] : session.audioIntents[index - h3Length];
    const expectedKind = h3 ? 'h3' : 'tts';
    const expectedUid = h3 ? item.taskUid : item.intentUid;
    const expectedSha256 = h3 ? item.planEvidenceSha256 : item.planSha256;
    if (reservation.authorizationUid !== authorizationUid
      || reservation.attestationUid !== attestation.uid
      || reservation.sessionUid !== sessionUid || reservation.dramaUid !== dramaUid
      || reservation.itemKind !== expectedKind || reservation.itemUid !== expectedUid
      || reservation.requestSha256 !== expectedSha256
      || (preparedAtEpochMs !== null && reservation.reservedAtEpochMs !== preparedAtEpochMs)) {
      fail(code);
    }
    if (preparedAtEpochMs === null) preparedAtEpochMs = reservation.reservedAtEpochMs;
    estimatedCostCnyFen += reservation.estimatedCostCnyFen;
    if (!Number.isSafeInteger(estimatedCostCnyFen)
      || estimatedCostCnyFen > MAXIMUM_COST_CNY_FEN) fail(code);
    parsedReservations[index] = reservation;
  }
  const maximumCostCnyFen = safeInteger(
    authorization.maximumCostCnyFen, 0, MAXIMUM_COST_CNY_FEN, code,
  );
  if (estimatedCostCnyFen > maximumCostCnyFen || preparedAtEpochMs === null) fail(code);
  const base = OBJECT_FREEZE({
    schemaVersion: BATCH_SCHEMA_VERSION,
    authorizationUid,
    sessionUid,
    dramaUid,
    attestationUid: attestation.uid,
    reservations: OBJECT_FREEZE(parsedReservations),
    estimatedCostCnyFen,
    preparedAtEpochMs,
  });
  return OBJECT_FREEZE({ ...base, batchSha256: digest(base) });
}

function assertMvpBenchmarkLiveEnvironmentAttestationFresh(value, nowEpochMs) {
  const attestation = parseMvpBenchmarkLiveEnvironmentAttestation(
    value,
    'MVP_BENCHMARK_EXECUTION_PREFLIGHT_DATA_INVALID',
  );
  const now = safeInteger(
    nowEpochMs, 0, 253402300799999,
    'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID',
  );
  if (now < attestation.attestedAtEpochMs || now >= attestation.expiresAtEpochMs) {
    fail('MVP_BENCHMARK_EXECUTION_PREFLIGHT_EXPIRED');
  }
  return attestation;
}

function isMvpBenchmarkExecutionPreflightError(error) {
  return error instanceof MvpBenchmarkExecutionPreflightError;
}

module.exports = OBJECT_FREEZE({
  APPROVED_LIVE_ENVIRONMENT,
  ATTESTATION_SCHEMA_VERSION,
  BATCH_SCHEMA_VERSION,
  COST_ESTIMATE_SCHEMA_VERSION,
  MAXIMUM_COST_CNY_FEN,
  MAX_LIVE_ENVIRONMENT_AGE_MS,
  MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256,
  MvpBenchmarkExecutionPreflightError,
  OBSERVATION_SCHEMA_VERSION,
  RESERVATION_SCHEMA_VERSION,
  assertMvpBenchmarkLiveEnvironmentAttestationFresh,
  createMvpBenchmarkCostEstimate,
  createMvpBenchmarkExecutionReservation,
  createMvpBenchmarkExecutionPreflightBatch,
  createMvpBenchmarkLiveEnvironmentAttestation,
  createMvpBenchmarkLiveEnvironmentObservation,
  isMvpBenchmarkExecutionPreflightError,
  parseMvpBenchmarkCostEstimate,
  parseMvpBenchmarkExecutionReservation,
  parseMvpBenchmarkLiveEnvironmentAttestation,
  parseMvpBenchmarkLiveEnvironmentObservation,
  serializeMvpBenchmarkExecutionPreflightJson,
});
