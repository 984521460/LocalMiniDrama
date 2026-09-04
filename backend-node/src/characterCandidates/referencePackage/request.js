'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const SCHEMA_VERSION = 'character-reference-package-execution-request.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'dramaUid', 'characterUid',
  'candidateExecutionUid', 'candidateUid', 'width', 'height', 'seed',
]);
const JSON_STRINGIFY = JSON.stringify;

function invalid() {
  throw new TypeError('Character reference package execution request is invalid');
}

function uid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}

function parseCharacterReferencePackageExecutionRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) invalid();
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return invalid();
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== KEYS.length) invalid();
  const input = Object.create(null);
  for (let index = 0; index < KEYS.length; index += 1) {
    const key = KEYS[index];
    if (!Object.hasOwn(descriptors, key)) invalid();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    input[key] = descriptor.value;
  }
  if (input.schemaVersion !== SCHEMA_VERSION
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
    candidateExecutionUid: uid(input.candidateExecutionUid),
    candidateUid: uid(input.candidateUid),
    width: input.width,
    height: input.height,
    seed: input.seed,
  });
}

function canonicalCharacterReferencePackageExecutionRequest(value) {
  const input = parseCharacterReferencePackageExecutionRequest(value);
  const encode = (entry) => Reflect.apply(JSON_STRINGIFY, JSON, [entry]);
  return `{"schemaVersion":${encode(input.schemaVersion)}`
    + `,"operationUid":${encode(input.operationUid)}`
    + `,"dramaUid":${encode(input.dramaUid)}`
    + `,"characterUid":${encode(input.characterUid)}`
    + `,"candidateExecutionUid":${encode(input.candidateExecutionUid)}`
    + `,"candidateUid":${encode(input.candidateUid)}`
    + `,"width":${input.width},"height":${input.height},"seed":${input.seed}}`;
}

function characterReferencePackageExecutionRequestSha256(value) {
  return createHash('sha256')
    .update(canonicalCharacterReferencePackageExecutionRequest(value), 'utf8')
    .digest('hex');
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  canonicalCharacterReferencePackageExecutionRequest,
  characterReferencePackageExecutionRequestSha256,
  parseCharacterReferencePackageExecutionRequest,
});
