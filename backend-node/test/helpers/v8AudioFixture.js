'use strict';

const { createDialogueDeliveryPlan } = require('../../src/audio/dialogueDelivery');
const { createVoiceProfileRecord } = require('../../src/audio/voiceProfile');
const {
  createAudioModePlan,
  createAudioModePlanVerifier,
} = require('../../src/audio/audioMode');
const { createAudioExecutionEvidence } = require('../../src/audio/audioExecutionEvidence');
const {
  createAudioTimeline,
  createAudioTimelineVerifier,
} = require('../../src/audio/audioTimeline');
const {
  createAudioMixPlan,
  createAudioMixPlanVerifier,
} = require('../../src/audio/audioMixPlan');
const {
  createProductionTimelineSnapshot,
  createProductionTimelineSnapshotVerifier,
} = require('../../src/audio/productionTimelineSnapshot');
const { createBgmTrack } = require('../../src/audio/bgmTrack');
const { createGenerationHistoryRecord } = require('../../src/assets/generationHistory');
const {
  compileH3ShotPrompt,
  normalizeH3GenerationSpec,
  validateH3VideoOutput,
} = require('../../src/h3');

function uid(number) {
  return `86000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function assetVersionEvidence({
  version,
  asset,
  mimeType = 'audio/wav',
  durationMs,
  width = null,
  height = null,
  sha,
  relativePath,
}) {
  return {
    uid: uid(version),
    assetUid: uid(asset),
    storageProvider: 'local',
    logicalUri: `asset://dramas/${uid(1)}/${relativePath}`,
    relativePath,
    sha256: sha,
    mimeType,
    width,
    height,
    durationMs,
    parentUid: null,
    status: 'ready',
    createdAt: '2027-01-15T08:00:00.000Z',
  };
}

function assetEvidence({ asset, version, assetType = 'audio' }) {
  return {
    uid: uid(asset),
    ownerType: 'drama',
    ownerUid: uid(1),
    assetType,
    currentVersionUid: uid(version),
    status: 'ready',
    createdAt: '2027-01-15T07:59:59.000Z',
    updatedAt: '2027-01-15T08:00:00.000Z',
  };
}

function voiceProfile() {
  return createVoiceProfileRecord({
    schemaVersion: '8.0',
    uid: uid(100),
    dramaUid: uid(1),
    characterUid: uid(10),
    characterVoiceVersionUid: uid(200),
    parentUid: null,
    revision: 1,
    provider: 'minimax',
    model: 'speech-02-hd',
    voiceKey: 'female-shaonv',
    credentialRef: `credential:v1:${uid(300)}`,
    sourceKind: 'provider-preset',
    status: 'ready',
    defaultEmotion: 'neutral',
    emotionMap: {
      neutral: 'neutral',
      happy: 'happy',
      sad: 'sad',
      angry: 'angry',
      fearful: 'fearful',
      surprised: 'surprised',
    },
    minimumSpeedPermille: 700,
    defaultSpeedPermille: 1000,
    maximumSpeedPermille: 1400,
    voiceVersion: {
      uid: uid(200),
      identityVersionUid: uid(400),
      parentUid: null,
      name: 'Synthetic contract voice',
      language: 'zh-CN',
      style: 'Synthetic provider preset for deterministic tests.',
      createdAtEpochMs: 1_800_000_000_000,
    },
    createdAtEpochMs: 1_800_000_000_000,
  });
}

function delivery(number, profileUid) {
  return createDialogueDeliveryPlan({
    schemaVersion: '8.0',
    timingAlgorithmVersion: 'dialogue-timing.v1',
    uid: uid(500 + number),
    dramaUid: uid(1),
    scriptResultUid: uid(2),
    shotId: `shot-${number}`,
    dialogueEntryId: `dialogue-${number}`,
    characterUid: uid(10),
    voiceProfileUid: profileUid,
    text: number === 1 ? '住手！' : '先打赢我。',
    emotion: number === 1 ? 'angry' : 'neutral',
    emotionIntensityPermille: number === 1 ? 850 : 500,
    speedPermille: number === 1 ? 1100 : 900,
    pauseBeforeMs: number === 1 ? 0 : 180,
    pauseAfterMs: 120,
  });
}

function h3GenerationSource() {
  const prompt = compileH3ShotPrompt({
    dramaUid: uid(1),
    semanticShot: {
      shotId: 'shot-h3',
      ordinal: 1,
      durationSeconds: 2,
      continuitySnapshotUid: uid(700),
      subjects: { description: 'Two fighters circle each other.', characters: [] },
      environment: {
        sceneId: 'courtyard',
        description: 'Rain falls across a stone courtyard.',
        scene: { sceneUid: uid(701), versionUid: uid(702) },
        props: [],
      },
      action: 'They exchange two fast strikes and separate.',
      camera: {
        shotSize: 'MS',
        cameraAngle: 'eye_level',
        cameraMovement: 'pan',
        composition: 'Both fighters remain visible across the frame.',
      },
      lighting: {
        quality: 'soft',
        direction: 'side',
        colorTemperature: 'cool',
        description: 'Cool rain light separates both silhouettes.',
      },
      continuity: {
        transitionFromPrevious: 'start',
        screenDirection: 'left_to_right',
        axisStrategy: 'establish',
        notes: 'The first fighter starts frame left.',
      },
    },
  });
  const generationSpec = normalizeH3GenerationSpec({
    mode: 't2v',
    prompt,
    width: 608,
    height: 352,
    durationSeconds: 1,
    seed: 42,
    referenceImages: [],
  });
  const videoEvidence = validateH3VideoOutput({
    generationSpec,
    measured: {
      sha256: 'b'.repeat(64),
      bytes: 220000,
      mimeType: 'video/mp4',
      width: 608,
      height: 352,
      durationMs: 1625,
      frames: 39,
      fps: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioStreams: 1,
      blackFrameRatio: 0.01,
      frozenFrameRatio: 0.02,
    },
  });
  return {
    generationHistoryUid: uid(703),
    generationSpec,
    videoEvidence,
    videoAsset: assetEvidence({ asset: 705, version: 704, assetType: 'video' }),
    videoVersionEvidence: assetVersionEvidence({
      version: 704,
      asset: 705,
      mimeType: 'video/mp4',
      durationMs: 1625,
      width: 608,
      height: 352,
      sha: 'b'.repeat(64),
      relativePath: 'videos/h3-shot.mp4',
    }),
  };
}

function planInput(mode) {
  const profile = voiceProfile();
  return {
    schemaVersion: '8.0',
    uid: uid(20),
    dramaUid: uid(1),
    workflowRunUid: uid(21),
    mode,
    dialogueDeliveries: [delivery(1, profile.uid), delivery(2, profile.uid)],
    voiceProfiles: mode === 'h3_native' ? [] : [profile],
    h3GenerationSource: mode === 'independent_tts' ? null : h3GenerationSource(),
    createdAtEpochMs: 1_800_000_100_000,
  };
}

function planEnvelope(input) {
  return {
    schemaVersion: input.schemaVersion,
    uid: input.uid,
    dramaUid: input.dramaUid,
    workflowRunUid: input.workflowRunUid,
    mode: input.mode,
    dialogueDeliveries: input.dialogueDeliveries,
    voiceProfiles: input.voiceProfiles,
    h3GenerationSource: input.h3GenerationSource,
    createdAtEpochMs: input.createdAtEpochMs,
  };
}

function verifiedPlan(input) {
  return createAudioModePlanVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== input.uid) throw new Error('synthetic-plan-anchor-mismatch');
      return planEnvelope(input);
    },
  }).verify(createAudioModePlan(input), input.uid);
}

function ttsOutputs(plan, durations) {
  return plan.ttsRequests.map((request, index) => ({
    dialogueDeliveryUid: request.dialogueDeliveryUid,
    requestSha256: request.requestSha256,
    audioAsset: assetEvidence({ asset: 920 + index, version: 910 + index }),
    audioVersionEvidence: assetVersionEvidence({
      version: 910 + index,
      asset: 920 + index,
      durationMs: durations[index],
      sha: String(index + 1).repeat(64),
      relativePath: `audio/dialogue-${index + 1}.wav`,
    }),
  }));
}

function createTimelineFixture(mode = 'independent_tts', durations = [700, 800]) {
  const rawPlan = planInput(mode);
  const plan = verifiedPlan(rawPlan);
  const execution = createAudioExecutionEvidence({
    schemaVersion: '8.0',
    uid: uid(930),
    plan,
    ttsOutputs: mode === 'h3_native' ? [] : ttsOutputs(plan, durations),
    createdAtEpochMs: 1_800_000_200_000,
  });
  const envelope = {
    schemaVersion: '8.0',
    uid: uid(950),
    plan,
    executionEvidence: execution,
    createdAtEpochMs: 1_800_000_300_000,
  };
  const candidate = createAudioTimeline(envelope);
  const verifier = createAudioTimelineVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== envelope.uid) throw new Error('synthetic-timeline-anchor-mismatch');
      return envelope;
    },
  });
  return Object.freeze({
    envelope,
    candidate,
    timeline: verifier.verify(JSON.parse(JSON.stringify(candidate)), envelope.uid),
  });
}

function createBgmTrackFixture(overrides = {}) {
  const durationMs = overrides.durationMs ?? 1000;
  const dramaUid = overrides.dramaUid ?? uid(1);
  const trackUid = overrides.uid ?? uid(1000);
  const assetUid = overrides.assetUid ?? uid(1001);
  const assetVersionUid = overrides.assetVersionUid ?? uid(1002);
  const license = overrides.license ?? {
    schemaVersion: 'bgm-license.v1',
    uid: uid(1003),
    basis: 'licensed',
    attestationKind: 'user-attestation',
    commercialUseAllowed: true,
    derivativesAllowed: true,
    attributionRequired: false,
    attributionText: null,
    attestedAtEpochMs: 1_800_000_250_000,
  };
  return createBgmTrack({
    schemaVersion: 'bgm-track.v1',
    uid: trackUid,
    dramaUid,
    title: 'Synthetic score',
    sourceKind: 'local-import',
    providerId: 'local-library',
    assetVersion: {
      uid: assetVersionUid,
      assetUid,
      storageProvider: 'local',
      logicalUri: `asset://dramas/${dramaUid}/bgm/${assetUid}/${assetVersionUid}`,
      relativePath: `projects/${dramaUid}/assets/bgm/${assetUid}/${assetVersionUid}.wav`,
      sha256: 'c'.repeat(64),
      mimeType: 'audio/wav',
      width: null,
      height: null,
      durationMs,
      parentUid: null,
      status: 'ready',
      createdAt: '2027-01-15T08:00:00.000Z',
    },
    license,
    createdAtEpochMs: overrides.createdAtEpochMs ?? 1_800_000_250_000,
  });
}

function mixSettings(mode, overrides = {}) {
  return {
    dialogueGainMilliDb: mode === 'h3_native' ? null : 0,
    nativeGainMilliDb: mode === 'independent_tts' ? null : -3000,
    bgmGainMilliDb: -9000,
    duckedBgmGainMilliDb: -18000,
    fadeInMs: 200,
    fadeOutMs: 300,
    duckingAttackMs: 50,
    duckingReleaseMs: 100,
    ...overrides,
  };
}

function createAudioMixFixture(mode = 'independent_tts', durations = [700, 800]) {
  const timelineFixture = createTimelineFixture(mode, durations);
  const bgmTrack = createBgmTrackFixture();
  const input = {
    schemaVersion: '8.0',
    uid: uid(1100),
    audioTimeline: timelineFixture.timeline,
    bgmTrack,
    settings: mixSettings(mode),
    createdAtEpochMs: 1_800_000_400_000,
  };
  const candidate = createAudioMixPlan(input);
  const verifier = createAudioMixPlanVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== input.uid) throw new Error('synthetic-mix-anchor-mismatch');
      return input;
    },
  });
  return Object.freeze({
    input,
    candidate,
    verifier,
    plan: verifier.verify(JSON.parse(JSON.stringify(candidate)), input.uid),
    timelineFixture,
    bgmTrack,
  });
}

function sourceEvidenceFromTimeline(timeline) {
  const sources = [];
  const seen = new Set();
  function add(source) {
    if (seen.has(source.sourceAssetVersionUid)) return;
    seen.add(source.sourceAssetVersionUid);
    const native = source.sourceKind === 'h3_native';
    const durationMs = native
      ? timeline.nativeTrack.durationMs
      : source.durationMs;
    const version = {
      uid: source.sourceAssetVersionUid,
      assetUid: source.sourceAssetUid,
      storageProvider: 'local',
      logicalUri: `asset://dramas/${timeline.dramaUid}/timeline/${source.sourceAssetUid}/${source.sourceAssetVersionUid}`,
      relativePath: native
        ? `projects/${timeline.dramaUid}/assets/video/${source.sourceAssetUid}/${source.sourceAssetVersionUid}.mp4`
        : `projects/${timeline.dramaUid}/assets/audio/${source.sourceAssetUid}/${source.sourceAssetVersionUid}.wav`,
      sha256: source.sourceMediaSha256,
      mimeType: source.sourceMimeType,
      width: native ? 608 : null,
      height: native ? 352 : null,
      durationMs,
      parentUid: null,
      status: 'ready',
      createdAt: '2027-01-15T08:00:00.000Z',
    };
    sources.push({
      sourceKind: source.sourceKind,
      asset: {
        uid: source.sourceAssetUid,
        ownerType: 'drama',
        ownerUid: timeline.dramaUid,
        assetType: native ? 'video' : 'audio',
        currentVersionUid: source.sourceAssetVersionUid,
        status: 'ready',
        createdAt: '2027-01-15T07:59:59.000Z',
        updatedAt: '2027-01-15T08:00:00.000Z',
      },
      assetVersion: version,
    });
  }
  timeline.segments.forEach(add);
  if (timeline.nativeTrack !== null) {
    add({
      sourceKind: 'h3_native',
      sourceAssetUid: timeline.nativeTrack.sourceAssetUid,
      sourceAssetVersionUid: timeline.nativeTrack.sourceAssetVersionUid,
      sourceMediaSha256: timeline.nativeTrack.sourceMediaSha256,
      sourceMimeType: timeline.nativeTrack.sourceMimeType,
      durationMs: timeline.nativeTrack.durationMs,
    });
  }
  return sources;
}

function timelineShots(durationMs, dramaUid, workflowRunUid) {
  const durations = durationMs === 1500 ? [700, 800] : [800, durationMs - 800];
  return durations.map((clipDurationMs, index) => {
    const assetNumber = 1210 + index;
    const versionNumber = 1200 + index;
    const asset = assetEvidence({ asset: assetNumber, version: versionNumber, assetType: 'video' });
    const assetVersion = assetVersionEvidence({
      version: versionNumber,
      asset: assetNumber,
      mimeType: 'video/mp4',
      durationMs: clipDurationMs,
      width: 608,
      height: 352,
      sha: String(index + 4).repeat(64),
      relativePath: `videos/shot-${index + 1}.mp4`,
    });
    const promptSemanticUid = uid(1240 + index);
    const manifestUid = uid(1250 + index);
    const generationRunUid = uid(1260 + index);
    const historyUid = uid(1220 + index);
    const generationHistory = createGenerationHistoryRecord({
      uid: historyUid,
      runUid: generationRunUid,
      dramaUid,
      assetUid: asset.uid,
      promptSemanticUid,
      manifestUid,
      manifestSha256: String(index + 6).repeat(64),
      provider: 'local-comfy',
      model: 'MiniMax-H3',
      seed: index + 1,
      parameters: { width: 608, height: 352 },
      input: {
        promptSemanticUid,
        manifestUid,
        generationSpec: { prompt: { shotId: `shot-${index + 1}` } },
      },
      status: 'succeeded',
      outputVersionUid: assetVersion.uid,
      outputVersionEvidence: assetVersion,
      parentVersionUid: null,
      parentVersionEvidence: null,
      errorCode: null,
      errorDetailRef: null,
      createdAtEpochMs: 1_800_000_100_000 + index,
      completedAtEpochMs: 1_800_000_200_000 + index,
    });
    return {
      shotId: `shot-${index + 1}`,
      plannedOrdinal: index + 1,
      h3ExecutionResult: {
        schemaVersion: 'h3-local-execution-result.v2',
        taskUid: uid(1270 + index),
        taskStateVersion: 9,
        workflowRunUid,
        generationRunUid,
        historyUid,
        assetUid: asset.uid,
        assetVersionUid: assetVersion.uid,
        nodeRunUid: uid(1280 + index),
        status: 'succeeded',
      },
      generationHistory,
      asset,
      assetVersion,
    };
  });
}

function createProductionTimelineFixture(mode = 'independent_tts') {
  const mixFixture = createAudioMixFixture(mode);
  const input = {
    schemaVersion: '8.0',
    uid: uid(1300),
    audioTimeline: mixFixture.timelineFixture.timeline,
    audioMixPlan: mixFixture.plan,
    shots: timelineShots(
      mixFixture.plan.durationMs,
      mixFixture.plan.dramaUid,
      mixFixture.plan.workflowRunUid,
    ),
    audioSources: sourceEvidenceFromTimeline(mixFixture.timelineFixture.timeline),
    bgmTrack: mixFixture.bgmTrack,
    createdAtEpochMs: 1_800_000_500_000,
  };
  const candidate = createProductionTimelineSnapshot(input);
  const verifier = createProductionTimelineSnapshotVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== input.uid) throw new Error('synthetic-snapshot-anchor-mismatch');
      return input;
    },
    loadGenerationHistory(expectedUid) {
      const shot = input.shots.find((entry) => entry.generationHistory.uid === expectedUid);
      if (!shot) throw new Error('synthetic-history-anchor-mismatch');
      return shot.generationHistory;
    },
    loadH3ExecutionResult(expectedUid) {
      const shot = input.shots.find((entry) => entry.h3ExecutionResult.taskUid === expectedUid);
      if (!shot) throw new Error('synthetic-h3-execution-anchor-mismatch');
      return shot.h3ExecutionResult;
    },
  });
  return Object.freeze({
    input,
    candidate,
    verifier,
    snapshot: verifier.verify(JSON.parse(JSON.stringify(candidate)), input.uid),
    mixFixture,
  });
}

module.exports = Object.freeze({
  createAudioMixFixture,
  createBgmTrackFixture,
  createProductionTimelineFixture,
  createTimelineFixture,
  uid,
});
