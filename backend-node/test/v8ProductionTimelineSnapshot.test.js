'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const {
  AudioModeContractError,
  canonicalHash,
} = require('../src/audio/audioContract');
const {
  createProductionTimelineSnapshot,
  createProductionTimelineSnapshotVerifier,
  requireTrustedProductionTimelineSnapshot,
} = require('../src/audio/productionTimelineSnapshot');
const {
  createProductionTimelineFixture,
  uid,
} = require('./helpers/v8AudioFixture');

const schemaRoot = path.resolve(__dirname, '../../schemas/v8');
const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const name of [
  'dialogue-delivery.schema.json',
  'subtitle-track.schema.json',
  'audio-timeline.schema.json',
  'audio-mix-plan.schema.json',
  'bgm-license.schema.json',
  'bgm-track.schema.json',
]) {
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(schemaRoot, name), 'utf8')));
}
const validateSnapshot = ajv.compile(JSON.parse(fs.readFileSync(
  path.join(schemaRoot, 'production-timeline-snapshot.schema.json'),
  'utf8',
)));

function expectCode(code) {
  return (error) => error instanceof AudioModeContractError
    && error.code === code
    && JSON.stringify(error) === JSON.stringify({ code, message: error.message });
}

function verifierFor(input) {
  return createProductionTimelineSnapshotVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== input.uid) throw new Error('synthetic-snapshot-anchor-mismatch');
      return input;
    },
    loadGenerationHistory(expectedUid) {
      const shot = input.shots.find((entry) => entry.generationHistory.uid === expectedUid);
      if (!shot) throw new Error('synthetic-history-anchor-mismatch');
      return shot.generationHistory;
    },
    loadH3ExecutionResult(expectedUid) {
      const shot = input.shots.find((entry) => entry.h3ExecutionResult.taskUid === expectedUid);
      if (!shot) throw new Error('synthetic-h3-execution-anchor-mismatch');
      return shot.h3ExecutionResult;
    },
  });
}

function verify(input) {
  const candidate = createProductionTimelineSnapshot(input);
  return verifierFor(input).verify(JSON.parse(JSON.stringify(candidate)), input.uid);
}

function resign(value) {
  const { snapshotSha256: _ignored, ...base } = value;
  return { ...value, snapshotSha256: canonicalHash(base) };
}

test('freezes ordered video, audio, subtitle, BGM and mix evidence into one snapshot', () => {
  const fixture = createProductionTimelineFixture('independent_tts');
  const snapshot = fixture.snapshot;

  assert.equal(validateSnapshot(snapshot), true, JSON.stringify(validateSnapshot.errors));
  assert.equal(snapshot.durationMs, 1500);
  assert.deepEqual(snapshot.shots.map((shot) => ({
    ordinal: shot.ordinal,
    shotId: shot.shotId,
    plannedOrdinal: shot.plannedOrdinal,
    startMs: shot.startMs,
    endMs: shot.endMs,
  })), [
    { ordinal: 0, shotId: 'shot-1', plannedOrdinal: 1, startMs: 0, endMs: 700 },
    { ordinal: 1, shotId: 'shot-2', plannedOrdinal: 2, startMs: 700, endMs: 1500 },
  ]);
  assert.deepEqual(snapshot.subtitleTrack, snapshot.audioTimeline.subtitleTrack);
  assert.equal(snapshot.audioSources.length, 2);
  assert.equal(snapshot.audioSources.every((source) => source.assetVersion.status === 'ready'), true);
  assert.equal(snapshot.bgmTrack.assetVersion.uid, snapshot.audioMixPlan.bgm.assetVersionUid);
  assert.equal(JSON.stringify(snapshot).includes('credential:v1:'), false);
  assert.equal(JSON.stringify(snapshot).includes('C:\\'), false);
  assert.deepEqual(requireTrustedProductionTimelineSnapshot(snapshot), snapshot);
});

test('reordering requires a new snapshot identity and never mutates the prior snapshot', () => {
  const original = createProductionTimelineFixture('independent_tts');
  const originalJson = JSON.stringify(original.snapshot);
  const reorderedInput = {
    ...original.input,
    uid: uid(1401),
    shots: [...original.input.shots].reverse(),
    createdAtEpochMs: original.input.createdAtEpochMs + 1,
  };
  const reordered = verify(reorderedInput);

  assert.equal(JSON.stringify(original.snapshot), originalJson);
  assert.notEqual(reordered.snapshotSha256, original.snapshot.snapshotSha256);
  assert.deepEqual(reordered.shots.map((shot) => shot.shotId), ['shot-2', 'shot-1']);
  assert.deepEqual(reordered.shots.map((shot) => [shot.startMs, shot.endMs]), [[0, 800], [800, 1500]]);

  const rebound = createProductionTimelineSnapshot({
    ...reorderedInput,
    uid: original.input.uid,
  });
  assert.throws(() => original.verifier.verify(rebound, original.input.uid),
    expectCode('PRODUCTION_TIMELINE_DATA_INVALID'));
});

test('cross-drama, duplicate and duration-inconsistent shot sources fail closed', () => {
  const fixture = createProductionTimelineFixture('independent_tts');
  const [first, second] = fixture.input.shots;
  const cases = [
    [{ ...first, asset: { ...first.asset, ownerUid: uid(99) } }, second],
    [first, { ...second, shotId: first.shotId }],
    [first, { ...second, plannedOrdinal: first.plannedOrdinal }],
    [first, { ...second, plannedOrdinal: 3 }],
    [first, { ...second, generationHistory: first.generationHistory }],
    [first, {
      ...second,
      assetVersion: { ...second.assetVersion, durationMs: second.assetVersion.durationMs + 1 },
    }],
  ];
  for (const shots of cases) {
    assert.throws(() => createProductionTimelineSnapshot({ ...fixture.input, shots }),
      expectCode('PRODUCTION_TIMELINE_INPUT_INVALID'));
  }
});

test('audio, subtitle and BGM sources must exactly match their trusted plans', () => {
  const fixture = createProductionTimelineFixture('hybrid');
  const cases = [
    { audioSources: fixture.input.audioSources.slice(1) },
    {
      audioSources: fixture.input.audioSources.map((source, index) => index === 0 ? ({
        ...source,
        assetVersion: { ...source.assetVersion, sha256: 'f'.repeat(64) },
      }) : source),
    },
    {
      bgmTrack: {
        ...fixture.input.bgmTrack,
        assetVersion: {
          ...fixture.input.bgmTrack.assetVersion,
          sha256: 'e'.repeat(64),
        },
      },
    },
  ];
  for (const overrides of cases) {
    assert.throws(() => createProductionTimelineSnapshot({ ...fixture.input, ...overrides }),
      expectCode('PRODUCTION_TIMELINE_INPUT_INVALID'));
  }

  const subtitleDrift = JSON.parse(JSON.stringify(fixture.candidate));
  subtitleDrift.subtitleTrack.cues[0].text = 'drifted subtitle';
  const resigned = resign(subtitleDrift);
  assert.throws(() => fixture.verifier.verify(resigned, fixture.input.uid),
    expectCode('PRODUCTION_TIMELINE_DATA_INVALID'));
});

test('media identities stay globally consistent across video, audio and BGM tracks', () => {
  const fixture = createProductionTimelineFixture('independent_tts');
  const [shot, ...remainingShots] = fixture.input.shots;
  const audio = fixture.input.audioSources[0];
  const conflictingShot = {
    ...shot,
    asset: {
      ...shot.asset,
      uid: audio.asset.uid,
    },
    assetVersion: {
      ...shot.assetVersion,
      assetUid: audio.asset.uid,
    },
  };
  assert.throws(() => createProductionTimelineSnapshot({
    ...fixture.input,
    shots: [conflictingShot, ...remainingShots],
  }), expectCode('PRODUCTION_TIMELINE_INPUT_INVALID'));

  const conflictingVersion = {
    ...shot,
    asset: {
      ...shot.asset,
      currentVersionUid: audio.assetVersion.uid,
    },
    assetVersion: {
      ...shot.assetVersion,
      uid: audio.assetVersion.uid,
    },
  };
  assert.throws(() => createProductionTimelineSnapshot({
    ...fixture.input,
    shots: [conflictingVersion, ...remainingShots],
  }), expectCode('PRODUCTION_TIMELINE_INPUT_INVALID'));

  const native = createProductionTimelineFixture('h3_native');
  const nativeSource = native.input.audioSources[0];
  const generationHistory = {
    ...native.input.shots[0].generationHistory,
    uid: uid(1403),
    assetUid: nativeSource.asset.uid,
    outputVersionUid: nativeSource.assetVersion.uid,
    outputVersionEvidence: nativeSource.assetVersion,
  };
  const sharedVideo = verify({
    ...native.input,
    uid: uid(1402),
    shots: [{
      shotId: 'shot-1',
      plannedOrdinal: 1,
      h3ExecutionResult: {
        ...native.input.shots[0].h3ExecutionResult,
        historyUid: generationHistory.uid,
        assetUid: nativeSource.asset.uid,
        assetVersionUid: nativeSource.assetVersion.uid,
      },
      generationHistory,
      asset: nativeSource.asset,
      assetVersion: nativeSource.assetVersion,
    }],
    createdAtEpochMs: native.input.createdAtEpochMs + 1,
  });
  assert.equal(sharedVideo.shots[0].assetVersion.uid, sharedVideo.audioSources[0].assetVersion.uid);
});

test('snapshot creation cannot predate any frozen media evidence', () => {
  const fixture = createProductionTimelineFixture('independent_tts');
  const future = new Date(fixture.input.createdAtEpochMs + 1).toISOString();
  const [shot, ...remainingShots] = fixture.input.shots;
  const [audio, ...remainingAudio] = fixture.input.audioSources;
  const cases = [
    {
      shots: [{ ...shot, asset: { ...shot.asset, updatedAt: future } }, ...remainingShots],
    },
    {
      audioSources: [{
        ...audio,
        assetVersion: { ...audio.assetVersion, createdAt: future },
      }, ...remainingAudio],
    },
    {
      bgmTrack: {
        ...fixture.input.bgmTrack,
        assetVersion: { ...fixture.input.bgmTrack.assetVersion, createdAt: future },
      },
    },
  ];
  for (const overrides of cases) {
    assert.throws(() => createProductionTimelineSnapshot({ ...fixture.input, ...overrides }),
      expectCode('PRODUCTION_TIMELINE_INPUT_INVALID'));
  }
});

test('every shot is bound to trusted succeeded generation history output evidence', () => {
  const fixture = createProductionTimelineFixture('independent_tts');
  const [shot, ...remainingShots] = fixture.input.shots;
  const history = shot.generationHistory;
  const differentAssetUid = uid(1410);
  const differentVersionUid = uid(1411);
  const invalidHistories = [
    { ...history, dramaUid: uid(99) },
    { ...history, runUid: uid(1412) },
    {
      ...history,
      assetUid: differentAssetUid,
      outputVersionEvidence: { ...history.outputVersionEvidence, assetUid: differentAssetUid },
    },
    {
      ...history,
      outputVersionUid: differentVersionUid,
      outputVersionEvidence: { ...history.outputVersionEvidence, uid: differentVersionUid },
    },
    {
      ...history,
      status: 'failed',
      outputVersionUid: null,
      outputVersionEvidence: null,
      errorCode: 'SYNTHETIC_FAILED',
    },
    { ...history, completedAtEpochMs: fixture.input.createdAtEpochMs + 1 },
  ];
  for (const generationHistory of invalidHistories) {
    assert.throws(() => createProductionTimelineSnapshot({
      ...fixture.input,
      shots: [{ ...shot, generationHistory }, ...remainingShots],
    }), expectCode('PRODUCTION_TIMELINE_INPUT_INVALID'));
  }

  const invalidH3Results = [
    { ...shot.h3ExecutionResult, workflowRunUid: uid(1415) },
    { ...shot.h3ExecutionResult, generationRunUid: uid(1416) },
    { ...shot.h3ExecutionResult, historyUid: uid(1417) },
    { ...shot.h3ExecutionResult, assetVersionUid: uid(1418) },
  ];
  for (const h3ExecutionResult of invalidH3Results) {
    assert.throws(() => createProductionTimelineSnapshot({
      ...fixture.input,
      shots: [{ ...shot, h3ExecutionResult }, ...remainingShots],
    }), expectCode('PRODUCTION_TIMELINE_INPUT_INVALID'));
  }

  const createdAfterCompletion = new Date(history.completedAtEpochMs + 1000).toISOString();
  assert.ok(Date.parse(createdAfterCompletion) < fixture.input.createdAtEpochMs);
  assert.throws(() => createProductionTimelineSnapshot({
    ...fixture.input,
    shots: [{
      ...shot,
      asset: {
        ...shot.asset,
        createdAt: createdAfterCompletion,
        updatedAt: createdAfterCompletion,
      },
      assetVersion: { ...shot.assetVersion, createdAt: createdAfterCompletion },
      generationHistory: {
        ...history,
        outputVersionEvidence: {
          ...history.outputVersionEvidence,
          createdAt: createdAfterCompletion,
        },
      },
    }, ...remainingShots],
  }), expectCode('PRODUCTION_TIMELINE_INPUT_INVALID'));

  const reboundHistory = { ...history, uid: uid(1413) };
  const reboundH3Result = { ...shot.h3ExecutionResult, historyUid: reboundHistory.uid };
  const reboundInput = {
    ...fixture.input,
    uid: uid(1414),
    shots: [{
      ...shot,
      h3ExecutionResult: reboundH3Result,
      generationHistory: reboundHistory,
    }, ...remainingShots],
    createdAtEpochMs: fixture.input.createdAtEpochMs + 1,
  };
  const candidate = createProductionTimelineSnapshot(reboundInput);
  const verifier = createProductionTimelineSnapshotVerifier({
    loadTrustedEnvelope() { return reboundInput; },
    loadGenerationHistory() { return history; },
    loadH3ExecutionResult() { return reboundInput.shots[0].h3ExecutionResult; },
  });
  assert.throws(() => verifier.verify(candidate, reboundInput.uid),
    expectCode('PRODUCTION_TIMELINE_DATA_INVALID'));

  const authoritativeResultDrift = createProductionTimelineSnapshotVerifier({
    loadTrustedEnvelope() { return fixture.input; },
    loadGenerationHistory(expectedUid) {
      return fixture.input.shots.find((entry) => (
        entry.generationHistory.uid === expectedUid
      )).generationHistory;
    },
    loadH3ExecutionResult(expectedUid) {
      const result = fixture.input.shots.find((entry) => (
        entry.h3ExecutionResult.taskUid === expectedUid
      )).h3ExecutionResult;
      return { ...result, taskStateVersion: result.taskStateVersion + 1 };
    },
  });
  assert.throws(() => authoritativeResultDrift.verify(fixture.candidate, fixture.input.uid),
    expectCode('PRODUCTION_TIMELINE_DATA_INVALID'));
});

test('external immutable envelopes reject coordinated source and metadata re-signing', () => {
  const fixture = createProductionTimelineFixture('h3_native');
  const rebound = resign({
    ...fixture.candidate,
    workflowRunUid: uid(1498),
    createdAtEpochMs: fixture.candidate.createdAtEpochMs + 1,
  });
  assert.throws(() => fixture.verifier.verify(rebound, fixture.input.uid),
    expectCode('PRODUCTION_TIMELINE_DATA_INVALID'));
  assert.throws(() => fixture.verifier.verify(fixture.candidate, uid(1499)),
    expectCode('PRODUCTION_TIMELINE_DATA_INVALID'));
  assert.throws(() => requireTrustedProductionTimelineSnapshot(fixture.candidate),
    expectCode('PRODUCTION_TIMELINE_DATA_INVALID'));
});

test('hostile records and loader proxies are rejected without executing traps or accessors', () => {
  const fixture = createProductionTimelineFixture('independent_tts');
  let rootReads = 0;
  const rootProxy = new Proxy(fixture.candidate, {
    ownKeys() { rootReads += 1; return []; },
    getOwnPropertyDescriptor() { rootReads += 1; return undefined; },
  });
  assert.throws(() => fixture.verifier.verify(rootProxy, fixture.input.uid),
    expectCode('PRODUCTION_TIMELINE_DATA_INVALID'));
  assert.equal(rootReads, 0);

  let arrayReads = 0;
  const shotsProxy = new Proxy(fixture.candidate.shots, {
    getPrototypeOf() { arrayReads += 1; throw new Error('timeline-shot-sentinel'); },
    ownKeys() { arrayReads += 1; return []; },
  });
  assert.throws(() => fixture.verifier.verify({ ...fixture.candidate, shots: shotsProxy }, fixture.input.uid),
    expectCode('PRODUCTION_TIMELINE_DATA_INVALID'));
  assert.equal(arrayReads, 0);

  let getterReads = 0;
  const hostile = { ...fixture.candidate };
  Object.defineProperty(hostile, 'durationMs', {
    enumerable: true,
    get() { getterReads += 1; return 1500; },
  });
  assert.throws(() => fixture.verifier.verify(hostile, fixture.input.uid),
    expectCode('PRODUCTION_TIMELINE_DATA_INVALID'));
  assert.equal(getterReads, 0);

  let applyReads = 0;
  const loaderProxy = new Proxy(() => fixture.input, {
    apply() { applyReads += 1; return fixture.input; },
  });
  assert.throws(() => createProductionTimelineSnapshotVerifier({
    loadTrustedEnvelope() { return fixture.input; },
    loadGenerationHistory: loaderProxy,
    loadH3ExecutionResult() { return fixture.input.shots[0].h3ExecutionResult; },
  }),
    expectCode('PRODUCTION_TIMELINE_INPUT_INVALID'));
  assert.equal(applyReads, 0);
});
