'use strict';

const {
  createDialogueDeliveryPlan,
} = require('../../src/audio/dialogueDelivery');
const { createVoiceProfileRecord } = require('../../src/audio/voiceProfile');
const { createAudioModePlan, createAudioModePlanVerifier } = require('../../src/audio/audioMode');
const { createAudioExecutionEvidence } = require('../../src/audio/audioExecutionEvidence');
const { createAudioTimeline, createAudioTimelineVerifier } = require('../../src/audio/audioTimeline');
const { createAudioMixPlan, createAudioMixPlanVerifier } = require('../../src/audio/audioMixPlan');
const {
  createProductionTimelineSnapshot,
  createProductionTimelineSnapshotVerifier,
} = require('../../src/audio/productionTimelineSnapshot');
const { createBgmTrack } = require('../../src/audio/bgmTrack');
const { createGenerationHistoryRecord } = require('../../src/assets/generationHistory');
const { createLocalMediaProbe } = require('../../src/media/localMediaProbe');
const {
  createMediaNormalizationPlan,
  createMediaNormalizationPlanVerifier,
} = require('../../src/media/mediaNormalizationPlan');
const { createMediaExportExecutionPlan } = require('../../src/media/mediaExportExecutionPlan');
const { uid } = require('./v8AudioFixture');

const DRAMA_UID = uid(1);
const WORKFLOW_RUN_UID = uid(21);
const CREATED_AT = '2027-01-15T08:00:00.000Z';

function version({ number, assetNumber, assetType, source }) {
  return Object.freeze({
    uid: uid(number),
    assetUid: uid(assetNumber),
    storageProvider: 'local',
    logicalUri: `asset://dramas/${DRAMA_UID}/${source.relativePath}`,
    relativePath: source.relativePath,
    sha256: source.sha256,
    mimeType: assetType === 'video' ? 'video/mp4' : source.mimeType,
    width: assetType === 'video' ? source.width : null,
    height: assetType === 'video' ? source.height : null,
    durationMs: source.durationMs,
    parentUid: null,
    status: 'ready',
    createdAt: CREATED_AT,
  });
}

function asset(assetNumber, versionNumber, assetType) {
  return Object.freeze({
    uid: uid(assetNumber),
    ownerType: 'drama',
    ownerUid: DRAMA_UID,
    assetType,
    currentVersionUid: uid(versionNumber),
    status: 'ready',
    createdAt: '2027-01-15T07:59:59.000Z',
    updatedAt: CREATED_AT,
  });
}

function voiceProfile() {
  return createVoiceProfileRecord({
    schemaVersion: '8.0',
    uid: uid(100),
    dramaUid: DRAMA_UID,
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
      neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
      fearful: 'fearful', surprised: 'surprised',
    },
    minimumSpeedPermille: 700,
    defaultSpeedPermille: 1000,
    maximumSpeedPermille: 1400,
    voiceVersion: {
      uid: uid(200), identityVersionUid: uid(400), parentUid: null,
      name: 'Synthetic export voice', language: 'zh-CN',
      style: 'Synthetic deterministic export fixture.',
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
    dramaUid: DRAMA_UID,
    scriptResultUid: uid(2),
    shotId: `shot-${number}`,
    dialogueEntryId: `dialogue-${number}`,
    characterUid: uid(10),
    voiceProfileUid: profileUid,
    text: number === 1 ? '住手！' : '先打赢我。',
    emotion: number === 1 ? 'angry' : 'neutral',
    emotionIntensityPermille: number === 1 ? 850 : 500,
    speedPermille: number === 1 ? 1100 : 900,
    pauseBeforeMs: 0,
    pauseAfterMs: 0,
  });
}

function trustedAudioPlan() {
  const profile = voiceProfile();
  const input = {
    schemaVersion: '8.0',
    uid: uid(20),
    dramaUid: DRAMA_UID,
    workflowRunUid: WORKFLOW_RUN_UID,
    mode: 'independent_tts',
    dialogueDeliveries: [delivery(1, profile.uid), delivery(2, profile.uid)],
    voiceProfiles: [profile],
    h3GenerationSource: null,
    createdAtEpochMs: 1_800_000_100_000,
  };
  return createAudioModePlanVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== input.uid) throw new Error('fixture-audio-plan-anchor');
      return input;
    },
  }).verify(createAudioModePlan(input), input.uid);
}

function trustedTimeline(sources) {
  const plan = trustedAudioPlan();
  const ttsOutputs = plan.ttsRequests.map((request, index) => {
    const assetNumber = 920 + index;
    const versionNumber = 910 + index;
    return {
      dialogueDeliveryUid: request.dialogueDeliveryUid,
      requestSha256: request.requestSha256,
      audioAsset: asset(assetNumber, versionNumber, 'audio'),
      audioVersionEvidence: version({
        number: versionNumber,
        assetNumber,
        assetType: 'audio',
        source: sources.dialogue[index],
      }),
    };
  });
  const executionEvidence = createAudioExecutionEvidence({
    schemaVersion: '8.0',
    uid: uid(930),
    plan,
    ttsOutputs,
    createdAtEpochMs: 1_800_000_200_000,
  });
  const input = {
    schemaVersion: '8.0',
    uid: uid(950),
    plan,
    executionEvidence,
    createdAtEpochMs: 1_800_000_300_000,
  };
  const timeline = createAudioTimelineVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== input.uid) throw new Error('fixture-timeline-anchor');
      return input;
    },
  }).verify(createAudioTimeline(input), input.uid);
  return Object.freeze({ timeline, ttsOutputs });
}

function trustedBgmTrack(source) {
  const bgmVersion = version({ number: 1002, assetNumber: 1001, assetType: 'audio', source });
  return createBgmTrack({
    schemaVersion: 'bgm-track.v1',
    uid: uid(1000),
    dramaUid: DRAMA_UID,
    title: 'Synthetic score',
    sourceKind: 'local-import',
    providerId: 'local-library',
    assetVersion: {
      ...bgmVersion,
      logicalUri: `asset://dramas/${DRAMA_UID}/bgm/${bgmVersion.assetUid}/${bgmVersion.uid}`,
    },
    license: {
      schemaVersion: 'bgm-license.v1',
      uid: uid(1003),
      basis: 'licensed',
      attestationKind: 'user-attestation',
      commercialUseAllowed: true,
      derivativesAllowed: true,
      attributionRequired: false,
      attributionText: null,
      attestedAtEpochMs: 1_800_000_250_000,
    },
    createdAtEpochMs: 1_800_000_250_000,
  });
}

function trustedMix(timeline, bgmTrack) {
  const input = {
    schemaVersion: '8.0',
    uid: uid(1100),
    audioTimeline: timeline,
    bgmTrack,
    settings: {
      dialogueGainMilliDb: 0,
      nativeGainMilliDb: null,
      bgmGainMilliDb: -9000,
      duckedBgmGainMilliDb: -18000,
      fadeInMs: 100,
      fadeOutMs: 100,
      duckingAttackMs: 50,
      duckingReleaseMs: 100,
    },
    createdAtEpochMs: 1_800_000_400_000,
  };
  return createAudioMixPlanVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== input.uid) throw new Error('fixture-mix-anchor');
      return input;
    },
  }).verify(createAudioMixPlan(input), input.uid);
}

function shotRecord(source, index) {
  const assetNumber = 1210 + index;
  const versionNumber = 1200 + index;
  const assetRecord = asset(assetNumber, versionNumber, 'video');
  const versionRecord = version({
    number: versionNumber, assetNumber, assetType: 'video', source,
  });
  const promptSemanticUid = uid(1240 + index);
  const manifestUid = uid(1250 + index);
  return Object.freeze({
    shotId: `shot-${index + 1}`,
    plannedOrdinal: index + 1,
    generationHistory: createGenerationHistoryRecord({
      uid: uid(1220 + index),
      runUid: WORKFLOW_RUN_UID,
      dramaUid: DRAMA_UID,
      assetUid: assetRecord.uid,
      promptSemanticUid,
      manifestUid,
      manifestSha256: String(index + 6).repeat(64),
      provider: 'local',
      model: 'synthetic-video-v1',
      seed: index + 1,
      parameters: { width: source.width, height: source.height },
      input: { promptSemanticUid, manifestUid },
      status: 'succeeded',
      outputVersionUid: versionRecord.uid,
      outputVersionEvidence: versionRecord,
      parentVersionUid: null,
      parentVersionEvidence: null,
      errorCode: null,
      errorDetailRef: null,
      createdAtEpochMs: 1_800_000_100_000 + index,
      completedAtEpochMs: 1_800_000_200_000 + index,
    }),
    asset: assetRecord,
    assetVersion: versionRecord,
  });
}

function trustedProductionSnapshot(sources) {
  const timelineFixture = trustedTimeline(sources);
  const bgmTrack = trustedBgmTrack(sources.bgm);
  const audioMixPlan = trustedMix(timelineFixture.timeline, bgmTrack);
  const input = {
    schemaVersion: '8.0',
    uid: uid(1300),
    audioTimeline: timelineFixture.timeline,
    audioMixPlan,
    shots: sources.video.map(shotRecord),
    audioSources: timelineFixture.ttsOutputs.map((output) => ({
      sourceKind: 'tts_asset',
      asset: output.audioAsset,
      assetVersion: output.audioVersionEvidence,
    })),
    bgmTrack,
    createdAtEpochMs: 1_800_000_500_000,
  };
  const candidate = createProductionTimelineSnapshot(input);
  const verifier = createProductionTimelineSnapshotVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== input.uid) throw new Error('fixture-production-anchor');
      return input;
    },
    loadGenerationHistory(expectedUid) {
      const shot = input.shots.find((entry) => entry.generationHistory.uid === expectedUid);
      if (!shot) throw new Error('fixture-history-anchor');
      return shot.generationHistory;
    },
  });
  return verifier.verify(candidate, input.uid);
}

async function trustedNormalization(local, snapshot) {
  const versions = [
    ...snapshot.shots.map((shot) => shot.assetVersion),
    ...snapshot.audioSources.map((source) => source.assetVersion),
    snapshot.bgmTrack.assetVersion,
  ];
  const inspector = createLocalMediaProbe({
    localRoot: local.localRoot,
    ffmpegPath: local.ffmpegPath,
    ffprobePath: local.ffprobePath,
    timeoutMs: 120_000,
  });
  const probes = [];
  for (let index = 0; index < versions.length; index += 1) {
    probes.push(await inspector.inspect({
      schemaVersion: '8.0',
      uid: uid(1401 + index),
      assetVersion: versions[index],
      probedAtEpochMs: 1_800_000_600_000 + index,
    }));
  }
  const input = {
    schemaVersion: '8.0',
    uid: uid(1400),
    productionTimelineSnapshot: snapshot,
    mediaProbes: probes,
    createdAtEpochMs: 1_800_000_700_000,
  };
  const candidate = createMediaNormalizationPlan(input);
  return createMediaNormalizationPlanVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== input.uid) throw new Error('fixture-normalization-anchor');
      return {
        schemaVersion: '8.0', uid: input.uid,
        productionTimelineSnapshot: snapshot,
        mediaProbeUids: probes.map((probe) => probe.uid),
        createdAtEpochMs: input.createdAtEpochMs,
      };
    },
    loadMediaProbeEvidence(expectedUid) {
      const probe = probes.find((entry) => entry.uid === expectedUid);
      if (!probe) throw new Error('fixture-probe-anchor');
      return probe;
    },
  }).verify(candidate, input.uid);
}

async function createTrustedMediaExportFixture(local, sources, executionNumber = 1500) {
  const snapshot = trustedProductionSnapshot(sources);
  const normalizationPlan = await trustedNormalization(local, snapshot);
  const executionPlan = createMediaExportExecutionPlan({
    schemaVersion: '8.0',
    uid: uid(executionNumber),
    productionTimelineSnapshot: snapshot,
    normalizationPlan,
    createdAtEpochMs: 1_800_000_800_000 + executionNumber,
  });
  return Object.freeze({ snapshot, normalizationPlan, executionPlan });
}

module.exports = Object.freeze({ createTrustedMediaExportFixture });
