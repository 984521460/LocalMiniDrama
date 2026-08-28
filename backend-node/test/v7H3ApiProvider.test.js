'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  H3ContractError,
  compileH3ShotPrompt,
  createMinimaxH3ApiProvider,
  normalizeH3GenerationSpec,
} = require('../src/h3');

const DRAMA_UID = '73000000-0000-4000-8000-000000000000';

function prompt() {
  return compileH3ShotPrompt({
    dramaUid: DRAMA_UID,
    semanticShot: {
      shotId: 'shot-one', ordinal: 1, durationSeconds: 5,
      continuitySnapshotUid: '73000000-0000-4000-8000-000000000001',
      subjects: { description: 'A violinist stands alone on a small stage.', characters: [] },
      environment: {
        sceneId: 'small-stage', description: 'Dark curtains frame a polished wooden floor.',
        scene: {
          sceneUid: '73000000-0000-4000-8000-000000000002',
          versionUid: '73000000-0000-4000-8000-000000000003',
        },
        props: [],
      },
      action: 'The violinist raises the bow and begins a measured phrase.',
      camera: {
        shotSize: 'MS', cameraAngle: 'eye_level', cameraMovement: 'static',
        composition: 'The violin and both hands remain clear against the curtain.',
      },
      lighting: {
        quality: 'soft', direction: 'top', colorTemperature: 'warm',
        description: 'A soft pool of light separates the performer from the dark stage.',
      },
      continuity: {
        transitionFromPrevious: 'start', screenDirection: 'neutral',
        axisStrategy: 'establish', notes: 'The performer begins facing slightly frame left.',
      },
    },
  });
}

function image(ordinal, role) {
  return {
    ordinal, role, dramaUid: DRAMA_UID,
    assetVersionUid: `73000000-0000-4000-8000-${String(10 + ordinal).padStart(12, '0')}`,
    sha256: String(ordinal).repeat(64), mimeType: 'image/png', width: 1344, height: 768,
  };
}

function spec(mode = 't2v', referenceImages = []) {
  return normalizeH3GenerationSpec({
    mode, prompt: prompt(), width: 1344, height: 768,
    durationSeconds: 5, seed: 5, referenceImages,
  });
}

function provider(urls = new Map()) {
  return createMinimaxH3ApiProvider({
    resolveMediaUrl(assetVersionUid) {
      return urls.get(assetVersionUid);
    },
  });
}

function invalid(error) {
  return error instanceof H3ContractError && error.code === 'H3_API_REQUEST_INVALID';
}

test('MiniMax H3 API fallback builds a credential-free T2V request from the shared profile', () => {
  const request = provider().buildRequest(spec());
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    model: 'MiniMax-H3',
    content: [{ type: 'text', text: prompt().text }],
    duration: 5,
    resolution: '768P',
    ratio: '16:9',
  });
  assert.doesNotMatch(
    JSON.stringify(request),
    /endpoint|authorization|credential|password|api[_-]?key|base[_-]?url/i,
  );
  assert.equal(Object.isFrozen(request.content), true);
});

test('MiniMax H3 API fallback maps exact first/last and reference-image identities', () => {
  const first = image(1, 'first');
  const last = image(2, 'last');
  const urls = new Map([
    [first.assetVersionUid, 'https://media.example.invalid/first.png'],
    [last.assetVersionUid, 'https://media.example.invalid/last.png'],
  ]);
  const firstLast = provider(urls).buildRequest(spec('fl2va-first-last', [first, last]));
  assert.deepEqual(JSON.parse(JSON.stringify(firstLast.content.slice(1))), [
    { type: 'image_url', image_url: { url: urls.get(first.assetVersionUid) }, role: 'first_frame' },
    { type: 'image_url', image_url: { url: urls.get(last.assetVersionUid) }, role: 'last_frame' },
  ]);
  assert.equal(firstLast.ratio, 'adaptive');

  const reference = { ...image(1, 'reference') };
  const referenceRequest = provider(new Map([
    [reference.assetVersionUid, 'https://media.example.invalid/reference.png'],
  ])).buildRequest(spec('ref2va', [reference]));
  assert.equal(referenceRequest.content[1].role, 'reference_image');
  assert.equal(Object.hasOwn(referenceRequest, 'ratio'), false);
});

test('MiniMax H3 API fallback maps optional reference audio without changing the prompt', () => {
  const audio = {
    dramaUid: DRAMA_UID,
    assetVersionUid: '73000000-0000-4000-8000-000000000099',
    sha256: 'a'.repeat(64),
    mimeType: 'audio/wav',
    durationMs: 5000,
  };
  const audioSpec = normalizeH3GenerationSpec({
    mode: 't2v', prompt: prompt(), width: 1344, height: 768,
    durationSeconds: 5, seed: 5, referenceImages: [], referenceAudio: audio,
  });
  const request = provider(new Map([
    [audio.assetVersionUid, 'https://media.example.invalid/reference.wav'],
  ])).buildRequest(audioSpec);
  assert.deepEqual(JSON.parse(JSON.stringify(request.content)), [
    { type: 'text', text: prompt().text },
    {
      type: 'audio_url',
      audio_url: { url: 'https://media.example.invalid/reference.wav' },
      role: 'reference_audio',
    },
  ]);
  assert.equal(request.ratio, '16:9');
});

test('MiniMax H3 API fallback rejects unsupported duration, unsafe URLs and missing media', () => {
  const short = normalizeH3GenerationSpec({
    mode: 't2v', prompt: prompt(), width: 608, height: 352,
    durationSeconds: 1, seed: 5, referenceImages: [],
  });
  assert.throws(() => provider().buildRequest(short), invalid);
  const first = image(1, 'first');
  const firstSpec = spec('fl2va-first', [first]);
  assert.throws(() => provider().buildRequest(firstSpec), invalid);
  assert.throws(
    () => provider(new Map([[
      first.assetVersionUid,
      'https://user:secret@media.example.invalid/frame.png',
    ]])).buildRequest(firstSpec),
    invalid,
  );
});

test('MiniMax H3 API provider rejects hostile configuration without reading traps', () => {
  let reads = 0;
  const options = new Proxy({ resolveMediaUrl() {} }, {
    ownKeys() {
      reads += 1;
      throw new Error('synthetic-options-marker');
    },
  });
  assert.throws(() => createMinimaxH3ApiProvider(options), TypeError);
  assert.equal(reads, 0);
});
