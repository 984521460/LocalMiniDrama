'use strict';

const { types: { isProxy } } = require('node:util');

const {
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
} = require('./audioContract');
const { requireTrustedAudioTimeline } = require('./audioTimeline');
const { assertBgmTrackExportReady } = require('./bgmTrack');

const AUDIO_MIX_ALGORITHM_VERSION = 'audio-ducking-ms.v1';
const INPUT_CODE = 'AUDIO_MIX_INPUT_INVALID';
const DATA_CODE = 'AUDIO_MIX_DATA_INVALID';
const MAX_TIMELINE_MS = 3_600_000;
const MIN_BGM_DURATION_MS = 1_000;
const MAX_BGM_DURATION_MS = 86_400_000;
const MAX_BGM_LOOPS = 3_600;
const MAX_DUCK_WINDOWS = 1_000;
const MIN_GAIN_MILLI_DB = -60_000;
const MAX_FOREGROUND_GAIN_MILLI_DB = 12_000;
const MIN_BGM_GAIN_MILLI_DB = -30_000;
const MAX_BGM_GAIN_MILLI_DB = 0;
const MIN_DUCK_REDUCTION_MILLI_DB = 3_000;
const MAX_FADE_MS = 30_000;
const MAX_ATTACK_MS = 2_000;
const MAX_RELEASE_MS = 5_000;
const AUDIO_MIME_TYPES = Object.freeze(new Set([
  'audio/aac', 'audio/flac', 'audio/mpeg', 'audio/wav', 'audio/x-wav',
]));
const TRUSTED_MIX_PLANS = new WeakSet();
const INPUT_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'audioTimeline', 'bgmTrack', 'settings', 'createdAtEpochMs',
]);
const SETTINGS_KEYS = Object.freeze([
  'dialogueGainMilliDb', 'nativeGainMilliDb', 'bgmGainMilliDb',
  'duckedBgmGainMilliDb', 'fadeInMs', 'fadeOutMs', 'duckingAttackMs',
  'duckingReleaseMs',
]);
const RECORD_KEYS = Object.freeze([
  'schemaVersion', 'algorithmVersion', 'uid', 'dramaUid', 'workflowRunUid',
  'timelineUid', 'timelineSha256', 'mode', 'durationMs', 'dialogueGainMilliDb',
  'nativeGainMilliDb', 'bgm', 'ducking', 'mixSha256', 'createdAtEpochMs',
]);
const BGM_KEYS = Object.freeze([
  'trackUid', 'licenseUid', 'assetUid', 'assetVersionUid', 'mediaSha256',
  'mimeType', 'sourceDurationMs', 'loopCount', 'baseGainMilliDb',
  'duckedGainMilliDb', 'fadeInMs', 'fadeOutMs',
]);
const DUCKING_KEYS = Object.freeze(['attackMs', 'releaseMs', 'windows']);
const WINDOW_KEYS = Object.freeze(['startMs', 'endMs', 'gainMilliDb']);

function safeTimeline(value, code) {
  try {
    return requireTrustedAudioTimeline(value);
  } catch {
    return fail(code);
  }
}

function safeBgmTrack(value, code) {
  try {
    return assertBgmTrackExportReady(value);
  } catch {
    return fail(code);
  }
}

function gain(value, minimum, maximum, code) {
  return boundedInteger(value, minimum, maximum, code);
}

function settingsRecord(value, durationMs, mode, code) {
  const input = exactObject(value, SETTINGS_KEYS, code);
  const dialogueGainMilliDb = input.dialogueGainMilliDb === null
    ? null
    : gain(
      input.dialogueGainMilliDb,
      -24_000,
      MAX_FOREGROUND_GAIN_MILLI_DB,
      code,
    );
  const nativeGainMilliDb = input.nativeGainMilliDb === null
    ? null
    : gain(
      input.nativeGainMilliDb,
      MIN_GAIN_MILLI_DB,
      MAX_FOREGROUND_GAIN_MILLI_DB,
      code,
    );
  if ((mode === 'h3_native') !== (dialogueGainMilliDb === null)
    || (mode === 'independent_tts') !== (nativeGainMilliDb === null)) fail(code);
  const output = Object.freeze({
    dialogueGainMilliDb,
    nativeGainMilliDb,
    bgmGainMilliDb: gain(
      input.bgmGainMilliDb,
      MIN_BGM_GAIN_MILLI_DB,
      MAX_BGM_GAIN_MILLI_DB,
      code,
    ),
    duckedBgmGainMilliDb: gain(
      input.duckedBgmGainMilliDb,
      MIN_GAIN_MILLI_DB,
      -MIN_DUCK_REDUCTION_MILLI_DB,
      code,
    ),
    fadeInMs: boundedInteger(input.fadeInMs, 0, Math.min(MAX_FADE_MS, durationMs), code),
    fadeOutMs: boundedInteger(input.fadeOutMs, 0, Math.min(MAX_FADE_MS, durationMs), code),
    duckingAttackMs: boundedInteger(input.duckingAttackMs, 0, MAX_ATTACK_MS, code),
    duckingReleaseMs: boundedInteger(input.duckingReleaseMs, 0, MAX_RELEASE_MS, code),
  });
  if (output.duckedBgmGainMilliDb
      > output.bgmGainMilliDb - MIN_DUCK_REDUCTION_MILLI_DB
    || output.fadeInMs + output.fadeOutMs > durationMs) fail(code);
  return output;
}

function sourceEvidence(track, durationMs, values, code) {
  const sourceDurationMs = boundedInteger(
    track.assetVersion.durationMs,
    MIN_BGM_DURATION_MS,
    MAX_BGM_DURATION_MS,
    code,
  );
  const loopCount = Math.ceil(durationMs / sourceDurationMs);
  if (loopCount < 1 || loopCount > MAX_BGM_LOOPS) fail(code);
  return Object.freeze({
    trackUid: track.uid,
    licenseUid: track.license.uid,
    assetUid: track.assetVersion.assetUid,
    assetVersionUid: track.assetVersion.uid,
    mediaSha256: track.assetVersion.sha256,
    mimeType: track.assetVersion.mimeType,
    sourceDurationMs,
    loopCount,
    baseGainMilliDb: values.bgmGainMilliDb,
    duckedGainMilliDb: values.duckedBgmGainMilliDb,
    fadeInMs: values.fadeInMs,
    fadeOutMs: values.fadeOutMs,
  });
}

function duckingWindows(segments, durationMs, values) {
  const windows = [];
  for (const segment of segments) {
    const next = {
      startMs: Math.max(0, segment.startMs - values.duckingAttackMs),
      endMs: Math.min(durationMs, segment.endMs + values.duckingReleaseMs),
      gainMilliDb: values.duckedBgmGainMilliDb,
    };
    const previous = windows.at(-1);
    if (previous && next.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, next.endMs);
    } else {
      windows.push(next);
    }
  }
  return frozenArray(windows.map((window) => Object.freeze(window)));
}

function mixRecord(input) {
  const base = Object.freeze({
    schemaVersion: 'audio-mix-plan.v1',
    algorithmVersion: AUDIO_MIX_ALGORITHM_VERSION,
    uid: input.uid,
    dramaUid: input.timeline.dramaUid,
    workflowRunUid: input.timeline.workflowRunUid,
    timelineUid: input.timeline.uid,
    timelineSha256: input.timeline.timelineSha256,
    mode: input.timeline.mode,
    durationMs: input.timeline.durationMs,
    dialogueGainMilliDb: input.values.dialogueGainMilliDb,
    nativeGainMilliDb: input.values.nativeGainMilliDb,
    bgm: sourceEvidence(input.track, input.timeline.durationMs, input.values, INPUT_CODE),
    ducking: Object.freeze({
      attackMs: input.values.duckingAttackMs,
      releaseMs: input.values.duckingReleaseMs,
      windows: duckingWindows(input.timeline.segments, input.timeline.durationMs, input.values),
    }),
    createdAtEpochMs: input.createdAtEpochMs,
  });
  return Object.freeze({
    schemaVersion: base.schemaVersion,
    algorithmVersion: base.algorithmVersion,
    uid: base.uid,
    dramaUid: base.dramaUid,
    workflowRunUid: base.workflowRunUid,
    timelineUid: base.timelineUid,
    timelineSha256: base.timelineSha256,
    mode: base.mode,
    durationMs: base.durationMs,
    dialogueGainMilliDb: base.dialogueGainMilliDb,
    nativeGainMilliDb: base.nativeGainMilliDb,
    bgm: base.bgm,
    ducking: base.ducking,
    mixSha256: canonicalHash(base),
    createdAtEpochMs: base.createdAtEpochMs,
  });
}

function createAudioMixPlan(value) {
  try {
    const input = exactObject(value, INPUT_KEYS, INPUT_CODE);
    if (input.schemaVersion !== '8.0') fail(INPUT_CODE);
    const timeline = safeTimeline(input.audioTimeline, INPUT_CODE);
    const track = safeBgmTrack(input.bgmTrack, INPUT_CODE);
    const uid = canonicalUid(input.uid, INPUT_CODE);
    const createdAtEpochMs = epoch(input.createdAtEpochMs, INPUT_CODE);
    const values = settingsRecord(input.settings, timeline.durationMs, timeline.mode, INPUT_CODE);
    const identities = new Set([
      uid,
      timeline.uid,
      track.uid,
      track.license.uid,
      track.assetVersion.assetUid,
      track.assetVersion.uid,
    ]);
    if (identities.size !== 6
      || track.dramaUid !== timeline.dramaUid
      || createdAtEpochMs < timeline.createdAtEpochMs
      || createdAtEpochMs < track.createdAtEpochMs) fail(INPUT_CODE);
    return mixRecord({ uid, timeline, track, values, createdAtEpochMs });
  } catch (error) {
    if (isAudioModeContractError(error) && error.code === INPUT_CODE) throw error;
    return fail(INPUT_CODE);
  }
}

function parseBgm(value, durationMs, code) {
  const input = exactObject(value, BGM_KEYS, code);
  if (!AUDIO_MIME_TYPES.has(input.mimeType)) fail(code);
  const sourceDurationMs = boundedInteger(
    input.sourceDurationMs,
    MIN_BGM_DURATION_MS,
    MAX_BGM_DURATION_MS,
    code,
  );
  const loopCount = boundedInteger(input.loopCount, 1, MAX_BGM_LOOPS, code);
  const baseGainMilliDb = gain(
    input.baseGainMilliDb,
    MIN_BGM_GAIN_MILLI_DB,
    MAX_BGM_GAIN_MILLI_DB,
    code,
  );
  const duckedGainMilliDb = gain(
    input.duckedGainMilliDb,
    MIN_GAIN_MILLI_DB,
    -MIN_DUCK_REDUCTION_MILLI_DB,
    code,
  );
  const fadeInMs = boundedInteger(input.fadeInMs, 0, Math.min(MAX_FADE_MS, durationMs), code);
  const fadeOutMs = boundedInteger(input.fadeOutMs, 0, Math.min(MAX_FADE_MS, durationMs), code);
  const identities = [input.trackUid, input.licenseUid, input.assetUid, input.assetVersionUid]
    .map((entry) => canonicalUid(entry, code));
  if (new Set(identities).size !== identities.length
    || loopCount !== Math.ceil(durationMs / sourceDurationMs)
    || duckedGainMilliDb > baseGainMilliDb - MIN_DUCK_REDUCTION_MILLI_DB
    || fadeInMs + fadeOutMs > durationMs) fail(code);
  return Object.freeze({
    trackUid: identities[0],
    licenseUid: identities[1],
    assetUid: identities[2],
    assetVersionUid: identities[3],
    mediaSha256: sha256(input.mediaSha256, code),
    mimeType: input.mimeType,
    sourceDurationMs,
    loopCount,
    baseGainMilliDb,
    duckedGainMilliDb,
    fadeInMs,
    fadeOutMs,
  });
}

function parseWindow(value, durationMs, expectedGain, code) {
  const input = exactObject(value, WINDOW_KEYS, code);
  const startMs = boundedInteger(input.startMs, 0, durationMs, code);
  const endMs = boundedInteger(input.endMs, 1, durationMs, code);
  const gainMilliDb = gain(input.gainMilliDb, MIN_GAIN_MILLI_DB, -3_000, code);
  if (startMs >= endMs || gainMilliDb !== expectedGain) fail(code);
  return Object.freeze({ startMs, endMs, gainMilliDb });
}

function parseDucking(value, durationMs, expectedGain, code) {
  const input = exactObject(value, DUCKING_KEYS, code);
  const windows = denseArray(input.windows, MAX_DUCK_WINDOWS, code)
    .map((entry) => parseWindow(entry, durationMs, expectedGain, code));
  if (windows.length < 1) fail(code);
  for (let index = 1; index < windows.length; index += 1) {
    if (windows[index].startMs <= windows[index - 1].endMs) fail(code);
  }
  return Object.freeze({
    attackMs: boundedInteger(input.attackMs, 0, MAX_ATTACK_MS, code),
    releaseMs: boundedInteger(input.releaseMs, 0, MAX_RELEASE_MS, code),
    windows: frozenArray(windows),
  });
}

function parseAudioMixPlanRecord(value) {
  try {
    const input = exactObject(value, RECORD_KEYS, DATA_CODE);
    if (input.schemaVersion !== 'audio-mix-plan.v1'
      || input.algorithmVersion !== AUDIO_MIX_ALGORITHM_VERSION
      || !['independent_tts', 'h3_native', 'hybrid'].includes(input.mode)) fail(DATA_CODE);
    const uid = canonicalUid(input.uid, DATA_CODE);
    const timelineUid = canonicalUid(input.timelineUid, DATA_CODE);
    const durationMs = boundedInteger(input.durationMs, 1, MAX_TIMELINE_MS, DATA_CODE);
    const dialogueGainMilliDb = input.dialogueGainMilliDb === null
      ? null
      : gain(input.dialogueGainMilliDb, -24_000, MAX_FOREGROUND_GAIN_MILLI_DB, DATA_CODE);
    const nativeGainMilliDb = input.nativeGainMilliDb === null
      ? null
      : gain(input.nativeGainMilliDb, MIN_GAIN_MILLI_DB, MAX_FOREGROUND_GAIN_MILLI_DB, DATA_CODE);
    if ((input.mode === 'h3_native') !== (dialogueGainMilliDb === null)
      || (input.mode === 'independent_tts') !== (nativeGainMilliDb === null)) fail(DATA_CODE);
    const bgm = parseBgm(input.bgm, durationMs, DATA_CODE);
    const ducking = parseDucking(input.ducking, durationMs, bgm.duckedGainMilliDb, DATA_CODE);
    const identities = new Set([
      uid,
      timelineUid,
      bgm.trackUid,
      bgm.licenseUid,
      bgm.assetUid,
      bgm.assetVersionUid,
    ]);
    if (identities.size !== 6) fail(DATA_CODE);
    const base = Object.freeze({
      schemaVersion: input.schemaVersion,
      algorithmVersion: input.algorithmVersion,
      uid,
      dramaUid: canonicalUid(input.dramaUid, DATA_CODE),
      workflowRunUid: canonicalUid(input.workflowRunUid, DATA_CODE),
      timelineUid,
      timelineSha256: sha256(input.timelineSha256, DATA_CODE),
      mode: input.mode,
      durationMs,
      dialogueGainMilliDb,
      nativeGainMilliDb,
      bgm,
      ducking,
      createdAtEpochMs: epoch(input.createdAtEpochMs, DATA_CODE),
    });
    const canonical = Object.freeze({
      schemaVersion: base.schemaVersion,
      algorithmVersion: base.algorithmVersion,
      uid: base.uid,
      dramaUid: base.dramaUid,
      workflowRunUid: base.workflowRunUid,
      timelineUid: base.timelineUid,
      timelineSha256: base.timelineSha256,
      mode: base.mode,
      durationMs: base.durationMs,
      dialogueGainMilliDb: base.dialogueGainMilliDb,
      nativeGainMilliDb: base.nativeGainMilliDb,
      bgm: base.bgm,
      ducking: base.ducking,
      mixSha256: canonicalHash(base),
      createdAtEpochMs: base.createdAtEpochMs,
    });
    if (canonical.mixSha256 !== input.mixSha256) fail(DATA_CODE);
    return canonical;
  } catch (error) {
    if (isAudioModeContractError(error) && error.code === DATA_CODE) throw error;
    return fail(DATA_CODE);
  }
}

function createAudioMixPlanVerifier(value) {
  const dependencies = exactObject(value, ['loadTrustedEnvelope'], INPUT_CODE);
  if (typeof dependencies.loadTrustedEnvelope !== 'function'
    || isProxy(dependencies.loadTrustedEnvelope)) fail(INPUT_CODE);
  const loadTrustedEnvelope = dependencies.loadTrustedEnvelope;
  return Object.freeze({
    verify(planValue, expectedPlanUid) {
      try {
        const anchorUid = canonicalUid(expectedPlanUid, DATA_CODE);
        const stored = parseAudioMixPlanRecord(planValue);
        const envelope = exactObject(loadTrustedEnvelope(anchorUid), INPUT_KEYS, DATA_CODE);
        if (envelope.uid !== anchorUid) fail(DATA_CODE);
        const expected = createAudioMixPlan(envelope);
        if (canonicalHash(stored) !== canonicalHash(expected)) fail(DATA_CODE);
        TRUSTED_MIX_PLANS.add(expected);
        return expected;
      } catch {
        return fail(DATA_CODE);
      }
    },
  });
}

function requireTrustedAudioMixPlan(value) {
  if ((typeof value === 'object' || typeof value === 'function')
    && value !== null && TRUSTED_MIX_PLANS.has(value)) return value;
  return fail(DATA_CODE);
}

module.exports = Object.freeze({
  AUDIO_MIX_ALGORITHM_VERSION,
  createAudioMixPlan,
  createAudioMixPlanVerifier,
  requireTrustedAudioMixPlan,
});
