'use strict';

const {
  canonicalHash,
  canonicalUid,
  epoch,
  exactObject,
  fail,
  frozenArray,
} = require('../audio/audioContract');
const {
  requireTrustedProductionTimelineSnapshot,
} = require('../audio/productionTimelineSnapshot');
const {
  requireTrustedMediaNormalizationPlan,
} = require('./mediaNormalizationPlan');
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

function requireTrustedMediaExportExecutionPlan(value) {
  if ((typeof value === 'object' || typeof value === 'function')
    && value !== null && TRUSTED_PLANS.has(value)) return value;
  return invalid(DATA_CODE);
}

module.exports = Object.freeze({
  MEDIA_EXPORT_ALGORITHM_VERSION: ALGORITHM_VERSION,
  MEDIA_EXPORT_EXECUTION_PLAN_SCHEMA_VERSION: SCHEMA_VERSION,
  createMediaExportExecutionPlan,
  requireTrustedMediaExportExecutionPlan,
});
