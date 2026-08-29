const { types: { isProxy } } = require('node:util');

const { isCredentialReference } = require('../workflows/credentialReference');

const ERROR_MESSAGE = 'Voice profile input is invalid';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;
const MODEL = /^[a-z0-9][a-z0-9._/-]*$/u;
const VOICE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const PROVIDERS = Object.freeze(['openai-compatible', 'minimax']);
const EMOTIONS = Object.freeze(['neutral', 'happy', 'sad', 'angry', 'fearful', 'surprised']);
const SECRET_SHAPES = Object.freeze([
  /^bearer\s/u,
  /^sk-[a-z0-9]{8}/u,
  /^akia[a-z0-9]{12}/u,
  /^-----begin\s.*private key-----/u,
]);

function fail() {
  throw new TypeError(ERROR_MESSAGE);
}

function ownDataSnapshot(value, expectedKeys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string')) fail();
    const sorted = keys.sort();
    const expected = [...expectedKeys].sort();
    if (sorted.length !== expected.length || sorted.some((key, index) => key !== expected[index])) {
      fail();
    }
    const snapshot = Object.create(null);
    for (const key of sorted) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (error instanceof TypeError && error.message === ERROR_MESSAGE) throw error;
    fail();
  }
}

function boundedString(value, maxLength, pattern) {
  if (typeof value !== 'string' || value !== value.trim() || value.includes('\0')) fail();
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maxLength) fail();
  }
  if (length < 1 || (pattern && !pattern.test(value))) fail();
  return value;
}

function canonicalUid(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail();
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
  const lowered = result.toLowerCase();
  if (SECRET_SHAPES.some((candidate) => candidate.test(lowered))) fail();
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
  return Object.freeze(Object.fromEntries(EMOTIONS.map((emotion) => [
    emotion,
    safeProviderValue(input[emotion], 64, VOICE_KEY),
  ])));
}

function profileCore(input) {
  const uid = canonicalUid(input.uid);
  const parentUid = canonicalUid(input.parentUid, true);
  if (parentUid === uid) fail();
  if (!PROVIDERS.includes(input.provider)) fail();
  if (input.sourceKind !== 'provider-preset' || !isCredentialReference(input.credentialRef)) fail();
  if (input.status !== 'ready' || !EMOTIONS.includes(input.defaultEmotion)) fail();
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
    credentialRef: input.credentialRef,
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

function createVoiceProfileDraft(value) {
  const input = ownDataSnapshot(value, [
    'schemaVersion', 'uid', 'dramaUid', 'characterUid', 'characterVoiceVersionUid',
    'parentUid', 'revision', 'provider', 'model', 'voiceKey', 'credentialRef',
    'sourceKind', 'status', 'defaultEmotion', 'emotionMap', 'minimumSpeedPermille',
    'defaultSpeedPermille', 'maximumSpeedPermille', 'createdAtEpochMs',
  ]);
  if (input.schemaVersion !== '8.0') fail();
  return Object.freeze(profileCore(input));
}

function createVoiceProfileRecord(value) {
  const input = ownDataSnapshot(value, [
    'schemaVersion', 'uid', 'dramaUid', 'characterUid', 'characterVoiceVersionUid',
    'parentUid', 'revision', 'provider', 'model', 'voiceKey', 'credentialRef',
    'sourceKind', 'status', 'defaultEmotion', 'emotionMap', 'minimumSpeedPermille',
    'defaultSpeedPermille', 'maximumSpeedPermille', 'voiceVersion', 'createdAtEpochMs',
  ]);
  if (input.schemaVersion !== '8.0') fail();
  const core = profileCore(input);
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

function createVoiceProfilePublicRecord(value) {
  const record = createVoiceProfileRecord(value);
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
};
