'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const SCHEMA_VERSION = 'character-candidate-execution-request.v1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'dramaUid', 'characterUid', 'extractionResultUid',
  'characterFactId', 'width', 'height', 'seed',
]);
const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;

class CharacterCandidateExecutionRequestError extends TypeError {
  constructor() {
    super('Character candidate execution request is invalid');
    this.name = 'CharacterCandidateExecutionRequestError';
    Object.freeze(this);
  }
}

function invalid() {
  throw new CharacterCandidateExecutionRequestError();
}

function exactObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) invalid();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid();
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== KEYS.length) invalid();
  const output = Object.create(null);
  for (let index = 0; index < KEYS.length; index += 1) {
    const key = KEYS[index];
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    output[key] = descriptor.value;
  }
  return output;
}

function uid(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) invalid();
  return value;
}

function parseCharacterCandidateExecutionRequest(value) {
  const input = exactObject(value);
  if (input.schemaVersion !== SCHEMA_VERSION
    || typeof input.characterFactId !== 'string'
    || !FACT_ID.test(input.characterFactId)
    || !Number.isSafeInteger(input.width) || input.width < 256 || input.width > 2048
    || !Number.isSafeInteger(input.height) || input.height < 256 || input.height > 2048
    || input.width * input.height > 4_194_304
    || !Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 4_294_967_295) {
    invalid();
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    operationUid: uid(input.operationUid),
    dramaUid: uid(input.dramaUid),
    characterUid: uid(input.characterUid),
    extractionResultUid: uid(input.extractionResultUid),
    characterFactId: input.characterFactId,
    width: input.width,
    height: input.height,
    seed: input.seed,
  });
}

function canonicalCharacterCandidateExecutionRequest(value) {
  const request = parseCharacterCandidateExecutionRequest(value);
  const encode = (item) => Reflect.apply(JSON_STRINGIFY, JSON, [item]);
  return `{"schemaVersion":${encode(request.schemaVersion)}`
    + `,"operationUid":${encode(request.operationUid)}`
    + `,"dramaUid":${encode(request.dramaUid)}`
    + `,"characterUid":${encode(request.characterUid)}`
    + `,"extractionResultUid":${encode(request.extractionResultUid)}`
    + `,"characterFactId":${encode(request.characterFactId)}`
    + `,"width":${request.width},"height":${request.height},"seed":${request.seed}}`;
}

function characterCandidateExecutionRequestSha256(value) {
  return createHash('sha256')
    .update(canonicalCharacterCandidateExecutionRequest(value), 'utf8')
    .digest('hex');
}

function parseCharacterCandidateExecutionRequestJson(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 16 * 1024) invalid();
  let parsed;
  try { parsed = Reflect.apply(JSON_PARSE, JSON, [value]); } catch { return invalid(); }
  const request = parseCharacterCandidateExecutionRequest(parsed);
  if (canonicalCharacterCandidateExecutionRequest(request) !== value) invalid();
  return request;
}

module.exports = Object.freeze({
  CharacterCandidateExecutionRequestError,
  SCHEMA_VERSION,
  canonicalCharacterCandidateExecutionRequest,
  characterCandidateExecutionRequestSha256,
  parseCharacterCandidateExecutionRequest,
  parseCharacterCandidateExecutionRequestJson,
});
