'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVIEW_REF = /^review:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const KEYS = Object.freeze([
  'schemaVersion', 'dramaUid', 'characterUid', 'characterName', 'characterDescription',
  'characterPersonality', 'characterAppearance', 'sourceSelectionUid',
  'extractionResultUid', 'extractionResultHash', 'extractionEnvelopeHash',
  'extractionApprovalRef', 'characterFactId', 'characterFactName',
  'characterFactDescription',
]);
const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_TRIM = String.prototype.trim;

function invalid() {
  throw new TypeError('Character candidate source is invalid');
}

function ownData(value) {
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

function text(value, { nullable = false, maximumBytes = 16 * 1024 } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumBytes
    || Reflect.apply(STRING_TRIM, value, []) !== value
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || /[\u0000\u007f]/u.test(value)) invalid();
  for (let index = 0; index < value.length; index += 1) {
    const unit = Reflect.apply(STRING_CHAR_CODE_AT, value, [index]);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) invalid();
      const next = Reflect.apply(STRING_CHAR_CODE_AT, value, [index + 1]);
      if (next < 0xdc00 || next > 0xdfff) invalid();
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
  return value;
}

function parseCharacterCandidateSource(value) {
  const input = ownData(value);
  if (input.schemaVersion !== 'character-candidate-source.v1'
    || typeof input.extractionResultHash !== 'string' || !SHA256.test(input.extractionResultHash)
    || typeof input.extractionEnvelopeHash !== 'string' || !SHA256.test(input.extractionEnvelopeHash)
    || typeof input.extractionApprovalRef !== 'string' || !REVIEW_REF.test(input.extractionApprovalRef)
    || typeof input.characterFactId !== 'string' || !FACT_ID.test(input.characterFactId)) invalid();
  const source = Object.freeze({
    schemaVersion: 'character-candidate-source.v1',
    dramaUid: uid(input.dramaUid),
    characterUid: uid(input.characterUid),
    characterName: text(input.characterName, { maximumBytes: 1024 }),
    characterDescription: text(input.characterDescription, { nullable: true }),
    characterPersonality: text(input.characterPersonality, { nullable: true }),
    characterAppearance: text(input.characterAppearance, { nullable: true }),
    sourceSelectionUid: uid(input.sourceSelectionUid),
    extractionResultUid: uid(input.extractionResultUid),
    extractionResultHash: input.extractionResultHash,
    extractionEnvelopeHash: input.extractionEnvelopeHash,
    extractionApprovalRef: input.extractionApprovalRef,
    characterFactId: input.characterFactId,
    characterFactName: text(input.characterFactName, { maximumBytes: 1024 }),
    characterFactDescription: text(input.characterFactDescription),
  });
  return source;
}

function canonicalCharacterCandidateSource(value) {
  const source = parseCharacterCandidateSource(value);
  const encode = (item) => Reflect.apply(JSON_STRINGIFY, JSON, [item]);
  let output = '{';
  for (let index = 0; index < KEYS.length; index += 1) {
    const key = KEYS[index];
    if (index > 0) output += ',';
    output += `${encode(key)}:${encode(source[key])}`;
  }
  return `${output}}`;
}

function characterCandidateSourceSha256(value) {
  return createHash('sha256')
    .update(canonicalCharacterCandidateSource(value), 'utf8')
    .digest('hex');
}

function parseCharacterCandidateSourceJson(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64 * 1024) invalid();
  let parsed;
  try { parsed = Reflect.apply(JSON_PARSE, JSON, [value]); } catch { return invalid(); }
  const source = parseCharacterCandidateSource(parsed);
  if (canonicalCharacterCandidateSource(source) !== value) invalid();
  return source;
}

module.exports = Object.freeze({
  canonicalCharacterCandidateSource,
  characterCandidateSourceSha256,
  parseCharacterCandidateSource,
  parseCharacterCandidateSourceJson,
});
