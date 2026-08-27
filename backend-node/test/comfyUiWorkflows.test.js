'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  H3_MODEL_FILES,
  buildMinimaxH3TextToVideoPrompt,
  buildMinimalImagePrompt,
  h3FramesForDuration,
} = require('../src/integrations/comfyui/workflows');

test('minimal image workflow is a native EmptyImage to SaveImage graph', () => {
  assert.deepEqual(buildMinimalImagePrompt({ width: 96, height: 64, color: 0x336699 }), {
    1: {
      class_type: 'EmptyImage',
      inputs: { width: 96, height: 64, batch_size: 1, color: 0x336699 },
    },
    2: {
      class_type: 'SaveImage',
      inputs: { images: ['1', 0], filename_prefix: 'phase1/ComfyUI_smoke' },
    },
  });
});

test('H3 duration snaps to the official 17k+5 frame grid at 24 fps', () => {
  assert.equal(h3FramesForDuration(0.2), 5);
  assert.equal(h3FramesForDuration(1), 39);
  assert.equal(h3FramesForDuration(5), 124);
});

test('H3 workflow uses the verified official files and four-step turbo path', () => {
  const graph = buildMinimaxH3TextToVideoPrompt({
    prompt: 'A paper lantern sways in a quiet alley.',
    width: 608,
    height: 352,
    durationSeconds: 0.2,
    seed: 20260825,
    filenamePrefix: 'video/H3_contract',
  });

  assert.equal(graph[127].inputs.unet_name, H3_MODEL_FILES.diffusionModel);
  assert.equal(graph[128].inputs.clip_name, H3_MODEL_FILES.textEncoder);
  assert.equal(graph[119].inputs.vae_name, H3_MODEL_FILES.videoVae);
  assert.equal(graph[120].inputs.vae_name, H3_MODEL_FILES.audioVae);
  assert.equal(graph[134].inputs.lora_name, H3_MODEL_FILES.turboLora4Step);
  assert.deepEqual(graph[124].inputs.model, ['134', 0]);
  assert.deepEqual(graph[126].inputs.model, ['134', 0]);
  assert.equal(graph[124].inputs.steps, 4);
  assert.equal(graph[131].inputs.length, 5);
  assert.equal(graph[131].inputs.width, 608);
  assert.equal(graph[131].inputs.height, 352);
  assert.equal(graph[92].inputs.filename_prefix, 'video/H3_contract');
});

test('workflow builders reject unsafe dimensions and empty prompts', () => {
  assert.throws(() => buildMinimalImagePrompt({ width: 0, height: 64 }), /width/i);
  assert.throws(() => buildMinimalImagePrompt({ filenamePrefix: '../escape' }), /filenamePrefix/i);
  assert.throws(() => buildMinimalImagePrompt({ filenamePrefix: 'C:/escape' }), /filenamePrefix/i);
  assert.throws(() => buildMinimaxH3TextToVideoPrompt({
    prompt: '   ',
    width: 608,
    height: 352,
    durationSeconds: 1,
  }), /prompt/i);
  assert.throws(() => buildMinimaxH3TextToVideoPrompt({
    prompt: 'test',
    width: 600,
    height: 352,
    durationSeconds: 1,
  }), /multiple of 32/i);
  assert.throws(() => buildMinimaxH3TextToVideoPrompt({
    prompt: 'test',
    width: 1376,
    height: 768,
    durationSeconds: 1,
  }), /canvas/i);
});
