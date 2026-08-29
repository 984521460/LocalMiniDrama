'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_EPOCH_MS = 253402300799999;
const ASSET_KEYS = Object.freeze([
  'uid', 'ownerType', 'ownerUid', 'assetType', 'currentVersionUid',
  'status', 'createdAt', 'updatedAt',
]);
const ERRORS = new WeakSet();
const ERROR_MESSAGES = Object.freeze({
  AUDIO_MODE_INPUT_INVALID: 'Audio mode input is invalid',
  AUDIO_MODE_DATA_INVALID: 'Audio mode data is invalid',
  AUDIO_TTS_NOT_CONFIGURED: 'Independent TTS is not configured',
  AUDIO_H3_NATIVE_UNAVAILABLE: 'H3 native audio is unavailable',
  AUDIO_EXECUTION_EVIDENCE_INVALID: 'Audio execution evidence is invalid',
  AUDIO_TIMELINE_INPUT_INVALID: 'Audio timeline input is invalid',
  AUDIO_TIMELINE_DATA_INVALID: 'Audio timeline data is invalid',
  AUDIO_MIX_INPUT_INVALID: 'Audio mix input is invalid',
  AUDIO_MIX_DATA_INVALID: 'Audio mix data is invalid',
  PRODUCTION_TIMELINE_INPUT_INVALID: 'Production timeline input is invalid',
  PRODUCTION_TIMELINE_DATA_INVALID: 'Production timeline data is invalid',
  MEDIA_PROFILE_DATA_INVALID: 'Media export profile data is invalid',
  MEDIA_PROBE_INPUT_INVALID: 'Media probe input is invalid',
  MEDIA_PROBE_FAILED: 'Local media probe failed',
  MEDIA_PROBE_DATA_INVALID: 'Media probe data is invalid',
  MEDIA_NORMALIZATION_INPUT_INVALID: 'Media normalization input is invalid',
  MEDIA_NORMALIZATION_DATA_INVALID: 'Media normalization data is invalid',
  BGM_LICENSE_INVALID: 'BGM license metadata is invalid',
  BGM_LICENSE_NOT_EXPORTABLE: 'BGM license does not permit project export',
  BGM_TRACK_INVALID: 'BGM track is invalid',
  BGM_IMPORT_INVALID: 'BGM import input is invalid',
  BGM_IMPORT_FAILED: 'BGM local import failed',
  BGM_IMPORT_CLEANUP_FAILED: 'BGM local import cleanup failed',
});

class AudioModeContractError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || 'Audio mode contract failed');
    this.name = 'AudioModeContractError';
    this.code = code;
    ERRORS.add(this);
  }

  toJSON() {
    return Object.freeze({ code: this.code, message: this.message });
  }
}

function isAudioModeContractError(value) {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null && ERRORS.has(value);
}

function fail(code) {
  throw new AudioModeContractError(code);
}

function exactObject(value, expectedKeys, code) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail(code);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string')) fail(code);
    const actual = [...keys].sort();
    const expected = [...expectedKeys].sort();
    if (actual.some((key, index) => key !== expected[index])) fail(code);
    const output = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
      output[key] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(code);
  }
}

function denseArray(value, maximumLength, code) {
  try {
    if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0 || lengthDescriptor.value > maximumLength) fail(code);
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== length + 1 || keys.some((key) => typeof key !== 'string')) fail(code);
    const output = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
      output.push(descriptor.value);
    }
    return output;
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(code);
  }
}

function canonicalUid(value, code) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail(code);
  return value;
}

function sha256(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code);
  return value;
}

function epoch(value, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EPOCH_MS) fail(code);
  return value;
}

function timestamp(value, code) {
  if (typeof value !== 'string' || value.length !== 24) fail(code);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value) fail(code);
  return value;
}

function assetEvidence(value, expected, code) {
  const input = exactObject(value, ASSET_KEYS, code);
  const createdAt = timestamp(input.createdAt, code);
  const updatedAt = timestamp(input.updatedAt, code);
  const output = Object.freeze({
    uid: canonicalUid(input.uid, code),
    ownerType: input.ownerType,
    ownerUid: canonicalUid(input.ownerUid, code),
    assetType: input.assetType,
    currentVersionUid: canonicalUid(input.currentVersionUid, code),
    status: input.status,
    createdAt,
    updatedAt,
  });
  if (output.uid !== expected.uid || output.ownerType !== 'drama'
    || output.ownerUid !== expected.ownerUid || output.assetType !== expected.assetType
    || output.currentVersionUid !== expected.currentVersionUid || output.status !== 'ready'
    || Date.parse(updatedAt) < Date.parse(createdAt)) fail(code);
  return output;
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function textHash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function frozenArray(values) {
  return Object.freeze([...values]);
}

module.exports = Object.freeze({
  AudioModeContractError,
  assetEvidence,
  boundedInteger,
  canonicalHash,
  canonicalUid,
  denseArray,
  epoch,
  exactObject,
  fail,
  frozenArray,
  isAudioModeContractError,
  sha256,
  textHash,
});
