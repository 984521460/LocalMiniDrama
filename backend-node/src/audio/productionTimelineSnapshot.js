'use strict';

const { types: { isProxy } } = require('node:util');

const {
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
} = require('./audioContract');
const {
  assetVersionEvidenceMatches,
  createAssetVersionEvidence,
} = require('../assets/assetVersionEvidence');
const { createGenerationHistoryRecord } = require('../assets/generationHistory');
const { parseH3LocalExecutionResult } = require('../h3/localExecutionService');
const {
  parseAudioTimelineRecord,
  requireTrustedAudioTimeline,
} = require('./audioTimeline');
const {
  parseAudioMixPlanRecord,
  requireTrustedAudioMixPlan,
} = require('./audioMixPlan');
const {
  assertBgmTrackExportReady,
  parseBgmTrack,
} = require('./bgmTrack');
const { parseSubtitleTrack } = require('./subtitleTrack');

const PRODUCTION_TIMELINE_ALGORITHM_VERSION = 'production-timeline-ms.v1';
const INPUT_CODE = 'PRODUCTION_TIMELINE_INPUT_INVALID';
const DATA_CODE = 'PRODUCTION_TIMELINE_DATA_INVALID';
const MAX_ITEMS = 1000;
const MAX_DURATION_MS = 3_600_000;
const SHOT_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const AUDIO_MIME_TYPES = Object.freeze(new Set([
  'audio/aac', 'audio/flac', 'audio/mpeg', 'audio/wav', 'audio/x-wav',
]));
const INPUT_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'audioTimeline', 'audioMixPlan', 'shots',
  'audioSources', 'bgmTrack', 'createdAtEpochMs',
]);
const RECORD_KEYS = Object.freeze([
  'schemaVersion', 'algorithmVersion', 'uid', 'dramaUid', 'workflowRunUid',
  'durationMs', 'shots', 'audioTimeline', 'audioSources', 'subtitleTrack',
  'audioMixPlan', 'bgmTrack', 'snapshotSha256', 'createdAtEpochMs',
]);
const SHOT_INPUT_KEYS = Object.freeze([
  'shotId', 'plannedOrdinal', 'h3ExecutionResult', 'generationHistory', 'asset', 'assetVersion',
]);
const SHOT_RECORD_KEYS = Object.freeze([
  'ordinal', 'shotId', 'plannedOrdinal', 'h3ExecutionResult', 'generationHistory',
  'startMs', 'endMs', 'durationMs', 'asset', 'assetVersion',
]);
const GENERATION_HISTORY_RECORD_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'runUid', 'dramaUid', 'assetUid', 'promptSemanticUid',
  'manifestUid', 'manifestSha256', 'provider', 'model', 'seed', 'parameters',
  'parametersSha256', 'input', 'inputSha256', 'status', 'outputVersionUid',
  'outputVersionEvidence', 'parentVersionUid', 'parentVersionEvidence',
  'errorCode', 'errorDetailRef', 'createdAtEpochMs', 'completedAtEpochMs',
]);
const GENERATION_HISTORY_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'runUid', 'dramaUid', 'assetUid', 'status',
  'outputVersionUid', 'outputVersionEvidence', 'createdAtEpochMs',
  'completedAtEpochMs',
]);
const AUDIO_SOURCE_KEYS = Object.freeze([
  'sourceKind', 'asset', 'assetVersion',
]);
const TRUSTED_SNAPSHOTS = new WeakSet();

function safeTrustedTimeline(value, code) {
  try {
    return requireTrustedAudioTimeline(value);
  } catch {
    return fail(code);
  }
}

function safeTrustedMix(value, code) {
  try {
    return requireTrustedAudioMixPlan(value);
  } catch {
    return fail(code);
  }
}

function safeParsedTimeline(value, code) {
  try {
    return parseAudioTimelineRecord(value);
  } catch {
    return fail(code);
  }
}

function safeParsedMix(value, code) {
  try {
    return parseAudioMixPlanRecord(value);
  } catch {
    return fail(code);
  }
}

function safeBgmTrack(value, code) {
  try {
    return code === INPUT_CODE
      ? assertBgmTrackExportReady(value)
      : parseBgmTrack(value);
  } catch {
    return fail(code);
  }
}

function sourceId(value, code) {
  if (typeof value !== 'string' || !SHOT_ID.test(value)) fail(code);
  return value;
}

function safeVersion(value, code) {
  try {
    return createAssetVersionEvidence(value);
  } catch {
    return fail(code);
  }
}

function safeAsset(value, version, dramaUid, assetType, code) {
  try {
    return assetEvidence(value, {
      uid: version.assetUid,
      ownerUid: dramaUid,
      assetType,
      currentVersionUid: version.uid,
    }, code);
  } catch {
    return fail(code);
  }
}

function videoEvidence(value, dramaUid, code) {
  const version = safeVersion(value.assetVersion, code);
  const asset = safeAsset(value.asset, version, dramaUid, 'video', code);
  if (version.mimeType !== 'video/mp4'
    || typeof version.sha256 !== 'string'
    || !Number.isSafeInteger(version.width) || version.width < 1
    || !Number.isSafeInteger(version.height) || version.height < 1
    || !Number.isSafeInteger(version.durationMs) || version.durationMs < 1
    || version.durationMs > MAX_DURATION_MS) fail(code);
  return Object.freeze({ asset, assetVersion: version });
}

function fullGenerationHistory(value, code) {
  const input = exactObject(value, GENERATION_HISTORY_RECORD_KEYS, code);
  if (input.schemaVersion !== 'generation-history.v1') fail(code);
  let record;
  try {
    record = createGenerationHistoryRecord({
      uid: input.uid,
      runUid: input.runUid,
      dramaUid: input.dramaUid,
      assetUid: input.assetUid,
      promptSemanticUid: input.promptSemanticUid,
      manifestUid: input.manifestUid,
      manifestSha256: input.manifestSha256,
      provider: input.provider,
      model: input.model,
      seed: input.seed,
      parameters: input.parameters,
      input: input.input,
      status: input.status,
      outputVersionUid: input.outputVersionUid,
      outputVersionEvidence: input.outputVersionEvidence,
      parentVersionUid: input.parentVersionUid,
      parentVersionEvidence: input.parentVersionEvidence,
      errorCode: input.errorCode,
      errorDetailRef: input.errorDetailRef,
      createdAtEpochMs: input.createdAtEpochMs,
      completedAtEpochMs: input.completedAtEpochMs,
    }, code);
  } catch {
    return fail(code);
  }
  if (record.parametersSha256 !== input.parametersSha256
    || record.inputSha256 !== input.inputSha256) fail(code);
  return record;
}

function safeH3ExecutionResult(value, code) {
  try {
    return parseH3LocalExecutionResult(value);
  } catch {
    return fail(code);
  }
}

function generationHistoryShotId(history, code) {
  const generationSpec = history.input?.generationSpec;
  const prompt = generationSpec?.prompt;
  if (history.provider !== 'local-comfy' || history.model !== 'MiniMax-H3'
    || !generationSpec || typeof generationSpec !== 'object'
    || !Object.hasOwn(generationSpec, 'prompt')
    || !prompt || typeof prompt !== 'object'
    || !Object.hasOwn(prompt, 'shotId')) fail(code);
  return sourceId(prompt.shotId, code);
}

function generationHistoryEvidence(
  value, asset, version, dramaUid, generationRunUid, createdAtEpochMs, code,
) {
  const input = exactObject(value, GENERATION_HISTORY_EVIDENCE_KEYS, code);
  if (input.schemaVersion !== 'generation-history-output-evidence.v1') fail(code);
  const outputVersionEvidence = safeVersion(input.outputVersionEvidence, code);
  const output = Object.freeze({
    schemaVersion: input.schemaVersion,
    uid: canonicalUid(input.uid, code),
    runUid: canonicalUid(input.runUid, code),
    dramaUid: canonicalUid(input.dramaUid, code),
    assetUid: canonicalUid(input.assetUid, code),
    status: input.status,
    outputVersionUid: canonicalUid(input.outputVersionUid, code),
    outputVersionEvidence,
    createdAtEpochMs: epoch(input.createdAtEpochMs, code),
    completedAtEpochMs: epoch(input.completedAtEpochMs, code),
  });
  if (output.status !== 'succeeded'
    || output.dramaUid !== dramaUid
    || output.runUid !== generationRunUid
    || output.assetUid !== version.assetUid
    || output.outputVersionUid !== version.uid
    || !assetVersionEvidenceMatches(output.outputVersionEvidence, version)
    || output.completedAtEpochMs < output.createdAtEpochMs
    || Date.parse(asset.createdAt) > output.completedAtEpochMs
    || Date.parse(output.outputVersionEvidence.createdAt) > output.completedAtEpochMs
    || output.completedAtEpochMs > createdAtEpochMs) fail(code);
  return output;
}

function generationHistoryEvidenceFromRecord(
  value, asset, version, dramaUid, generationRunUid, createdAtEpochMs, code,
) {
  const record = fullGenerationHistory(value, code);
  return generationHistoryEvidence({
    schemaVersion: 'generation-history-output-evidence.v1',
    uid: record.uid,
    runUid: record.runUid,
    dramaUid: record.dramaUid,
    assetUid: record.assetUid,
    status: record.status,
    outputVersionUid: record.outputVersionUid,
    outputVersionEvidence: record.outputVersionEvidence,
    createdAtEpochMs: record.createdAtEpochMs,
    completedAtEpochMs: record.completedAtEpochMs,
  }, asset, version, dramaUid, generationRunUid, createdAtEpochMs, code);
}

function shotInput(
  value, ordinal, startMs, dramaUid, workflowRunUid, createdAtEpochMs, code,
) {
  const input = exactObject(value, SHOT_INPUT_KEYS, code);
  const evidence = videoEvidence(input, dramaUid, code);
  const h3ExecutionResult = safeH3ExecutionResult(input.h3ExecutionResult, code);
  const history = generationHistoryEvidenceFromRecord(
    input.generationHistory,
    evidence.asset,
    evidence.assetVersion,
    dramaUid,
    h3ExecutionResult.generationRunUid,
    createdAtEpochMs,
    code,
  );
  const durationMs = evidence.assetVersion.durationMs;
  const endMs = startMs + durationMs;
  const shotId = sourceId(input.shotId, code);
  if (endMs > MAX_DURATION_MS
    || h3ExecutionResult.workflowRunUid !== workflowRunUid
    || h3ExecutionResult.historyUid !== history.uid
    || h3ExecutionResult.assetUid !== evidence.asset.uid
    || h3ExecutionResult.assetVersionUid !== evidence.assetVersion.uid
    || generationHistoryShotId(fullGenerationHistory(input.generationHistory, code), code) !== shotId) {
    fail(code);
  }
  return Object.freeze({
    ordinal,
    shotId,
    plannedOrdinal: boundedInteger(input.plannedOrdinal, 1, MAX_ITEMS, code),
    h3ExecutionResult,
    generationHistory: history,
    startMs,
    endMs,
    durationMs,
    asset: evidence.asset,
    assetVersion: evidence.assetVersion,
  });
}

function shotRecord(value, dramaUid, workflowRunUid, durationMs, createdAtEpochMs, code) {
  const input = exactObject(value, SHOT_RECORD_KEYS, code);
  const ordinal = boundedInteger(input.ordinal, 0, MAX_ITEMS - 1, code);
  const startMs = boundedInteger(input.startMs, 0, durationMs, code);
  const endMs = boundedInteger(input.endMs, 1, durationMs, code);
  const clipDurationMs = boundedInteger(input.durationMs, 1, MAX_DURATION_MS, code);
  const evidence = videoEvidence(input, dramaUid, code);
  const h3ExecutionResult = safeH3ExecutionResult(input.h3ExecutionResult, code);
  const history = generationHistoryEvidence(
    input.generationHistory,
    evidence.asset,
    evidence.assetVersion,
    dramaUid,
    h3ExecutionResult.generationRunUid,
    createdAtEpochMs,
    code,
  );
  if (endMs <= startMs || endMs - startMs !== clipDurationMs
    || evidence.assetVersion.durationMs !== clipDurationMs
    || h3ExecutionResult.workflowRunUid !== workflowRunUid
    || h3ExecutionResult.historyUid !== history.uid
    || h3ExecutionResult.assetUid !== evidence.asset.uid
    || h3ExecutionResult.assetVersionUid !== evidence.assetVersion.uid) fail(code);
  return Object.freeze({
    ordinal,
    shotId: sourceId(input.shotId, code),
    plannedOrdinal: boundedInteger(input.plannedOrdinal, 1, MAX_ITEMS, code),
    h3ExecutionResult,
    generationHistory: history,
    startMs,
    endMs,
    durationMs: clipDurationMs,
    asset: evidence.asset,
    assetVersion: evidence.assetVersion,
  });
}

function assertUniqueShots(shots, durationMs, code) {
  const identities = {
    shotId: new Set(),
    plannedOrdinal: new Set(),
    generationHistoryUid: new Set(),
    h3TaskUid: new Set(),
    h3NodeRunUid: new Set(),
    generationRunUid: new Set(),
    assetUid: new Set(),
    assetVersionUid: new Set(),
  };
  let cursor = 0;
  for (let index = 0; index < shots.length; index += 1) {
    const shot = shots[index];
    if (shot.ordinal !== index || shot.startMs !== cursor
      || identities.shotId.has(shot.shotId)
      || identities.plannedOrdinal.has(shot.plannedOrdinal)
      || identities.generationHistoryUid.has(shot.generationHistory.uid)
      || identities.h3TaskUid.has(shot.h3ExecutionResult.taskUid)
      || identities.h3NodeRunUid.has(shot.h3ExecutionResult.nodeRunUid)
      || identities.generationRunUid.has(shot.h3ExecutionResult.generationRunUid)
      || identities.assetUid.has(shot.asset.uid)
      || identities.assetVersionUid.has(shot.assetVersion.uid)) fail(code);
    identities.shotId.add(shot.shotId);
    identities.plannedOrdinal.add(shot.plannedOrdinal);
    identities.generationHistoryUid.add(shot.generationHistory.uid);
    identities.h3TaskUid.add(shot.h3ExecutionResult.taskUid);
    identities.h3NodeRunUid.add(shot.h3ExecutionResult.nodeRunUid);
    identities.generationRunUid.add(shot.h3ExecutionResult.generationRunUid);
    identities.assetUid.add(shot.asset.uid);
    identities.assetVersionUid.add(shot.assetVersion.uid);
    cursor = shot.endMs;
  }
  for (let ordinal = 1; ordinal <= shots.length; ordinal += 1) {
    if (!identities.plannedOrdinal.has(ordinal)) fail(code);
  }
  if (cursor !== durationMs) fail(code);
}

function assetEvidenceMatches(left, right) {
  return left.uid === right.uid
    && left.ownerType === right.ownerType
    && left.ownerUid === right.ownerUid
    && left.assetType === right.assetType
    && left.currentVersionUid === right.currentVersionUid
    && left.status === right.status
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function assertGlobalMediaIdentities(shots, sources, track, dramaUid, createdAtEpochMs, code) {
  const assets = new Map();
  const versions = new Map();

  function register(asset, version) {
    if (Date.parse(asset.createdAt) > createdAtEpochMs
      || Date.parse(asset.updatedAt) > createdAtEpochMs
      || Date.parse(version.createdAt) > createdAtEpochMs) fail(code);
    const existingAsset = assets.get(asset.uid);
    if (existingAsset && !assetEvidenceMatches(existingAsset, asset)) fail(code);
    const existingVersion = versions.get(version.uid);
    if (existingVersion && !assetVersionEvidenceMatches(existingVersion, version)) fail(code);
    if (version.assetUid !== asset.uid) fail(code);
    assets.set(asset.uid, asset);
    versions.set(version.uid, version);
  }

  for (const shot of shots) register(shot.asset, shot.assetVersion);
  for (const source of sources) register(source.asset, source.assetVersion);

  const bgmVersion = track.assetVersion;
  if (Date.parse(bgmVersion.createdAt) > createdAtEpochMs) fail(code);
  const existingBgmAsset = assets.get(bgmVersion.assetUid);
  if (existingBgmAsset && (
    existingBgmAsset.ownerType !== 'drama'
    || existingBgmAsset.ownerUid !== dramaUid
    || existingBgmAsset.assetType !== 'bgm'
    || existingBgmAsset.currentVersionUid !== bgmVersion.uid
    || existingBgmAsset.status !== 'ready'
  )) fail(code);
  const existingBgmVersion = versions.get(bgmVersion.uid);
  if (existingBgmVersion
    && !assetVersionEvidenceMatches(existingBgmVersion, bgmVersion)) fail(code);
  versions.set(bgmVersion.uid, bgmVersion);
}

function expectedAudioSources(timeline, code) {
  const sources = [];
  const byVersion = new Map();
  function add(source) {
    const existing = byVersion.get(source.assetVersionUid);
    if (existing) {
      if (existing.sourceKind !== source.sourceKind
        || existing.assetUid !== source.assetUid
        || existing.mediaSha256 !== source.mediaSha256
        || existing.mimeType !== source.mimeType
        || existing.durationMs !== source.durationMs) fail(code);
      return;
    }
    byVersion.set(source.assetVersionUid, source);
    sources.push(Object.freeze(source));
  }
  for (const segment of timeline.segments) {
    add({
      sourceKind: segment.sourceKind,
      assetUid: segment.sourceAssetUid,
      assetVersionUid: segment.sourceAssetVersionUid,
      mediaSha256: segment.sourceMediaSha256,
      mimeType: segment.sourceMimeType,
      durationMs: segment.sourceKind === 'h3_native'
        ? timeline.nativeTrack.durationMs
        : segment.durationMs,
    });
  }
  if (timeline.nativeTrack !== null) {
    add({
      sourceKind: 'h3_native',
      assetUid: timeline.nativeTrack.sourceAssetUid,
      assetVersionUid: timeline.nativeTrack.sourceAssetVersionUid,
      mediaSha256: timeline.nativeTrack.sourceMediaSha256,
      mimeType: timeline.nativeTrack.sourceMimeType,
      durationMs: timeline.nativeTrack.durationMs,
    });
  }
  return frozenArray(sources);
}

function audioSourceRecord(value, expected, dramaUid, code) {
  const input = exactObject(value, AUDIO_SOURCE_KEYS, code);
  if (input.sourceKind !== expected.sourceKind) fail(code);
  const version = safeVersion(input.assetVersion, code);
  const assetType = expected.sourceKind === 'tts_asset' ? 'audio' : 'video';
  const asset = safeAsset(input.asset, version, dramaUid, assetType, code);
  if (version.assetUid !== expected.assetUid
    || version.uid !== expected.assetVersionUid
    || version.sha256 !== expected.mediaSha256
    || version.mimeType !== expected.mimeType
    || version.durationMs !== expected.durationMs
    || (expected.sourceKind === 'tts_asset' && (
      !AUDIO_MIME_TYPES.has(version.mimeType)
      || version.width !== null || version.height !== null
    ))
    || (expected.sourceKind === 'h3_native' && (
      version.mimeType !== 'video/mp4'
      || !Number.isSafeInteger(version.width) || version.width < 1
      || !Number.isSafeInteger(version.height) || version.height < 1
    ))) fail(code);
  return Object.freeze({ sourceKind: input.sourceKind, asset, assetVersion: version });
}

function audioSources(value, timeline, dramaUid, code) {
  const expected = expectedAudioSources(timeline, code);
  const inputs = denseArray(value, MAX_ITEMS, code);
  if (inputs.length !== expected.length || inputs.length < 1) fail(code);
  return frozenArray(inputs.map((entry, index) => (
    audioSourceRecord(entry, expected[index], dramaUid, code)
  )));
}

function assertPlanRelations(timeline, mix, track, subtitle, code) {
  if (mix.dramaUid !== timeline.dramaUid
    || mix.workflowRunUid !== timeline.workflowRunUid
    || mix.timelineUid !== timeline.uid
    || mix.timelineSha256 !== timeline.timelineSha256
    || mix.mode !== timeline.mode
    || mix.durationMs !== timeline.durationMs
    || subtitle.timelineUid !== timeline.uid
    || subtitle.trackSha256 !== timeline.subtitleTrack.trackSha256
    || track.dramaUid !== timeline.dramaUid
    || mix.bgm.trackUid !== track.uid
    || mix.bgm.licenseUid !== track.license.uid
    || mix.bgm.assetUid !== track.assetVersion.assetUid
    || mix.bgm.assetVersionUid !== track.assetVersion.uid
    || mix.bgm.mediaSha256 !== track.assetVersion.sha256
    || mix.bgm.mimeType !== track.assetVersion.mimeType
    || mix.bgm.sourceDurationMs !== track.assetVersion.durationMs) fail(code);
}

function subtitleRecord(value, timeline, code) {
  try {
    return parseSubtitleTrack(value, {
      timelineUid: timeline.uid,
      planUid: timeline.planUid,
      executionUid: timeline.executionUid,
      durationMs: timeline.durationMs,
      maximumDurationMs: MAX_DURATION_MS,
      segments: timeline.segments,
      timingAlgorithmVersion: timeline.timingAlgorithmVersion,
    }, code);
  } catch {
    return fail(code);
  }
}

function buildRecord(input) {
  const base = Object.freeze({
    schemaVersion: 'production-timeline-snapshot.v1',
    algorithmVersion: PRODUCTION_TIMELINE_ALGORITHM_VERSION,
    uid: input.uid,
    dramaUid: input.timeline.dramaUid,
    workflowRunUid: input.timeline.workflowRunUid,
    durationMs: input.timeline.durationMs,
    shots: input.shots,
    audioTimeline: input.timeline,
    audioSources: input.audioSources,
    subtitleTrack: input.subtitle,
    audioMixPlan: input.mix,
    bgmTrack: input.track,
    createdAtEpochMs: input.createdAtEpochMs,
  });
  return Object.freeze({ ...base, snapshotSha256: canonicalHash(base) });
}

function createProductionTimelineSnapshot(value) {
  try {
    const input = exactObject(value, INPUT_KEYS, INPUT_CODE);
    if (input.schemaVersion !== '8.0') fail(INPUT_CODE);
    const timeline = safeTrustedTimeline(input.audioTimeline, INPUT_CODE);
    const mix = safeTrustedMix(input.audioMixPlan, INPUT_CODE);
    const track = safeBgmTrack(input.bgmTrack, INPUT_CODE);
    const subtitle = timeline.subtitleTrack;
    assertPlanRelations(timeline, mix, track, subtitle, INPUT_CODE);
    const uid = canonicalUid(input.uid, INPUT_CODE);
    const createdAtEpochMs = epoch(input.createdAtEpochMs, INPUT_CODE);
    const shotInputs = denseArray(input.shots, MAX_ITEMS, INPUT_CODE);
    if (shotInputs.length < 1) fail(INPUT_CODE);
    let cursor = 0;
    const shots = shotInputs.map((entry, index) => {
      const shot = shotInput(
        entry,
        index,
        cursor,
        timeline.dramaUid,
        timeline.workflowRunUid,
        createdAtEpochMs,
        INPUT_CODE,
      );
      cursor = shot.endMs;
      return shot;
    });
    assertUniqueShots(shots, timeline.durationMs, INPUT_CODE);
    const sources = audioSources(input.audioSources, timeline, timeline.dramaUid, INPUT_CODE);
    assertGlobalMediaIdentities(
      shots, sources, track, timeline.dramaUid, createdAtEpochMs, INPUT_CODE,
    );
    const identities = new Set([uid, timeline.uid, mix.uid, track.uid]);
    if (identities.size !== 4 || createdAtEpochMs < mix.createdAtEpochMs
      || createdAtEpochMs < timeline.createdAtEpochMs
      || createdAtEpochMs < track.createdAtEpochMs) fail(INPUT_CODE);
    return buildRecord({
      uid,
      timeline,
      mix,
      shots: frozenArray(shots),
      audioSources: sources,
      subtitle,
      track,
      createdAtEpochMs,
    });
  } catch (error) {
    if (isAudioModeContractError(error) && error.code === INPUT_CODE) throw error;
    return fail(INPUT_CODE);
  }
}

function parseProductionTimelineSnapshotRecord(value) {
  try {
    const input = exactObject(value, RECORD_KEYS, DATA_CODE);
    if (input.schemaVersion !== 'production-timeline-snapshot.v1'
      || input.algorithmVersion !== PRODUCTION_TIMELINE_ALGORITHM_VERSION) fail(DATA_CODE);
    const uid = canonicalUid(input.uid, DATA_CODE);
    const dramaUid = canonicalUid(input.dramaUid, DATA_CODE);
    const workflowRunUid = canonicalUid(input.workflowRunUid, DATA_CODE);
    const durationMs = boundedInteger(input.durationMs, 1, MAX_DURATION_MS, DATA_CODE);
    const timeline = safeParsedTimeline(input.audioTimeline, DATA_CODE);
    const mix = safeParsedMix(input.audioMixPlan, DATA_CODE);
    const track = safeBgmTrack(input.bgmTrack, DATA_CODE);
    const subtitle = subtitleRecord(input.subtitleTrack, timeline, DATA_CODE);
    assertPlanRelations(timeline, mix, track, subtitle, DATA_CODE);
    if (timeline.dramaUid !== dramaUid || timeline.workflowRunUid !== workflowRunUid
      || timeline.durationMs !== durationMs) fail(DATA_CODE);
    const createdAtEpochMs = epoch(input.createdAtEpochMs, DATA_CODE);
    const shots = denseArray(input.shots, MAX_ITEMS, DATA_CODE)
      .map((entry) => shotRecord(
        entry, dramaUid, workflowRunUid, durationMs, createdAtEpochMs, DATA_CODE,
      ));
    if (shots.length < 1) fail(DATA_CODE);
    assertUniqueShots(shots, durationMs, DATA_CODE);
    const sources = audioSources(input.audioSources, timeline, dramaUid, DATA_CODE);
    assertGlobalMediaIdentities(shots, sources, track, dramaUid, createdAtEpochMs, DATA_CODE);
    if (createdAtEpochMs < mix.createdAtEpochMs
      || createdAtEpochMs < timeline.createdAtEpochMs
      || createdAtEpochMs < track.createdAtEpochMs) fail(DATA_CODE);
    const canonical = buildRecord({
      uid,
      timeline,
      mix,
      shots: frozenArray(shots),
      audioSources: sources,
      subtitle,
      track,
      createdAtEpochMs,
    });
    if (canonical.snapshotSha256 !== input.snapshotSha256) fail(DATA_CODE);
    return canonical;
  } catch (error) {
    if (isAudioModeContractError(error) && error.code === DATA_CODE) throw error;
    return fail(DATA_CODE);
  }
}

function createProductionTimelineSnapshotVerifier(value) {
  const dependencies = exactObject(
    value, ['loadTrustedEnvelope', 'loadGenerationHistory', 'loadH3ExecutionResult'], INPUT_CODE,
  );
  if (typeof dependencies.loadTrustedEnvelope !== 'function'
    || isProxy(dependencies.loadTrustedEnvelope)
    || typeof dependencies.loadGenerationHistory !== 'function'
    || isProxy(dependencies.loadGenerationHistory)
    || typeof dependencies.loadH3ExecutionResult !== 'function'
    || isProxy(dependencies.loadH3ExecutionResult)) fail(INPUT_CODE);
  const loadTrustedEnvelope = dependencies.loadTrustedEnvelope;
  const loadGenerationHistory = dependencies.loadGenerationHistory;
  const loadH3ExecutionResult = dependencies.loadH3ExecutionResult;
  return Object.freeze({
    verify(snapshotValue, expectedSnapshotUid) {
      try {
        const uid = canonicalUid(expectedSnapshotUid, DATA_CODE);
        const stored = parseProductionTimelineSnapshotRecord(snapshotValue);
        const envelope = exactObject(loadTrustedEnvelope(uid), INPUT_KEYS, DATA_CODE);
        if (envelope.uid !== uid) fail(DATA_CODE);
        const expected = createProductionTimelineSnapshot(envelope);
        for (const shot of expected.shots) {
          const trustedH3Result = safeH3ExecutionResult(
            loadH3ExecutionResult(shot.h3ExecutionResult.taskUid), DATA_CODE,
          );
          if (JSON.stringify(trustedH3Result) !== JSON.stringify(shot.h3ExecutionResult)) {
            fail(DATA_CODE);
          }
          const trustedHistory = generationHistoryEvidenceFromRecord(
            loadGenerationHistory(shot.generationHistory.uid),
            shot.asset,
            shot.assetVersion,
            expected.dramaUid,
            shot.h3ExecutionResult.generationRunUid,
            expected.createdAtEpochMs,
            DATA_CODE,
          );
          if (JSON.stringify(trustedHistory) !== JSON.stringify(shot.generationHistory)) {
            fail(DATA_CODE);
          }
        }
        if (JSON.stringify(stored) !== JSON.stringify(expected)) fail(DATA_CODE);
        TRUSTED_SNAPSHOTS.add(expected);
        return expected;
      } catch {
        return fail(DATA_CODE);
      }
    },
  });
}

function requireTrustedProductionTimelineSnapshot(value) {
  if ((typeof value === 'object' || typeof value === 'function')
    && value !== null && TRUSTED_SNAPSHOTS.has(value)) return value;
  return fail(DATA_CODE);
}

module.exports = Object.freeze({
  PRODUCTION_TIMELINE_ALGORITHM_VERSION,
  createProductionTimelineSnapshot,
  createProductionTimelineSnapshotVerifier,
  parseProductionTimelineSnapshotRecord,
  requireTrustedProductionTimelineSnapshot,
});
