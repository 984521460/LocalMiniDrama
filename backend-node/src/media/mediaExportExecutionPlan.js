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
  textHash,
} = require('../audio/audioContract');
const { parseAudioMixPlanRecord } = require('../audio/audioMixPlan');
const {
  requireTrustedProductionTimelineSnapshot,
} = require('../audio/productionTimelineSnapshot');
const {
  requireTrustedMediaNormalizationPlan,
} = require('./mediaNormalizationPlan');
const { parseMediaExportProfileRecord } = require('./mediaExportProfile');
const { freezeSnapshot } = require('../repositories/v2/rowMapping');
const { createAssSubtitleDocument } = require('./assSubtitleDocument');

const INPUT_CODE = 'MEDIA_EXPORT_INPUT_INVALID';
const DATA_CODE = 'MEDIA_EXPORT_DATA_INVALID';
const SCHEMA_VERSION = 'media-export-execution-plan.v1';
const ALGORITHM_VERSION = 'local-ffmpeg-export.v1';
const INPUT_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'productionTimelineSnapshot', 'normalizationPlan',
  'createdAtEpochMs',
]);
const TRUSTED_PLANS = new WeakSet();
const RECORD_KEYS = Object.freeze([
  'schemaVersion', 'algorithmVersion', 'uid', 'dramaUid', 'workflowRunUid', 'mode',
  'durationMs', 'productionTimelineSnapshotUid', 'productionTimelineSnapshotSha256',
  'normalizationPlanUid', 'normalizationPlanSha256', 'profile', 'videoSources',
  'audioSources', 'subtitleTrackSha256', 'subtitleDocument', 'audioMixPlan',
  'outputRelativePath', 'createdAtEpochMs', 'executionPlanSha256',
]);
const VIDEO_SOURCE_KEYS = Object.freeze([
  'ordinal', 'shotId', 'startMs', 'endMs', 'durationMs', 'assetVersionUid',
  'relativePath', 'sha256', 'mediaProbeUid', 'mediaProbeSha256',
]);
const AUDIO_SOURCE_KEYS = Object.freeze([
  'ordinal', 'role', 'sourceKind', 'assetVersionUid', 'relativePath', 'sha256',
  'mediaProbeUid', 'mediaProbeSha256', 'durationMs', 'placements',
]);
const PLACEMENT_KEYS = Object.freeze(['startMs', 'endMs']);
const SUBTITLE_DOCUMENT_KEYS = Object.freeze([
  'schemaVersion', 'algorithmVersion', 'timelineUid', 'trackSha256', 'cueCount',
  'content', 'contentSha256', 'documentSha256',
]);

function invalid(code = INPUT_CODE) {
  fail(code);
}

function trustedTimeline(value) {
  try { return requireTrustedProductionTimelineSnapshot(value); } catch { return invalid(); }
}

function trustedNormalization(value) {
  try { return requireTrustedMediaNormalizationPlan(value); } catch { return invalid(); }
}

function assertPlanBinding(snapshot, plan) {
  if (plan.dramaUid !== snapshot.dramaUid
    || plan.workflowRunUid !== snapshot.workflowRunUid
    || plan.durationMs !== snapshot.durationMs
    || plan.productionTimelineSnapshotUid !== snapshot.uid
    || plan.productionTimelineSnapshotSha256 !== snapshot.snapshotSha256
    || plan.subtitleTrackSha256 !== snapshot.subtitleTrack.trackSha256
    || plan.audioMixPlanUid !== snapshot.audioMixPlan.uid
    || plan.audioMixPlanSha256 !== snapshot.audioMixPlan.mixSha256) invalid();
}

function videoSources(snapshot, plan) {
  if (plan.videoInputs.length !== snapshot.shots.length) invalid();
  return frozenArray(snapshot.shots.map((shot, ordinal) => {
    const normalized = plan.videoInputs[ordinal];
    if (normalized.ordinal !== ordinal || normalized.shotId !== shot.shotId
      || normalized.assetVersionUid !== shot.assetVersion.uid
      || normalized.assetVersionSha256 !== shot.assetVersion.sha256
      || Math.abs(normalized.source.durationMs - shot.durationMs) > 50) invalid();
    return Object.freeze({
      ordinal,
      shotId: shot.shotId,
      startMs: shot.startMs,
      endMs: shot.endMs,
      durationMs: shot.durationMs,
      assetVersionUid: shot.assetVersion.uid,
      relativePath: shot.assetVersion.relativePath,
      sha256: shot.assetVersion.sha256,
      mediaProbeUid: normalized.mediaProbeUid,
      mediaProbeSha256: normalized.mediaProbeSha256,
    });
  }));
}

function sourceVersion(snapshot, normalized) {
  if (normalized.role === 'bgm') return snapshot.bgmTrack.assetVersion;
  const source = snapshot.audioSources.find(
    (entry) => entry.assetVersion.uid === normalized.assetVersionUid,
  );
  if (!source || source.sourceKind !== normalized.sourceKind) invalid();
  return source.assetVersion;
}

function placements(snapshot, normalized) {
  if (normalized.role === 'bgm') {
    return frozenArray([Object.freeze({ startMs: 0, endMs: snapshot.durationMs })]);
  }
  if (normalized.role === 'native') {
    if (snapshot.audioTimeline.nativeTrack?.sourceAssetVersionUid !== normalized.assetVersionUid) {
      invalid();
    }
    return frozenArray([Object.freeze({ startMs: 0, endMs: snapshot.durationMs })]);
  }
  const records = snapshot.audioTimeline.segments
    .filter((entry) => entry.sourceAssetVersionUid === normalized.assetVersionUid)
    .map((entry) => Object.freeze({ startMs: entry.startMs, endMs: entry.endMs }));
  if (records.length < 1) invalid();
  return frozenArray(records);
}

function audioSources(snapshot, plan) {
  return frozenArray(plan.audioInputs.map((normalized, ordinal) => {
    if (normalized.ordinal !== ordinal) invalid();
    const version = sourceVersion(snapshot, normalized);
    if (version.uid !== normalized.assetVersionUid
      || version.sha256 !== normalized.assetVersionSha256
      || Math.abs(version.durationMs - normalized.source.durationMs) > 50) invalid();
    return Object.freeze({
      ordinal,
      role: normalized.role,
      sourceKind: normalized.sourceKind,
      assetVersionUid: version.uid,
      relativePath: version.relativePath,
      sha256: version.sha256,
      mediaProbeUid: normalized.mediaProbeUid,
      mediaProbeSha256: normalized.mediaProbeSha256,
      durationMs: version.durationMs,
      placements: placements(snapshot, normalized),
    });
  }));
}

function createMediaExportExecutionPlan(value) {
  try {
    const input = exactObject(value, INPUT_KEYS, INPUT_CODE);
    if (input.schemaVersion !== '8.0') invalid();
    const uid = canonicalUid(input.uid, INPUT_CODE);
    const snapshot = trustedTimeline(input.productionTimelineSnapshot);
    const normalization = trustedNormalization(input.normalizationPlan);
    const createdAtEpochMs = epoch(input.createdAtEpochMs, INPUT_CODE);
    assertPlanBinding(snapshot, normalization);
    if (createdAtEpochMs < snapshot.createdAtEpochMs
      || createdAtEpochMs < normalization.createdAtEpochMs
      || new Set([uid, snapshot.uid, normalization.uid, snapshot.audioMixPlan.uid]).size !== 4) {
      invalid();
    }
    const subtitleDocument = createAssSubtitleDocument(snapshot);
    const base = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      algorithmVersion: ALGORITHM_VERSION,
      uid,
      dramaUid: snapshot.dramaUid,
      workflowRunUid: snapshot.workflowRunUid,
      mode: snapshot.audioTimeline.mode,
      durationMs: snapshot.durationMs,
      productionTimelineSnapshotUid: snapshot.uid,
      productionTimelineSnapshotSha256: snapshot.snapshotSha256,
      normalizationPlanUid: normalization.uid,
      normalizationPlanSha256: normalization.planSha256,
      profile: normalization.profile,
      videoSources: videoSources(snapshot, normalization),
      audioSources: audioSources(snapshot, normalization),
      subtitleTrackSha256: snapshot.subtitleTrack.trackSha256,
      subtitleDocument,
      audioMixPlan: snapshot.audioMixPlan,
      outputRelativePath: `projects/${snapshot.dramaUid}/exports/${uid}.mp4`,
      createdAtEpochMs,
    });
    const record = Object.freeze({ ...base, executionPlanSha256: canonicalHash(base) });
    TRUSTED_PLANS.add(record);
    return record;
  } catch {
    return invalid();
  }
}

function safeRelativeMedia(value, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
    || value.includes('\\') || value.includes('\0') || value !== value.trim()
    || value.startsWith('/') || value.includes(':')
    || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    invalid(code);
  }
  return value;
}

function persistedSubtitle(value, trackSha256, code) {
  const input = exactObject(value, SUBTITLE_DOCUMENT_KEYS, code);
  if (input.schemaVersion !== 'ass-subtitle-document.v1'
    || input.algorithmVersion !== 'ass-burn-in-centisecond.v1'
    || sha256(input.trackSha256, code) !== trackSha256
    || typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > 2 * 1024 * 1024
    || textHash(input.content) !== sha256(input.contentSha256, code)) invalid(code);
  const base = Object.freeze({
    schemaVersion: input.schemaVersion,
    algorithmVersion: input.algorithmVersion,
    timelineUid: canonicalUid(input.timelineUid, code),
    trackSha256: input.trackSha256,
    cueCount: boundedInteger(input.cueCount, 0, 100_000, code),
    content: input.content,
    contentSha256: input.contentSha256,
  });
  if (canonicalHash(base) !== sha256(input.documentSha256, code)) invalid(code);
  return Object.freeze({ ...base, documentSha256: input.documentSha256 });
}

function persistedVideoSources(value, durationMs, code) {
  const records = [];
  let previousEndMs = 0;
  for (const [ordinal, entry] of denseArray(value, 100_000, code).entries()) {
    const input = exactObject(entry, VIDEO_SOURCE_KEYS, code);
    const startMs = boundedInteger(input.startMs, 0, durationMs, code);
    const endMs = boundedInteger(input.endMs, 1, durationMs, code);
    const record = Object.freeze({
      ordinal: boundedInteger(input.ordinal, 0, 99_999, code),
      shotId: typeof input.shotId === 'string' && input.shotId.length >= 1
        && input.shotId.length <= 256 ? input.shotId : invalid(code),
      startMs,
      endMs,
      durationMs: boundedInteger(input.durationMs, 1, durationMs, code),
      assetVersionUid: canonicalUid(input.assetVersionUid, code),
      relativePath: safeRelativeMedia(input.relativePath, code),
      sha256: sha256(input.sha256, code),
      mediaProbeUid: canonicalUid(input.mediaProbeUid, code),
      mediaProbeSha256: sha256(input.mediaProbeSha256, code),
    });
    if (record.ordinal !== ordinal || record.endMs - record.startMs !== record.durationMs
      || record.startMs !== previousEndMs) invalid(code);
    records.push(record);
    previousEndMs = record.endMs;
  }
  if (records.length < 1 || records.at(-1).endMs !== durationMs) invalid(code);
  return frozenArray(records);
}

function persistedAudioSources(value, durationMs, mode, code) {
  const records = denseArray(value, 100_000, code).map((entry, ordinal) => {
    const input = exactObject(entry, AUDIO_SOURCE_KEYS, code);
    const placements = denseArray(input.placements, 100_000, code).map((placement) => {
      const range = exactObject(placement, PLACEMENT_KEYS, code);
      const startMs = boundedInteger(range.startMs, 0, durationMs, code);
      const endMs = boundedInteger(range.endMs, 1, durationMs, code);
      if (endMs <= startMs) invalid(code);
      return Object.freeze({ startMs, endMs });
    });
    if (placements.length < 1) invalid(code);
    return Object.freeze({
      ordinal: input.ordinal === ordinal ? ordinal : invalid(code),
      role: ['dialogue', 'native', 'bgm'].includes(input.role) ? input.role : invalid(code),
      sourceKind: ['tts_asset', 'h3_native', 'bgm'].includes(input.sourceKind)
        ? input.sourceKind : invalid(code),
      assetVersionUid: canonicalUid(input.assetVersionUid, code),
      relativePath: safeRelativeMedia(input.relativePath, code),
      sha256: sha256(input.sha256, code),
      mediaProbeUid: canonicalUid(input.mediaProbeUid, code),
      mediaProbeSha256: sha256(input.mediaProbeSha256, code),
      durationMs: boundedInteger(input.durationMs, 1, 3_600_100, code),
      placements: frozenArray(placements),
    });
  });
  const roles = new Set(records.map((entry) => entry.role));
  if (!roles.has('bgm')
    || (mode === 'independent_tts' && (roles.has('native') || !roles.has('dialogue')))
    || (mode === 'h3_native' && (roles.has('dialogue') || !roles.has('native')))
    || (mode === 'hybrid' && (!roles.has('dialogue') || !roles.has('native')))) invalid(code);
  return frozenArray(records);
}

function parseMediaExportExecutionPlanRecord(value) {
  try {
    const input = exactObject(value, RECORD_KEYS, DATA_CODE);
    if (input.schemaVersion !== SCHEMA_VERSION || input.algorithmVersion !== ALGORITHM_VERSION
      || !['independent_tts', 'h3_native', 'hybrid'].includes(input.mode)) invalid(DATA_CODE);
    const uid = canonicalUid(input.uid, DATA_CODE);
    const dramaUid = canonicalUid(input.dramaUid, DATA_CODE);
    const durationMs = boundedInteger(input.durationMs, 1, 3_600_000, DATA_CODE);
    const profile = parseMediaExportProfileRecord(input.profile);
    const subtitleTrackSha256 = sha256(input.subtitleTrackSha256, DATA_CODE);
    const audioMixPlan = parseAudioMixPlanRecord(input.audioMixPlan);
    if (audioMixPlan.dramaUid !== dramaUid || audioMixPlan.mode !== input.mode
      || audioMixPlan.durationMs !== durationMs) invalid(DATA_CODE);
    const base = Object.freeze({
      schemaVersion: input.schemaVersion,
      algorithmVersion: input.algorithmVersion,
      uid,
      dramaUid,
      workflowRunUid: canonicalUid(input.workflowRunUid, DATA_CODE),
      mode: input.mode,
      durationMs,
      productionTimelineSnapshotUid: canonicalUid(input.productionTimelineSnapshotUid, DATA_CODE),
      productionTimelineSnapshotSha256: sha256(input.productionTimelineSnapshotSha256, DATA_CODE),
      normalizationPlanUid: canonicalUid(input.normalizationPlanUid, DATA_CODE),
      normalizationPlanSha256: sha256(input.normalizationPlanSha256, DATA_CODE),
      profile,
      videoSources: persistedVideoSources(input.videoSources, durationMs, DATA_CODE),
      audioSources: persistedAudioSources(input.audioSources, durationMs, input.mode, DATA_CODE),
      subtitleTrackSha256,
      subtitleDocument: persistedSubtitle(input.subtitleDocument, subtitleTrackSha256, DATA_CODE),
      audioMixPlan,
      outputRelativePath: safeRelativeMedia(input.outputRelativePath, DATA_CODE),
      createdAtEpochMs: epoch(input.createdAtEpochMs, DATA_CODE),
    });
    if (base.outputRelativePath !== `projects/${dramaUid}/exports/${uid}.mp4`
      || canonicalHash(base) !== sha256(input.executionPlanSha256, DATA_CODE)) invalid(DATA_CODE);
    const record = freezeSnapshot({ ...base, executionPlanSha256: input.executionPlanSha256 });
    TRUSTED_PLANS.add(record);
    return record;
  } catch {
    return invalid(DATA_CODE);
  }
}

function requireTrustedMediaExportExecutionPlan(value) {
  if ((typeof value === 'object' || typeof value === 'function')
    && value !== null && TRUSTED_PLANS.has(value)) return value;
  return invalid(DATA_CODE);
}

module.exports = Object.freeze({
  MEDIA_EXPORT_ALGORITHM_VERSION: ALGORITHM_VERSION,
  MEDIA_EXPORT_EXECUTION_PLAN_SCHEMA_VERSION: SCHEMA_VERSION,
  createMediaExportExecutionPlan,
  parseMediaExportExecutionPlanRecord,
  requireTrustedMediaExportExecutionPlan,
});
