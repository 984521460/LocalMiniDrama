'use strict';

const { types: { isProxy } } = require('node:util');

const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_CREATE = Object.create;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_PROTOTYPE = Object.prototype;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_TEST = RegExp.prototype.test;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

const REQUEST_SCHEMA_VERSION = 'mvp-benchmark-closeout-status-request.v1';
const SCHEMA_VERSION = 'mvp-benchmark-closeout-status.v1';
const GATE_DEFINITIONS = OBJECT_FREEZE([
  OBJECT_FREEZE({ id: 'production-execution', pending: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_PENDING', failed: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED' }),
  OBJECT_FREEZE({ id: 'final-export', pending: 'MVP_BENCHMARK_FINAL_EXPORT_PENDING', failed: 'MVP_BENCHMARK_FINAL_EXPORT_FAILED' }),
  OBJECT_FREEZE({ id: 'human-av-review', pending: 'MVP_BENCHMARK_HUMAN_AV_REVIEW_PENDING', failed: null }),
  OBJECT_FREEZE({ id: 'accounting-settlement', pending: 'MVP_BENCHMARK_ACCOUNTING_SETTLEMENT_PENDING', failed: null }),
  OBJECT_FREEZE({ id: 'resource-release', pending: 'MVP_BENCHMARK_RESOURCE_RELEASE_PENDING', failed: null }),
]);
const GLOBAL_EVIDENCE_IDS = OBJECT_FREEZE([
  'windows-release-lifecycle',
  'section-19-project-evidence',
  'licenses-and-sources',
  'accepted-residual-risks',
]);
const REQUEST_KEYS = OBJECT_FREEZE([
  'schemaVersion', 'dramaUid', 'sessionUid', 'authorizationUid', 'batchSha256',
]);
const GATE_KEYS = OBJECT_FREEZE(['id', 'status', 'evidenceSha256', 'blockerCode']);
const RECORD_KEYS = OBJECT_FREEZE([
  'schemaVersion', 'dramaUid', 'sessionUid', 'authorizationUid', 'batchSha256',
  'benchmarkEvidenceComplete', 'mvpComplete', 'completedGateCount', 'totalGateCount',
  'gates', 'remainingMvpEvidenceIds',
]);

class MvpBenchmarkCloseoutStatusError extends Error {
  constructor(code) {
    const messages = OBJECT_FREEZE({
      MVP_BENCHMARK_CLOSEOUT_STATUS_INPUT_INVALID:
        'MVP benchmark closeout status input is invalid',
      MVP_BENCHMARK_CLOSEOUT_STATUS_UNAVAILABLE:
        'MVP benchmark closeout status is unavailable',
    });
    super(messages[code] ?? messages.MVP_BENCHMARK_CLOSEOUT_STATUS_INPUT_INVALID);
    this.name = 'MvpBenchmarkCloseoutStatusError';
    this.code = code;
    OBJECT_FREEZE(this);
  }
}

function fail(code) {
  throw new MvpBenchmarkCloseoutStatusError(code);
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) fail(code);
  let descriptors;
  let prototype;
  try {
    descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
    prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
  } catch {
    return fail(code);
  }
  if ((prototype !== OBJECT_PROTOTYPE && prototype !== null)
    || REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]).length !== keys.length) fail(code);
  const output = REFLECT_APPLY(OBJECT_CREATE, Object, [null]);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptors, key])) fail(code);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable
      || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) fail(code);
    output[key] = descriptor.value;
  }
  return output;
}

function denseArray(value, maximumLength, code) {
  if (!ARRAY_IS_ARRAY(value) || isProxy(value)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]) !== ARRAY_PROTOTYPE) fail(code);
  const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
  if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptors, 'length'])) fail(code);
  const lengthDescriptor = descriptors.length;
  if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [lengthDescriptor, 'value'])) fail(code);
  const length = lengthDescriptor.value;
  if (!NUMBER_IS_SAFE_INTEGER(length) || length < 1 || length > maximumLength
    || REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]).length !== length + 1) fail(code);
  const output = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptors, key])) fail(code);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable
      || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) fail(code);
    output[index] = descriptor.value;
  }
  return output;
}

function uid(value, code) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, UUID_V4, [value])) fail(code);
  return value;
}

function sha256(value, code) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, SHA256, [value])) fail(code);
  return value;
}

function parseMvpBenchmarkCloseoutStatusRequest(value) {
  const code = 'MVP_BENCHMARK_CLOSEOUT_STATUS_INPUT_INVALID';
  const input = exactObject(value, REQUEST_KEYS, code);
  if (input.schemaVersion !== REQUEST_SCHEMA_VERSION) fail(code);
  return OBJECT_FREEZE({
    schemaVersion: REQUEST_SCHEMA_VERSION,
    dramaUid: uid(input.dramaUid, code),
    sessionUid: uid(input.sessionUid, code),
    authorizationUid: uid(input.authorizationUid, code),
    batchSha256: sha256(input.batchSha256, code),
  });
}

function createMvpBenchmarkCloseoutStatus(value) {
  const code = 'MVP_BENCHMARK_CLOSEOUT_STATUS_UNAVAILABLE';
  const input = exactObject(value, RECORD_KEYS, code);
  if (input.schemaVersion !== SCHEMA_VERSION || input.mvpComplete !== false
    || input.totalGateCount !== GATE_DEFINITIONS.length) fail(code);
  const gates = denseArray(input.gates, GATE_DEFINITIONS.length, code);
  if (gates.length !== GATE_DEFINITIONS.length) fail(code);
  const normalizedGates = new Array(gates.length);
  let completedGateCount = 0;
  for (let index = 0; index < gates.length; index += 1) {
    const gate = exactObject(gates[index], GATE_KEYS, code);
    const definition = GATE_DEFINITIONS[index];
    if (gate.id !== definition.id
      || (gate.status !== 'complete' && gate.status !== 'pending' && gate.status !== 'failed')) fail(code);
    if (gate.status === 'complete') {
      sha256(gate.evidenceSha256, code);
      if (gate.blockerCode !== null) fail(code);
      completedGateCount += 1;
    } else {
      if (gate.evidenceSha256 !== null) fail(code);
      const expected = gate.status === 'pending' ? definition.pending : definition.failed;
      if (expected === null || gate.blockerCode !== expected) fail(code);
    }
    normalizedGates[index] = OBJECT_FREEZE({
      id: gate.id,
      status: gate.status,
      evidenceSha256: gate.evidenceSha256,
      blockerCode: gate.blockerCode,
    });
  }
  if (input.completedGateCount !== completedGateCount
    || input.benchmarkEvidenceComplete !== (completedGateCount === gates.length)) fail(code);
  const remaining = denseArray(input.remainingMvpEvidenceIds, 9, code);
  const expectedRemaining = [];
  for (let index = 0; index < normalizedGates.length; index += 1) {
    if (normalizedGates[index].status !== 'complete') expectedRemaining.push(normalizedGates[index].id);
  }
  for (let index = 0; index < GLOBAL_EVIDENCE_IDS.length; index += 1) {
    expectedRemaining.push(GLOBAL_EVIDENCE_IDS[index]);
  }
  if (remaining.length !== expectedRemaining.length) fail(code);
  for (let index = 0; index < remaining.length; index += 1) {
    if (remaining[index] !== expectedRemaining[index]) fail(code);
  }
  return OBJECT_FREEZE({
    schemaVersion: SCHEMA_VERSION,
    dramaUid: uid(input.dramaUid, code),
    sessionUid: uid(input.sessionUid, code),
    authorizationUid: uid(input.authorizationUid, code),
    batchSha256: sha256(input.batchSha256, code),
    benchmarkEvidenceComplete: input.benchmarkEvidenceComplete,
    mvpComplete: false,
    completedGateCount,
    totalGateCount: GATE_DEFINITIONS.length,
    gates: OBJECT_FREEZE(normalizedGates),
    remainingMvpEvidenceIds: OBJECT_FREEZE(remaining),
  });
}

function isMvpBenchmarkCloseoutStatusError(error) {
  return error instanceof MvpBenchmarkCloseoutStatusError;
}

module.exports = OBJECT_FREEZE({
  GATE_DEFINITIONS,
  GLOBAL_EVIDENCE_IDS,
  MvpBenchmarkCloseoutStatusError,
  REQUEST_SCHEMA_VERSION,
  SCHEMA_VERSION,
  createMvpBenchmarkCloseoutStatus,
  isMvpBenchmarkCloseoutStatusError,
  parseMvpBenchmarkCloseoutStatusRequest,
});
