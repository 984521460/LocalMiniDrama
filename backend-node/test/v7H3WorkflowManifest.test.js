'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  H3ContractError,
  compileH3GenerationWorkflow,
  compileH3ShotPrompt,
  createH3TextToVideoWorkflowBundle,
  normalizeH3GenerationSpec,
} = require('../src/h3');
const { isComfyWorkflowManifest } = require('../src/remote/workflowManifest');

const DRAMA_UID = '71000000-0000-4000-8000-000000000000';

function semanticShot() {
  return {
    shotId: 'shot-one', ordinal: 1, durationSeconds: 5,
    continuitySnapshotUid: '71000000-0000-4000-8000-000000000001',
    subjects: { description: 'A courier waits beneath a lantern.', characters: [] },
    environment: {
      sceneId: 'night-alley',
      description: 'A narrow stone alley glistens after rain.',
      scene: {
        sceneUid: '71000000-0000-4000-8000-000000000002',
        versionUid: '71000000-0000-4000-8000-000000000003',
      },
      props: [],
    },
    action: 'The courier turns as a paper lantern moves in the wind.',
    camera: {
      shotSize: 'MS', cameraAngle: 'eye_level', cameraMovement: 'dolly',
      composition: 'The courier stays centered while the alley opens behind them.',
    },
    lighting: {
      quality: 'mixed', direction: 'side', colorTemperature: 'warm',
      description: 'Warm lantern light meets cool reflected light from the stones.',
    },
    continuity: {
      transitionFromPrevious: 'start', screenDirection: 'neutral', axisStrategy: 'establish',
      notes: 'The courier begins still and faces frame right.',
    },
  };
}

function t2vSpec() {
  const prompt = compileH3ShotPrompt({ dramaUid: DRAMA_UID, semanticShot: semanticShot() });
  return normalizeH3GenerationSpec({
    mode: 't2v', prompt, width: 608, height: 352,
    durationSeconds: 1, seed: 77, referenceImages: [],
  });
}

function referenceAudio() {
  return {
    dramaUid: DRAMA_UID,
    assetVersionUid: '71000000-0000-4000-8000-000000000020',
    sha256: 'b'.repeat(64),
    mimeType: 'audio/wav',
    durationMs: 1000,
  };
}

test('H3 T2V bundle is a deterministic branded manifest with complete model closure', () => {
  const first = createH3TextToVideoWorkflowBundle();
  const second = createH3TextToVideoWorkflowBundle();
  assert.equal(first, second);
  assert.equal(isComfyWorkflowManifest(first.manifest), true);
  assert.equal(first.manifest.manifestId, 'minimax-h3-t2v-local-v1');
  assert.equal(
    first.manifest.workflowSha256,
    crypto.createHash('sha256').update(first.workflowJson, 'utf8').digest('hex'),
  );
  assert.deepEqual(
    first.manifest.requirements.filter(({ kind }) => kind === 'model').map(({ fileName }) => fileName).sort(),
    [
      'minimax_h3_audio_vae_fp32.safetensors',
      'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
      'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
      'minimax_h3_video_vae_fp16.safetensors',
      'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    ].sort(),
  );
  assert.equal(Object.isFrozen(first), true);
});

test('H3 T2V compiler binds only normalized application values and the video output marker', () => {
  const spec = t2vSpec();
  const compiled = compileH3GenerationWorkflow({
    generationSpec: spec,
    filenamePrefix: 'video/shot-one-v1',
  });
  assert.equal(compiled.manifestUid, createH3TextToVideoWorkflowBundle().manifest.uid);
  assert.equal(compiled.prompt[131].inputs.prompt, spec.prompt.text);
  assert.equal(compiled.prompt[131].inputs.width, 608);
  assert.equal(compiled.prompt[131].inputs.height, 352);
  assert.equal(compiled.prompt[131].inputs.length, 39);
  assert.equal(compiled.prompt[129].inputs.noise_seed, 77);
  assert.equal(compiled.prompt[92].inputs.filename_prefix, 'video/shot-one-v1');
  assert.equal(compiled.outputNodeIds.video, '92');
  assert.deepEqual(Object.keys(compiled.outputNodeIds), ['video']);
  assert.doesNotMatch(JSON.stringify(compiled), /password|authorization|credential|api[_-]?key/i);
});

test('H3 workflow compiler refuses unverified modes and unsafe output prefixes', () => {
  const base = t2vSpec();
  const reference = {
    ordinal: 1,
    role: 'first',
    dramaUid: DRAMA_UID,
    assetVersionUid: '71000000-0000-4000-8000-000000000010',
    sha256: 'a'.repeat(64),
    mimeType: 'image/png',
    width: 608,
    height: 352,
  };
  const firstFrame = normalizeH3GenerationSpec({
    mode: 'fl2va-first', prompt: base.prompt, width: 608, height: 352,
    durationSeconds: 1, seed: 77, referenceImages: [reference],
  });
  assert.throws(
    () => compileH3GenerationWorkflow({
      generationSpec: firstFrame,
      filenamePrefix: 'video/unverified',
    }),
    (error) => error instanceof H3ContractError && error.code === 'H3_WORKFLOW_UNVERIFIED',
  );
  assert.throws(
    () => compileH3GenerationWorkflow({
      generationSpec: normalizeH3GenerationSpec({
        mode: 't2v', prompt: base.prompt, width: 608, height: 352,
        durationSeconds: 1, seed: 77, referenceImages: [],
        referenceAudio: referenceAudio(),
      }),
      filenamePrefix: 'video/unverified-audio',
    }),
    (error) => error instanceof H3ContractError && error.code === 'H3_WORKFLOW_UNVERIFIED',
  );
  assert.throws(
    () => compileH3GenerationWorkflow({
      generationSpec: base,
      filenamePrefix: '../private/output',
    }),
    (error) => error instanceof H3ContractError && error.code === 'H3_GENERATION_INPUT_INVALID',
  );
});
