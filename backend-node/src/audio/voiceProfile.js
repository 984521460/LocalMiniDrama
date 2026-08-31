const { types: { isProxy } } = require('node:util');

const { isCredentialReference } = require('../workflows/credentialReference');

const ERROR_MESSAGE = 'Voice profile input is invalid';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;
const MODEL = /^[a-z0-9][a-z0-9._/-]*$/u;
const VOICE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const PROVIDERS = Object.freeze(['openai-compatible', 'minimax']);
const EMOTIONS = Object.freeze(['neutral', 'happy', 'sad', 'angry', 'fearful', 'surprised']);
const PUBLIC_RECORD_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'dramaUid', 'characterUid', 'characterVoiceVersionUid',
  'parentUid', 'revision', 'provider', 'model', 'voiceKey', 'sourceKind', 'status',
  'defaultEmotion', 'emotionMap', 'minimumSpeedPermille', 'defaultSpeedPermille',
  'maximumSpeedPermille', 'voiceVersion', 'credentialConfigured', 'createdAtEpochMs',
]);
const SECRET_SHAPES = Object.freeze([
  /^bearer\s/u,
  /^sk-[a-z0-9]{8}/u,
  /^akia[a-z0-9]{12}/u,
  /^-----begin\s.*private key-----/u,
]);
const ARRAY_IS_ARRAY = Array.isArray;
const DEFINE_PROPERTY = Object.defineProperty;
const GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const HAS_OWN = Object.hasOwn;
const OWN_KEYS = Reflect.ownKeys;
const REGEXP_TEST = RegExp.prototype.test;
const STRING_CODE_POINT_AT = String.prototype.codePointAt;
const STRING_INDEX_OF = String.prototype.indexOf;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const STRING_TRIM = String.prototype.trim;

function includes(values, expected) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function defineValue(target, key, value) {
  Reflect.apply(DEFINE_PROPERTY, Object, [target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  }]);
}

function fail() {
  throw new TypeError(ERROR_MESSAGE);
}

function ownDataSnapshot(value, expectedKeys) {
  try {
    if (value === null || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) fail();
    const prototype = Reflect.apply(GET_PROTOTYPE_OF, Object, [value]);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Reflect.apply(GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
    const keys = Reflect.apply(OWN_KEYS, Reflect, [descriptors]);
    if (keys.length !== expectedKeys.length) fail();
    for (let index = 0; index < keys.length; index += 1) {
      if (typeof keys[index] !== 'string') fail();
    }
    const snapshot = Object.create(null);
    for (let index = 0; index < expectedKeys.length; index += 1) {
      const key = expectedKeys[index];
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !HAS_OWN(descriptor, 'value')) fail();
      defineValue(snapshot, key, descriptor.value);
    }
    return snapshot;
  } catch (error) {
    if (error instanceof TypeError && error.message === ERROR_MESSAGE) throw error;
    fail();
  }
}

function boundedString(value, maxLength, pattern) {
  if (typeof value !== 'string' || value !== Reflect.apply(STRING_TRIM, value, [])
    || Reflect.apply(STRING_INDEX_OF, value, ['\0']) !== -1) fail();
  let length = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = Reflect.apply(STRING_CODE_POINT_AT, value, [index]);
    index += codePoint > 0xffff ? 2 : 1;
    length += 1;
    if (length > maxLength) fail();
  }
  if (length < 1 || (pattern && !Reflect.apply(REGEXP_TEST, pattern, [value]))) fail();
  return value;
}

function canonicalUid(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !Reflect.apply(REGEXP_TEST, UUID_V4, [value])) fail();
  return value;
}

function boundedInteger(value, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) fail();
  return value;
}

function epoch(value) {
  const result = boundedInteger(value, 0);
  if (result > 253402300799999) fail();
  return result;
}

function safeProviderValue(value, maximum, pattern) {
  const result = boundedString(value, maximum, pattern);
  const lowered = Reflect.apply(STRING_TO_LOWER_CASE, result, []);
  for (let index = 0; index < SECRET_SHAPES.length; index += 1) {
    if (Reflect.apply(REGEXP_TEST, SECRET_SHAPES[index], [lowered])) fail();
  }
  return result;
}

function voiceVersion(value, expectedUid) {
  const input = ownDataSnapshot(value, [
    'uid', 'identityVersionUid', 'parentUid', 'name', 'language', 'style',
    'createdAtEpochMs',
  ]);
  const uid = canonicalUid(input.uid);
  const parentUid = canonicalUid(input.parentUid, true);
  if (uid !== expectedUid) fail();
  if (parentUid === uid) fail();
  return Object.freeze({
    uid,
    identityVersionUid: canonicalUid(input.identityVersionUid),
    parentUid,
    name: boundedString(input.name, 120),
    language: boundedString(input.language, 16, LANGUAGE),
    style: boundedString(input.style, 1000),
    createdAtEpochMs: epoch(input.createdAtEpochMs),
  });
}

function emotionMap(value) {
  const input = ownDataSnapshot(value, EMOTIONS);
  const output = Object.create(null);
  for (let index = 0; index < EMOTIONS.length; index += 1) {
    const emotion = EMOTIONS[index];
    defineValue(output, emotion, safeProviderValue(input[emotion], 64, VOICE_KEY));
  }
  return Object.freeze(output);
}

function profileCore(input) {
  const uid = canonicalUid(input.uid);
  const parentUid = canonicalUid(input.parentUid, true);
  if (parentUid === uid) fail();
  if (!includes(PROVIDERS, input.provider)) fail();
  if (input.sourceKind !== 'provider-preset') fail();
  if (input.status !== 'ready' || !includes(EMOTIONS, input.defaultEmotion)) fail();
  const minimumSpeedPermille = boundedInteger(input.minimumSpeedPermille, 500);
  const defaultSpeedPermille = boundedInteger(input.defaultSpeedPermille, 500);
  const maximumSpeedPermille = boundedInteger(input.maximumSpeedPermille, 500);
  if (
    maximumSpeedPermille > 2000
    || minimumSpeedPermille > defaultSpeedPermille
    || defaultSpeedPermille > maximumSpeedPermille
  ) fail();
  return {
    schemaVersion: '8.0',
    uid,
    dramaUid: canonicalUid(input.dramaUid),
    characterUid: canonicalUid(input.characterUid),
    characterVoiceVersionUid: canonicalUid(input.characterVoiceVersionUid),
    parentUid,
    revision: boundedInteger(input.revision, 1),
    provider: input.provider,
    model: safeProviderValue(input.model, 128, MODEL),
    voiceKey: safeProviderValue(input.voiceKey, 128, VOICE_KEY),
    sourceKind: 'provider-preset',
    status: 'ready',
    defaultEmotion: input.defaultEmotion,
    emotionMap: emotionMap(input.emotionMap),
    minimumSpeedPermille,
    defaultSpeedPermille,
    maximumSpeedPermille,
    createdAtEpochMs: epoch(input.createdAtEpochMs),
  };
}

function internalProfileCore(input) {
  if (!isCredentialReference(input.credentialRef)) fail();
  return { ...profileCore(input), credentialRef: input.credentialRef };
}

function createVoiceProfileDraft(value) {
  const input = ownDataSnapshot(value, [
    'schemaVersion', 'uid', 'dramaUid', 'characterUid', 'characterVoiceVersionUid',
    'parentUid', 'revision', 'provider', 'model', 'voiceKey', 'credentialRef',
    'sourceKind', 'status', 'defaultEmotion', 'emotionMap', 'minimumSpeedPermille',
    'defaultSpeedPermille', 'maximumSpeedPermille', 'createdAtEpochMs',
  ]);
  if (input.schemaVersion !== '8.0') fail();
  return Object.freeze(internalProfileCore(input));
}

function createVoiceProfileRecord(value) {
  const input = ownDataSnapshot(value, [
    'schemaVersion', 'uid', 'dramaUid', 'characterUid', 'characterVoiceVersionUid',
    'parentUid', 'revision', 'provider', 'model', 'voiceKey', 'credentialRef',
    'sourceKind', 'status', 'defaultEmotion', 'emotionMap', 'minimumSpeedPermille',
    'defaultSpeedPermille', 'maximumSpeedPermille', 'voiceVersion', 'createdAtEpochMs',
  ]);
  if (input.schemaVersion !== '8.0') fail();
  const core = internalProfileCore(input);
  return Object.freeze({
    ...core,
    voiceVersion: voiceVersion(input.voiceVersion, core.characterVoiceVersionUid),
  });
}

function createVoiceProfileSelectionRecord(value) {
  const input = ownDataSnapshot(value, [
    'schemaVersion', 'uid', 'dramaUid', 'characterUid', 'voiceProfileUid',
    'previousVoiceProfileUid', 'stateVersion', 'changedAtEpochMs',
  ]);
  if (input.schemaVersion !== '8.0') fail();
  const voiceProfileUid = canonicalUid(input.voiceProfileUid);
  const previousVoiceProfileUid = canonicalUid(input.previousVoiceProfileUid, true);
  if (voiceProfileUid === previousVoiceProfileUid) fail();
  return Object.freeze({
    schemaVersion: '8.0',
    uid: canonicalUid(input.uid),
    dramaUid: canonicalUid(input.dramaUid),
    characterUid: canonicalUid(input.characterUid),
    voiceProfileUid,
    previousVoiceProfileUid,
    stateVersion: boundedInteger(input.stateVersion, 1),
    changedAtEpochMs: epoch(input.changedAtEpochMs),
  });
}

function publicVoiceProfileRecord(record) {
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    uid: record.uid,
    dramaUid: record.dramaUid,
    characterUid: record.characterUid,
    characterVoiceVersionUid: record.characterVoiceVersionUid,
    parentUid: record.parentUid,
    revision: record.revision,
    provider: record.provider,
    model: record.model,
    voiceKey: record.voiceKey,
    sourceKind: record.sourceKind,
    status: record.status,
    defaultEmotion: record.defaultEmotion,
    emotionMap: record.emotionMap,
    minimumSpeedPermille: record.minimumSpeedPermille,
    defaultSpeedPermille: record.defaultSpeedPermille,
    maximumSpeedPermille: record.maximumSpeedPermille,
    voiceVersion: record.voiceVersion,
    credentialConfigured: true,
    createdAtEpochMs: record.createdAtEpochMs,
  });
}

function createVoiceProfilePublicRecord(value) {
  return publicVoiceProfileRecord(createVoiceProfileRecord(value));
}

function parseVoiceProfilePublicRecord(value) {
  const input = ownDataSnapshot(value, PUBLIC_RECORD_KEYS);
  if (input.schemaVersion !== '8.0' || input.credentialConfigured !== true) fail();
  const core = profileCore(input);
  return publicVoiceProfileRecord(Object.freeze({
    ...core,
    voiceVersion: voiceVersion(input.voiceVersion, core.characterVoiceVersionUid),
  }));
}

function createVoiceProfileRequest(value) {
  const input = ownDataSnapshot(value, [
    'character_voice_version_uid', 'parent_uid', 'expected_revision', 'provider',
    'model', 'voice_key', 'credential_ref', 'default_emotion', 'emotion_map',
    'minimum_speed_permille', 'default_speed_permille', 'maximum_speed_permille',
  ]);
  const expectedRevision = boundedInteger(input.expected_revision, 0);
  return Object.freeze({
    characterVoiceVersionUid: canonicalUid(input.character_voice_version_uid),
    parentUid: canonicalUid(input.parent_uid, true),
    revision: expectedRevision + 1,
    provider: input.provider,
    model: input.model,
    voiceKey: input.voice_key,
    credentialRef: input.credential_ref,
    defaultEmotion: input.default_emotion,
    emotionMap: input.emotion_map,
    minimumSpeedPermille: input.minimum_speed_permille,
    defaultSpeedPermille: input.default_speed_permille,
    maximumSpeedPermille: input.maximum_speed_permille,
  });
}

function createVoiceProfileActivationRequest(value) {
  const input = ownDataSnapshot(value, ['expected_state_version']);
  return Object.freeze({
    expectedStateVersion: boundedInteger(input.expected_state_version, 0),
  });
}

module.exports = {
  VOICE_PROFILE_PROVIDERS: PROVIDERS,
  createVoiceProfileActivationRequest,
  createVoiceProfileDraft,
  createVoiceProfilePublicRecord,
  createVoiceProfileRecord,
  createVoiceProfileRequest,
  createVoiceProfileSelectionRecord,
  parseVoiceProfilePublicRecord,
};
