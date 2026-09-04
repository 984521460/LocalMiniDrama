'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const { canonicalHash } = require('../src/audio/audioContract');
const { createDialogueDeliveryPlan } = require('../src/audio/dialogueDelivery');
const { createVoiceProfileRecord } = require('../src/audio/voiceProfile');
const {
  AudioModeContractError,
  createAudioModePlan,
  createAudioModePlanVerifier,
} = require('../src/audio/audioMode');
const { createAudioExecutionEvidence } = require('../src/audio/audioExecutionEvidence');
const {
  AUDIO_TIMELINE_ALGORITHM_VERSION,
  createAudioTimeline,
  createAudioTimelineVerifier,
  requireTrustedAudioTimeline,
} = require('../src/audio/audioTimeline');
const {
  compileH3ShotPrompt,
  normalizeH3GenerationSpec,
  validateH3VideoOutput,
} = require('../src/h3');

const SCHEMA_ROOT = path.resolve(__dirname, '../../schemas/v8');
const H3_SCHEMA_ROOT = path.resolve(__dirname, '../../schemas/v7');
const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const schemaName of ['dialogue-delivery.schema.json', 'voice-profile.schema.json']) {
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, schemaName), 'utf8')));
}
for (const schemaName of ['h3-generation-spec.schema.json', 'h3-video-evidence.schema.json']) {
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(H3_SCHEMA_ROOT, schemaName), 'utf8')));
}
ajv.addSchema(JSON.parse(fs.readFileSync(
  path.join(SCHEMA_ROOT, 'subtitle-track.schema.json'), 'utf8',
)));
const validateTimelineSchema = ajv.compile(JSON.parse(fs.readFileSync(
  path.join(SCHEMA_ROOT, 'audio-timeline.schema.json'), 'utf8',
)));

function uid(number) {
  return `82000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function voiceProfile() {
  return createVoiceProfileRecord({
    schemaVersion: '8.0', uid: uid(100), dramaUid: uid(1), characterUid: uid(10),
    characterVoiceVersionUid: uid(200), parentUid: null, revision: 1,
    provider: 'minimax', model: 'speech-02-hd', voiceKey: 'female-shaonv',
    credentialRef: `credential:v1:${uid(300)}`,
    sourceKind: 'provider-preset', status: 'ready', defaultEmotion: 'neutral',
    emotionMap: {
      neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
      fearful: 'fearful', surprised: 'surprised',
    },
    minimumSpeedPermille: 700, defaultSpeedPermille: 1000,
    maximumSpeedPermille: 1400,
    voiceVersion: {
      uid: uid(200), identityVersionUid: uid(400), parentUid: null,
      name: 'Synthetic contract voice', language: 'zh-CN',
      style: 'Synthetic provider preset for deterministic tests.',
      createdAtEpochMs: 1_800_000_000_000,
    },
    createdAtEpochMs: 1_800_000_000_000,
  });
}

function delivery(number, profileUid) {
  return createDialogueDeliveryPlan({
    schemaVersion: '8.0', timingAlgorithmVersion: 'dialogue-timing.v1',
    uid: uid(500 + number), dramaUid: uid(1), scriptResultUid: uid(2),
    shotId: `shot-${number}`, dialogueEntryId: `dialogue-${number}`,
    characterUid: uid(10), voiceProfileUid: profileUid,
    text: number === 1 ? '住手！' : '先打赢我。',
    emotion: number === 1 ? 'angry' : 'neutral',
    emotionIntensityPermille: number === 1 ? 850 : 500,
    speedPermille: number === 1 ? 1100 : 900,
    pauseBeforeMs: number === 1 ? 0 : 180, pauseAfterMs: 120,
  });
}

function assetVersionEvidence({
  version, asset, mimeType = 'audio/wav', durationMs,
  width = null, height = null, sha, relativePath,
}) {
  return {
    uid: uid(version), assetUid: uid(asset), storageProvider: 'local',
    logicalUri: `asset://dramas/${uid(1)}/${relativePath}`, relativePath,
    sha256: sha, mimeType, width, height, durationMs, parentUid: null,
    status: 'ready', createdAt: '2027-01-15T08:00:00.000Z',
  };
}

function assetEvidence({ asset, version, assetType = 'audio', ownerUid = uid(1) }) {
  return {
    uid: uid(asset), ownerType: 'drama', ownerUid, assetType,
    currentVersionUid: uid(version), status: 'ready',
    createdAt: '2027-01-15T07:59:59.000Z', updatedAt: '2027-01-15T08:00:00.000Z',
  };
}

function h3GenerationSource() {
  const prompt = compileH3ShotPrompt({
    dramaUid: uid(1),
    semanticShot: {
      shotId: 'shot-h3', ordinal: 1, durationSeconds: 2,
      continuitySnapshotUid: uid(700),
      subjects: { description: 'Two fighters circle each other.', characters: [] },
      environment: {
        sceneId: 'courtyard', description: 'Rain falls across a stone courtyard.',
        scene: { sceneUid: uid(701), versionUid: uid(702) }, props: [],
      },
      action: 'They exchange two fast strikes and separate.',
      camera: {
        shotSize: 'MS', cameraAngle: 'eye_level', cameraMovement: 'pan',
        composition: 'Both fighters remain visible across the frame.',
      },
      lighting: {
        quality: 'soft', direction: 'side', colorTemperature: 'cool',
        description: 'Cool rain light separates both silhouettes.',
      },
      continuity: {
        transitionFromPrevious: 'start', screenDirection: 'left_to_right',
        axisStrategy: 'establish', notes: 'The first fighter starts frame left.',
      },
    },
  });
  const generationSpec = normalizeH3GenerationSpec({
    mode: 't2v', prompt, width: 608, height: 352,
    durationSeconds: 1, seed: 42, referenceImages: [],
  });
  const videoEvidence = validateH3VideoOutput({
    generationSpec,
    measured: {
      sha256: 'b'.repeat(64), bytes: 220000, mimeType: 'video/mp4',
      width: 608, height: 352, durationMs: 1625, frames: 39, fps: 24,
      videoCodec: 'h264', audioCodec: 'aac', audioStreams: 1,
      blackFrameRatio: 0.01, frozenFrameRatio: 0.02,
    },
  });
  return {
    generationHistoryUid: uid(703), generationSpec, videoEvidence,
    videoAsset: assetEvidence({ asset: 705, version: 704, assetType: 'video' }),
    videoVersionEvidence: assetVersionEvidence({
      version: 704, asset: 705, mimeType: 'video/mp4', durationMs: 1625,
      width: 608, height: 352, sha: 'b'.repeat(64), relativePath: 'videos/h3-shot.mp4',
    }),
  };
}

function planInput(mode) {
  const profile = voiceProfile();
  return {
    schemaVersion: '8.0', uid: uid(20), dramaUid: uid(1), workflowRunUid: uid(21), mode,
    dialogueDeliveries: [delivery(1, profile.uid), delivery(2, profile.uid)],
    voiceProfiles: mode === 'h3_native' ? [] : [profile],
    h3GenerationSource: mode === 'independent_tts' ? null : h3GenerationSource(),
    createdAtEpochMs: 1_800_000_100_000,
  };
}

function planEnvelope(input) {
  return {
    schemaVersion: input.schemaVersion, uid: input.uid, dramaUid: input.dramaUid,
    workflowRunUid: input.workflowRunUid, mode: input.mode,
    dialogueDeliveries: input.dialogueDeliveries, voiceProfiles: input.voiceProfiles,
    h3GenerationSource: input.h3GenerationSource, createdAtEpochMs: input.createdAtEpochMs,
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

function ttsOutputs(plan, durations = [700, 800], offset = 0) {
  return plan.ttsRequests.map((request, index) => ({
    dialogueDeliveryUid: request.dialogueDeliveryUid,
    requestSha256: request.requestSha256,
    audioAsset: assetEvidence({ asset: 920 + offset + index, version: 910 + offset + index }),
    audioVersionEvidence: assetVersionEvidence({
      version: 910 + offset + index, asset: 920 + offset + index,
      durationMs: durations[index], sha: String(index + 1 + offset).slice(-1).repeat(64),
      relativePath: `audio/dialogue-${offset + index + 1}.wav`,
    }),
  }));
}

function executionEvidence(plan, durations = [700, 800], offset = 0) {
  return createAudioExecutionEvidence({
    schemaVersion: '8.0', uid: uid(930), plan,
    ttsOutputs: plan.mode === 'h3_native' ? [] : ttsOutputs(plan, durations, offset),
    createdAtEpochMs: 1_800_000_200_000,
  });
}

function timelineFixture(mode, durations = [700, 800]) {
  const rawPlan = planInput(mode);
  const plan = verifiedPlan(rawPlan);
  const execution = executionEvidence(plan, durations);
  const envelope = {
    schemaVersion: '8.0', uid: uid(950), plan, executionEvidence: execution,
    createdAtEpochMs: 1_800_000_300_000,
  };
  const candidate = createAudioTimeline(envelope);
  const verifier = createAudioTimelineVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== envelope.uid) throw new Error('synthetic-timeline-anchor-mismatch');
      return envelope;
    },
  });
  return {
    rawPlan, plan, execution, envelope, candidate,
    timeline: verifier.verify(JSON.parse(JSON.stringify(candidate)), envelope.uid), verifier,
  };
}

function expectCode(code) {
  return (error) => error instanceof AudioModeContractError
    && error.code === code
    && JSON.stringify(error) === JSON.stringify({ code, message: error.message });
}

function resignTimeline(value) {
  const { timelineSha256: _ignored, ...base } = value;
  return { ...value, timelineSha256: canonicalHash(base) };
}

test('all audio modes produce exact integer-millisecond segments and source-bound subtitles', () => {
  assert.equal(AUDIO_TIMELINE_ALGORITHM_VERSION, 'audio-timeline-ms.v1');
  const independent = timelineFixture('independent_tts').timeline;
  const hybrid = timelineFixture('hybrid').timeline;
  const native = timelineFixture('h3_native').timeline;

  assert.equal(independent.durationMs, 1500);
  assert.deepEqual(independent.segments.map((entry) => [entry.startMs, entry.endMs]), [
    [0, 700], [700, 1500],
  ]);
  assert.equal(independent.nativeTrack, null);
  assert.equal(independent.segments.every((entry) => entry.sourceKind === 'tts_asset'), true);

  assert.equal(hybrid.durationMs, 1625);
  assert.equal(hybrid.segments.at(-1).endMs, 1500);
  assert.equal(hybrid.nativeTrack.sourceAssetVersionUid, uid(704));
  assert.equal(hybrid.segments.every((entry) => entry.sourceKind === 'tts_asset'), true);

  assert.equal(native.durationMs, 1625);
  assert.equal(native.segments.at(-1).endMs, 1625);
  assert.equal(native.segments.every((entry) => (
    entry.sourceKind === 'h3_native'
      && entry.sourceAssetVersionUid === native.nativeTrack.sourceAssetVersionUid
      && entry.sourceMediaSha256 === native.nativeTrack.sourceMediaSha256
  )), true);

  for (const timeline of [independent, hybrid, native]) {
    assert.equal(validateTimelineSchema(timeline), true, JSON.stringify(validateTimelineSchema.errors));
    assert.equal(timeline.segments.length, timeline.subtitleTrack.cues.length);
    for (let index = 0; index < timeline.segments.length; index += 1) {
      const segment = timeline.segments[index];
      const cue = timeline.subtitleTrack.cues[index];
      assert.deepEqual(
        [cue.startMs, cue.endMs, cue.sourceAssetVersionUid, cue.sourceMediaSha256],
        [segment.startMs, segment.endMs, segment.sourceAssetVersionUid, segment.sourceMediaSha256],
      );
    }
    assert.equal(JSON.stringify(timeline).includes('credential:v1:'), false);
  }
});

test('independent TTS can be placed on the full video axis with deterministic silence gaps', () => {
  const rawPlan = planInput('independent_tts');
  const plan = verifiedPlan(rawPlan);
  const execution = executionEvidence(plan, [700, 800]);
  const envelope = {
    schemaVersion: '8.0',
    uid: uid(951),
    plan,
    executionEvidence: execution,
    targetDurationMs: 6500,
    placements: [
      { dialogueDeliveryUid: plan.dialogueBindings[0].dialogueDeliveryUid, startMs: 250 },
      { dialogueDeliveryUid: plan.dialogueBindings[1].dialogueDeliveryUid, startMs: 4000 },
    ],
    createdAtEpochMs: 1_800_000_300_000,
  };
  const candidate = createAudioTimeline(envelope);
  const timeline = createAudioTimelineVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== envelope.uid) throw new Error('synthetic-placed-timeline-anchor');
      return envelope;
    },
  }).verify(candidate, envelope.uid);

  assert.equal(timeline.timingAlgorithmVersion, 'audio-timeline-ms.v2');
  assert.equal(timeline.durationMs, 6500);
  assert.deepEqual(timeline.segments.map((entry) => [entry.startMs, entry.endMs]), [
    [250, 950], [4000, 4800],
  ]);
  assert.deepEqual(timeline.subtitleTrack.cues.map((entry) => [entry.startMs, entry.endMs]), [
    [250, 950], [4000, 4800],
  ]);
  assert.equal(validateTimelineSchema(timeline), true, JSON.stringify(validateTimelineSchema.errors));

  const invalidPlacements = [
    [
      envelope.placements[0],
      { ...envelope.placements[1], startMs: 900 },
    ],
    [
      { ...envelope.placements[0], dialogueDeliveryUid: uid(999) },
      envelope.placements[1],
    ],
  ];
  for (const placements of invalidPlacements) {
    assert.throws(() => createAudioTimeline({ ...envelope, placements }),
      expectCode('AUDIO_TIMELINE_INPUT_INVALID'));
  }
  assert.throws(() => createAudioTimeline({ ...envelope, targetDurationMs: 4500 }),
    expectCode('AUDIO_TIMELINE_INPUT_INVALID'));

  const downgraded = resignTimeline({
    ...timeline,
    timingAlgorithmVersion: 'audio-timeline-ms.v1',
    subtitleTrack: {
      ...timeline.subtitleTrack,
      timingAlgorithmVersion: 'audio-timeline-ms.v1',
    },
  });
  assert.throws(() => createAudioTimelineVerifier({
    loadTrustedEnvelope() { return envelope; },
  }).verify(downgraded, envelope.uid), expectCode('AUDIO_TIMELINE_DATA_INVALID'));
});

test('H3-native proportional allocation is deterministic, contiguous and exact at every boundary', () => {
  const first = timelineFixture('h3_native').timeline;
  const second = timelineFixture('h3_native').timeline;
  assert.deepEqual(first, second);
  assert.equal(first.segments.reduce((sum, entry) => sum + entry.durationMs, 0), 1625);
  assert.equal(first.segments.every((entry) => Number.isInteger(entry.startMs)
    && Number.isInteger(entry.endMs) && entry.durationMs >= 1), true);
  assert.equal(first.segments[0].startMs, 0);
  for (let index = 1; index < first.segments.length; index += 1) {
    assert.equal(first.segments[index].startMs, first.segments[index - 1].endMs);
    assert.equal(first.subtitleTrack.cues[index].startMs >= first.subtitleTrack.cues[index - 1].endMs, true);
  }
  assert.equal(first.segments.at(-1).endMs, first.durationMs);
});

test('timeline creation fails closed on missing audio, overrun, stale time and untrusted sources', () => {
  const raw = planInput('independent_tts');
  const untrustedPlan = createAudioModePlan(raw);
  const trustedPlan = verifiedPlan(raw);
  const execution = executionEvidence(trustedPlan);
  assert.throws(() => createAudioTimeline({
    schemaVersion: '8.0', uid: uid(950), plan: untrustedPlan,
    executionEvidence: execution, createdAtEpochMs: 1_800_000_300_000,
  }), expectCode('AUDIO_TIMELINE_INPUT_INVALID'));
  assert.throws(() => createAudioTimeline({
    schemaVersion: '8.0', uid: uid(950), plan: trustedPlan,
    executionEvidence: { ...execution, ttsOutputs: execution.ttsOutputs.slice(0, 1) },
    createdAtEpochMs: 1_800_000_300_000,
  }), expectCode('AUDIO_TIMELINE_INPUT_INVALID'));
  assert.throws(() => createAudioTimeline({
    schemaVersion: '8.0', uid: uid(950), plan: trustedPlan,
    executionEvidence: execution, createdAtEpochMs: execution.createdAtEpochMs - 1,
  }), expectCode('AUDIO_TIMELINE_INPUT_INVALID'));

  const hybridRaw = planInput('hybrid');
  const hybridPlan = verifiedPlan(hybridRaw);
  const overrun = executionEvidence(hybridPlan, [900, 900]);
  assert.throws(() => createAudioTimeline({
    schemaVersion: '8.0', uid: uid(950), plan: hybridPlan,
    executionEvidence: overrun, createdAtEpochMs: 1_800_000_300_000,
  }), expectCode('AUDIO_TIMELINE_INPUT_INVALID'));

  const fixture = timelineFixture('independent_tts');
  assert.throws(() => requireTrustedAudioTimeline(fixture.candidate),
    expectCode('AUDIO_TIMELINE_DATA_INVALID'));
  assert.deepEqual(requireTrustedAudioTimeline(fixture.timeline), fixture.timeline);
});

test('external immutable envelope rejects coordinated source and top-level metadata re-signing', () => {
  const fixture = timelineFixture('independent_tts');
  const replacementExecution = executionEvidence(fixture.plan, [600, 900], 20);
  const replacement = createAudioTimeline({ ...fixture.envelope, executionEvidence: replacementExecution });
  assert.throws(() => fixture.verifier.verify(replacement, fixture.envelope.uid),
    expectCode('AUDIO_TIMELINE_DATA_INVALID'));

  const rebound = resignTimeline({
    ...fixture.candidate, workflowRunUid: uid(999),
    createdAtEpochMs: fixture.candidate.createdAtEpochMs + 1,
  });
  assert.throws(() => fixture.verifier.verify(rebound, fixture.envelope.uid),
    expectCode('AUDIO_TIMELINE_DATA_INVALID'));
  assert.throws(() => fixture.verifier.verify(fixture.candidate, uid(951)),
    expectCode('AUDIO_TIMELINE_DATA_INVALID'));
});

test('persisted timeline and envelope boundaries reject proxies and accessors without executing them', () => {
  const fixture = timelineFixture('independent_tts');
  let rootReads = 0;
  const rootProxy = new Proxy(fixture.candidate, {
    ownKeys() { rootReads += 1; return []; },
    getOwnPropertyDescriptor() { rootReads += 1; return undefined; },
  });
  assert.throws(() => fixture.verifier.verify(rootProxy, fixture.envelope.uid),
    expectCode('AUDIO_TIMELINE_DATA_INVALID'));
  assert.equal(rootReads, 0);

  let arrayReads = 0;
  const segmentProxy = new Proxy(fixture.candidate.segments, {
    getPrototypeOf() { arrayReads += 1; throw new Error('segment-array-sentinel'); },
    ownKeys() { arrayReads += 1; return []; },
  });
  assert.throws(
    () => fixture.verifier.verify({ ...fixture.candidate, segments: segmentProxy }, fixture.envelope.uid),
    expectCode('AUDIO_TIMELINE_DATA_INVALID'),
  );
  assert.equal(arrayReads, 0);

  let envelopeReads = 0;
  const envelopeProxy = new Proxy(fixture.envelope, {
    ownKeys() { envelopeReads += 1; return []; },
    getOwnPropertyDescriptor() { envelopeReads += 1; return undefined; },
  });
  const verifier = createAudioTimelineVerifier({ loadTrustedEnvelope: () => envelopeProxy });
  assert.throws(() => verifier.verify(fixture.candidate, fixture.envelope.uid),
    expectCode('AUDIO_TIMELINE_DATA_INVALID'));
  assert.equal(envelopeReads, 0);

  let getterReads = 0;
  const hostile = { ...fixture.candidate };
  Object.defineProperty(hostile, 'mode', {
    enumerable: true,
    get() { getterReads += 1; return 'independent_tts'; },
  });
  assert.throws(() => fixture.verifier.verify(hostile, fixture.envelope.uid),
    expectCode('AUDIO_TIMELINE_DATA_INVALID'));
  assert.equal(getterReads, 0);
});

test('Schema rejects malformed mode/source shapes while runtime enforces cross-field continuity', () => {
  const fixture = timelineFixture('independent_tts');
  assert.equal(validateTimelineSchema(fixture.timeline), true, JSON.stringify(validateTimelineSchema.errors));
  assert.equal(validateTimelineSchema({
    ...fixture.timeline,
    nativeTrack: {
      sourceKind: 'h3_native', sourceAssetUid: uid(1), sourceAssetVersionUid: uid(2),
      sourceMediaSha256: 'a'.repeat(64), sourceMimeType: 'video/mp4', durationMs: 1500,
      h3SourceSha256: 'b'.repeat(64),
    },
  }), false);
  assert.equal(validateTimelineSchema({
    ...fixture.timeline,
    segments: [
      { ...fixture.timeline.segments[0], sourceMimeType: 'video/mp4' },
      fixture.timeline.segments[1],
    ],
  }), false);
  assert.equal(validateTimelineSchema({
    ...fixture.timeline,
    subtitleTrack: {
      ...fixture.timeline.subtitleTrack,
      cues: [
        { ...fixture.timeline.subtitleTrack.cues[0], sourceKind: 'h3_native' },
        fixture.timeline.subtitleTrack.cues[1],
      ],
    },
  }), false);

  const overlapped = resignTimeline({
    ...fixture.candidate,
    segments: [
      fixture.candidate.segments[0],
      { ...fixture.candidate.segments[1], startMs: 600, durationMs: 900 },
    ],
  });
  assert.throws(() => fixture.verifier.verify(overlapped, fixture.envelope.uid),
    expectCode('AUDIO_TIMELINE_DATA_INVALID'));
});
