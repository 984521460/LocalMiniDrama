'use strict';

const { createAssetVersionEvidence } = require('../assets/assetVersionEvidence');
const { sha256Canonical } = require('../h3/contract');
const { validateH3GenerationSpec } = require('../h3/generationSpec');
const { validateH3VideoEvidence } = require('../h3/outputValidation');
const { H3_PROFILE } = require('../h3/profile');
const { assertH3WorkflowVerified } = require('../h3/workflowSupport');
const { parseDialogueDeliveryPlan } = require('./dialogueDelivery');
const {
  createVoiceProfilePublicRecord,
  createVoiceProfileRecord,
  parseVoiceProfilePublicRecord,
} = require('./voiceProfile');
const {
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
} = require('./audioContract');

const MODES = Object.freeze(['independent_tts', 'h3_native', 'hybrid']);
const INPUT_CODE = 'AUDIO_MODE_INPUT_INVALID';
const DATA_CODE = 'AUDIO_MODE_DATA_INVALID';
const TTS_CODE = 'AUDIO_TTS_NOT_CONFIGURED';
const H3_CODE = 'AUDIO_H3_NATIVE_UNAVAILABLE';
const MAX_DIALOGUES = 1000;
const TRUSTED_PLANS = new WeakSet();
const TRUSTED_ENVELOPE_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'dramaUid', 'workflowRunUid', 'mode',
  'dialogueDeliveries', 'voiceProfiles', 'h3GenerationSource', 'createdAtEpochMs',
]);
const PLAN_INPUT_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'dramaUid', 'workflowRunUid', 'mode',
  'dialogueDeliveries', 'voiceProfiles', 'h3GenerationSource', 'createdAtEpochMs',
]);
const PLAN_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'dramaUid', 'workflowRunUid', 'mode',
  'dialogueBindings', 'ttsRequests', 'h3NativeSource', 'planSha256', 'createdAtEpochMs',
]);
const BINDING_KEYS = Object.freeze([
  'dialogueDelivery', 'dialogueDeliveryUid', 'characterUid', 'voiceProfileUid',
  'textSha256', 'timingSha256', 'estimatedTotalDurationMs',
]);
const REQUEST_KEYS = Object.freeze([
  'dialogueDeliveryUid', 'voiceProfileUid', 'voiceProfile', 'provider', 'model',
  'voiceKey', 'providerEmotion', 'text', 'textSha256', 'timingSha256',
  'emotionIntensityPermille', 'speedPermille', 'requestSha256',
]);
const H3_INPUT_KEYS = Object.freeze([
  'generationHistoryUid', 'generationSpec', 'videoEvidence', 'videoAsset',
  'videoVersionEvidence',
]);
const H3_SOURCE_KEYS = Object.freeze([
  'generationHistoryUid', 'generationSpec', 'videoEvidence',
  'generationSpecSha256', 'videoEvidenceSha256', 'videoAsset',
  'videoVersionEvidence', 'audioCodec', 'audioStreams', 'durationMs', 'sourceSha256',
]);
const MODEL = /^[a-z0-9][a-z0-9._/-]*$/u;
const VOICE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;
const DEFINE_PROPERTY = Object.defineProperty;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const MAP_SIZE = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
const REGEXP_TEST = RegExp.prototype.test;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const SET_SIZE = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
const STRING_CODE_POINT_AT = String.prototype.codePointAt;
const STRING_NORMALIZE = String.prototype.normalize;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const STRING_TRIM = String.prototype.trim;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;

function append(target, value) {
  Reflect.apply(DEFINE_PROPERTY, Object, [target, String(target.length), {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  }]);
}

function includes(values, expected) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function mapValues(values, mapper) {
  const output = [];
  for (let index = 0; index < values.length; index += 1) {
    append(output, mapper(values[index], index));
  }
  return output;
}

function safeText(value, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096
    || value !== Reflect.apply(STRING_TRIM, value, [])
    || Reflect.apply(STRING_NORMALIZE, value, ['NFC']) !== value
    || Reflect.apply(REGEXP_TEST, FORBIDDEN_TEXT, [value])
    || Buffer.byteLength(value, 'utf8') > 4096) fail(code);
  let points = 0;
  for (let index = 0; index < value.length;) {
    const point = Reflect.apply(STRING_CODE_POINT_AT, value, [index]);
    index += point > 0xffff ? 2 : 1;
    points += 1;
    if (points > 1024) fail(code);
  }
  return value;
}

function safeProviderText(value, maximum, pattern, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || value !== Reflect.apply(STRING_TRIM, value, [])
    || !Reflect.apply(REGEXP_TEST, pattern, [value])) fail(code);
  const lowered = Reflect.apply(STRING_TO_LOWER_CASE, value, []);
  if (Reflect.apply(
    REGEXP_TEST,
    /^(?:bearer\s|sk-[a-z0-9]{8}|akia[a-z0-9]{12}|-----begin\s)/u,
    [lowered],
  )) fail(code);
  return value;
}

function bindingFromDelivery(delivery) {
  return Object.freeze({
    dialogueDelivery: delivery,
    dialogueDeliveryUid: delivery.uid,
    characterUid: delivery.characterUid,
    voiceProfileUid: delivery.voiceProfileUid,
    textSha256: delivery.textSha256,
    timingSha256: delivery.timingSha256,
    estimatedTotalDurationMs: delivery.estimatedTotalDurationMs,
  });
}

function parseBinding(value, code) {
  const input = exactObject(value, BINDING_KEYS, code);
  let dialogueDelivery;
  try {
    dialogueDelivery = parseDialogueDeliveryPlan(input.dialogueDelivery);
  } catch {
    return fail(code);
  }
  const canonical = bindingFromDelivery(dialogueDelivery);
  if (canonical.dialogueDeliveryUid !== input.dialogueDeliveryUid
    || canonical.characterUid !== input.characterUid
    || canonical.voiceProfileUid !== input.voiceProfileUid
    || canonical.textSha256 !== input.textSha256
    || canonical.timingSha256 !== input.timingSha256
    || canonical.estimatedTotalDurationMs !== input.estimatedTotalDurationMs) fail(code);
  return canonical;
}

function ttsRequest(delivery, profile) {
  const base = Object.freeze({
    dialogueDeliveryUid: delivery.uid,
    voiceProfileUid: profile.uid,
    voiceProfile: createVoiceProfilePublicRecord(profile),
    provider: profile.provider,
    model: profile.model,
    voiceKey: profile.voiceKey,
    providerEmotion: profile.emotionMap[delivery.emotion],
    text: delivery.text,
    textSha256: delivery.textSha256,
    timingSha256: delivery.timingSha256,
    emotionIntensityPermille: delivery.emotionIntensityPermille,
    speedPermille: delivery.speedPermille,
  });
  return Object.freeze({ ...base, requestSha256: canonicalHash(base) });
}

function parseTtsRequest(value, code) {
  const input = exactObject(value, REQUEST_KEYS, code);
  if (input.provider !== 'openai-compatible' && input.provider !== 'minimax') fail(code);
  let voiceProfile;
  try {
    voiceProfile = parseVoiceProfilePublicRecord(input.voiceProfile);
  } catch {
    return fail(code);
  }
  const text = safeText(input.text, code);
  const base = Object.freeze({
    dialogueDeliveryUid: canonicalUid(input.dialogueDeliveryUid, code),
    voiceProfileUid: canonicalUid(input.voiceProfileUid, code),
    voiceProfile,
    provider: input.provider,
    model: safeProviderText(input.model, 128, MODEL, code),
    voiceKey: safeProviderText(input.voiceKey, 128, VOICE_KEY, code),
    providerEmotion: safeProviderText(input.providerEmotion, 64, VOICE_KEY, code),
    text,
    textSha256: sha256(input.textSha256, code),
    timingSha256: sha256(input.timingSha256, code),
    emotionIntensityPermille: boundedInteger(input.emotionIntensityPermille, 0, 1000, code),
    speedPermille: boundedInteger(input.speedPermille, 500, 2000, code),
  });
  if (base.voiceProfileUid !== voiceProfile.uid
    || base.provider !== voiceProfile.provider || base.model !== voiceProfile.model
    || base.voiceKey !== voiceProfile.voiceKey
    || base.speedPermille < voiceProfile.minimumSpeedPermille
    || base.speedPermille > voiceProfile.maximumSpeedPermille
    || textHash(text) !== base.textSha256 || canonicalHash(base) !== input.requestSha256) fail(code);
  return Object.freeze({ ...base, requestSha256: input.requestSha256 });
}

function validatedH3Source(value, expectedDramaUid) {
  try {
    const input = exactObject(value, H3_INPUT_KEYS, H3_CODE);
    const generationSpec = validateH3GenerationSpec(input.generationSpec);
    assertH3WorkflowVerified(generationSpec);
    const videoEvidence = validateH3VideoEvidence({
      generationSpec,
      evidence: input.videoEvidence,
    });
    const version = createAssetVersionEvidence(input.videoVersionEvidence);
    const videoAsset = assetEvidence(input.videoAsset, {
      uid: version.assetUid,
      ownerUid: expectedDramaUid,
      assetType: 'video',
      currentVersionUid: version.uid,
    }, H3_CODE);
    if (generationSpec.prompt.dramaUid !== expectedDramaUid
      || version.sha256 === null || version.mimeType !== 'video/mp4'
      || version.width !== videoEvidence.width || version.height !== videoEvidence.height
      || version.durationMs !== videoEvidence.durationMs || version.sha256 !== videoEvidence.sha256
      || Date.parse(version.createdAt) < Date.parse(videoAsset.createdAt)
      || Date.parse(videoAsset.updatedAt) < Date.parse(version.createdAt)) fail(H3_CODE);
    const base = Object.freeze({
      generationHistoryUid: canonicalUid(input.generationHistoryUid, H3_CODE),
      generationSpec,
      videoEvidence,
      generationSpecSha256: videoEvidence.generationSpecSha256,
      videoEvidenceSha256: sha256Canonical(videoEvidence),
      videoAsset,
      videoVersionEvidence: version,
      audioCodec: videoEvidence.audioCodec,
      audioStreams: videoEvidence.audioStreams,
      durationMs: videoEvidence.durationMs,
    });
    return Object.freeze({ ...base, sourceSha256: canonicalHash(base) });
  } catch {
    return fail(H3_CODE);
  }
}

function parseH3Source(value, code, expectedDramaUid) {
  try {
    const input = exactObject(value, H3_SOURCE_KEYS, code);
    const generationSpec = validateH3GenerationSpec(input.generationSpec);
    assertH3WorkflowVerified(generationSpec);
    const videoEvidence = validateH3VideoEvidence({
      generationSpec,
      evidence: input.videoEvidence,
    });
    const version = createAssetVersionEvidence(input.videoVersionEvidence);
    const videoAsset = assetEvidence(input.videoAsset, {
      uid: version.assetUid,
      ownerUid: expectedDramaUid,
      assetType: 'video',
      currentVersionUid: version.uid,
    }, code);
    const base = Object.freeze({
      generationHistoryUid: canonicalUid(input.generationHistoryUid, code),
      generationSpec,
      videoEvidence,
      generationSpecSha256: sha256(input.generationSpecSha256, code),
      videoEvidenceSha256: sha256(input.videoEvidenceSha256, code),
      videoAsset,
      videoVersionEvidence: version,
      audioCodec: input.audioCodec,
      audioStreams: input.audioStreams,
      durationMs: input.durationMs,
    });
    if (generationSpec.prompt.dramaUid !== expectedDramaUid
      || base.generationSpecSha256 !== videoEvidence.generationSpecSha256
      || base.videoEvidenceSha256 !== sha256Canonical(videoEvidence)
      || base.audioCodec !== videoEvidence.audioCodec
      || base.audioStreams !== videoEvidence.audioStreams
      || base.durationMs !== videoEvidence.durationMs
      || base.audioCodec !== 'aac' || base.audioStreams !== 1
      || !Number.isSafeInteger(base.durationMs) || base.durationMs < 1
      || base.durationMs > 20_000 || version.sha256 === null
      || version.mimeType !== 'video/mp4' || version.width === null || version.height === null
      || version.sha256 !== videoEvidence.sha256
      || version.width !== videoEvidence.width || version.height !== videoEvidence.height
      || version.width % H3_PROFILE.canvas.multipleOf !== 0
      || version.height % H3_PROFILE.canvas.multipleOf !== 0
      || Math.max(version.width, version.height) > H3_PROFILE.canvas.maximumLongEdge
      || Math.min(version.width, version.height) > H3_PROFILE.canvas.maximumShortEdge
      || version.width * version.height > H3_PROFILE.canvas.maximumPixels
      || Date.parse(version.createdAt) < Date.parse(videoAsset.createdAt)
      || Date.parse(videoAsset.updatedAt) < Date.parse(version.createdAt)
      || version.durationMs !== base.durationMs || canonicalHash(base) !== input.sourceSha256) fail(code);
    return Object.freeze({ ...base, sourceSha256: input.sourceSha256 });
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(code);
  }
}

function planRecord(input) {
  const base = Object.freeze({
    schemaVersion: '8.0',
    uid: input.uid,
    dramaUid: input.dramaUid,
    workflowRunUid: input.workflowRunUid,
    mode: input.mode,
    dialogueBindings: input.dialogueBindings,
    ttsRequests: input.ttsRequests,
    h3NativeSource: input.h3NativeSource,
    createdAtEpochMs: input.createdAtEpochMs,
  });
  return Object.freeze({
    schemaVersion: base.schemaVersion,
    uid: base.uid,
    dramaUid: base.dramaUid,
    workflowRunUid: base.workflowRunUid,
    mode: base.mode,
    dialogueBindings: base.dialogueBindings,
    ttsRequests: base.ttsRequests,
    h3NativeSource: base.h3NativeSource,
    planSha256: canonicalHash(base),
    createdAtEpochMs: base.createdAtEpochMs,
  });
}

function trustedPlan(value) {
  Reflect.apply(WEAK_SET_ADD, TRUSTED_PLANS, [value]);
  return value;
}

function createAudioModePlan(value) {
  try {
    const input = exactObject(value, PLAN_INPUT_KEYS, INPUT_CODE);
    if (input.schemaVersion !== '8.0' || !includes(MODES, input.mode)) fail(INPUT_CODE);
    const uid = canonicalUid(input.uid, INPUT_CODE);
    const dramaUid = canonicalUid(input.dramaUid, INPUT_CODE);
    const workflowRunUid = canonicalUid(input.workflowRunUid, INPUT_CODE);
    const deliveryInputs = denseArray(input.dialogueDeliveries, MAX_DIALOGUES, INPUT_CODE);
    const deliveries = mapValues(deliveryInputs, (delivery) => parseDialogueDeliveryPlan(delivery));
    if (deliveries.length < 1) fail(INPUT_CODE);
    const deliveryUids = new Set();
    for (let index = 0; index < deliveries.length; index += 1) {
      if (deliveries[index].dramaUid !== dramaUid
        || Reflect.apply(SET_HAS, deliveryUids, [deliveries[index].uid])) fail(INPUT_CODE);
      Reflect.apply(SET_ADD, deliveryUids, [deliveries[index].uid]);
    }
    const dialogueBindings = frozenArray(mapValues(deliveries, bindingFromDelivery));

    let ttsRequests = frozenArray([]);
    const profileInputs = denseArray(input.voiceProfiles, MAX_DIALOGUES, INPUT_CODE);
    if (input.mode === 'h3_native') {
      if (profileInputs.length !== 0) fail(INPUT_CODE);
    } else {
      const profiles = [];
      try {
        for (let index = 0; index < profileInputs.length; index += 1) {
          append(profiles, createVoiceProfileRecord(profileInputs[index]));
        }
      } catch {
        fail(TTS_CODE);
      }
      const profileMap = new Map();
      for (let index = 0; index < profiles.length; index += 1) {
        if (Reflect.apply(MAP_GET, profileMap, [profiles[index].uid]) !== undefined) fail(TTS_CODE);
        Reflect.apply(MAP_SET, profileMap, [profiles[index].uid, profiles[index]]);
      }
      const referencedProfiles = new Set();
      for (let index = 0; index < deliveries.length; index += 1) {
        Reflect.apply(SET_ADD, referencedProfiles, [deliveries[index].voiceProfileUid]);
      }
      if (Reflect.apply(MAP_SIZE, profileMap, []) !== profiles.length
        || Reflect.apply(MAP_SIZE, profileMap, [])
          !== Reflect.apply(SET_SIZE, referencedProfiles, [])) fail(TTS_CODE);
      ttsRequests = frozenArray(mapValues(deliveries, (delivery) => {
        const profile = Reflect.apply(MAP_GET, profileMap, [delivery.voiceProfileUid]);
        if (!profile || profile.dramaUid !== dramaUid || profile.characterUid !== delivery.characterUid
          || delivery.speedPermille < profile.minimumSpeedPermille
          || delivery.speedPermille > profile.maximumSpeedPermille) fail(TTS_CODE);
        return ttsRequest(delivery, profile);
      }));
    }

    let h3NativeSource = null;
    if (input.mode === 'independent_tts') {
      if (input.h3GenerationSource !== null) fail(INPUT_CODE);
    } else {
      if (input.h3GenerationSource === null) fail(H3_CODE);
      h3NativeSource = validatedH3Source(input.h3GenerationSource, dramaUid);
    }

    return planRecord({
      uid,
      dramaUid,
      workflowRunUid,
      mode: input.mode,
      dialogueBindings,
      ttsRequests,
      h3NativeSource,
      createdAtEpochMs: epoch(input.createdAtEpochMs, INPUT_CODE),
    });
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(INPUT_CODE);
  }
}

function parseAudioModePlanRecord(value) {
  try {
    const input = exactObject(value, PLAN_KEYS, DATA_CODE);
    if (input.schemaVersion !== '8.0' || !includes(MODES, input.mode)) fail(DATA_CODE);
    const uid = canonicalUid(input.uid, DATA_CODE);
    const dramaUid = canonicalUid(input.dramaUid, DATA_CODE);
    const workflowRunUid = canonicalUid(input.workflowRunUid, DATA_CODE);
    const bindingInputs = denseArray(input.dialogueBindings, MAX_DIALOGUES, DATA_CODE);
    const bindings = mapValues(bindingInputs, (binding) => parseBinding(binding, DATA_CODE));
    const bindingUids = new Set();
    for (let index = 0; index < bindings.length; index += 1) {
      if (Reflect.apply(SET_HAS, bindingUids, [bindings[index].dialogueDeliveryUid])) fail(DATA_CODE);
      Reflect.apply(SET_ADD, bindingUids, [bindings[index].dialogueDeliveryUid]);
    }
    if (bindings.length < 1) fail(DATA_CODE);
    const requestInputs = denseArray(input.ttsRequests, MAX_DIALOGUES, DATA_CODE);
    const requests = mapValues(requestInputs, (request) => parseTtsRequest(request, DATA_CODE));
    const needsTts = input.mode !== 'h3_native';
    const needsH3 = input.mode !== 'independent_tts';
    if ((needsTts && requests.length !== bindings.length) || (!needsTts && requests.length !== 0)) fail(DATA_CODE);
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      const binding = bindings[index];
      if (request.dialogueDeliveryUid !== binding.dialogueDeliveryUid
        || request.voiceProfileUid !== binding.voiceProfileUid
        || request.voiceProfile.dramaUid !== dramaUid
        || request.voiceProfile.characterUid !== binding.characterUid
        || request.providerEmotion
          !== request.voiceProfile.emotionMap[binding.dialogueDelivery.emotion]
        || request.text !== binding.dialogueDelivery.text
        || request.emotionIntensityPermille
          !== binding.dialogueDelivery.emotionIntensityPermille
        || request.speedPermille !== binding.dialogueDelivery.speedPermille
        || request.textSha256 !== binding.textSha256
        || request.timingSha256 !== binding.timingSha256) fail(DATA_CODE);
    }
    if ((needsH3 && input.h3NativeSource === null)
      || (!needsH3 && input.h3NativeSource !== null)) fail(DATA_CODE);
    const h3NativeSource = needsH3
      ? parseH3Source(input.h3NativeSource, DATA_CODE, dramaUid)
      : null;
    const canonical = planRecord({
      uid,
      dramaUid,
      workflowRunUid,
      mode: input.mode,
      dialogueBindings: frozenArray(bindings),
      ttsRequests: frozenArray(requests),
      h3NativeSource,
      createdAtEpochMs: epoch(input.createdAtEpochMs, DATA_CODE),
    });
    if (canonical.planSha256 !== input.planSha256) fail(DATA_CODE);
    return canonical;
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(DATA_CODE);
  }
}

function parseAudioTtsRequestRecord(value) {
  return parseTtsRequest(value, DATA_CODE);
}

function parseAudioModePlanAgainstEnvelope(value, expectedEnvelope, expectedPlanUid) {
  try {
    const stored = parseAudioModePlanRecord(value);
    const envelope = exactObject(expectedEnvelope, TRUSTED_ENVELOPE_KEYS, DATA_CODE);
    if (envelope.uid !== expectedPlanUid) fail(DATA_CODE);
    const expected = createAudioModePlan(envelope);
    if (canonicalHash(stored) !== canonicalHash(expected)) fail(DATA_CODE);
    return trustedPlan(expected);
  } catch (error) {
    if (isAudioModeContractError(error) && error.code === DATA_CODE) throw error;
    return fail(DATA_CODE);
  }
}

function createAudioModePlanVerifier(value) {
  const dependencies = exactObject(value, ['loadTrustedEnvelope'], INPUT_CODE);
  if (typeof dependencies.loadTrustedEnvelope !== 'function') fail(INPUT_CODE);
  const loadTrustedEnvelope = dependencies.loadTrustedEnvelope;
  return Object.freeze({
    verify(planValue, expectedPlanUid) {
      let stored;
      let envelope;
      let anchorUid;
      try {
        anchorUid = canonicalUid(expectedPlanUid, DATA_CODE);
        stored = parseAudioModePlanRecord(planValue);
        envelope = loadTrustedEnvelope(anchorUid);
      } catch {
        return fail(DATA_CODE);
      }
      return parseAudioModePlanAgainstEnvelope(stored, envelope, anchorUid);
    },
  });
}

function requireTrustedAudioModePlan(value) {
  if ((typeof value === 'object' || typeof value === 'function')
    && value !== null && Reflect.apply(WEAK_SET_HAS, TRUSTED_PLANS, [value])) return value;
  return fail(DATA_CODE);
}

function parseH3NativeSourceEvidence(value, expectedDramaUid) {
  return parseH3Source(value, DATA_CODE, canonicalUid(expectedDramaUid, DATA_CODE));
}

function assertAudioModeExecutionReady(planValue, value) {
  try {
    const plan = requireTrustedAudioModePlan(planValue);
    const availability = exactObject(
      value,
      ['ttsProviderConfigured', 'h3NativeAvailable'],
      INPUT_CODE,
    );
    if (typeof availability.ttsProviderConfigured !== 'boolean'
      || typeof availability.h3NativeAvailable !== 'boolean') fail(INPUT_CODE);
    if (plan.mode !== 'h3_native' && !availability.ttsProviderConfigured) fail(TTS_CODE);
    if (plan.mode !== 'independent_tts' && !availability.h3NativeAvailable) fail(H3_CODE);
    return plan;
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(INPUT_CODE);
  }
}

module.exports = Object.freeze({
  AUDIO_MODES: MODES,
  AudioModeContractError,
  assertAudioModeExecutionReady,
  createAudioModePlan,
  createAudioModePlanVerifier,
  parseAudioModePlanRecord,
  parseAudioTtsRequestRecord,
  parseH3NativeSourceEvidence,
  requireTrustedAudioModePlan,
});
