'use strict';

const { createAssetVersionEvidence } = require('../assets/assetVersionEvidence');
const {
  canonicalHash,
  canonicalUid,
  denseArray,
  epoch,
  exactObject,
  fail,
  frozenArray,
  isAudioModeContractError,
  sha256,
  assetEvidence,
} = require('./audioContract');
const { requireTrustedAudioModePlan, parseH3NativeSourceEvidence } = require('./audioMode');

const CODE = 'AUDIO_EXECUTION_EVIDENCE_INVALID';
const MAX_OUTPUTS = 1000;
const AUDIO_MIME_TYPES = Object.freeze(new Set([
  'audio/aac', 'audio/flac', 'audio/mpeg', 'audio/wav', 'audio/x-wav',
]));
const INPUT_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'plan', 'ttsOutputs', 'createdAtEpochMs',
]);
const RECORD_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'planUid', 'planSha256', 'mode', 'h3NativeSource',
  'ttsOutputs', 'executionSha256', 'createdAtEpochMs',
]);
const OUTPUT_KEYS = Object.freeze([
  'dialogueDeliveryUid', 'requestSha256', 'audioAsset', 'audioVersionEvidence',
]);

function audioOutput(value, expectedDramaUid) {
  try {
    const input = exactObject(value, OUTPUT_KEYS, CODE);
    const evidence = createAssetVersionEvidence(input.audioVersionEvidence);
    const audioAsset = assetEvidence(input.audioAsset, {
      uid: evidence.assetUid,
      ownerUid: expectedDramaUid,
      assetType: 'audio',
      currentVersionUid: evidence.uid,
    }, CODE);
    if (evidence.sha256 === null || !AUDIO_MIME_TYPES.has(evidence.mimeType)
      || evidence.width !== null || evidence.height !== null
      || !Number.isSafeInteger(evidence.durationMs) || evidence.durationMs < 1
      || evidence.durationMs > 600_000
      || Date.parse(evidence.createdAt) < Date.parse(audioAsset.createdAt)
      || Date.parse(audioAsset.updatedAt) < Date.parse(evidence.createdAt)) fail(CODE);
    return Object.freeze({
      dialogueDeliveryUid: canonicalUid(input.dialogueDeliveryUid, CODE),
      requestSha256: sha256(input.requestSha256, CODE),
      audioAsset,
      audioVersionEvidence: evidence,
    });
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(CODE);
  }
}

function validateOutputs(values, plan) {
  const outputs = denseArray(values, MAX_OUTPUTS, CODE)
    .map((value) => audioOutput(value, plan.dramaUid));
  if (outputs.length !== plan.ttsRequests.length) fail(CODE);
  const versionUids = new Set();
  const assetUids = new Set();
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index];
    const request = plan.ttsRequests[index];
    if (output.dialogueDeliveryUid !== request.dialogueDeliveryUid
      || output.requestSha256 !== request.requestSha256
      || versionUids.has(output.audioVersionEvidence.uid)
      || assetUids.has(output.audioVersionEvidence.assetUid)) fail(CODE);
    versionUids.add(output.audioVersionEvidence.uid);
    assetUids.add(output.audioVersionEvidence.assetUid);
  }
  if (plan.h3NativeSource !== null
    && (versionUids.has(plan.h3NativeSource.videoVersionEvidence.uid)
      || assetUids.has(plan.h3NativeSource.videoAsset.uid))) fail(CODE);
  return frozenArray(outputs);
}

function record(input) {
  const base = Object.freeze({
    schemaVersion: '8.0',
    uid: input.uid,
    planUid: input.plan.uid,
    planSha256: input.plan.planSha256,
    mode: input.plan.mode,
    h3NativeSource: input.plan.h3NativeSource,
    ttsOutputs: input.ttsOutputs,
    createdAtEpochMs: input.createdAtEpochMs,
  });
  return Object.freeze({
    schemaVersion: base.schemaVersion,
    uid: base.uid,
    planUid: base.planUid,
    planSha256: base.planSha256,
    mode: base.mode,
    h3NativeSource: base.h3NativeSource,
    ttsOutputs: base.ttsOutputs,
    executionSha256: canonicalHash(base),
    createdAtEpochMs: base.createdAtEpochMs,
  });
}

function safePlan(value) {
  try {
    return requireTrustedAudioModePlan(value);
  } catch {
    return fail(CODE);
  }
}

function createAudioExecutionEvidence(value) {
  try {
    const input = exactObject(value, INPUT_KEYS, CODE);
    if (input.schemaVersion !== '8.0') fail(CODE);
    const plan = safePlan(input.plan);
    return record({
      uid: canonicalUid(input.uid, CODE),
      plan,
      ttsOutputs: validateOutputs(input.ttsOutputs, plan),
      createdAtEpochMs: epoch(input.createdAtEpochMs, CODE),
    });
  } catch (error) {
    if (isAudioModeContractError(error) && error.code === CODE) throw error;
    return fail(CODE);
  }
}

function parseAudioExecutionEvidence(value, expectedPlan) {
  try {
    const input = exactObject(value, RECORD_KEYS, CODE);
    if (input.schemaVersion !== '8.0') fail(CODE);
    const plan = safePlan(expectedPlan);
    let h3NativeSource = null;
    if (plan.h3NativeSource === null) {
      if (input.h3NativeSource !== null) fail(CODE);
    } else {
      try {
        h3NativeSource = parseH3NativeSourceEvidence(input.h3NativeSource, plan.dramaUid);
      } catch {
        return fail(CODE);
      }
      if (canonicalHash(h3NativeSource) !== canonicalHash(plan.h3NativeSource)) fail(CODE);
    }
    if (input.planUid !== plan.uid || input.planSha256 !== plan.planSha256
      || input.mode !== plan.mode) fail(CODE);
    const canonical = record({
      uid: canonicalUid(input.uid, CODE),
      plan,
      ttsOutputs: validateOutputs(input.ttsOutputs, plan),
      createdAtEpochMs: epoch(input.createdAtEpochMs, CODE),
    });
    if (canonical.executionSha256 !== input.executionSha256) fail(CODE);
    return canonical;
  } catch (error) {
    if (isAudioModeContractError(error) && error.code === CODE) throw error;
    return fail(CODE);
  }
}

module.exports = Object.freeze({
  createAudioExecutionEvidence,
  parseAudioExecutionEvidence,
});
