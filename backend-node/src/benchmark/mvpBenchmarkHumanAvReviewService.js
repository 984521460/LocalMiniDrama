'use strict';

const { randomUUID } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const {
  MvpBenchmarkHumanAvReviewError,
  isMvpBenchmarkHumanAvReviewError,
  requestRecord,
} = require('./mvpBenchmarkHumanAvReview');

const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REGEXP_TEST = RegExp.prototype.test;

function unavailable() {
  throw new MvpBenchmarkHumanAvReviewError(
    'MVP_BENCHMARK_HUMAN_AV_REVIEW_UNAVAILABLE',
  );
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) unavailable();
  let prototype;
  let descriptors;
  try {
    prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
    descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
  } catch {
    unavailable();
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]).length !== keys.length) unavailable();
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!OBJECT_HAS_OWN(descriptors, key)) unavailable();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) unavailable();
    output[key] = descriptor.value;
  }
  return output;
}

function captureRepository(value) {
  if (!value || typeof value !== 'object' || isProxy(value)) unavailable();
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
  const methods = Object.create(null);
  for (const key of ['create', 'getByAuthorization']) {
    const descriptor = descriptors[key];
    if (!descriptor || !OBJECT_HAS_OWN(descriptor, 'value')
      || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) unavailable();
    methods[key] = descriptor.value;
  }
  return Object.freeze({ methods: Object.freeze(methods), target: value });
}

function configuration(value) {
  const input = exactObject(value, ['repositories', 'createUid', 'nowEpochMs']);
  const repository = input.repositories?.mvpBenchmarkHumanAvReviews;
  const createUid = input.createUid ?? randomUUID;
  const nowEpochMs = input.nowEpochMs ?? Date.now;
  if (typeof createUid !== 'function' || isProxy(createUid)
    || typeof nowEpochMs !== 'function' || isProxy(nowEpochMs)) unavailable();
  return Object.freeze({
    repository: captureRepository(repository),
    createUid,
    nowEpochMs,
  });
}

function generatedUid(config) {
  let value;
  try { value = REFLECT_APPLY(config.createUid, undefined, []); } catch { unavailable(); }
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, UUID_V4, [value])) unavailable();
  return value;
}

function currentTime(config) {
  let value;
  try { value = REFLECT_APPLY(config.nowEpochMs, undefined, []); } catch { unavailable(); }
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) unavailable();
  return value;
}

function lookupRequest(value) {
  const input = exactObject(value, [
    'sessionUid', 'authorizationUid', 'dramaUid', 'expectedBatchSha256',
  ]);
  for (const key of ['sessionUid', 'authorizationUid', 'dramaUid']) {
    if (typeof input[key] !== 'string'
      || !REFLECT_APPLY(REGEXP_TEST, UUID_V4, [input[key]])) unavailable();
  }
  if (typeof input.expectedBatchSha256 !== 'string'
    || !REFLECT_APPLY(REGEXP_TEST, SHA256, [input.expectedBatchSha256])) unavailable();
  return Object.freeze(input);
}

function call(binding, method, args) {
  try {
    return REFLECT_APPLY(binding.methods[method], binding.target, args);
  } catch (error) {
    if (isMvpBenchmarkHumanAvReviewError(error)
      || error?.code === 'V2_REPOSITORY_CONFLICT'
      || error?.code === 'V2_REPOSITORY_DATA_INVALID') throw error;
    return unavailable();
  }
}

function createMvpBenchmarkHumanAvReviewService(value) {
  const config = configuration(value);
  return Object.freeze({
    review(valueToReview) {
      const request = requestRecord(valueToReview);
      return call(config.repository, 'create', [{
        uid: generatedUid(config),
        request,
      }, { nowEpochMs: currentTime(config) }]);
    },
    get(valueToRead) {
      const input = lookupRequest(valueToRead);
      const review = call(
        config.repository, 'getByAuthorization', [input.authorizationUid],
      );
      if (!review) {
        throw new MvpBenchmarkHumanAvReviewError(
          'MVP_BENCHMARK_HUMAN_AV_REVIEW_NOT_FOUND',
        );
      }
      if (review.sessionUid !== input.sessionUid
        || review.authorizationUid !== input.authorizationUid
        || review.dramaUid !== input.dramaUid
        || review.batchSha256 !== input.expectedBatchSha256) unavailable();
      return review;
    },
  });
}

module.exports = Object.freeze({ createMvpBenchmarkHumanAvReviewService });
