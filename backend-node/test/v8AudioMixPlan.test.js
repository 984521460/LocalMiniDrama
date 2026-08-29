'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const { AudioModeContractError, canonicalHash } = require('../src/audio/audioContract');
const {
  AUDIO_MIX_ALGORITHM_VERSION,
  createAudioMixPlan,
  createAudioMixPlanVerifier,
  requireTrustedAudioMixPlan,
} = require('../src/audio/audioMixPlan');
const {
  createBgmTrackFixture,
  createTimelineFixture,
  uid,
} = require('./helpers/v8AudioFixture');

const SCHEMA_ROOT = path.resolve(__dirname, '../../schemas/v8');
const validateMixPlan = new Ajv2020({ allErrors: true, strict: true }).compile(
  JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, 'audio-mix-plan.schema.json'), 'utf8')),
);

function settings(overrides = {}) {
  return {
    dialogueGainMilliDb: 0,
    nativeGainMilliDb: -3000,
    bgmGainMilliDb: -9000,
    duckedBgmGainMilliDb: -18000,
    fadeInMs: 200,
    fadeOutMs: 300,
    duckingAttackMs: 50,
    duckingReleaseMs: 100,
    ...overrides,
  };
}

function envelope(mode = 'hybrid', overrides = {}) {
  return {
    schemaVersion: '8.0',
    uid: uid(1100),
    audioTimeline: createTimelineFixture(mode).timeline,
    bgmTrack: createBgmTrackFixture(),
    settings: settings({
      dialogueGainMilliDb: mode === 'h3_native' ? null : 0,
      nativeGainMilliDb: mode === 'independent_tts' ? null : -3000,
    }),
    createdAtEpochMs: 1_800_000_400_000,
    ...overrides,
  };
}

function verifiedFixture(mode = 'hybrid', overrides = {}) {
  const input = envelope(mode, overrides);
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
  });
}

function expectCode(code) {
  return (error) => error instanceof AudioModeContractError
    && error.code === code
    && JSON.stringify(error) === JSON.stringify({ code, message: error.message });
}

function resign(value) {
  const { mixSha256: _ignored, ...base } = value;
  return { ...value, mixSha256: canonicalHash(base) };
}

test('builds deterministic source-bound mix plans for all three audio modes', () => {
  assert.equal(AUDIO_MIX_ALGORITHM_VERSION, 'audio-ducking-ms.v1');
  for (const mode of ['independent_tts', 'h3_native', 'hybrid']) {
    const first = verifiedFixture(mode).plan;
    const second = verifiedFixture(mode).plan;
    assert.deepEqual(first, second);
    assert.equal(validateMixPlan(first), true, JSON.stringify(validateMixPlan.errors));
    assert.equal(first.mode, mode);
    assert.equal(first.bgm.loopCount, Math.ceil(first.durationMs / first.bgm.sourceDurationMs));
    assert.equal(first.ducking.windows[0].startMs, 0);
    assert.equal(first.ducking.windows.at(-1).endMs <= first.durationMs, true);
    assert.equal(first.nativeGainMilliDb === null, mode === 'independent_tts');
    assert.equal(first.dialogueGainMilliDb === null, mode === 'h3_native');
    assert.equal(JSON.stringify(first).includes('relativePath'), false);
    assert.equal(JSON.stringify(first).includes('logicalUri'), false);
    assert.equal(JSON.stringify(first).includes('credential:v1:'), false);
  }
});

test('hybrid ducking follows dialogue time and preserves the native-audio tail', () => {
  const plan = verifiedFixture('hybrid').plan;
  assert.equal(plan.durationMs, 1625);
  assert.deepEqual(plan.ducking.windows, [
    { startMs: 0, endMs: 1600, gainMilliDb: -18000 },
  ]);
  assert.equal(plan.ducking.windows[0].endMs < plan.durationMs, true);
  assert.equal(plan.bgm.fadeInMs, 200);
  assert.equal(plan.bgm.fadeOutMs, 300);
});

test('gain, fade, ducking and loop bounds fail closed before a plan is trusted', () => {
  const cases = [
    settings({ nativeGainMilliDb: null, dialogueGainMilliDb: 12001 }),
    settings({ nativeGainMilliDb: null, bgmGainMilliDb: 1 }),
    settings({ nativeGainMilliDb: null, duckedBgmGainMilliDb: -10000 }),
    settings({ nativeGainMilliDb: null, fadeInMs: 1500, fadeOutMs: 200 }),
    settings({ nativeGainMilliDb: null, duckingAttackMs: 2001 }),
    settings({ nativeGainMilliDb: null, duckingReleaseMs: 5001 }),
  ];
  for (const value of cases) {
    assert.throws(() => createAudioMixPlan(envelope('independent_tts', { settings: value })),
      expectCode('AUDIO_MIX_INPUT_INVALID'));
  }
  assert.throws(() => createAudioMixPlan(envelope('independent_tts', {
    bgmTrack: createBgmTrackFixture({ durationMs: 999 }),
  })), expectCode('AUDIO_MIX_INPUT_INVALID'));
  assert.throws(() => createAudioMixPlan(envelope('independent_tts', {
    settings: settings({ nativeGainMilliDb: -3000 }),
  })), expectCode('AUDIO_MIX_INPUT_INVALID'));
  assert.throws(() => createAudioMixPlan(envelope('hybrid', {
    settings: settings({ nativeGainMilliDb: null }),
  })), expectCode('AUDIO_MIX_INPUT_INVALID'));
  assert.throws(() => createAudioMixPlan(envelope('hybrid', {
    settings: settings({ nativeGainMilliDb: -60001 }),
  })), expectCode('AUDIO_MIX_INPUT_INVALID'));
  assert.throws(() => createAudioMixPlan(envelope('h3_native', {
    settings: settings({ dialogueGainMilliDb: 0, nativeGainMilliDb: -3000 }),
  })), expectCode('AUDIO_MIX_INPUT_INVALID'));
  assert.throws(() => createAudioMixPlan(envelope('independent_tts', {
    settings: settings({ dialogueGainMilliDb: null, nativeGainMilliDb: null }),
  })), expectCode('AUDIO_MIX_INPUT_INVALID'));
});

test('non-exportable, cross-drama and stale BGM sources are rejected', () => {
  const original = createBgmTrackFixture();
  assert.throws(() => createAudioMixPlan(envelope('independent_tts', {
    bgmTrack: createBgmTrackFixture({
      license: { ...original.license, commercialUseAllowed: false },
    }),
  })), expectCode('AUDIO_MIX_INPUT_INVALID'));
  assert.throws(() => createAudioMixPlan(envelope('independent_tts', {
    bgmTrack: createBgmTrackFixture({ dramaUid: uid(99) }),
  })), expectCode('AUDIO_MIX_INPUT_INVALID'));
  assert.throws(() => createAudioMixPlan(envelope('independent_tts', {
    createdAtEpochMs: 1_800_000_200_000,
  })), expectCode('AUDIO_MIX_INPUT_INVALID'));
});

test('external immutable envelope rejects coordinated source and metadata re-signing', () => {
  const fixture = verifiedFixture('hybrid');
  const rebound = resign({
    ...fixture.candidate,
    workflowRunUid: uid(1199),
    createdAtEpochMs: fixture.candidate.createdAtEpochMs + 1,
  });
  assert.throws(() => fixture.verifier.verify(rebound, fixture.input.uid),
    expectCode('AUDIO_MIX_DATA_INVALID'));

  const replacementInput = envelope('hybrid', {
    uid: fixture.input.uid,
    bgmTrack: createBgmTrackFixture({ uid: uid(1200) }),
  });
  const replacement = createAudioMixPlan(replacementInput);
  assert.throws(() => fixture.verifier.verify(replacement, fixture.input.uid),
    expectCode('AUDIO_MIX_DATA_INVALID'));
  assert.throws(() => fixture.verifier.verify(fixture.candidate, uid(1198)),
    expectCode('AUDIO_MIX_DATA_INVALID'));
  assert.deepEqual(requireTrustedAudioMixPlan(fixture.plan), fixture.plan);
  assert.throws(() => requireTrustedAudioMixPlan(fixture.candidate),
    expectCode('AUDIO_MIX_DATA_INVALID'));
});

test('hostile values and persisted extra fields are rejected without executing accessors', () => {
  const fixture = verifiedFixture('independent_tts');
  let rootReads = 0;
  const rootProxy = new Proxy(fixture.candidate, {
    ownKeys() { rootReads += 1; return []; },
    getOwnPropertyDescriptor() { rootReads += 1; return undefined; },
  });
  assert.throws(() => fixture.verifier.verify(rootProxy, fixture.input.uid),
    expectCode('AUDIO_MIX_DATA_INVALID'));
  assert.equal(rootReads, 0);

  let arrayReads = 0;
  const windowsProxy = new Proxy(fixture.candidate.ducking.windows, {
    getPrototypeOf() { arrayReads += 1; throw new Error('duck-window-sentinel'); },
    ownKeys() { arrayReads += 1; return []; },
  });
  assert.throws(() => fixture.verifier.verify({
    ...fixture.candidate,
    ducking: { ...fixture.candidate.ducking, windows: windowsProxy },
  }, fixture.input.uid), expectCode('AUDIO_MIX_DATA_INVALID'));
  assert.equal(arrayReads, 0);

  let getterReads = 0;
  const hostile = { ...fixture.candidate };
  Object.defineProperty(hostile, 'mode', {
    enumerable: true,
    get() { getterReads += 1; return 'independent_tts'; },
  });
  assert.throws(() => fixture.verifier.verify(hostile, fixture.input.uid),
    expectCode('AUDIO_MIX_DATA_INVALID'));
  assert.equal(getterReads, 0);
  assert.equal(validateMixPlan({ ...fixture.plan, privatePath: 'C:/private/audio.wav' }), false);

  let applyReads = 0;
  const loaderProxy = new Proxy(() => fixture.input, {
    apply() { applyReads += 1; return fixture.input; },
  });
  assert.throws(() => createAudioMixPlanVerifier({ loadTrustedEnvelope: loaderProxy }),
    expectCode('AUDIO_MIX_INPUT_INVALID'));
  assert.equal(applyReads, 0);
});
