'use strict';

const {
  boundedInteger,
  canonicalHash,
  canonicalUid,
  denseArray,
  epoch,
  exactObject,
  fail,
  frozenArray,
  sha256,
} = require('../audio/audioContract');
const { parseMediaExportProfileRecord } = require('./mediaExportProfile');

const DATA_CODE = 'MEDIA_NORMALIZATION_DATA_INVALID';
const MEDIA_NORMALIZATION_SCHEMA_VERSION = 'media-normalization-plan.v1';
const MEDIA_NORMALIZATION_ALGORITHM_VERSION = 'media-normalization.v1';
const MAX_MEDIA_INPUTS = 2001;
const RECORD_KEYS = Object.freeze([
  'schemaVersion', 'algorithmVersion', 'uid', 'dramaUid', 'workflowRunUid',
  'durationMs', 'productionTimelineSnapshotUid', 'productionTimelineSnapshotSha256',
  'profile', 'mediaProbeUids', 'videoInputs', 'audioInputs', 'subtitleTrackSha256',
  'audioMixPlanUid', 'audioMixPlanSha256', 'createdAtEpochMs', 'planSha256',
]);
const VIDEO_INPUT_KEYS = Object.freeze([
  'ordinal', 'shotId', 'assetVersionUid', 'assetVersionSha256', 'mediaProbeUid',
  'mediaProbeSha256', 'source', 'target',
]);
const VIDEO_SOURCE_KEYS = Object.freeze(['durationMs', 'width', 'height', 'frameRate']);
const VIDEO_TARGET_KEYS = Object.freeze([
  'width', 'height', 'frameRate', 'pixelFormat', 'scaleMode', 'padColor',
  'sampleAspectRatio',
]);
const AUDIO_INPUT_KEYS = Object.freeze([
  'ordinal', 'role', 'sourceKind', 'assetVersionUid', 'assetVersionSha256',
  'mediaProbeUid', 'mediaProbeSha256', 'source', 'target',
]);
const AUDIO_SOURCE_KEYS = Object.freeze([
  'durationMs', 'codec', 'sampleRateHz', 'channels', 'channelLayout',
]);
const AUDIO_TARGET_KEYS = Object.freeze(['codec', 'sampleRateHz', 'channels', 'channelLayout']);
const RATIONAL_KEYS = Object.freeze(['numerator', 'denominator']);

function invalid() {
  fail(DATA_CODE);
}

function token(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) invalid();
  return value;
}

function rational(value) {
  const input = exactObject(value, RATIONAL_KEYS, DATA_CODE);
  return Object.freeze({
    numerator: boundedInteger(input.numerator, 1, 1_000_000, DATA_CODE),
    denominator: boundedInteger(input.denominator, 1, 1_000_000_000, DATA_CODE),
  });
}

function videoTarget(profile) {
  return Object.freeze({
    width: profile.video.width,
    height: profile.video.height,
    frameRate: Object.freeze({
      numerator: profile.video.frameRate.numerator,
      denominator: profile.video.frameRate.denominator,
    }),
    pixelFormat: profile.video.pixelFormat,
    scaleMode: profile.video.scaleMode,
    padColor: profile.video.padColor,
    sampleAspectRatio: profile.video.sampleAspectRatio,
  });
}

function audioTarget(profile) {
  return Object.freeze({
    codec: profile.audio.codec,
    sampleRateHz: profile.audio.sampleRateHz,
    channels: profile.audio.channels,
    channelLayout: profile.audio.channelLayout,
  });
}

function parseVideoSource(value) {
  const input = exactObject(value, VIDEO_SOURCE_KEYS, DATA_CODE);
  return Object.freeze({
    durationMs: boundedInteger(input.durationMs, 1, 3_600_000, DATA_CODE),
    width: boundedInteger(input.width, 1, 16_384, DATA_CODE),
    height: boundedInteger(input.height, 1, 16_384, DATA_CODE),
    frameRate: rational(input.frameRate),
  });
}

function parseVideoTarget(value, profile) {
  const input = exactObject(value, VIDEO_TARGET_KEYS, DATA_CODE);
  const canonical = Object.freeze({
    width: boundedInteger(input.width, 1, 16_384, DATA_CODE),
    height: boundedInteger(input.height, 1, 16_384, DATA_CODE),
    frameRate: rational(input.frameRate),
    pixelFormat: input.pixelFormat,
    scaleMode: input.scaleMode,
    padColor: input.padColor,
    sampleAspectRatio: input.sampleAspectRatio,
  });
  if (JSON.stringify(canonical) !== JSON.stringify(videoTarget(profile))) invalid();
  return canonical;
}

function parseVideoInput(value, ordinal, profile) {
  const input = exactObject(value, VIDEO_INPUT_KEYS, DATA_CODE);
  if (input.ordinal !== ordinal) invalid();
  return Object.freeze({
    ordinal,
    shotId: token(input.shotId, /^[a-z][a-z0-9-]{0,63}$/u),
    assetVersionUid: canonicalUid(input.assetVersionUid, DATA_CODE),
    assetVersionSha256: sha256(input.assetVersionSha256, DATA_CODE),
    mediaProbeUid: canonicalUid(input.mediaProbeUid, DATA_CODE),
    mediaProbeSha256: sha256(input.mediaProbeSha256, DATA_CODE),
    source: parseVideoSource(input.source),
    target: parseVideoTarget(input.target, profile),
  });
}

function parseAudioSource(value) {
  const input = exactObject(value, AUDIO_SOURCE_KEYS, DATA_CODE);
  return Object.freeze({
    durationMs: boundedInteger(input.durationMs, 1, 3_600_000, DATA_CODE),
    codec: token(input.codec, /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/u),
    sampleRateHz: boundedInteger(input.sampleRateHz, 8_000, 384_000, DATA_CODE),
    channels: boundedInteger(input.channels, 1, 32, DATA_CODE),
    channelLayout: token(input.channelLayout, /^[A-Za-z0-9][A-Za-z0-9._:+()-]{0,127}$/u),
  });
}

function parseAudioTarget(value, profile) {
  const input = exactObject(value, AUDIO_TARGET_KEYS, DATA_CODE);
  const canonical = Object.freeze({
    codec: input.codec,
    sampleRateHz: input.sampleRateHz,
    channels: input.channels,
    channelLayout: input.channelLayout,
  });
  if (JSON.stringify(canonical) !== JSON.stringify(audioTarget(profile))) invalid();
  return canonical;
}

function parseAudioInput(value, ordinal, profile) {
  const input = exactObject(value, AUDIO_INPUT_KEYS, DATA_CODE);
  if (input.ordinal !== ordinal || !['dialogue', 'native', 'bgm'].includes(input.role)
    || !['tts_asset', 'h3_native', 'bgm'].includes(input.sourceKind)
    || (input.role === 'dialogue' && input.sourceKind !== 'tts_asset')
    || (input.role === 'native' && input.sourceKind !== 'h3_native')
    || (input.role === 'bgm' && input.sourceKind !== 'bgm')) invalid();
  return Object.freeze({
    ordinal,
    role: input.role,
    sourceKind: input.sourceKind,
    assetVersionUid: canonicalUid(input.assetVersionUid, DATA_CODE),
    assetVersionSha256: sha256(input.assetVersionSha256, DATA_CODE),
    mediaProbeUid: canonicalUid(input.mediaProbeUid, DATA_CODE),
    mediaProbeSha256: sha256(input.mediaProbeSha256, DATA_CODE),
    source: parseAudioSource(input.source),
    target: parseAudioTarget(input.target, profile),
  });
}

function assertProbeBindings(probeUids, videos, audios) {
  const orderedInputProbeUids = [];
  const probeBindings = new Map();
  const versionBindings = new Map();
  for (const entry of [...videos, ...audios]) {
    const probeBinding = probeBindings.get(entry.mediaProbeUid);
    const versionBinding = versionBindings.get(entry.assetVersionUid);
    if (probeBinding && (probeBinding.probeSha256 !== entry.mediaProbeSha256
      || probeBinding.assetVersionUid !== entry.assetVersionUid)) invalid();
    if (versionBinding && (versionBinding.assetVersionSha256 !== entry.assetVersionSha256
      || versionBinding.mediaProbeUid !== entry.mediaProbeUid)) invalid();
    if (!probeBinding) {
      probeBindings.set(entry.mediaProbeUid, Object.freeze({
        probeSha256: entry.mediaProbeSha256,
        assetVersionUid: entry.assetVersionUid,
      }));
      orderedInputProbeUids.push(entry.mediaProbeUid);
    }
    if (!versionBinding) {
      versionBindings.set(entry.assetVersionUid, Object.freeze({
        assetVersionSha256: entry.assetVersionSha256,
        mediaProbeUid: entry.mediaProbeUid,
      }));
    }
  }
  if (probeUids.length !== orderedInputProbeUids.length
    || probeUids.some((uid, index) => uid !== orderedInputProbeUids[index])) invalid();
}

function parseMediaNormalizationPlanRecord(value) {
  try {
    const input = exactObject(value, RECORD_KEYS, DATA_CODE);
    if (input.schemaVersion !== MEDIA_NORMALIZATION_SCHEMA_VERSION
      || input.algorithmVersion !== MEDIA_NORMALIZATION_ALGORITHM_VERSION) invalid();
    const profile = parseMediaExportProfileRecord(input.profile);
    const probeUids = denseArray(input.mediaProbeUids, MAX_MEDIA_INPUTS, DATA_CODE)
      .map((uid) => canonicalUid(uid, DATA_CODE));
    if (probeUids.length < 1 || new Set(probeUids).size !== probeUids.length) invalid();
    const videos = denseArray(input.videoInputs, 1000, DATA_CODE)
      .map((entry, index) => parseVideoInput(entry, index, profile));
    const audios = denseArray(input.audioInputs, 1001, DATA_CODE)
      .map((entry, index) => parseAudioInput(entry, index, profile));
    if (videos.length < 1 || audios.length < 1) invalid();
    assertProbeBindings(probeUids, videos, audios);
    const base = Object.freeze({
      schemaVersion: MEDIA_NORMALIZATION_SCHEMA_VERSION,
      algorithmVersion: MEDIA_NORMALIZATION_ALGORITHM_VERSION,
      uid: canonicalUid(input.uid, DATA_CODE),
      dramaUid: canonicalUid(input.dramaUid, DATA_CODE),
      workflowRunUid: canonicalUid(input.workflowRunUid, DATA_CODE),
      durationMs: boundedInteger(input.durationMs, 1, 3_600_000, DATA_CODE),
      productionTimelineSnapshotUid: canonicalUid(input.productionTimelineSnapshotUid, DATA_CODE),
      productionTimelineSnapshotSha256: sha256(input.productionTimelineSnapshotSha256, DATA_CODE),
      profile,
      mediaProbeUids: frozenArray(probeUids),
      videoInputs: frozenArray(videos),
      audioInputs: frozenArray(audios),
      subtitleTrackSha256: sha256(input.subtitleTrackSha256, DATA_CODE),
      audioMixPlanUid: canonicalUid(input.audioMixPlanUid, DATA_CODE),
      audioMixPlanSha256: sha256(input.audioMixPlanSha256, DATA_CODE),
      createdAtEpochMs: epoch(input.createdAtEpochMs, DATA_CODE),
    });
    const expectedHash = canonicalHash(base);
    if (sha256(input.planSha256, DATA_CODE) !== expectedHash) invalid();
    return Object.freeze({ ...base, planSha256: expectedHash });
  } catch {
    return invalid();
  }
}

module.exports = Object.freeze({
  MAX_MEDIA_INPUTS,
  MEDIA_NORMALIZATION_ALGORITHM_VERSION,
  MEDIA_NORMALIZATION_SCHEMA_VERSION,
  parseMediaNormalizationPlanRecord,
});
