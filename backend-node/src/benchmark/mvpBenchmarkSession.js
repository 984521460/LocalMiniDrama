'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const REQUEST_SCHEMA_VERSION = 'mvp-benchmark-session-request.v1';
const PLAN_SCHEMA_VERSION = 'mvp-benchmark-session-plan.v1';
const MAX_H3_TASKS = 6;
const MIN_H3_TASKS = 4;
const MAX_AUDIO_INTENTS = 32;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
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
const SET_ADD = Set.prototype.add;
const SET_CONSTRUCTOR = Set;
const SET_HAS = Set.prototype.has;
const REQUEST_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'dramaUid', 'workflowRunUid', 'h3TaskUids',
  'audioIntentUids', 'createdAtEpochMs',
]);
const PLAN_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'dramaUid', 'workflowRunUid', 'workflowUid',
  'graphHash', 'graphRevision', 'h3Tasks', 'audioIntents', 'planSha256',
  'createdAtEpochMs',
]);
const PLAN_INPUT_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'dramaUid', 'workflowRunUid', 'workflowUid',
  'graphHash', 'graphRevision', 'h3Tasks', 'audioIntents', 'createdAtEpochMs',
]);
const H3_KEYS = Object.freeze([
  'taskUid', 'intentUid', 'nodeRunUid', 'nodeUid', 'assetUid', 'manifestUid',
  'generationSpecSha256', 'planEvidenceSha256',
]);
const AUDIO_KEYS = Object.freeze(['intentUid', 'nodeRunUid', 'nodeUid', 'planSha256']);

class MvpBenchmarkSessionError extends Error {
  constructor(code) {
    super(code === 'MVP_BENCHMARK_SESSION_DATA_INVALID'
      ? 'MVP benchmark session data is invalid'
      : 'MVP benchmark session input is invalid');
    this.name = 'MvpBenchmarkSessionError';
    this.code = code;
  }
}

function fail(code) {
  throw new MvpBenchmarkSessionError(code);
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
      if (!descriptor || !descriptor.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) fail(code);
      OBJECT_DEFINE_PROPERTY(output, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
    return output;
  } catch (error) {
    if (error instanceof MvpBenchmarkSessionError) throw error;
    return fail(code);
  }
}

function denseArray(value, minimum, maximum, code) {
  try {
    if (!ARRAY_IS_ARRAY(value) || isProxy(value)
      || OBJECT_GET_PROTOTYPE_OF(value) !== Array.prototype) fail(code);
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < minimum || length > maximum
      || REFLECT_OWN_KEYS(descriptors).length !== length + 1) fail(code);
    const output = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) fail(code);
      OBJECT_DEFINE_PROPERTY(output, String(index), {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
    return output;
  } catch (error) {
    if (error instanceof MvpBenchmarkSessionError) throw error;
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

function epoch(value, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) fail(code);
  return value;
}

function sortedUniqueUids(value, minimum, maximum, code) {
  const input = denseArray(value, minimum, maximum, code);
  const output = [];
  for (let index = 0; index < input.length; index += 1) {
    const current = uid(input[index], code);
    let insertAt = output.length;
    while (insertAt > 0 && output[insertAt - 1] > current) insertAt -= 1;
    if (output[insertAt] === current || output[insertAt - 1] === current) fail(code);
    for (let move = output.length; move > insertAt; move -= 1) output[move] = output[move - 1];
    output[insertAt] = current;
  }
  return OBJECT_FREEZE(output);
}

function parseMvpBenchmarkSessionRequest(value, code = 'MVP_BENCHMARK_SESSION_INPUT_INVALID') {
  const input = exactObject(value, REQUEST_KEYS, code);
  if (input.schemaVersion !== REQUEST_SCHEMA_VERSION) fail(code);
  return OBJECT_FREEZE({
    schemaVersion: REQUEST_SCHEMA_VERSION,
    uid: uid(input.uid, code),
    dramaUid: uid(input.dramaUid, code),
    workflowRunUid: uid(input.workflowRunUid, code),
    h3TaskUids: sortedUniqueUids(input.h3TaskUids, MIN_H3_TASKS, MAX_H3_TASKS, code),
    audioIntentUids: sortedUniqueUids(input.audioIntentUids, 1, MAX_AUDIO_INTENTS, code),
    createdAtEpochMs: epoch(input.createdAtEpochMs, code),
  });
}

function parseH3Item(value, code) {
  const input = exactObject(value, H3_KEYS, code);
  return OBJECT_FREEZE({
    taskUid: uid(input.taskUid, code),
    intentUid: uid(input.intentUid, code),
    nodeRunUid: uid(input.nodeRunUid, code),
    nodeUid: uid(input.nodeUid, code),
    assetUid: uid(input.assetUid, code),
    manifestUid: uid(input.manifestUid, code),
    generationSpecSha256: sha256(input.generationSpecSha256, code),
    planEvidenceSha256: sha256(input.planEvidenceSha256, code),
  });
}

function parseAudioItem(value, code) {
  const input = exactObject(value, AUDIO_KEYS, code);
  return OBJECT_FREEZE({
    intentUid: uid(input.intentUid, code),
    nodeRunUid: uid(input.nodeRunUid, code),
    nodeUid: uid(input.nodeUid, code),
    planSha256: sha256(input.planSha256, code),
  });
}

function parsedItems(value, minimum, maximum, parser, identityKey, code) {
  const input = denseArray(value, minimum, maximum, code);
  const output = [];
  const identities = new SET_CONSTRUCTOR();
  const nodeRuns = new SET_CONSTRUCTOR();
  const nodes = new SET_CONSTRUCTOR();
  for (let index = 0; index < input.length; index += 1) {
    const item = parser(input[index], code);
    if (REFLECT_APPLY(SET_HAS, identities, [item[identityKey]])
      || REFLECT_APPLY(SET_HAS, nodeRuns, [item.nodeRunUid])
      || REFLECT_APPLY(SET_HAS, nodes, [item.nodeUid])) {
      fail(code);
    }
    REFLECT_APPLY(SET_ADD, identities, [item[identityKey]]);
    REFLECT_APPLY(SET_ADD, nodeRuns, [item.nodeRunUid]);
    REFLECT_APPLY(SET_ADD, nodes, [item.nodeUid]);
    output[index] = item;
  }
  return OBJECT_FREEZE(output);
}

function serializeMvpBenchmarkSessionJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return REFLECT_APPLY(JSON_STRINGIFY, JSON, [value]);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (ARRAY_IS_ARRAY(value)) {
    let output = '[';
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) output += ',';
      output += serializeMvpBenchmarkSessionJson(value[index]);
    }
    return `${output}]`;
  }
  if (!value || typeof value !== 'object') {
    throw new TypeError('MVP benchmark session JSON is invalid');
  }
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
  const keys = REFLECT_OWN_KEYS(descriptors);
  let output = '{';
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor?.enumerable
      || !OBJECT_HAS_OWN(descriptor, 'value')) {
      throw new TypeError('MVP benchmark session JSON is invalid');
    }
    if (index > 0) output += ',';
    output += `${REFLECT_APPLY(JSON_STRINGIFY, JSON, [key])}:${serializeMvpBenchmarkSessionJson(descriptor.value)}`;
  }
  return `${output}}`;
}

function basePlan(value, code) {
  const input = exactObject(value, PLAN_KEYS, code);
  if (input.schemaVersion !== PLAN_SCHEMA_VERSION) fail(code);
  return OBJECT_FREEZE({
    schemaVersion: PLAN_SCHEMA_VERSION,
    uid: uid(input.uid, code),
    dramaUid: uid(input.dramaUid, code),
    workflowRunUid: uid(input.workflowRunUid, code),
    workflowUid: uid(input.workflowUid, code),
    graphHash: sha256(input.graphHash, code),
    graphRevision: Number.isSafeInteger(input.graphRevision) && input.graphRevision >= 0
      ? input.graphRevision : fail(code),
    h3Tasks: parsedItems(
      input.h3Tasks, MIN_H3_TASKS, MAX_H3_TASKS, parseH3Item, 'taskUid', code,
    ),
    audioIntents: parsedItems(
      input.audioIntents, 1, MAX_AUDIO_INTENTS, parseAudioItem, 'intentUid', code,
    ),
    createdAtEpochMs: epoch(input.createdAtEpochMs, code),
  });
}

function planDigest(value) {
  return createHash('sha256').update(serializeMvpBenchmarkSessionJson(value), 'utf8').digest('hex');
}

function createMvpBenchmarkSessionPlan(value, code = 'MVP_BENCHMARK_SESSION_INPUT_INVALID') {
  const input = exactObject(value, PLAN_INPUT_KEYS, code);
  const withPlaceholder = {
    schemaVersion: input.schemaVersion,
    uid: input.uid,
    dramaUid: input.dramaUid,
    workflowRunUid: input.workflowRunUid,
    workflowUid: input.workflowUid,
    graphHash: input.graphHash,
    graphRevision: input.graphRevision,
    h3Tasks: input.h3Tasks,
    audioIntents: input.audioIntents,
    planSha256: '0'.repeat(64),
    createdAtEpochMs: input.createdAtEpochMs,
  };
  const base = basePlan(withPlaceholder, code);
  return OBJECT_FREEZE({
    schemaVersion: base.schemaVersion,
    uid: base.uid,
    dramaUid: base.dramaUid,
    workflowRunUid: base.workflowRunUid,
    workflowUid: base.workflowUid,
    graphHash: base.graphHash,
    graphRevision: base.graphRevision,
    h3Tasks: base.h3Tasks,
    audioIntents: base.audioIntents,
    planSha256: planDigest(base),
    createdAtEpochMs: base.createdAtEpochMs,
  });
}

function parseMvpBenchmarkSessionPlan(value, code = 'MVP_BENCHMARK_SESSION_DATA_INVALID') {
  const input = exactObject(value, PLAN_KEYS, code);
  const expected = createMvpBenchmarkSessionPlan({
    schemaVersion: input.schemaVersion,
    uid: input.uid,
    dramaUid: input.dramaUid,
    workflowRunUid: input.workflowRunUid,
    workflowUid: input.workflowUid,
    graphHash: input.graphHash,
    graphRevision: input.graphRevision,
    h3Tasks: input.h3Tasks,
    audioIntents: input.audioIntents,
    createdAtEpochMs: input.createdAtEpochMs,
  }, code);
  if (sha256(input.planSha256, code) !== expected.planSha256) fail(code);
  return expected;
}

function isMvpBenchmarkSessionError(error) {
  return error instanceof MvpBenchmarkSessionError;
}

module.exports = OBJECT_FREEZE({
  MAX_AUDIO_INTENTS,
  MAX_H3_TASKS,
  MIN_H3_TASKS,
  MvpBenchmarkSessionError,
  PLAN_SCHEMA_VERSION,
  REQUEST_SCHEMA_VERSION,
  createMvpBenchmarkSessionPlan,
  isMvpBenchmarkSessionError,
  parseMvpBenchmarkSessionPlan,
  parseMvpBenchmarkSessionRequest,
  serializeMvpBenchmarkSessionJson,
});
