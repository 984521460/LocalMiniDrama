'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const SCHEMA_VERSION = 'narrative-execution-request.v1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[a-z][a-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVIEW_REF = /^review:v1:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const RESULT_TYPES = Object.freeze(new Set(['extraction', 'adaptation', 'script', 'shot']));
const ASSET_TYPES = Object.freeze(new Set([
  'character', 'scene', 'prop',
]));
const ROOT_KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'dramaUid', 'sourceSelectionUid', 'resultType',
  'upstreamResultUid', 'upstreamResultHash', 'upstreamEnvelopeHash',
  'upstreamApprovalRef', 'durationBudget', 'style', 'assetVersions',
]);
const DURATION_KEYS = Object.freeze(['targetSeconds', 'toleranceSeconds']);
const STYLE_KEYS = Object.freeze(['genre', 'tone', 'audience']);
const ASSET_KEYS = Object.freeze(['assetVersionRef', 'assetType', 'bindingRef']);
const SET_HAS = Set.prototype.has;
const SET_ADD = Set.prototype.add;
const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_TRIM = String.prototype.trim;

class NarrativeExecutionRequestError extends TypeError {
  constructor() {
    super('Narrative execution request is invalid');
    this.name = 'NarrativeExecutionRequestError';
    Object.freeze(this);
  }
}

function invalid() {
  throw new NarrativeExecutionRequestError();
}

function ownData(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) invalid();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid();
  }
  if (prototype !== Object.prototype && prototype !== null
    || Reflect.ownKeys(descriptors).length !== keys.length) invalid();
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    output[key] = descriptor.value;
  }
  return output;
}

function denseArray(value, maximumLength) {
  if (!Array.isArray(value) || isProxy(value)) invalid();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return invalid(); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength
    || Reflect.ownKeys(descriptors).length !== length + 1) invalid();
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    Object.defineProperty(output, String(index), {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return output;
}

function canonicalUid(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) invalid();
  return value;
}

function boundedText(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
    || Reflect.apply(STRING_TRIM, value, []) !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, 'utf8') > 512) invalid();
  let codePoints = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = Reflect.apply(STRING_CHAR_CODE_AT, value, [index]);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = Reflect.apply(STRING_CHAR_CODE_AT, value, [index + 1]);
      if (!(second >= 0xdc00 && second <= 0xdfff)) invalid();
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) invalid();
    codePoints += 1;
    if (codePoints > 128) invalid();
  }
  return value;
}

function upstreamEvidence(input) {
  const empty = input.upstreamResultUid === null
    && input.upstreamResultHash === null
    && input.upstreamEnvelopeHash === null
    && input.upstreamApprovalRef === null;
  if (empty) return null;
  if (typeof input.upstreamResultHash !== 'string'
    || !SHA256.test(input.upstreamResultHash)
    || typeof input.upstreamEnvelopeHash !== 'string'
    || !SHA256.test(input.upstreamEnvelopeHash)
    || typeof input.upstreamApprovalRef !== 'string'
    || !REVIEW_REF.test(input.upstreamApprovalRef)) invalid();
  const resultUid = canonicalUid(input.upstreamResultUid);
  if (input.upstreamApprovalRef.slice('review:v1:'.length) === resultUid) invalid();
  return Object.freeze({
    resultUid,
    resultHash: input.upstreamResultHash,
    envelopeHash: input.upstreamEnvelopeHash,
    approvalRef: input.upstreamApprovalRef,
  });
}

function durationBudget(value) {
  const input = ownData(value, DURATION_KEYS);
  if (!Number.isSafeInteger(input.targetSeconds)
    || input.targetSeconds < 45 || input.targetSeconds > 75
    || !Number.isSafeInteger(input.toleranceSeconds)
    || input.toleranceSeconds < 0 || input.toleranceSeconds > 15) invalid();
  return Object.freeze({
    targetSeconds: input.targetSeconds,
    toleranceSeconds: input.toleranceSeconds,
  });
}

function style(value) {
  const input = ownData(value, STYLE_KEYS);
  return Object.freeze({
    genre: boundedText(input.genre),
    tone: boundedText(input.tone),
    audience: boundedText(input.audience),
  });
}

function assetVersions(value) {
  const items = denseArray(value, 256);
  const output = [];
  const refs = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const input = ownData(items[index], ASSET_KEYS);
    if (typeof input.assetVersionRef !== 'string'
      || !/^asset-version:v1:[0-9a-f-]{36}$/u.test(input.assetVersionRef)
      || !UUID_V4.test(input.assetVersionRef.slice('asset-version:v1:'.length))
      || typeof input.assetType !== 'string'
      || !Reflect.apply(SET_HAS, ASSET_TYPES, [input.assetType])
      || typeof input.bindingRef !== 'string'
      || !TOKEN.test(input.bindingRef)
      || Reflect.apply(SET_HAS, refs, [input.assetVersionRef])) invalid();
    Reflect.apply(SET_ADD, refs, [input.assetVersionRef]);
    Object.defineProperty(output, String(index), {
      configurable: true,
      enumerable: true,
      value: Object.freeze({
        assetVersionRef: input.assetVersionRef,
        assetType: input.assetType,
        bindingRef: input.bindingRef,
      }),
      writable: true,
    });
  }
  return Object.freeze(output);
}

function parseNarrativeExecutionRequest(value) {
  const input = ownData(value, ROOT_KEYS);
  if (input.schemaVersion !== SCHEMA_VERSION
    || typeof input.resultType !== 'string'
    || !Reflect.apply(SET_HAS, RESULT_TYPES, [input.resultType])) invalid();
  const request = {
    schemaVersion: SCHEMA_VERSION,
    operationUid: canonicalUid(input.operationUid),
    dramaUid: canonicalUid(input.dramaUid),
    sourceSelectionUid: canonicalUid(input.sourceSelectionUid),
    resultType: input.resultType,
    upstreamResultUid: input.upstreamResultUid === null
      ? null : canonicalUid(input.upstreamResultUid),
    upstreamResultHash: input.upstreamResultHash,
    upstreamEnvelopeHash: input.upstreamEnvelopeHash,
    upstreamApprovalRef: input.upstreamApprovalRef,
    durationBudget: input.durationBudget === null ? null : durationBudget(input.durationBudget),
    style: input.style === null ? null : style(input.style),
    assetVersions: assetVersions(input.assetVersions),
  };
  const upstream = upstreamEvidence(input);
  if ((upstream === null) !== (request.upstreamResultUid === null)
    || (upstream && upstream.resultUid !== request.upstreamResultUid)) invalid();
  if (request.resultType === 'extraction') {
    if (upstream !== null || request.durationBudget !== null
      || request.style !== null || request.assetVersions.length !== 0) invalid();
  } else if (request.resultType === 'adaptation') {
    if (upstream === null || request.durationBudget === null
      || request.style === null || request.assetVersions.length !== 0) invalid();
  } else if (request.resultType === 'script') {
    if (upstream === null || request.durationBudget !== null
      || request.style !== null || request.assetVersions.length !== 0) invalid();
  } else if (upstream === null || request.durationBudget !== null
    || request.style !== null) invalid();
  return Object.freeze(request);
}

function canonicalNarrativeExecutionRequest(value) {
  const request = parseNarrativeExecutionRequest(value);
  const encode = (item) => Reflect.apply(JSON_STRINGIFY, JSON, [item]);
  const duration = request.durationBudget === null
    ? 'null'
    : `{"targetSeconds":${request.durationBudget.targetSeconds},"toleranceSeconds":${request.durationBudget.toleranceSeconds}}`;
  const style = request.style === null
    ? 'null'
    : `{"genre":${encode(request.style.genre)},"tone":${encode(request.style.tone)},"audience":${encode(request.style.audience)}}`;
  let assets = '[';
  for (let index = 0; index < request.assetVersions.length; index += 1) {
    const item = request.assetVersions[index];
    if (index > 0) assets += ',';
    assets += `{"assetVersionRef":${encode(item.assetVersionRef)},"assetType":${encode(item.assetType)},"bindingRef":${encode(item.bindingRef)}}`;
  }
  assets += ']';
  return `{"schemaVersion":${encode(request.schemaVersion)}`
    + `,"operationUid":${encode(request.operationUid)}`
    + `,"dramaUid":${encode(request.dramaUid)}`
    + `,"sourceSelectionUid":${encode(request.sourceSelectionUid)}`
    + `,"resultType":${encode(request.resultType)}`
    + `,"upstreamResultUid":${encode(request.upstreamResultUid)}`
    + `,"upstreamResultHash":${encode(request.upstreamResultHash)}`
    + `,"upstreamEnvelopeHash":${encode(request.upstreamEnvelopeHash)}`
    + `,"upstreamApprovalRef":${encode(request.upstreamApprovalRef)}`
    + `,"durationBudget":${duration}`
    + `,"style":${style}`
    + `,"assetVersions":${assets}}`;
}

function narrativeExecutionRequestSha256(value) {
  return createHash('sha256')
    .update(canonicalNarrativeExecutionRequest(value), 'utf8')
    .digest('hex');
}

function parseNarrativeExecutionRequestJson(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64 * 1024) invalid();
  let parsed;
  try { parsed = Reflect.apply(JSON_PARSE, JSON, [value]); } catch { return invalid(); }
  const request = parseNarrativeExecutionRequest(parsed);
  if (canonicalNarrativeExecutionRequest(request) !== value) invalid();
  return request;
}

module.exports = Object.freeze({
  NarrativeExecutionRequestError,
  SCHEMA_VERSION,
  canonicalNarrativeExecutionRequest,
  narrativeExecutionRequestSha256,
  parseNarrativeExecutionRequest,
  parseNarrativeExecutionRequestJson,
});
