'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const {
  H3ContractError,
  compileH3ShotPrompt,
  normalizeH3GenerationSpec,
  validateH3VideoOutput,
} = require('../src/h3');

function generationSpec() {
  const prompt = compileH3ShotPrompt({
    dramaUid: '72000000-0000-4000-8000-000000000000',
    semanticShot: {
      shotId: 'shot-one', ordinal: 1, durationSeconds: 5,
      continuitySnapshotUid: '72000000-0000-4000-8000-000000000001',
      subjects: { description: 'A rider crosses an open field.', characters: [] },
      environment: {
        sceneId: 'open-field', description: 'Tall grass moves beneath a bright overcast sky.',
        scene: {
          sceneUid: '72000000-0000-4000-8000-000000000002',
          versionUid: '72000000-0000-4000-8000-000000000003',
        },
        props: [],
      },
      action: 'The rider accelerates and passes close to the camera.',
      camera: {
        shotSize: 'LS', cameraAngle: 'low', cameraMovement: 'pan',
        composition: 'The rider crosses the lower third while the horizon remains stable.',
      },
      lighting: {
        quality: 'natural', direction: 'ambient', colorTemperature: 'neutral',
        description: 'Soft daylight preserves detail in the rider and grass.',
      },
      continuity: {
        transitionFromPrevious: 'start', screenDirection: 'left_to_right',
        axisStrategy: 'establish', notes: 'The rider enters from frame left.',
      },
    },
  });
  return normalizeH3GenerationSpec({
    mode: 't2v', prompt, width: 608, height: 352,
    durationSeconds: 1, seed: 9, referenceImages: [],
  });
}

function measured(overrides = {}) {
  return {
    sha256: 'b'.repeat(64),
    bytes: 123456,
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
    ...overrides,
  };
}

function outputInvalid(error) {
  return error instanceof H3ContractError && error.code === 'H3_OUTPUT_INVALID';
}

test('H3 video evidence binds hash, media probe and normalized generation identity', () => {
  const evidence = validateH3VideoOutput({ generationSpec: generationSpec(), measured: measured() });
  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v7/h3-video-evidence.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  assert.equal(evidence.generationSpecSha256.length, 64);
  assert.equal(evidence.durationMs, 1625);
  assert.equal(Object.isFrozen(evidence), true);
});

test('H3 video evidence rejects wrong dimensions, duration, streams and perceptual failure', () => {
  const spec = generationSpec();
  for (const invalid of [
    measured({ width: 1280 }),
    measured({ durationMs: 600 }),
    measured({ frames: 38 }),
    measured({ fps: 23.976 }),
    measured({ videoCodec: 'vp9' }),
    measured({ audioStreams: 0, audioCodec: null }),
    measured({ blackFrameRatio: 0.99 }),
    measured({ frozenFrameRatio: 0.99 }),
    measured({ bytes: 0 }),
  ]) {
    assert.throws(
      () => validateH3VideoOutput({ generationSpec: spec, measured: invalid }),
      outputInvalid,
    );
  }
});

test('H3 video evidence rejects hostile probe containers without running traps', () => {
  let reads = 0;
  const measuredProxy = new Proxy(measured(), {
    ownKeys() {
      reads += 1;
      throw new Error('synthetic-media-proxy-marker');
    },
  });
  assert.throws(
    () => validateH3VideoOutput({ generationSpec: generationSpec(), measured: measuredProxy }),
    outputInvalid,
  );
  assert.equal(reads, 0);
});
