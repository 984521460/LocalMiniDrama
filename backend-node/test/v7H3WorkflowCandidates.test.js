'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  H3ContractError,
  H3_OFFICIAL_WORKFLOW_SOURCES,
  compileH3GenerationWorkflow,
  compileH3WorkflowCandidate,
  compileH3ShotPrompt,
  createH3WorkflowCandidateBundle,
  normalizeH3GenerationSpec,
} = require('../src/h3');
const { isComfyWorkflowManifest } = require('../src/remote/workflowManifest');

const DRAMA_UID = '75000000-0000-4000-8000-000000000000';

function prompt() {
  return compileH3ShotPrompt({
    dramaUid: DRAMA_UID,
    semanticShot: {
      shotId: 'shot-candidate', ordinal: 1, durationSeconds: 5,
      continuitySnapshotUid: '75000000-0000-4000-8000-000000000001',
      subjects: { description: 'Two couriers face each other in a rain-soaked courtyard.', characters: [] },
      environment: {
        sceneId: 'rain-courtyard',
        description: 'A stone courtyard under cold rain.',
        scene: {
          sceneUid: '75000000-0000-4000-8000-000000000002',
          versionUid: '75000000-0000-4000-8000-000000000003',
        },
        props: [],
      },
      action: 'They circle, exchange two quick strikes, then separate.',
      camera: {
        shotSize: 'MS', cameraAngle: 'eye_level', cameraMovement: 'dolly',
        composition: 'Both couriers remain readable across the cut.',
      },
      lighting: {
        quality: 'mixed', direction: 'side', colorTemperature: 'cool',
        description: 'Cold rain catches a warm side light.',
      },
      continuity: {
        transitionFromPrevious: 'start', screenDirection: 'neutral', axisStrategy: 'establish',
        notes: 'The courier in blue remains frame left.',
      },
    },
  });
}

function image(ordinal, role) {
  return {
    ordinal,
    role,
    dramaUid: DRAMA_UID,
    assetVersionUid: `75000000-0000-4000-8000-${String(ordinal + 10).padStart(12, '0')}`,
    sha256: String(ordinal).repeat(64),
    mimeType: 'image/png',
    width: 608,
    height: 352,
  };
}

function audio() {
  return {
    dramaUid: DRAMA_UID,
    assetVersionUid: '75000000-0000-4000-8000-000000000020',
    sha256: 'a'.repeat(64),
    mimeType: 'audio/wav',
    durationMs: 1000,
  };
}

function spec(mode, referenceImages, referenceAudio = null) {
  return normalizeH3GenerationSpec({
    mode,
    prompt: prompt(),
    width: 608,
    height: 352,
    durationSeconds: 1,
    seed: 77,
    referenceImages,
    referenceAudio,
  });
}

function imageFile(reference, suffix = reference.ordinal) {
  return {
    assetVersionUid: reference.assetVersionUid,
    sha256: reference.sha256,
    fileName: `h3-input/shot-candidate-reference-${suffix}.png`,
  };
}

function audioFile(reference) {
  return {
    assetVersionUid: reference.assetVersionUid,
    sha256: reference.sha256,
    fileName: 'h3-input/shot-candidate-reference-audio.wav',
  };
}

function compileCandidate(generationSpec, referenceImages, referenceAudio = null) {
  return compileH3WorkflowCandidate({
    generationSpec,
    filenamePrefix: 'video/shot-candidate-v1',
    mediaBindings: {
      referenceImages: referenceImages.map((reference) => imageFile(reference)),
      referenceAudio: referenceAudio === null ? null : audioFile(referenceAudio),
    },
  });
}

test('H3 candidate catalog pins the official I2V and Ref2V templates without claiming real validation', () => {
  assert.deepEqual(H3_OFFICIAL_WORKFLOW_SOURCES.i2v, {
    repository: 'Comfy-Org/workflow_templates',
    commit: '0b1ef3ec90846bf82eba195ddcc30a1f5b2b6b38',
    templatePath: 'templates/video_minimax_h3_i2v.json',
    templateSha256: '4dc94e9ea308c1d60409e7f55dba5e2788dab4659c2dbb90f1e9481498767540',
    templateBytes: 71242,
    realValidation: 'unverified',
  });
  assert.deepEqual(H3_OFFICIAL_WORKFLOW_SOURCES.ref2v, {
    repository: 'Comfy-Org/workflow_templates',
    commit: '0b1ef3ec90846bf82eba195ddcc30a1f5b2b6b38',
    templatePath: 'templates/video_minimax_h3_r2v.json',
    templateSha256: '14b30659a057547e02bdd4bbbdda3f8670aa6d7d81d1d8d99c4f9ad1e2eabc44',
    templateBytes: 45121,
    realValidation: 'unverified',
  });
  assert.equal(Object.isFrozen(H3_OFFICIAL_WORKFLOW_SOURCES), true);
  assert.equal(Object.isFrozen(H3_OFFICIAL_WORKFLOW_SOURCES.i2v), true);
});

test('H3 first-frame and first-last candidate bundles are deterministic closed manifests', () => {
  for (const entry of [
    { mode: 'fl2va-first', referenceImageCount: 1, referenceAudio: false },
    { mode: 'fl2va-first-last', referenceImageCount: 2, referenceAudio: false },
  ]) {
    const first = createH3WorkflowCandidateBundle(entry);
    const second = createH3WorkflowCandidateBundle(entry);
    assert.equal(first, second);
    assert.equal(first.supportStatus, 'implementation-candidate-unverified');
    assert.equal(first.source, H3_OFFICIAL_WORKFLOW_SOURCES.i2v);
    assert.equal(isComfyWorkflowManifest(first.manifest), true);
    assert.equal(
      first.manifest.workflowSha256,
      crypto.createHash('sha256').update(first.workflowJson, 'utf8').digest('hex'),
    );
    assert.equal(Object.isFrozen(first), true);
  }
});

test('H3 FL2VA candidate compiler binds one or two ordered images and native video output', () => {
  const firstReference = image(1, 'first');
  const firstCompiled = compileCandidate(
    spec('fl2va-first', [firstReference]),
    [firstReference],
  );
  assert.equal(firstCompiled.supportStatus, 'implementation-candidate-unverified');
  assert.equal(firstCompiled.prompt[201].class_type, 'LoadImage');
  assert.equal(firstCompiled.prompt[201].inputs.image, 'h3-input/shot-candidate-reference-1.png');
  assert.deepEqual(firstCompiled.prompt[131].inputs.first_frame, ['201', 0]);
  assert.equal(Object.hasOwn(firstCompiled.prompt[131].inputs, 'last_frame'), false);
  assert.equal(firstCompiled.outputNodeIds.video, '92');

  const lastReference = image(2, 'last');
  const firstLastCompiled = compileCandidate(
    spec('fl2va-first-last', [firstReference, lastReference]),
    [firstReference, lastReference],
  );
  assert.deepEqual(firstLastCompiled.prompt[131].inputs.first_frame, ['201', 0]);
  assert.deepEqual(firstLastCompiled.prompt[131].inputs.last_frame, ['202', 0]);
  assert.equal(firstLastCompiled.prompt[202].inputs.image, 'h3-input/shot-candidate-reference-2.png');
  assert.doesNotMatch(JSON.stringify(firstLastCompiled), /password|authorization|credential|api[_-]?key/i);
});

test('H3 Ref2VA candidates bind one through four ordered images and optional reference audio', () => {
  for (let count = 1; count <= 4; count += 1) {
    const references = Array.from({ length: count }, (_, index) => image(index + 1, 'reference'));
    const compiled = compileCandidate(spec('ref2va', references), references);
    assert.equal(compiled.prompt[131].class_type, 'MiniMaxH3ReferenceToVideo');
    references.forEach((reference, index) => {
      const nodeId = String(201 + index);
      assert.equal(compiled.prompt[nodeId].inputs.image, `h3-input/shot-candidate-reference-${index + 1}.png`);
      assert.deepEqual(compiled.prompt[131].inputs[`ref_images.ref_image_${index}`], [nodeId, 0]);
    });
    assert.equal(Object.hasOwn(compiled.prompt[131].inputs, 'ref_audios.ref_audio_0'), false);
  }

  const references = [image(1, 'reference'), image(2, 'reference')];
  const referenceAudio = audio();
  const compiled = compileCandidate(
    spec('ref2va', references, referenceAudio),
    references,
    referenceAudio,
  );
  assert.equal(compiled.prompt[301].class_type, 'LoadAudio');
  assert.equal(compiled.prompt[301].inputs.audio, 'h3-input/shot-candidate-reference-audio.wav');
  assert.deepEqual(compiled.prompt[131].inputs['ref_audios.ref_audio_0'], ['301', 0]);
  assert.deepEqual(compiled.prompt[121].inputs.samples, ['125', 0]);
  assert.deepEqual(compiled.prompt[122].inputs.samples, ['125', 0]);
  assert.deepEqual(compiled.prompt[130].inputs.images, ['122', 0]);
  assert.deepEqual(compiled.prompt[130].inputs.audio, ['121', 0]);
  assert.deepEqual(Object.keys(compiled.outputNodeIds), ['video']);
  assert.equal(compiled.outputNodeIds.video, '92');
  assert.equal(compiled.nativeAudioOutput, true);
  assert.deepEqual(
    createH3WorkflowCandidateBundle({
      mode: 'ref2va', referenceImageCount: 2, referenceAudio: true,
    }).manifest.requirements.filter(({ kind }) => kind === 'model').map(({ fileName }) => fileName).sort(),
    [
      'minimax_h3_audio_vae_fp32.safetensors',
      'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
      'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
      'minimax_h3_video_vae_fp16.safetensors',
      'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    ].sort(),
  );
});

test('H3 candidate compiler rejects mismatched evidence, unsafe names, and unsupported audio placement', () => {
  const firstReference = image(1, 'first');
  const firstSpec = spec('fl2va-first', [firstReference]);
  const mismatched = imageFile(firstReference);
  mismatched.sha256 = 'f'.repeat(64);
  assert.throws(
    () => compileH3WorkflowCandidate({
      generationSpec: firstSpec,
      filenamePrefix: 'video/shot-candidate-v1',
      mediaBindings: { referenceImages: [mismatched], referenceAudio: null },
    }),
    (error) => error instanceof H3ContractError && error.code === 'H3_GENERATION_INPUT_INVALID',
  );

  const unsafe = imageFile(firstReference);
  unsafe.fileName = '../private/reference.png';
  assert.throws(
    () => compileH3WorkflowCandidate({
      generationSpec: firstSpec,
      filenamePrefix: 'video/shot-candidate-v1',
      mediaBindings: { referenceImages: [unsafe], referenceAudio: null },
    }),
    (error) => error instanceof H3ContractError && error.code === 'H3_GENERATION_INPUT_INVALID',
  );

  const audioReference = audio();
  const unsupportedAudioSpec = spec('fl2va-first', [firstReference], audioReference);
  assert.throws(
    () => compileCandidate(unsupportedAudioSpec, [firstReference], audioReference),
    (error) => error instanceof H3ContractError && error.code === 'H3_WORKFLOW_UNVERIFIED',
  );

  const references = [image(1, 'reference'), image(2, 'reference')];
  const duplicateFiles = references.map((reference) => imageFile(reference, 1));
  assert.throws(
    () => compileH3WorkflowCandidate({
      generationSpec: spec('ref2va', references),
      filenamePrefix: 'video/shot-candidate-v1',
      mediaBindings: { referenceImages: duplicateFiles, referenceAudio: null },
    }),
    (error) => error instanceof H3ContractError && error.code === 'H3_GENERATION_INPUT_INVALID',
  );

  const wrongExtension = imageFile(firstReference);
  wrongExtension.fileName = 'h3-input/reference.wav';
  assert.throws(
    () => compileH3WorkflowCandidate({
      generationSpec: firstSpec,
      filenamePrefix: 'video/shot-candidate-v1',
      mediaBindings: { referenceImages: [wrongExtension], referenceAudio: null },
    }),
    (error) => error instanceof H3ContractError && error.code === 'H3_GENERATION_INPUT_INVALID',
  );
});

test('candidate compilation does not silently enable unverified modes in the production compiler', () => {
  const firstReference = image(1, 'first');
  const generationSpec = spec('fl2va-first', [firstReference]);
  assert.doesNotThrow(() => compileCandidate(generationSpec, [firstReference]));
  assert.throws(
    () => compileH3GenerationWorkflow({
      generationSpec,
      filenamePrefix: 'video/shot-candidate-v1',
    }),
    (error) => error instanceof H3ContractError && error.code === 'H3_WORKFLOW_UNVERIFIED',
  );
});
