'use strict';

const {
  createMediaProbeEvidence,
  createMediaProbeEvidenceVerifier,
} = require('../../src/media/mediaProbeEvidence');
const {
  createMediaNormalizationPlan,
  createMediaNormalizationPlanVerifier,
} = require('../../src/media/mediaNormalizationPlan');
const { createProductionTimelineFixture, uid } = require('./v8AudioFixture');

function probeInput(assetVersion, number, { includeAudio = false } = {}) {
  const video = assetVersion.mimeType === 'video/mp4';
  return {
    schemaVersion: '8.0',
    uid: uid(number),
    assetVersion,
    bytes: 10_000 + number,
    durationMs: assetVersion.durationMs,
    formatNames: video ? ['mov', 'mp4'] : ['wav'],
    video: video ? {
      codecName: 'h264',
      width: assetVersion.width,
      height: assetVersion.height,
      pixelFormat: 'yuv420p',
      averageFrameRate: { numerator: 24, denominator: 1 },
      timeBase: { numerator: 1, denominator: 90_000 },
      sampleAspectRatio: '1:1',
      displayAspectRatio: '19:11',
      frameCount: Math.max(1, Math.round((assetVersion.durationMs * 24) / 1000)),
    } : null,
    audio: (!video || includeAudio) ? {
      codecName: video ? 'aac' : 'pcm_s16le',
      sampleRateHz: 48_000,
      channels: 2,
      channelLayout: 'stereo',
      sampleFormat: 'fltp',
    } : null,
    decoded: true,
    probedAtEpochMs: 1_800_000_600_000 + number,
  };
}

function trustedProbe(input) {
  const candidate = createMediaProbeEvidence(input);
  const verifier = createMediaProbeEvidenceVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== input.uid) throw new Error('synthetic-probe-anchor-mismatch');
      return input;
    },
  });
  return verifier.verify(JSON.parse(JSON.stringify(candidate)), input.uid);
}

function createMediaNormalizationFixture(mode = 'independent_tts') {
  const timelineFixture = createProductionTimelineFixture(mode);
  const snapshot = timelineFixture.snapshot;
  const versions = [];
  const seen = new Set();
  const append = (assetVersion, includeAudio = false) => {
    const existing = versions.find((entry) => entry.assetVersion.uid === assetVersion.uid);
    if (existing) {
      existing.includeAudio ||= includeAudio;
      return;
    }
    if (seen.has(assetVersion.uid)) return;
    seen.add(assetVersion.uid);
    versions.push({ assetVersion, includeAudio });
  };
  snapshot.shots.forEach((shot) => append(shot.assetVersion));
  snapshot.audioSources.forEach((source) => append(
    source.assetVersion,
    source.sourceKind === 'h3_native',
  ));
  append(snapshot.bgmTrack.assetVersion);

  const probeInputs = versions.map((entry, index) => probeInput(
    entry.assetVersion,
    1401 + index,
    { includeAudio: entry.includeAudio },
  ));
  const mediaProbes = probeInputs.map(trustedProbe);
  const input = {
    schemaVersion: '8.0',
    uid: uid(1400),
    productionTimelineSnapshot: snapshot,
    mediaProbes,
    createdAtEpochMs: 1_800_000_700_000,
  };
  const candidate = createMediaNormalizationPlan(input);
  const verifier = createMediaNormalizationPlanVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== input.uid) throw new Error('synthetic-plan-anchor-mismatch');
      return {
        schemaVersion: '8.0',
        uid: input.uid,
        productionTimelineSnapshot: input.productionTimelineSnapshot,
        mediaProbeUids: input.mediaProbes.map((probe) => probe.uid),
        createdAtEpochMs: input.createdAtEpochMs,
      };
    },
    loadMediaProbeEvidence(expectedUid) {
      const probe = mediaProbes.find((entry) => entry.uid === expectedUid);
      if (!probe) throw new Error('synthetic-probe-missing');
      return probe;
    },
  });
  return Object.freeze({
    timelineFixture,
    probeInputs,
    mediaProbes,
    input,
    candidate,
    verifier,
    plan: verifier.verify(JSON.parse(JSON.stringify(candidate)), input.uid),
  });
}

module.exports = Object.freeze({
  createMediaNormalizationFixture,
  probeInput,
  trustedProbe,
});
