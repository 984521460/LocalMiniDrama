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
  assertAudioModeExecutionReady,
  createAudioModePlan,
  createAudioModePlanVerifier,
} = require('../src/audio/audioMode');
const {
  createAudioExecutionEvidence,
  parseAudioExecutionEvidence,
} = require('../src/audio/audioExecutionEvidence');
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
const validatePlanSchema = ajv.compile(JSON.parse(fs.readFileSync(
  path.join(SCHEMA_ROOT, 'audio-mode-plan.schema.json'), 'utf8',
)));
const validateExecutionSchema = ajv.compile(JSON.parse(fs.readFileSync(
  path.join(SCHEMA_ROOT, 'audio-execution-evidence.schema.json'), 'utf8',
)));

function uid(number) {
  return `81000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function voiceProfile(number, characterUid) {
  return createVoiceProfileRecord({
    schemaVersion: '8.0',
    uid: uid(100 + number),
    dramaUid: uid(1),
    characterUid,
    characterVoiceVersionUid: uid(200 + number),
    parentUid: null,
    revision: 1,
    provider: number === 1 ? 'minimax' : 'openai-compatible',
    model: number === 1 ? 'speech-02-hd' : 'tts-1',
    voiceKey: number === 1 ? 'female-shaonv' : 'alloy',
    credentialRef: `credential:v1:${uid(300 + number)}`,
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
      uid: uid(200 + number),
      identityVersionUid: uid(400 + number),
      parentUid: null,
      name: `Voice ${number}`,
      language: 'zh-CN',
      style: 'Provider preset used for synthetic contract tests.',
      createdAtEpochMs: 1_800_000_000_000 + number,
    },
    createdAtEpochMs: 1_800_000_000_000 + number,
  });
}

function delivery(number, characterUid, voiceProfileUid) {
  return createDialogueDeliveryPlan({
    schemaVersion: '8.0',
    timingAlgorithmVersion: 'dialogue-timing.v1',
    uid: uid(500 + number),
    dramaUid: uid(1),
    scriptResultUid: uid(2),
    shotId: `shot-${number}`,
    dialogueEntryId: `dialogue-${number}`,
    characterUid,
    voiceProfileUid,
    text: number === 1 ? '住手！你不能带走她。' : '那就先打赢我。',
    emotion: number === 1 ? 'angry' : 'neutral',
    emotionIntensityPermille: number === 1 ? 850 : 500,
    speedPermille: number === 1 ? 1100 : 900,
    pauseBeforeMs: number === 1 ? 0 : 180,
    pauseAfterMs: 240,
  });
}

function assetVersionEvidence({
  version = 900, asset = 901, mimeType = 'audio/wav', durationMs = 1800,
  width = null, height = null, sha = 'a'.repeat(64), relativePath = 'audio/dialogue.wav',
} = {}) {
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

function assetEvidence({ asset = 901, version = 900, assetType = 'audio', ownerUid = uid(1) } = {}) {
  return {
    uid: uid(asset),
    ownerType: 'drama',
    ownerUid,
    assetType,
    currentVersionUid: uid(version),
    status: 'ready',
    createdAt: '2027-01-15T07:59:59.000Z',
    updatedAt: '2027-01-15T08:00:00.000Z',
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
  const characters = [uid(10), uid(11)];
  const profiles = characters.map((characterUid, index) => voiceProfile(index + 1, characterUid));
  const deliveries = profiles.map((profile, index) => delivery(index + 1, characters[index], profile.uid));
  return {
    schemaVersion: '8.0',
    uid: uid(20),
    dramaUid: uid(1),
    workflowRunUid: uid(21),
    mode,
    dialogueDeliveries: deliveries,
    voiceProfiles: mode === 'h3_native' ? [] : profiles,
    h3GenerationSource: mode === 'independent_tts' ? null : h3GenerationSource(),
    createdAtEpochMs: 1_800_000_100_000,
  };
}

function sourceSnapshot(input) {
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

function verifierFor(input) {
  return createAudioModePlanVerifier({
    loadTrustedEnvelope(planUid) {
      if (planUid !== input.uid) throw new Error('synthetic-plan-anchor-mismatch');
      return sourceSnapshot(input);
    },
  });
}

function verifiedPlan(input) {
  return verifierFor(input).verify(createAudioModePlan(input), input.uid);
}

function expectCode(code) {
  return (error) => error instanceof AudioModeContractError
    && error.code === code
    && JSON.stringify(error) === JSON.stringify({ code, message: error.message });
}

test('three audio modes produce exact secret-free plans without silent fallback', () => {
  const independent = createAudioModePlan(planInput('independent_tts'));
  const native = createAudioModePlan(planInput('h3_native'));
  const hybridInput = planInput('hybrid');
  const hybrid = createAudioModePlan(hybridInput);

  assert.equal(independent.ttsRequests.length, 2);
  assert.equal(independent.h3NativeSource, null);
  assert.equal(native.ttsRequests.length, 0);
  assert.equal(native.h3NativeSource.audioCodec, 'aac');
  assert.equal(hybrid.ttsRequests.length, 2);
  assert.equal(hybrid.h3NativeSource.audioStreams, 1);
  assert.deepEqual(hybrid.dialogueBindings, independent.dialogueBindings);
  assert.equal(JSON.stringify(independent).includes('credential:v1:'), false);
  assert.equal(Object.isFrozen(hybrid), true);
  assert.equal(Object.isFrozen(hybrid.ttsRequests), true);
  assert.equal(validatePlanSchema(independent), true, JSON.stringify(validatePlanSchema.errors));
  assert.equal(validatePlanSchema(native), true, JSON.stringify(validatePlanSchema.errors));
  assert.equal(validatePlanSchema(hybrid), true, JSON.stringify(validatePlanSchema.errors));
  assert.deepEqual(
    verifierFor(hybridInput).verify(JSON.parse(JSON.stringify(hybrid)), hybridInput.uid),
    hybrid,
  );
  assert.equal(validatePlanSchema({ ...hybrid, mode: 'h3_native' }), false);
  assert.equal(validatePlanSchema({
    ...hybrid,
    h3NativeSource: {
      ...hybrid.h3NativeSource,
      videoVersionEvidence: {
        ...hybrid.h3NativeSource.videoVersionEvidence,
        relativePath: '../other-drama/video.mp4',
      },
    },
  }), false);
});

test('mode availability fails closed before any legacy or external provider path is used', () => {
  const independent = planInput('independent_tts');
  assert.throws(
    () => createAudioModePlan({ ...independent, voiceProfiles: [] }),
    expectCode('AUDIO_TTS_NOT_CONFIGURED'),
  );
  assert.throws(
    () => createAudioModePlan({
      ...independent,
      voiceProfiles: [independent.voiceProfiles[0], independent.voiceProfiles[0]],
    }),
    expectCode('AUDIO_TTS_NOT_CONFIGURED'),
  );
  const hybrid = planInput('hybrid');
  assert.throws(
    () => createAudioModePlan({ ...hybrid, h3GenerationSource: null }),
    expectCode('AUDIO_H3_NATIVE_UNAVAILABLE'),
  );
  const native = planInput('h3_native');
  assert.throws(
    () => createAudioModePlan({ ...native, voiceProfiles: [voiceProfile(1, uid(10))] }),
    expectCode('AUDIO_MODE_INPUT_INVALID'),
  );
  assert.throws(
    () => createAudioModePlan({ ...independent, h3GenerationSource: h3GenerationSource() }),
    expectCode('AUDIO_MODE_INPUT_INVALID'),
  );
  const crossDramaSource = h3GenerationSource();
  assert.throws(
    () => createAudioModePlan({
      ...hybrid,
      h3GenerationSource: {
        ...crossDramaSource,
        videoAsset: { ...crossDramaSource.videoAsset, ownerUid: uid(999) },
      },
    }),
    expectCode('AUDIO_H3_NATIVE_UNAVAILABLE'),
  );
  const independentPlan = verifiedPlan(independent);
  const nativePlan = verifiedPlan(native);
  const hybridPlan = verifiedPlan(hybrid);
  assert.throws(
    () => assertAudioModeExecutionReady(createAudioModePlan(hybrid), {
      ttsProviderConfigured: true, h3NativeAvailable: true,
    }),
    expectCode('AUDIO_MODE_DATA_INVALID'),
  );
  assert.throws(
    () => assertAudioModeExecutionReady(independentPlan, {
      ttsProviderConfigured: false, h3NativeAvailable: false,
    }),
    expectCode('AUDIO_TTS_NOT_CONFIGURED'),
  );
  assert.throws(
    () => assertAudioModeExecutionReady(nativePlan, {
      ttsProviderConfigured: false, h3NativeAvailable: false,
    }),
    expectCode('AUDIO_H3_NATIVE_UNAVAILABLE'),
  );
  assert.throws(
    () => assertAudioModeExecutionReady(hybridPlan, {
      ttsProviderConfigured: true, h3NativeAvailable: false,
    }),
    expectCode('AUDIO_H3_NATIVE_UNAVAILABLE'),
  );
  assert.deepEqual(assertAudioModeExecutionReady(hybridPlan, {
    ttsProviderConfigured: true, h3NativeAvailable: true,
  }), hybridPlan);
  assert.equal(require.cache[require.resolve('../src/services/ttsService')], undefined);
});

test('execution evidence requires every selected source and validated ready audio versions', () => {
  const plan = verifiedPlan(planInput('hybrid'));
  const ttsOutputs = plan.ttsRequests.map((request, index) => ({
    dialogueDeliveryUid: request.dialogueDeliveryUid,
    requestSha256: request.requestSha256,
    audioAsset: assetEvidence({ asset: 920 + index, version: 910 + index }),
    audioVersionEvidence: assetVersionEvidence({
      version: 910 + index,
      asset: 920 + index,
      durationMs: 1700 + index * 200,
      sha: String(index + 1).repeat(64),
      relativePath: `audio/dialogue-${index + 1}.wav`,
    }),
  }));
  const evidence = createAudioExecutionEvidence({
    schemaVersion: '8.0',
    uid: uid(930),
    plan,
    ttsOutputs,
    createdAtEpochMs: 1_800_000_200_000,
  });
  assert.equal(evidence.mode, 'hybrid');
  assert.equal(evidence.ttsOutputs.length, 2);
  assert.equal(evidence.h3NativeSource.videoVersionEvidence.sha256, 'b'.repeat(64));
  assert.equal(validateExecutionSchema(evidence), true, JSON.stringify(validateExecutionSchema.errors));
  assert.deepEqual(parseAudioExecutionEvidence(JSON.parse(JSON.stringify(evidence)), plan), evidence);

  const nativePlan = verifiedPlan(planInput('h3_native'));
  const nativeEvidence = createAudioExecutionEvidence({
    schemaVersion: '8.0', uid: uid(934), plan: nativePlan, ttsOutputs: [],
    createdAtEpochMs: 1_800_000_200_004,
  });
  assert.equal(nativeEvidence.ttsOutputs.length, 0);
  assert.equal(validateExecutionSchema(nativeEvidence), true, JSON.stringify(validateExecutionSchema.errors));

  const independentPlan = verifiedPlan(planInput('independent_tts'));
  const independentEvidence = createAudioExecutionEvidence({
    schemaVersion: '8.0', uid: uid(935), plan: independentPlan, ttsOutputs,
    createdAtEpochMs: 1_800_000_200_005,
  });
  assert.equal(independentEvidence.h3NativeSource, null);
  assert.equal(validateExecutionSchema(independentEvidence), true, JSON.stringify(validateExecutionSchema.errors));

  assert.throws(
    () => createAudioExecutionEvidence({
      schemaVersion: '8.0', uid: uid(931), plan, ttsOutputs: ttsOutputs.slice(0, 1),
      createdAtEpochMs: 1_800_000_200_001,
    }),
    expectCode('AUDIO_EXECUTION_EVIDENCE_INVALID'),
  );
  assert.throws(
    () => createAudioExecutionEvidence({
      schemaVersion: '8.0', uid: uid(936), plan,
      ttsOutputs: [{
        ...ttsOutputs[0],
        audioAsset: { ...ttsOutputs[0].audioAsset, ownerUid: uid(999) },
      }, ttsOutputs[1]],
      createdAtEpochMs: 1_800_000_200_006,
    }),
    expectCode('AUDIO_EXECUTION_EVIDENCE_INVALID'),
  );
  assert.throws(
    () => createAudioExecutionEvidence({
      schemaVersion: '8.0', uid: uid(932), plan,
      ttsOutputs: [{ ...ttsOutputs[0], requestSha256: 'f'.repeat(64) }, ttsOutputs[1]],
      createdAtEpochMs: 1_800_000_200_002,
    }),
    expectCode('AUDIO_EXECUTION_EVIDENCE_INVALID'),
  );
  assert.throws(
    () => createAudioExecutionEvidence({
      schemaVersion: '8.0', uid: uid(933), plan,
      ttsOutputs: [{
        ...ttsOutputs[0],
        audioVersionEvidence: { ...ttsOutputs[0].audioVersionEvidence, mimeType: 'video/mp4' },
      }, ttsOutputs[1]],
      createdAtEpochMs: 1_800_000_200_003,
    }),
    expectCode('AUDIO_EXECUTION_EVIDENCE_INVALID'),
  );
});

test('persisted plans and execution evidence reject drift and hostile containers', () => {
  const h3Input = planInput('h3_native');
  const plan = createAudioModePlan(h3Input);
  const h3Verifier = verifierFor(h3Input);
  assert.throws(
    () => h3Verifier.verify({ ...plan, planSha256: '0'.repeat(64) }, h3Input.uid),
    expectCode('AUDIO_MODE_DATA_INVALID'),
  );
  const unsignedReboundPlan = {
    ...plan,
    workflowRunUid: uid(997),
    createdAtEpochMs: plan.createdAtEpochMs + 86_400_000,
  };
  delete unsignedReboundPlan.planSha256;
  assert.throws(
    () => h3Verifier.verify({
      ...unsignedReboundPlan,
      planSha256: canonicalHash(unsignedReboundPlan),
    }, h3Input.uid),
    expectCode('AUDIO_MODE_DATA_INVALID'),
  );

  const unsignedForgedSource = {
    ...plan.h3NativeSource,
    generationSpecSha256: 'c'.repeat(64),
    videoEvidenceSha256: 'd'.repeat(64),
  };
  delete unsignedForgedSource.sourceSha256;
  const forgedSource = {
    ...unsignedForgedSource,
    sourceSha256: canonicalHash(unsignedForgedSource),
  };
  const unsignedForgedPlan = { ...plan, h3NativeSource: forgedSource };
  delete unsignedForgedPlan.planSha256;
  assert.throws(
    () => h3Verifier.verify({
      ...unsignedForgedPlan,
      planSha256: canonicalHash(unsignedForgedPlan),
    }, h3Input.uid),
    expectCode('AUDIO_MODE_DATA_INVALID'),
  );
  assert.throws(
    () => h3Verifier.verify({
      ...plan,
      h3NativeSource: {
        ...plan.h3NativeSource,
        videoVersionEvidence: {
          ...plan.h3NativeSource.videoVersionEvidence,
          sha256: 'c'.repeat(64),
        },
      },
    }, h3Input.uid),
    expectCode('AUDIO_MODE_DATA_INVALID'),
  );

  const ttsInput = planInput('independent_tts');
  const ttsPlan = createAudioModePlan(ttsInput);
  const ttsVerifier = verifierFor(ttsInput);
  const forgedBinding = {
    ...ttsPlan.dialogueBindings[0],
    voiceProfileUid: uid(998),
    timingSha256: 'e'.repeat(64),
    estimatedTotalDurationMs: ttsPlan.dialogueBindings[0].estimatedTotalDurationMs + 1,
  };
  const unsignedForgedRequest = {
    ...ttsPlan.ttsRequests[0],
    voiceProfileUid: uid(998),
    provider: 'openai-compatible',
    model: 'forged-model',
    voiceKey: 'forged-voice',
    providerEmotion: 'forged-emotion',
    timingSha256: 'e'.repeat(64),
    speedPermille: 1200,
  };
  delete unsignedForgedRequest.requestSha256;
  const forgedRequest = {
    ...unsignedForgedRequest,
    requestSha256: canonicalHash(unsignedForgedRequest),
  };
  const unsignedForgedTtsPlan = {
    ...ttsPlan,
    dialogueBindings: [forgedBinding, ttsPlan.dialogueBindings[1]],
    ttsRequests: [forgedRequest, ttsPlan.ttsRequests[1]],
  };
  delete unsignedForgedTtsPlan.planSha256;
  assert.throws(
    () => ttsVerifier.verify({
      ...unsignedForgedTtsPlan,
      planSha256: canonicalHash(unsignedForgedTtsPlan),
    }, ttsInput.uid),
    expectCode('AUDIO_MODE_DATA_INVALID'),
  );

  const replacementProfile = voiceProfile(9, uid(10));
  const replacementInput = {
    ...ttsInput,
    dialogueDeliveries: [delivery(9, uid(10), replacementProfile.uid), ttsInput.dialogueDeliveries[1]],
    voiceProfiles: [replacementProfile, ttsInput.voiceProfiles[1]],
  };
  const replacementPlan = createAudioModePlan(replacementInput);
  const unsignedSubstitutedPlan = {
    ...ttsPlan,
    dialogueBindings: [replacementPlan.dialogueBindings[0], ttsPlan.dialogueBindings[1]],
    ttsRequests: [replacementPlan.ttsRequests[0], ttsPlan.ttsRequests[1]],
  };
  delete unsignedSubstitutedPlan.planSha256;
  assert.throws(
    () => ttsVerifier.verify({
      ...unsignedSubstitutedPlan,
      planSha256: canonicalHash(unsignedSubstitutedPlan),
    }, ttsInput.uid),
    expectCode('AUDIO_MODE_DATA_INVALID'),
  );

  let rootReads = 0;
  const rootProxy = new Proxy(planInput('independent_tts'), {
    ownKeys() {
      rootReads += 1;
      throw new Error('synthetic-audio-mode-proxy');
    },
  });
  assert.throws(() => createAudioModePlan(rootProxy), expectCode('AUDIO_MODE_INPUT_INVALID'));
  assert.equal(rootReads, 0);

  let arrayReads = 0;
  const hostileArray = new Proxy([], {
    getPrototypeOf() {
      arrayReads += 1;
      throw new Error('synthetic-audio-array-proxy');
    },
  });
  assert.throws(
    () => createAudioModePlan({ ...planInput('independent_tts'), dialogueDeliveries: hostileArray }),
    expectCode('AUDIO_MODE_INPUT_INVALID'),
  );
  assert.equal(arrayReads, 0);

  let nestedReads = 0;
  const trustedH3Plan = h3Verifier.verify(plan, h3Input.uid);
  const nativeExecution = createAudioExecutionEvidence({
    schemaVersion: '8.0', uid: uid(940), plan: trustedH3Plan, ttsOutputs: [],
    createdAtEpochMs: 1_800_000_300_000,
  });
  const nestedProxy = new Proxy(nativeExecution.h3NativeSource, {
    ownKeys() {
      nestedReads += 1;
      throw new Error('synthetic-h3-source-proxy');
    },
  });
  assert.throws(
    () => parseAudioExecutionEvidence(
      { ...nativeExecution, h3NativeSource: nestedProxy }, trustedH3Plan,
    ),
    expectCode('AUDIO_EXECUTION_EVIDENCE_INVALID'),
  );
  assert.equal(nestedReads, 0);

  let getterReads = 0;
  const hostile = planInput('independent_tts');
  Object.defineProperty(hostile, 'mode', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error('synthetic-mode-getter');
    },
  });
  assert.throws(() => createAudioModePlan(hostile), expectCode('AUDIO_MODE_INPUT_INVALID'));
  assert.equal(getterReads, 0);
});
