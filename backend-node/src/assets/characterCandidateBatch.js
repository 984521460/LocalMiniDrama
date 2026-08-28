const { createHash, randomUUID } = require('node:crypto');
const { types: { isPromise, isProxy } } = require('node:util');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const DEFAULT_GENERATION_TIMEOUT_MS = 10 * 60_000;
const MAX_GENERATION_TIMEOUT_MS = 60 * 60_000;
const NATIVE_PROMISE_THEN = Promise.prototype.then;
const ERROR_MESSAGES = Object.freeze({
  CHARACTER_CANDIDATE_INPUT_INVALID: 'Character candidate request is invalid',
  CHARACTER_CANDIDATE_GENERATOR_UNAVAILABLE: 'Local character candidate generator is unavailable',
  CHARACTER_CANDIDATE_GENERATION_FAILED: 'Local character candidate generation failed',
  CHARACTER_CANDIDATE_OUTPUT_INVALID: 'Character candidate output is invalid',
});
const INTERNAL_ERRORS = new WeakSet();
const INTERNAL_BATCHES = new WeakSet();

class CharacterCandidateError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.CHARACTER_CANDIDATE_OUTPUT_INVALID);
    this.name = 'CharacterCandidateError';
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'CHARACTER_CANDIDATE_OUTPUT_INVALID';
    INTERNAL_ERRORS.add(this);
    Object.freeze(this);
  }
}

function fail(code) {
  throw new CharacterCandidateError(code);
}

function isCharacterCandidateError(value) {
  return INTERNAL_ERRORS.has(value);
}

function ownDataSnapshot(value, code) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail(code);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') fail(code);
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (isCharacterCandidateError(error)) throw error;
    fail(code);
  }
}

function exactObject(value, fields, code) {
  const snapshot = ownDataSnapshot(value, code);
  const keys = Object.keys(snapshot).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(code);
  }
  return snapshot;
}

function denseArraySnapshot(value, expectedLength, code) {
  try {
    if (!Array.isArray(value) || isProxy(value)) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    if (length !== expectedLength) fail(code);
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
    if (keys.length !== expectedLength) fail(code);
    return Object.freeze(Array.from({ length: expectedLength }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
      return descriptor.value;
    }));
  } catch (error) {
    if (isCharacterCandidateError(error)) throw error;
    fail(code);
  }
}

function canonicalUid(value, code) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail(code);
  return value;
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function createCharacterCandidateRequest(value) {
  const code = 'CHARACTER_CANDIDATE_INPUT_INVALID';
  const input = exactObject(value, [
    'schemaVersion',
    'batchUid',
    'characterUid',
    'promptSemanticUid',
    'profileUid',
    'manifestUid',
    'width',
    'height',
    'seed',
    'candidateCount',
  ], code);
  if (input.schemaVersion !== '5.0' || input.candidateCount !== 4) fail(code);
  return Object.freeze({
    schemaVersion: '5.0',
    batchUid: canonicalUid(input.batchUid, code),
    characterUid: canonicalUid(input.characterUid, code),
    promptSemanticUid: canonicalUid(input.promptSemanticUid, code),
    profileUid: canonicalUid(input.profileUid, code),
    manifestUid: canonicalUid(input.manifestUid, code),
    width: boundedInteger(input.width, 64, 8192, code),
    height: boundedInteger(input.height, 64, 8192, code),
    seed: boundedInteger(input.seed, 0, 4_294_967_295, code),
    candidateCount: 4,
  });
}

function candidateRecord(value, request, ordinal) {
  const code = 'CHARACTER_CANDIDATE_OUTPUT_INVALID';
  const input = exactObject(value, [
    'uid',
    'ordinal',
    'assetVersionUid',
    'logicalUri',
    'mediaType',
    'width',
    'height',
    'contentSha256',
    'presentation',
  ], code);
  const expectedUri = `asset://characters/${request.characterUid}/candidate-batches/${request.batchUid}/${ordinal}`;
  if (
    input.ordinal !== ordinal
    || input.logicalUri !== expectedUri
    || !MEDIA_TYPES.has(input.mediaType)
    || input.width !== request.width
    || input.height !== request.height
    || typeof input.contentSha256 !== 'string'
    || !SHA256.test(input.contentSha256)
    || input.presentation !== 'single_portrait'
  ) fail(code);
  return Object.freeze({
    uid: canonicalUid(input.uid, code),
    ordinal,
    assetVersionUid: canonicalUid(input.assetVersionUid, code),
    logicalUri: expectedUri,
    mediaType: input.mediaType,
    width: request.width,
    height: request.height,
    contentSha256: input.contentSha256,
    presentation: 'single_portrait',
  });
}

function assertUnique(records, field) {
  if (new Set(records.map((record) => record[field])).size !== records.length) {
    fail('CHARACTER_CANDIDATE_OUTPUT_INVALID');
  }
}

function requestHash(request) {
  return createHash('sha256').update(JSON.stringify(request), 'utf8').digest('hex');
}

function createCharacterCandidateBatch(requestValue, outputValue) {
  const request = createCharacterCandidateRequest(requestValue);
  const output = exactObject(
    outputValue,
    ['candidates'],
    'CHARACTER_CANDIDATE_OUTPUT_INVALID',
  );
  const candidates = denseArraySnapshot(
    output.candidates,
    4,
    'CHARACTER_CANDIDATE_OUTPUT_INVALID',
  ).map((candidate, ordinal) => candidateRecord(candidate, request, ordinal));
  for (const field of ['uid', 'assetVersionUid', 'logicalUri', 'contentSha256']) {
    assertUnique(candidates, field);
  }
  const batch = Object.freeze({
    schemaVersion: '5.0',
    batchUid: request.batchUid,
    characterUid: request.characterUid,
    requestSha256: requestHash(request),
    request,
    candidates: Object.freeze(candidates),
  });
  INTERNAL_BATCHES.add(batch);
  return batch;
}

function isCharacterCandidateBatch(value) {
  return INTERNAL_BATCHES.has(value);
}

function serviceInput(value, batchUid) {
  const code = 'CHARACTER_CANDIDATE_INPUT_INVALID';
  const input = exactObject(value, [
    'schemaVersion',
    'characterUid',
    'promptSemanticUid',
    'profileUid',
    'manifestUid',
    'width',
    'height',
    'seed',
    'candidateCount',
  ], code);
  return createCharacterCandidateRequest({
    schemaVersion: input.schemaVersion,
    batchUid,
    characterUid: input.characterUid,
    promptSemanticUid: input.promptSemanticUid,
    profileUid: input.profileUid,
    manifestUid: input.manifestUid,
    width: input.width,
    height: input.height,
    seed: input.seed,
    candidateCount: input.candidateCount,
  });
}

function normalizeGenerator(value) {
  if (value === undefined) return null;
  let generator;
  try {
    generator = exactObject(
      value,
      ['scope', 'generateCharacterCandidates'],
      'CHARACTER_CANDIDATE_GENERATOR_UNAVAILABLE',
    );
  } catch {
    throw new TypeError('Local character candidate generator is invalid');
  }
  if (generator.scope !== 'local' || typeof generator.generateCharacterCandidates !== 'function') {
    throw new TypeError('Local character candidate generator is invalid');
  }
  return Object.freeze({
    scope: 'local',
    generateCharacterCandidates: generator.generateCharacterCandidates,
  });
}

function generationTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GENERATION_TIMEOUT_MS) {
    throw new TypeError('Character candidate generation timeout is invalid');
  }
  return value;
}

function isExactNativePromise(value) {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.getPrototypeOf(value) === Promise.prototype
      && !Object.hasOwn(descriptors, 'constructor')
      && !Object.hasOwn(descriptors, 'then');
  } catch {
    return false;
  }
}

function settleNativePromise(value, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(result);
    };
    const timer = setTimeout(() => {
      finish(
        reject,
        new CharacterCandidateError('CHARACTER_CANDIDATE_GENERATION_FAILED'),
      );
    }, timeoutMs);
    try {
      Reflect.apply(NATIVE_PROMISE_THEN, value, [
        (output) => finish(resolve, output),
        () => finish(
          reject,
          new CharacterCandidateError('CHARACTER_CANDIDATE_GENERATION_FAILED'),
        ),
      ]);
    } catch {
      finish(
        reject,
        new CharacterCandidateError('CHARACTER_CANDIDATE_GENERATION_FAILED'),
      );
    }
  });
}

function createCharacterCandidateBatchService({
  localGenerator,
  createUid = randomUUID,
  generationTimeoutMs = DEFAULT_GENERATION_TIMEOUT_MS,
} = {}) {
  if (typeof createUid !== 'function') {
    throw new TypeError('Character candidate UID factory is invalid');
  }
  const generator = normalizeGenerator(localGenerator);
  const timeoutMs = generationTimeout(generationTimeoutMs);
  return Object.freeze({
    async generate(value) {
      if (generator === null) fail('CHARACTER_CANDIDATE_GENERATOR_UNAVAILABLE');
      let request;
      try {
        request = serviceInput(value, createUid());
      } catch (error) {
        if (isCharacterCandidateError(error)) throw error;
        fail('CHARACTER_CANDIDATE_INPUT_INVALID');
      }
      let generated;
      try {
        generated = Reflect.apply(generator.generateCharacterCandidates, generator, [request]);
      } catch {
        fail('CHARACTER_CANDIDATE_GENERATION_FAILED');
      }
      if (isProxy(generated)) fail('CHARACTER_CANDIDATE_OUTPUT_INVALID');
      let output = generated;
      if (isPromise(generated)) {
        if (!isExactNativePromise(generated)) {
          fail('CHARACTER_CANDIDATE_GENERATION_FAILED');
        }
        try {
          output = await settleNativePromise(generated, timeoutMs);
        } catch {
          fail('CHARACTER_CANDIDATE_GENERATION_FAILED');
        }
      }
      try {
        return createCharacterCandidateBatch(request, output);
      } catch {
        fail('CHARACTER_CANDIDATE_OUTPUT_INVALID');
      }
    },
  });
}

module.exports = {
  createCharacterCandidateBatch,
  createCharacterCandidateBatchService,
  createCharacterCandidateRequest,
  isCharacterCandidateBatch,
  isCharacterCandidateError,
};
