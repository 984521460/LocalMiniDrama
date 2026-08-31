'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const JSON_STRINGIFY = JSON.stringify;
const ARRAY_IS_ARRAY = Array.isArray;
const DEFINE_PROPERTY = Object.defineProperty;
const FREEZE = Object.freeze;
const GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const HAS_OWN = Object.hasOwn;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_TEST = RegExp.prototype.test;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_DELETE = WeakSet.prototype.delete;
const WEAK_SET_HAS = WeakSet.prototype.has;

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
  AUDIO_TTS_SUBMISSION_INVALID: 'Independent TTS submission is invalid',
  AUDIO_TTS_SUBMISSION_DATA_INVALID: 'Independent TTS submission state is invalid',
  AUDIO_TTS_SUBMISSION_UNKNOWN: 'Independent TTS submission result is unknown',
  AUDIO_TTS_PROVIDER_UNAVAILABLE: 'Independent TTS provider is unavailable',
  AUDIO_TTS_PROVIDER_REJECTED: 'Independent TTS provider rejected the request',
  AUDIO_TTS_RESPONSE_INVALID: 'Independent TTS provider response is invalid',
  AUDIO_TTS_REQUEST_ABORTED: 'Independent TTS provider request was aborted',
  AUDIO_TTS_EXECUTION_INPUT_INVALID: 'Independent TTS execution input is invalid',
  AUDIO_TTS_EXECUTION_NOT_FOUND: 'Independent TTS execution was not found',
  AUDIO_TTS_EXECUTION_DATA_INVALID: 'Independent TTS execution state is invalid',
  AUDIO_TTS_EXECUTION_IN_PROGRESS: 'Independent TTS execution is already in progress',
  AUDIO_TTS_EXECUTION_FAILED: 'Independent TTS execution failed',
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
  MEDIA_EXPORT_INPUT_INVALID: 'Media export input is invalid',
  MEDIA_EXPORT_FAILED: 'Local media export failed',
  MEDIA_EXPORT_OUTPUT_INVALID: 'Media export output is invalid',
  MEDIA_EXPORT_DATA_INVALID: 'Media export data is invalid',
  MEDIA_EXPORT_RUN_INPUT_INVALID: 'Media export run input is invalid',
  MEDIA_EXPORT_RUN_DATA_INVALID: 'Media export run data is invalid',
  BGM_LICENSE_INVALID: 'BGM license metadata is invalid',
  BGM_LICENSE_NOT_EXPORTABLE: 'BGM license does not permit project export',
  BGM_TRACK_INVALID: 'BGM track is invalid',
  BGM_IMPORT_INVALID: 'BGM import input is invalid',
  BGM_IMPORT_FAILED: 'BGM local import failed',
  BGM_IMPORT_CLEANUP_FAILED: 'BGM local import cleanup failed',
});

function append(target, value) {
  Reflect.apply(DEFINE_PROPERTY, Object, [target, String(target.length), {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  }]);
}

class AudioModeContractError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || 'Audio mode contract failed');
    this.name = 'AudioModeContractError';
    this.code = code;
    Reflect.apply(WEAK_SET_ADD, ERRORS, [this]);
  }

  toJSON() {
    return Object.freeze({ code: this.code, message: this.message });
  }
}

function isAudioModeContractError(value) {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null && Reflect.apply(WEAK_SET_HAS, ERRORS, [value]);
}

function fail(code) {
  throw new AudioModeContractError(code);
}

function exactObject(value, expectedKeys, code) {
  try {
    if (value === null || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) {
      fail(code);
    }
    const prototype = Reflect.apply(GET_PROTOTYPE_OF, Object, [value]);
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    const descriptors = Reflect.apply(GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
    const keys = Reflect.apply(REFLECT_OWN_KEYS, Reflect, [descriptors]);
    if (keys.length !== expectedKeys.length) fail(code);
    for (let index = 0; index < keys.length; index += 1) {
      if (typeof keys[index] !== 'string') fail(code);
    }
    const output = Object.create(null);
    for (let index = 0; index < expectedKeys.length; index += 1) {
      const key = expectedKeys[index];
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !HAS_OWN(descriptor, 'value')) fail(code);
      Reflect.apply(DEFINE_PROPERTY, Object, [output, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: descriptor.value,
      }]);
    }
    return output;
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(code);
  }
}

function denseArray(value, maximumLength, code) {
  try {
    if (isProxy(value) || !ARRAY_IS_ARRAY(value)
      || Reflect.apply(GET_PROTOTYPE_OF, Object, [value]) !== Array.prototype) fail(code);
    const descriptors = Reflect.apply(GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !HAS_OWN(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0 || lengthDescriptor.value > maximumLength) fail(code);
    const length = lengthDescriptor.value;
    const keys = Reflect.apply(REFLECT_OWN_KEYS, Reflect, [descriptors]);
    if (keys.length !== length + 1) fail(code);
    for (let index = 0; index < keys.length; index += 1) {
      if (typeof keys[index] !== 'string') fail(code);
    }
    const output = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !HAS_OWN(descriptor, 'value')) fail(code);
      append(output, descriptor.value);
    }
    return output;
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(code);
  }
}

function canonicalUid(value, code) {
  if (typeof value !== 'string' || !Reflect.apply(REGEXP_TEST, UUID_V4, [value])) fail(code);
  return value;
}

function sha256(value, code) {
  if (typeof value !== 'string' || !Reflect.apply(REGEXP_TEST, SHA256, [value])) fail(code);
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

function jsonSnapshot(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || isProxy(value)
    || Reflect.apply(WEAK_SET_HAS, ancestors, [value])) {
    throw new TypeError('Audio canonical JSON is invalid');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Reflect.apply(GET_PROTOTYPE_OF, Object, [value]);
    descriptors = Reflect.apply(GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
  } catch {
    throw new TypeError('Audio canonical JSON is invalid');
  }
  Reflect.apply(WEAK_SET_ADD, ancestors, [value]);
  try {
    if (ARRAY_IS_ARRAY(value)) {
      if (prototype !== Array.prototype) throw new TypeError('Audio canonical JSON is invalid');
      const length = descriptors.length;
      if (!length || !HAS_OWN(length, 'value') || !Number.isSafeInteger(length.value)
        || length.value < 0) throw new TypeError('Audio canonical JSON is invalid');
      const keys = Reflect.apply(REFLECT_OWN_KEYS, Reflect, [descriptors]);
      if (keys.length !== length.value + 1) {
        throw new TypeError('Audio canonical JSON is invalid');
      }
      for (let index = 0; index < keys.length; index += 1) {
        if (typeof keys[index] !== 'string') {
          throw new TypeError('Audio canonical JSON is invalid');
        }
      }
      const output = [];
      Reflect.apply(DEFINE_PROPERTY, Object, [output, 'toJSON', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: undefined,
      }]);
      for (let index = 0; index < length.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !HAS_OWN(descriptor, 'value')) {
          throw new TypeError('Audio canonical JSON is invalid');
        }
        Reflect.apply(DEFINE_PROPERTY, Object, [output, String(index), {
          configurable: true,
          enumerable: true,
          writable: true,
          value: jsonSnapshot(descriptor.value, ancestors),
        }]);
      }
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Audio canonical JSON is invalid');
    }
    const output = Object.create(null);
    const keys = Reflect.apply(REFLECT_OWN_KEYS, Reflect, [descriptors]);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !descriptor || !HAS_OWN(descriptor, 'value')) {
        throw new TypeError('Audio canonical JSON is invalid');
      }
      if (!descriptor.enumerable) continue;
      Reflect.apply(DEFINE_PROPERTY, Object, [output, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: jsonSnapshot(descriptor.value, ancestors),
      }]);
    }
    return output;
  } finally {
    Reflect.apply(WEAK_SET_DELETE, ancestors, [value]);
  }
}

function canonicalJson(value) {
  const snapshot = jsonSnapshot(value, new WeakSet());
  return Reflect.apply(JSON_STRINGIFY, JSON, [snapshot]);
}

function canonicalHash(value) {
  return createHash('sha256')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function textHash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function frozenArray(values) {
  const output = [];
  for (let index = 0; index < values.length; index += 1) append(output, values[index]);
  return Reflect.apply(FREEZE, Object, [output]);
}

module.exports = Object.freeze({
  AudioModeContractError,
  assetEvidence,
  boundedInteger,
  canonicalHash,
  canonicalJson,
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
