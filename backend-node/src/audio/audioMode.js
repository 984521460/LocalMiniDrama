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

function safeText(value, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096
    || value !== value.trim() || value.normalize('NFC') !== value
    || FORBIDDEN_TEXT.test(value) || Buffer.byteLength(value, 'utf8') > 4096) fail(code);
  let points = 0;
  for (const _point of value) {
    points += 1;
    if (points > 1024) fail(code);
  }
  return value;
}

function safeProviderText(value, maximum, pattern, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || value !== value.trim() || !pattern.test(value)) fail(code);
  const lowered = value.toLowerCase();
  if (/^(?:bearer\s|sk-[a-z0-9]{8}|akia[a-z0-9]{12}|-----begin\s)/u.test(lowered)) fail(code);
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
  if (!['openai-compatible', 'minimax'].includes(input.provider)) fail(code);
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
  TRUSTED_PLANS.add(value);
  return value;
}

function createAudioModePlan(value) {
  try {
    const input = exactObject(value, PLAN_INPUT_KEYS, INPUT_CODE);
    if (input.schemaVersion !== '8.0' || !MODES.includes(input.mode)) fail(INPUT_CODE);
    const uid = canonicalUid(input.uid, INPUT_CODE);
    const dramaUid = canonicalUid(input.dramaUid, INPUT_CODE);
    const workflowRunUid = canonicalUid(input.workflowRunUid, INPUT_CODE);
    const deliveries = denseArray(input.dialogueDeliveries, MAX_DIALOGUES, INPUT_CODE)
      .map((delivery) => parseDialogueDeliveryPlan(delivery));
    if (deliveries.length < 1 || deliveries.some((delivery) => delivery.dramaUid !== dramaUid)) fail(INPUT_CODE);
    const deliveryUids = new Set(deliveries.map((delivery) => delivery.uid));
    if (deliveryUids.size !== deliveries.length) fail(INPUT_CODE);
    const dialogueBindings = frozenArray(deliveries.map(bindingFromDelivery));

    let ttsRequests = frozenArray([]);
    const profileInputs = denseArray(input.voiceProfiles, MAX_DIALOGUES, INPUT_CODE);
    if (input.mode === 'h3_native') {
      if (profileInputs.length !== 0) fail(INPUT_CODE);
    } else {
      const profiles = [];
      try {
        for (const profile of profileInputs) profiles.push(createVoiceProfileRecord(profile));
      } catch {
        fail(TTS_CODE);
      }
      const profileMap = new Map(profiles.map((profile) => [profile.uid, profile]));
      const referencedProfiles = new Set(deliveries.map((delivery) => delivery.voiceProfileUid));
      if (profileMap.size !== profiles.length || profileMap.size !== referencedProfiles.size
        || [...profileMap.keys()].some((profileUid) => !referencedProfiles.has(profileUid))) fail(TTS_CODE);
      ttsRequests = frozenArray(deliveries.map((delivery) => {
        const profile = profileMap.get(delivery.voiceProfileUid);
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
    if (input.schemaVersion !== '8.0' || !MODES.includes(input.mode)) fail(DATA_CODE);
    const uid = canonicalUid(input.uid, DATA_CODE);
    const dramaUid = canonicalUid(input.dramaUid, DATA_CODE);
    const workflowRunUid = canonicalUid(input.workflowRunUid, DATA_CODE);
    const bindings = denseArray(input.dialogueBindings, MAX_DIALOGUES, DATA_CODE)
      .map((binding) => parseBinding(binding, DATA_CODE));
    if (bindings.length < 1
      || new Set(bindings.map((binding) => binding.dialogueDeliveryUid)).size !== bindings.length) fail(DATA_CODE);
    const requests = denseArray(input.ttsRequests, MAX_DIALOGUES, DATA_CODE)
      .map((request) => parseTtsRequest(request, DATA_CODE));
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
    && value !== null && TRUSTED_PLANS.has(value)) return value;
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
  parseH3NativeSourceEvidence,
  requireTrustedAudioModePlan,
});
