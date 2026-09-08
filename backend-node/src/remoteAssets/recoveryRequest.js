'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const SCHEMA_VERSION = 'remote-asset-recovery-request.v1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'dramaUid', 'characterUid', 'extractionResultUid',
  'characterFactId', 'connectionUid', 'connectionEvidenceSha256', 'remoteTaskUid',
]);
const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;

class RemoteAssetRecoveryRequestError extends TypeError {
  constructor() {
    super('Remote asset recovery request is invalid');
    this.name = 'RemoteAssetRecoveryRequestError';
    Object.freeze(this);
  }
}

function invalid() {
  throw new RemoteAssetRecoveryRequestError();
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

function parseRemoteAssetRecoveryRequest(value) {
  const input = exactObject(value);
  if (input.schemaVersion !== SCHEMA_VERSION
    || typeof input.characterFactId !== 'string' || !FACT_ID.test(input.characterFactId)
    || typeof input.connectionEvidenceSha256 !== 'string'
    || !SHA256.test(input.connectionEvidenceSha256)) invalid();
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    operationUid: uid(input.operationUid),
    dramaUid: uid(input.dramaUid),
    characterUid: uid(input.characterUid),
    extractionResultUid: uid(input.extractionResultUid),
    characterFactId: input.characterFactId,
    connectionUid: uid(input.connectionUid),
    connectionEvidenceSha256: input.connectionEvidenceSha256,
    remoteTaskUid: uid(input.remoteTaskUid),
  });
}

function canonicalRemoteAssetRecoveryRequest(value) {
  const request = parseRemoteAssetRecoveryRequest(value);
  const encode = (item) => Reflect.apply(JSON_STRINGIFY, JSON, [item]);
  return `{"schemaVersion":${encode(request.schemaVersion)}`
    + `,"operationUid":${encode(request.operationUid)}`
    + `,"dramaUid":${encode(request.dramaUid)}`
    + `,"characterUid":${encode(request.characterUid)}`
    + `,"extractionResultUid":${encode(request.extractionResultUid)}`
    + `,"characterFactId":${encode(request.characterFactId)}`
    + `,"connectionUid":${encode(request.connectionUid)}`
    + `,"connectionEvidenceSha256":${encode(request.connectionEvidenceSha256)}`
    + `,"remoteTaskUid":${encode(request.remoteTaskUid)}}`;
}

function remoteAssetRecoveryRequestSha256(value) {
  return createHash('sha256')
    .update(canonicalRemoteAssetRecoveryRequest(value), 'utf8')
    .digest('hex');
}

function parseRemoteAssetRecoveryRequestJson(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 16 * 1024) invalid();
  let parsed;
  try { parsed = Reflect.apply(JSON_PARSE, JSON, [value]); } catch { return invalid(); }
  const request = parseRemoteAssetRecoveryRequest(parsed);
  if (canonicalRemoteAssetRecoveryRequest(request) !== value) invalid();
  return request;
}

module.exports = Object.freeze({
  RemoteAssetRecoveryRequestError,
  SCHEMA_VERSION,
  canonicalRemoteAssetRecoveryRequest,
  parseRemoteAssetRecoveryRequest,
  parseRemoteAssetRecoveryRequestJson,
  remoteAssetRecoveryRequestSha256,
});
