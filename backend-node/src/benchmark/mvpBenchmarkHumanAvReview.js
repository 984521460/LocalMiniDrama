'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const ARRAY_IS_ARRAY = Array.isArray;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const JSON_STRINGIFY = JSON.stringify;
const OBJECT_CREATE = Object.create;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_TEST = RegExp.prototype.test;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_TRIM = String.prototype.trim;
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const REQUEST_SCHEMA_VERSION = 'mvp-benchmark-human-av-review-request.v1';
const SCHEMA_VERSION = 'mvp-benchmark-human-av-review.v1';
const INPUT_CODE = 'MVP_BENCHMARK_HUMAN_AV_REVIEW_INPUT_INVALID';
const DATA_CODE = 'MVP_BENCHMARK_HUMAN_AV_REVIEW_DATA_INVALID';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_EPOCH_MS = 253402300799999;
const MAX_NOTE_BYTES = 2048;
const REQUEST_KEYS = OBJECT_FREEZE([
  'schemaVersion', 'sessionUid', 'authorizationUid', 'dramaUid',
  'expectedBatchSha256', 'exportRunUid', 'videoPlaybackAccepted',
  'subtitleSyncAccepted', 'bgmBalanceAccepted', 'reviewNote',
]);
const SOURCE_KEYS = OBJECT_FREEZE([
  'uid', 'sessionUid', 'authorizationUid', 'batchSha256', 'dramaUid',
  'workflowRunUid', 'exportRunUid', 'exportExecutionPlanSha256',
  'outputAssetUid', 'outputAssetVersionUid', 'outputSha256', 'outputBytes',
  'outputDurationMs', 'outputWidth', 'outputHeight', 'exportCompletedAtEpochMs',
  'videoPlaybackAccepted', 'subtitleSyncAccepted', 'bgmBalanceAccepted',
  'reviewNote', 'reviewedAtEpochMs',
]);
const RECORD_KEYS = OBJECT_FREEZE(['schemaVersion', ...SOURCE_KEYS, 'reviewSha256']);

const ERRORS = new WeakSet();
const ERROR_MESSAGES = OBJECT_FREEZE({
  [INPUT_CODE]: 'MVP benchmark human audiovisual review input is invalid',
  [DATA_CODE]: 'MVP benchmark human audiovisual review data is invalid',
  MVP_BENCHMARK_HUMAN_AV_REVIEW_NOT_FOUND:
    'MVP benchmark human audiovisual review was not found',
  MVP_BENCHMARK_HUMAN_AV_REVIEW_CONFLICT:
    'MVP benchmark human audiovisual review conflicts with existing evidence',
  MVP_BENCHMARK_HUMAN_AV_REVIEW_UNAVAILABLE:
    'MVP benchmark human audiovisual review is unavailable',
});

class MvpBenchmarkHumanAvReviewError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? 'MVP benchmark human audiovisual review failed');
    this.name = 'MvpBenchmarkHumanAvReviewError';
    this.code = code;
    ERRORS.add(this);
  }

  toJSON() {
    return OBJECT_FREEZE({ code: this.code, message: this.message });
  }
}

function fail(code) {
  throw new MvpBenchmarkHumanAvReviewError(code);
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) fail(code);
  let prototype;
  let descriptors;
  try {
    prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
    descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
  } catch {
    fail(code);
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]).length !== keys.length) fail(code);
  const output = OBJECT_CREATE(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!OBJECT_HAS_OWN(descriptors, key)) fail(code);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) fail(code);
    output[key] = descriptor.value;
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

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function accepted(value, code) {
  if (value !== true) fail(code);
  return true;
}

function wellFormed(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index]);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const following = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index + 1]);
      if (following < 0xdc00 || following > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function reviewNote(value, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_NOTE_BYTES
    || BUFFER_BYTE_LENGTH(value, 'utf8') > MAX_NOTE_BYTES
    || REFLECT_APPLY(STRING_TRIM, value, []) !== value
    || !wellFormed(value)
    || REFLECT_APPLY(REGEXP_TEST, INVALID_CONTROL, [value])) fail(code);
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON_STRINGIFY(value), 'utf8').digest('hex');
}

function requestRecord(value) {
  const input = exactObject(value, REQUEST_KEYS, INPUT_CODE);
  if (input.schemaVersion !== REQUEST_SCHEMA_VERSION) fail(INPUT_CODE);
  return OBJECT_FREEZE({
    schemaVersion: REQUEST_SCHEMA_VERSION,
    sessionUid: uid(input.sessionUid, INPUT_CODE),
    authorizationUid: uid(input.authorizationUid, INPUT_CODE),
    dramaUid: uid(input.dramaUid, INPUT_CODE),
    expectedBatchSha256: sha256(input.expectedBatchSha256, INPUT_CODE),
    exportRunUid: uid(input.exportRunUid, INPUT_CODE),
    videoPlaybackAccepted: accepted(input.videoPlaybackAccepted, INPUT_CODE),
    subtitleSyncAccepted: accepted(input.subtitleSyncAccepted, INPUT_CODE),
    bgmBalanceAccepted: accepted(input.bgmBalanceAccepted, INPUT_CODE),
    reviewNote: reviewNote(input.reviewNote, INPUT_CODE),
  });
}

function createMvpBenchmarkHumanAvReview(value, code = INPUT_CODE) {
  const input = exactObject(value, SOURCE_KEYS, code);
  const exportCompletedAtEpochMs = integer(
    input.exportCompletedAtEpochMs, 0, MAX_EPOCH_MS, code,
  );
  const reviewedAtEpochMs = integer(input.reviewedAtEpochMs, 0, MAX_EPOCH_MS, code);
  if (reviewedAtEpochMs < exportCompletedAtEpochMs) fail(code);
  const record = OBJECT_FREEZE({
    schemaVersion: SCHEMA_VERSION,
    uid: uid(input.uid, code),
    sessionUid: uid(input.sessionUid, code),
    authorizationUid: uid(input.authorizationUid, code),
    batchSha256: sha256(input.batchSha256, code),
    dramaUid: uid(input.dramaUid, code),
    workflowRunUid: uid(input.workflowRunUid, code),
    exportRunUid: uid(input.exportRunUid, code),
    exportExecutionPlanSha256: sha256(input.exportExecutionPlanSha256, code),
    outputAssetUid: uid(input.outputAssetUid, code),
    outputAssetVersionUid: uid(input.outputAssetVersionUid, code),
    outputSha256: sha256(input.outputSha256, code),
    outputBytes: integer(input.outputBytes, 1, 64 * 1024 * 1024 * 1024, code),
    outputDurationMs: integer(input.outputDurationMs, 1, 3_600_100, code),
    outputWidth: integer(input.outputWidth, 1920, 1920, code),
    outputHeight: integer(input.outputHeight, 1080, 1080, code),
    exportCompletedAtEpochMs,
    videoPlaybackAccepted: accepted(input.videoPlaybackAccepted, code),
    subtitleSyncAccepted: accepted(input.subtitleSyncAccepted, code),
    bgmBalanceAccepted: accepted(input.bgmBalanceAccepted, code),
    reviewNote: reviewNote(input.reviewNote, code),
    reviewedAtEpochMs,
  });
  return OBJECT_FREEZE({ ...record, reviewSha256: digest(record) });
}

function parseMvpBenchmarkHumanAvReview(value) {
  const input = exactObject(value, RECORD_KEYS, DATA_CODE);
  if (input.schemaVersion !== SCHEMA_VERSION) fail(DATA_CODE);
  const source = OBJECT_CREATE(null);
  for (let index = 0; index < SOURCE_KEYS.length; index += 1) {
    source[SOURCE_KEYS[index]] = input[SOURCE_KEYS[index]];
  }
  const record = createMvpBenchmarkHumanAvReview(source, DATA_CODE);
  if (sha256(input.reviewSha256, DATA_CODE) !== record.reviewSha256) fail(DATA_CODE);
  return record;
}

function serializeMvpBenchmarkHumanAvReview(value) {
  return JSON_STRINGIFY(parseMvpBenchmarkHumanAvReview(value));
}

function isMvpBenchmarkHumanAvReviewError(value) {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null && ERRORS.has(value);
}

module.exports = OBJECT_FREEZE({
  DATA_CODE,
  INPUT_CODE,
  MAX_NOTE_BYTES,
  MvpBenchmarkHumanAvReviewError,
  REQUEST_SCHEMA_VERSION,
  SCHEMA_VERSION,
  createMvpBenchmarkHumanAvReview,
  isMvpBenchmarkHumanAvReviewError,
  parseMvpBenchmarkHumanAvReview,
  requestRecord,
  serializeMvpBenchmarkHumanAvReview,
});
