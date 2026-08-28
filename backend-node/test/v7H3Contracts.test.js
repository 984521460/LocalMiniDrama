'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const {
  H3_PROFILE,
  H3ContractError,
  compileH3ShotPrompt,
  normalizeH3GenerationSpec,
} = require('../src/h3');
const {
  H3_MODEL_FILES,
  buildMinimaxH3TextToVideoPrompt,
} = require('../src/integrations/comfyui/workflows');

const profileSchema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../schemas/v7/h3-profile.schema.json'),
  'utf8',
));
const promptSchema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../schemas/v7/h3-shot-prompt.schema.json'),
  'utf8',
));
const generationSchema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../schemas/v7/h3-generation-spec.schema.json'),
  'utf8',
));

function semanticShot(overrides = {}) {
  return {
    shotId: 'shot-one',
    ordinal: 1,
    durationSeconds: 5,
    continuitySnapshotUid: '70000000-0000-4000-8000-000000000001',
    subjects: {
      description: 'Two rivals face each other in a rain-soaked courtyard.',
      characters: [{
        factRef: 'character-one',
        characterUid: '70000000-0000-4000-8000-000000000002',
        referencePackageUid: '70000000-0000-4000-8000-000000000003',
        identityVersionUid: '70000000-0000-4000-8000-000000000004',
        costumeVersionUid: '70000000-0000-4000-8000-000000000005',
      }],
    },
    environment: {
      sceneId: 'rainy-courtyard',
      description: 'Stone paving reflects warm lantern light under steady rain.',
      scene: {
        sceneUid: '70000000-0000-4000-8000-000000000006',
        versionUid: '70000000-0000-4000-8000-000000000007',
      },
      props: [],
    },
    action: 'One fighter advances while the other pivots aside and counters.',
    camera: {
      shotSize: 'MS',
      cameraAngle: 'eye_level',
      cameraMovement: 'dolly',
      composition: 'Both fighters remain readable while the counter lands in profile.',
    },
    lighting: {
      quality: 'mixed',
      direction: 'side',
      colorTemperature: 'warm',
      description: 'Lantern side light outlines the figures against cool rain.',
    },
    continuity: {
      transitionFromPrevious: 'start',
      screenDirection: 'left_to_right',
      axisStrategy: 'establish',
      notes: 'The fighter in the dark coat remains on frame left.',
    },
    ...overrides,
  };
}

function mediaEvidence(ordinal, role) {
  return {
    ordinal,
    role,
    dramaUid: '70000000-0000-4000-8000-000000000000',
    assetVersionUid: `70000000-0000-4000-8000-${String(100 + ordinal).padStart(12, '0')}`,
    sha256: String(ordinal).repeat(64),
    mimeType: 'image/png',
    width: 1344,
    height: 768,
  };
}

function promptInput(overrides = {}) {
  return {
    dramaUid: '70000000-0000-4000-8000-000000000000',
    semanticShot: semanticShot(),
    ...overrides,
  };
}

function expectCode(code) {
  return (error) => error instanceof H3ContractError && error.code === code;
}

test('H3 profile is immutable, schema-valid, and distinguishes measured from unverified modes', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(profileSchema);
  assert.equal(validate(H3_PROFILE), true, JSON.stringify(validate.errors));
  assert.equal(H3_PROFILE.schemaVersion, 'h3-profile.v1');
  assert.equal(H3_PROFILE.fps, 24);
  assert.deepEqual(H3_PROFILE.frameGrid, { offset: 5, stride: 17, minimum: 5 });
  assert.equal(H3_PROFILE.modes.t2v.realValidation, 'validated-rtx4090');
  assert.equal(H3_PROFILE.modes['fl2va-first'].realValidation, 'unverified');
  assert.equal(H3_PROFILE.modes['fl2va-first-last'].realValidation, 'unverified');
  assert.equal(H3_PROFILE.modes.ref2va.realValidation, 'unverified');
  assert.equal(H3_PROFILE.models.videoVae.sha256, null);
  assert.equal(H3_PROFILE.models.videoVae.digestStatus, 'historical-evidence-malformed');
  assert.equal(Object.isFrozen(H3_PROFILE), true);
  assert.equal(Object.isFrozen(H3_PROFILE.models), true);
  assert.equal(Object.isFrozen(H3_PROFILE.modes), true);
  assert.doesNotMatch(JSON.stringify(H3_PROFILE), /password|authorization|credential|api[_-]?key/i);
  assert.deepEqual(H3_MODEL_FILES, {
    diffusionModel: H3_PROFILE.models.diffusion.fileName,
    textEncoder: H3_PROFILE.models.textEncoder.fileName,
    videoVae: H3_PROFILE.models.videoVae.fileName,
    audioVae: H3_PROFILE.models.audioVae.fileName,
    turboLora4Step: H3_PROFILE.models.turboLora.fileName,
  });

  const forgedDigest = structuredClone(H3_PROFILE);
  forgedDigest.models.videoVae.digestStatus = 'verified';
  assert.equal(validate(forgedDigest), false);
  const missingDigest = structuredClone(H3_PROFILE);
  missingDigest.models.diffusion.sha256 = null;
  assert.equal(validate(missingDigest), false);
});

test('H3 shot prompt deterministically compiles provider-neutral semantic evidence', () => {
  const first = compileH3ShotPrompt(promptInput());
  const second = compileH3ShotPrompt(promptInput());
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(promptSchema);
  assert.equal(validate(first), true, JSON.stringify(validate.errors));
  assert.deepEqual(first, second);
  assert.equal(first.promptSha256.length, 64);
  assert.match(first.text, /rain-soaked courtyard/u);
  assert.match(first.text, /medium shot/u);
  assert.doesNotMatch(first.text, /70000000|safetensors|workflow|sampler|provider|seed|steps|cfg/i);
  assert.equal(Object.isFrozen(first), true);
});

test('H3 shot prompt rejects unsafe text and hostile containers without executing traps', () => {
  assert.throws(
    () => compileH3ShotPrompt(promptInput({
      semanticShot: semanticShot({ action: 'Generated with Stable Diffusion.' }),
    })),
    expectCode('H3_PROMPT_INVALID'),
  );
  let reads = 0;
  const input = new Proxy(promptInput(), {
    ownKeys() {
      reads += 1;
      throw new Error('synthetic-proxy-marker');
    },
  });
  assert.throws(() => compileH3ShotPrompt(input), expectCode('H3_PROMPT_INVALID'));
  assert.equal(reads, 0);
});

test('H3 generation spec normalizes frame grid and exact reference roles', () => {
  const prompt = compileH3ShotPrompt(promptInput());
  const t2v = normalizeH3GenerationSpec({
    mode: 't2v',
    prompt,
    width: 608,
    height: 352,
    durationSeconds: 1,
    seed: 42,
    referenceImages: [],
  });
  const firstLast = normalizeH3GenerationSpec({
    mode: 'fl2va-first-last',
    prompt,
    width: 1344,
    height: 768,
    durationSeconds: 5,
    seed: 0,
    referenceImages: [mediaEvidence(1, 'first'), mediaEvidence(2, 'last')],
  });
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(generationSchema);
  assert.equal(validate(t2v), true, JSON.stringify(validate.errors));
  assert.equal(validate(firstLast), true, JSON.stringify(validate.errors));
  assert.equal(t2v.frames, 39);
  assert.equal(t2v.fps, 24);
  const graph = buildMinimaxH3TextToVideoPrompt({
    prompt: t2v.prompt.text,
    width: t2v.width,
    height: t2v.height,
    durationSeconds: t2v.durationSeconds,
    seed: t2v.seed,
  });
  assert.equal(graph[124].inputs.steps, H3_PROFILE.sampler.steps);
  assert.equal(graph[130].inputs.fps, H3_PROFILE.fps);
  assert.equal(graph[131].inputs.length, t2v.frames);
  assert.deepEqual(firstLast.referenceImages.map(({ ordinal, role }) => ({ ordinal, role })), [
    { ordinal: 1, role: 'first' },
    { ordinal: 2, role: 'last' },
  ]);
  assert.equal(Object.isFrozen(firstLast.referenceImages), true);
});

test('H3 generation spec rejects invalid canvas, sparse or mismatched references, and prompt drift', () => {
  const prompt = compileH3ShotPrompt(promptInput());
  const base = {
    mode: 'fl2va-first-last', prompt, width: 1344, height: 768,
    durationSeconds: 5, seed: 1,
  };
  assert.throws(
    () => normalizeH3GenerationSpec({ ...base, width: 1330, referenceImages: [
      mediaEvidence(1, 'first'), mediaEvidence(2, 'last'),
    ] }),
    expectCode('H3_GENERATION_INPUT_INVALID'),
  );
  assert.throws(
    () => normalizeH3GenerationSpec({ ...base, referenceImages: [
      mediaEvidence(1, 'last'), mediaEvidence(2, 'first'),
    ] }),
    expectCode('H3_GENERATION_INPUT_INVALID'),
  );
  const sparse = new Array(2);
  sparse[0] = mediaEvidence(1, 'first');
  assert.throws(
    () => normalizeH3GenerationSpec({ ...base, referenceImages: sparse }),
    expectCode('H3_GENERATION_INPUT_INVALID'),
  );
  assert.throws(
    () => normalizeH3GenerationSpec({
      ...base,
      prompt: { ...prompt, promptSha256: '0'.repeat(64) },
      referenceImages: [mediaEvidence(1, 'first'), mediaEvidence(2, 'last')],
    }),
    expectCode('H3_GENERATION_INPUT_INVALID'),
  );
});
