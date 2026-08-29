'use strict';

const { types: { isProxy } } = require('node:util');

const {
  canonicalHash,
  canonicalUid,
  denseArray,
  epoch,
  exactObject,
  fail,
  frozenArray,
  textHash,
} = require('../audio/audioContract');
const {
  requireTrustedProductionTimelineSnapshot,
} = require('../audio/productionTimelineSnapshot');
const {
  getMvpMediaExportProfile,
  requireTrustedMediaExportProfile,
} = require('./mediaExportProfile');
const {
  requireTrustedMediaProbeEvidence,
} = require('./mediaProbeEvidence');
const {
  MAX_MEDIA_INPUTS,
  MEDIA_NORMALIZATION_ALGORITHM_VERSION,
  MEDIA_NORMALIZATION_SCHEMA_VERSION,
  parseMediaNormalizationPlanRecord,
} = require('./mediaNormalizationRecord');

const INPUT_CODE = 'MEDIA_NORMALIZATION_INPUT_INVALID';
const DATA_CODE = 'MEDIA_NORMALIZATION_DATA_INVALID';
const INPUT_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'productionTimelineSnapshot', 'mediaProbes', 'createdAtEpochMs',
]);
const ENVELOPE_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'productionTimelineSnapshot', 'mediaProbeUids', 'createdAtEpochMs',
]);
const TRUSTED_PLANS = new WeakSet();

function invalid(code = DATA_CODE) {
  fail(code);
}

function safeTrustedTimeline(value, code) {
  try {
    return requireTrustedProductionTimelineSnapshot(value);
  } catch {
    return invalid(code);
  }
}

function safeTrustedProbe(value, code) {
  try {
    return requireTrustedMediaProbeEvidence(value);
  } catch {
    return invalid(code);
  }
}

function safeProfile() {
  try {
    return requireTrustedMediaExportProfile(getMvpMediaExportProfile());
  } catch {
    return invalid(INPUT_CODE);
  }
}

function targetFrameRate(profile) {
  return Object.freeze({
    numerator: profile.video.frameRate.numerator,
    denominator: profile.video.frameRate.denominator,
  });
}

function videoTarget(profile) {
  return Object.freeze({
    width: profile.video.width,
    height: profile.video.height,
    frameRate: targetFrameRate(profile),
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

function expectedMedia(snapshot) {
  const entries = [];
  const indexByVersion = new Map();
  const append = (assetVersion, usage) => {
    const existingIndex = indexByVersion.get(assetVersion.uid);
    if (existingIndex !== undefined) {
      entries[existingIndex].usages.push(usage);
      return;
    }
    indexByVersion.set(assetVersion.uid, entries.length);
    entries.push({ assetVersion, usages: [usage] });
  };
  snapshot.shots.forEach((shot) => append(shot.assetVersion, Object.freeze({
    kind: 'video', shot,
  })));
  snapshot.audioSources.forEach((source) => append(source.assetVersion, Object.freeze({
    kind: 'audio', source,
  })));
  append(snapshot.bgmTrack.assetVersion, Object.freeze({
    kind: 'bgm', track: snapshot.bgmTrack,
  }));
  return entries;
}

function assertProbeMatchesVersion(probe, version, usages, createdAtEpochMs, code) {
  if (probe.assetVersionUid !== version.uid || probe.assetUid !== version.assetUid
    || probe.assetVersionSha256 !== version.sha256
    || probe.relativePathSha256 !== textHash(version.relativePath)
    || probe.mimeType !== version.mimeType || probe.probedAtEpochMs > createdAtEpochMs) invalid(code);
  const videoUse = usages.some((usage) => usage.kind === 'video');
  const nativeUse = usages.some((usage) => (
    usage.kind === 'audio' && usage.source.sourceKind === 'h3_native'
  ));
  const audioOnlyUse = usages.some((usage) => (
    usage.kind === 'bgm' || (usage.kind === 'audio' && usage.source.sourceKind === 'tts_asset')
  ));
  if (videoUse && (probe.mediaKind !== 'video' || probe.video === null)) invalid(code);
  if (nativeUse && (probe.mediaKind !== 'video' || probe.audio === null)) invalid(code);
  if (audioOnlyUse && (probe.mediaKind !== 'audio' || probe.audio === null || probe.video !== null)) {
    invalid(code);
  }
}

function canonicalProbes(value, snapshot, createdAtEpochMs, code) {
  const probes = denseArray(value, MAX_MEDIA_INPUTS, code).map((entry) => safeTrustedProbe(entry, code));
  const expected = expectedMedia(snapshot);
  if (probes.length !== expected.length) invalid(code);
  const probeUids = new Set();
  const probeHashes = new Set();
  for (let index = 0; index < probes.length; index += 1) {
    const probe = probes[index];
    if (probeUids.has(probe.uid) || probeHashes.has(probe.evidenceSha256)) invalid(code);
    probeUids.add(probe.uid);
    probeHashes.add(probe.evidenceSha256);
    assertProbeMatchesVersion(
      probe,
      expected[index].assetVersion,
      expected[index].usages,
      createdAtEpochMs,
      code,
    );
  }
  return Object.freeze({ probes: frozenArray(probes), expected });
}

function videoInputs(snapshot, probesByVersion, profile) {
  return frozenArray(snapshot.shots.map((shot, ordinal) => {
    const probe = probesByVersion.get(shot.assetVersion.uid);
    if (!probe?.video) invalid(INPUT_CODE);
    return Object.freeze({
      ordinal,
      shotId: shot.shotId,
      assetVersionUid: shot.assetVersion.uid,
      assetVersionSha256: shot.assetVersion.sha256,
      mediaProbeUid: probe.uid,
      mediaProbeSha256: probe.evidenceSha256,
      source: Object.freeze({
        durationMs: probe.durationMs,
        width: probe.video.width,
        height: probe.video.height,
        frameRate: probe.video.averageFrameRate,
      }),
      target: videoTarget(profile),
    });
  }));
}

function audioInputs(snapshot, probesByVersion, profile) {
  const records = [];
  const append = (role, sourceKind, version) => {
    const probe = probesByVersion.get(version.uid);
    if (!probe?.audio) invalid(INPUT_CODE);
    records.push(Object.freeze({
      ordinal: records.length,
      role,
      sourceKind,
      assetVersionUid: version.uid,
      assetVersionSha256: version.sha256,
      mediaProbeUid: probe.uid,
      mediaProbeSha256: probe.evidenceSha256,
      source: Object.freeze({
        durationMs: probe.durationMs,
        codec: probe.audio.codecName,
        sampleRateHz: probe.audio.sampleRateHz,
        channels: probe.audio.channels,
        channelLayout: probe.audio.channelLayout,
      }),
      target: audioTarget(profile),
    }));
  };
  snapshot.audioSources.forEach((source) => append(
    source.sourceKind === 'h3_native' ? 'native' : 'dialogue',
    source.sourceKind,
    source.assetVersion,
  ));
  append('bgm', 'bgm', snapshot.bgmTrack.assetVersion);
  return frozenArray(records);
}

function canonicalInput(value, code) {
  const input = exactObject(value, INPUT_KEYS, code);
  if (input.schemaVersion !== '8.0') invalid(code);
  const snapshot = safeTrustedTimeline(input.productionTimelineSnapshot, code);
  const createdAtEpochMs = epoch(input.createdAtEpochMs, code);
  if (createdAtEpochMs < snapshot.createdAtEpochMs) invalid(code);
  const media = canonicalProbes(input.mediaProbes, snapshot, createdAtEpochMs, code);
  return Object.freeze({
    uid: canonicalUid(input.uid, code),
    snapshot,
    mediaProbes: media.probes,
    createdAtEpochMs,
  });
}

function buildRecord(value) {
  const profile = safeProfile();
  const probesByVersion = new Map(
    value.mediaProbes.map((probe) => [probe.assetVersionUid, probe]),
  );
  const base = Object.freeze({
    schemaVersion: MEDIA_NORMALIZATION_SCHEMA_VERSION,
    algorithmVersion: MEDIA_NORMALIZATION_ALGORITHM_VERSION,
    uid: value.uid,
    dramaUid: value.snapshot.dramaUid,
    workflowRunUid: value.snapshot.workflowRunUid,
    durationMs: value.snapshot.durationMs,
    productionTimelineSnapshotUid: value.snapshot.uid,
    productionTimelineSnapshotSha256: value.snapshot.snapshotSha256,
    profile,
    mediaProbeUids: frozenArray(value.mediaProbes.map((probe) => probe.uid)),
    videoInputs: videoInputs(value.snapshot, probesByVersion, profile),
    audioInputs: audioInputs(value.snapshot, probesByVersion, profile),
    subtitleTrackSha256: value.snapshot.subtitleTrack.trackSha256,
    audioMixPlanUid: value.snapshot.audioMixPlan.uid,
    audioMixPlanSha256: value.snapshot.audioMixPlan.mixSha256,
    createdAtEpochMs: value.createdAtEpochMs,
  });
  return Object.freeze({ ...base, planSha256: canonicalHash(base) });
}

function createMediaNormalizationPlan(value) {
  try {
    return buildRecord(canonicalInput(value, INPUT_CODE));
  } catch {
    return invalid(INPUT_CODE);
  }
}

function createMediaNormalizationPlanVerifier(value) {
  const dependencies = exactObject(
    value, ['loadTrustedEnvelope', 'loadMediaProbeEvidence'], INPUT_CODE,
  );
  if (typeof dependencies.loadTrustedEnvelope !== 'function'
    || isProxy(dependencies.loadTrustedEnvelope)
    || typeof dependencies.loadMediaProbeEvidence !== 'function'
    || isProxy(dependencies.loadMediaProbeEvidence)) invalid(INPUT_CODE);
  const loadTrustedEnvelope = dependencies.loadTrustedEnvelope;
  const loadMediaProbeEvidence = dependencies.loadMediaProbeEvidence;
  return Object.freeze({
    verify(recordValue, expectedUid) {
      try {
        const uid = canonicalUid(expectedUid, DATA_CODE);
        const stored = parseMediaNormalizationPlanRecord(recordValue);
        const envelope = exactObject(loadTrustedEnvelope(uid), ENVELOPE_KEYS, DATA_CODE);
        if (envelope.schemaVersion !== '8.0' || envelope.uid !== uid) invalid();
        const mediaProbeUids = denseArray(envelope.mediaProbeUids, MAX_MEDIA_INPUTS, DATA_CODE)
          .map((probeUid) => canonicalUid(probeUid, DATA_CODE));
        if (mediaProbeUids.length < 1 || new Set(mediaProbeUids).size !== mediaProbeUids.length) {
          invalid();
        }
        const mediaProbes = mediaProbeUids.map((probeUid) => (
          safeTrustedProbe(loadMediaProbeEvidence(probeUid), DATA_CODE)
        ));
        const expected = createMediaNormalizationPlan({
          schemaVersion: '8.0',
          uid,
          productionTimelineSnapshot: safeTrustedTimeline(
            envelope.productionTimelineSnapshot, DATA_CODE,
          ),
          mediaProbes,
          createdAtEpochMs: envelope.createdAtEpochMs,
        });
        if (JSON.stringify(stored) !== JSON.stringify(expected)) invalid();
        TRUSTED_PLANS.add(expected);
        return expected;
      } catch {
        return invalid();
      }
    },
  });
}

function requireTrustedMediaNormalizationPlan(value) {
  if ((typeof value === 'object' || typeof value === 'function')
    && value !== null && TRUSTED_PLANS.has(value)) return value;
  return invalid();
}

module.exports = Object.freeze({
  MEDIA_NORMALIZATION_ALGORITHM_VERSION,
  MEDIA_NORMALIZATION_SCHEMA_VERSION,
  createMediaNormalizationPlan,
  createMediaNormalizationPlanVerifier,
  parseMediaNormalizationPlanRecord,
  requireTrustedMediaNormalizationPlan,
});
