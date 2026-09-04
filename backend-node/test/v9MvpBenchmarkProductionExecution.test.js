'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');
const Ajv2020 = require('ajv/dist/2020');

const executionStepSchema = require('../../schemas/v9/mvp-benchmark-production-execution-step.schema.json');
const executionRequestSchema = require('../../schemas/v9/mvp-benchmark-production-execution-request.schema.json');
const executionProgressSchema = require('../../schemas/v9/mvp-benchmark-production-execution-progress.schema.json');

const {
  APPROVED_LIVE_ENVIRONMENT,
  createMvpBenchmarkLiveEnvironmentObservation,
} = require('../src/benchmark/mvpBenchmarkExecutionPreflight');
const {
  createMvpBenchmarkExecutionPreflightService,
} = require('../src/benchmark/mvpBenchmarkExecutionPreflightService');
const {
  createMvpBenchmarkProductionExecutionService,
} = require('../src/benchmark/mvpBenchmarkProductionExecutionService');
const { createH3TextToVideoWorkflowBundle } = require('../src/h3/workflowBundle');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const mvpBenchmarkRoutes = require('../src/routes/v2/mvpBenchmark');
const { createMvpBenchmarkSessionFixture } = require('./helpers/v9MvpBenchmarkSessionFixture');
const { uid } = require('./helpers/v2RepositoryDatabase');

function authorizationRequest(current, session) {
  return {
    schemaVersion: 'mvp-benchmark-external-authorization-request.v1',
    uid: uid(99700),
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    sessionPlanSha256: session.planSha256,
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    maximumCostCnyFen: 1_000,
    validityDurationMs: 60 * 60 * 1000,
  };
}

function rawObservation(current, observedAtEpochMs = 2_000) {
  const observation = createMvpBenchmarkLiveEnvironmentObservation({
    schemaVersion: 'mvp-benchmark-live-environment-observation.v1',
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    observedAtEpochMs,
    approvedEnvironmentSha256:
      '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43',
    gpu: structuredClone(APPROVED_LIVE_ENVIRONMENT.gpu),
    comfyUI: structuredClone(APPROVED_LIVE_ENVIRONMENT.comfyUI),
    runtime: structuredClone(APPROVED_LIVE_ENVIRONMENT.runtime),
    models: structuredClone(APPROVED_LIVE_ENVIRONMENT.models),
  });
  const { observationSha256: _digest, ...raw } = observation;
  return raw;
}

function freshExecutionDependencies(current, observedAtEpochMs = 2_200) {
  let nextUid = 99000;
  let inspections = 0;
  return Object.freeze({
    createUid: () => uid(nextUid++),
    inspections: () => inspections,
    liveEnvironmentVerifier: Object.freeze({
      inspect() {
        inspections += 1;
        return Promise.resolve(rawObservation(current, observedAtEpochMs));
      },
    }),
  });
}

async function preparedBatch(current) {
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  let nextUid = 99710;
  const preflight = createMvpBenchmarkExecutionPreflightService({
    repositories: current.repositories,
    liveEnvironmentVerifier: Object.freeze({
      inspect() { return Promise.resolve(rawObservation(current)); },
    }),
    costEstimator: Object.freeze({
      estimateH3() {
        return Promise.resolve({ estimatedCostCnyFen: 10, policyUid: uid(99790) });
      },
      estimateTts() {
        return Promise.resolve({ estimatedCostCnyFen: 5, policyUid: uid(99791) });
      },
    }),
    createUid: () => uid(nextUid++),
    nowEpochMs: () => 2_100,
  });
  const batch = await preflight.prepareBatch(authorization.uid);
  return { authorization, batch, session };
}

function h3Result(taskUid, offset) {
  return Object.freeze({
    schemaVersion: 'h3-local-execution-result.v2',
    taskUid,
    taskStateVersion: 7,
    workflowRunUid: uid(99100 + offset),
    generationRunUid: uid(99600 + offset),
    historyUid: uid(99500 + offset),
    assetUid: uid(99400 + offset),
    assetVersionUid: uid(99300 + offset),
    nodeRunUid: uid(99200 + offset),
    status: 'succeeded',
  });
}

function audioResult(current) {
  return Object.freeze({
    schemaVersion: 'audio-tts-execution-record.v1',
    intentUid: current.audioIntent.uid,
    dramaUid: current.audioIntent.dramaUid,
    workflowRunUid: current.audioIntent.workflowRunUid,
    nodeRunUid: current.audioIntent.nodeRunUid,
    evidence: Object.freeze({ uid: uid(99100) }),
  });
}

function executionRequest(authorization, session, batch, ordinal = 0) {
  const reservation = batch.reservations[ordinal];
  return Object.freeze({
    schemaVersion: 'mvp-benchmark-production-execution-request.v1',
    authorizationUid: authorization.uid,
    dramaUid: session.dramaUid,
    sessionUid: session.uid,
    expectedBatchSha256: batch.batchSha256,
    expectedOrdinal: ordinal,
    expectedItemKind: reservation.itemKind,
    expectedItemUid: reservation.itemUid,
  });
}

function executionSeed(request) {
  return {
    schemaVersion: request.schemaVersion,
    expectedBatchSha256: request.expectedBatchSha256,
    expectedOrdinal: request.expectedOrdinal,
    expectedItemKind: request.expectedItemKind,
    expectedItemUid: request.expectedItemUid,
  };
}

function progressRequest(authorization, session, batch) {
  return Object.freeze({
    schemaVersion: 'mvp-benchmark-production-execution-progress-request.v1',
    authorizationUid: authorization.uid,
    dramaUid: session.dramaUid,
    sessionUid: session.uid,
    expectedBatchSha256: batch.batchSha256,
  });
}

async function listen(app) {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

function executionFixture(current, options = {}) {
  const h3Completed = new Map();
  let completedAudio = null;
  let audioMediaReads = 0;
  let audioPersistedReads = 0;
  const calls = [];
  const fresh = freshExecutionDependencies(current);
  const h3LocalExecution = Object.freeze({
    get(taskUid) { return h3Completed.get(taskUid) ?? null; },
    execute(taskUid, request, permit) {
      calls.push(Object.freeze({ kind: 'h3', taskUid, request, permit }));
      const result = h3Result(taskUid, calls.length);
      h3Completed.set(taskUid, result);
      return Promise.resolve(result);
    },
  });
  const audioTtsExecution = Object.freeze({
    get(intentUid, dramaUid) {
      audioMediaReads += 1;
      assert.equal(intentUid, current.audioIntent.uid);
      assert.equal(dramaUid, current.audioIntent.dramaUid);
      return Promise.resolve(completedAudio);
    },
    getPersisted(intentUid, dramaUid) {
      audioPersistedReads += 1;
      assert.equal(intentUid, current.audioIntent.uid);
      assert.equal(dramaUid, current.audioIntent.dramaUid);
      return completedAudio;
    },
    execute(intentUid, dramaUid, permit) {
      calls.push(Object.freeze({ kind: 'tts', intentUid, dramaUid, permit }));
      completedAudio = audioResult(current);
      return Promise.resolve(completedAudio);
    },
  });
  return Object.freeze({
    audioMediaReads: () => audioMediaReads,
    audioPersistedReads: () => audioPersistedReads,
    calls,
    completeAudio() { completedAudio = audioResult(current); },
    h3Completed,
    inspections: options.inspections ?? fresh.inspections,
    service: createMvpBenchmarkProductionExecutionService({
      repositories: current.repositories,
      executionGate: options.executionGate ?? current.repositories.mvpBenchmarkExecutionGate,
      h3LocalExecution,
      audioTtsExecution,
      liveEnvironmentVerifier: options.liveEnvironmentVerifier ?? fresh.liveEnvironmentVerifier,
      createUid: fresh.createUid,
      nowEpochMs: options.nowEpochMs ?? (() => 2_200),
    }),
  });
}

function makeCurrentReplacement(current, intent, replacementVersionUid) {
  current.repositories.assets.addVersion({
    uid: replacementVersionUid,
    assetUid: intent.assetUid,
    storageProvider: 'local',
    logicalUri:
      `asset://dramas/${current.dramaUid}/benchmark/video/${intent.assetUid}/${replacementVersionUid}`,
    relativePath:
      `projects/${current.dramaUid}/assets/video/${intent.assetUid}/${replacementVersionUid}.mp4`,
    sha256: '9'.repeat(64),
    mimeType: 'video/mp4',
    width: 608,
    height: 352,
    durationMs: 1625,
    parentUid: intent.parentVersionUid,
    status: 'ready',
  }, { makeCurrent: true });
}

test('execute-next derives the exact H3 request and advances at most one frozen item', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, batch, session } = await preparedBatch(current);
  const fixture = executionFixture(current);
  const first = await fixture.service.executeNext(executionRequest(authorization, session, batch));

  assert.equal(first.schemaVersion, 'mvp-benchmark-production-execution-step.v1');
  assert.equal(first.authorizationUid, authorization.uid);
  assert.equal(first.sessionUid, session.uid);
  assert.equal(first.dramaUid, session.dramaUid);
  assert.equal(first.completedCount, 1);
  assert.equal(first.totalCount, batch.reservations.length);
  assert.equal(first.batchComplete, false);
  const validateStep = new Ajv2020({ strict: true }).compile(executionStepSchema);
  assert.equal(validateStep(first), true, JSON.stringify(validateStep.errors));
  assert.equal(validateStep({ ...first, item: null }), false);
  assert.deepEqual(first.item, Object.freeze({
    ordinal: 0,
    itemKind: 'h3',
    itemUid: session.h3Tasks[0].taskUid,
    status: 'succeeded',
  }));
  assert.equal(fixture.calls.length, 1);
  const call = fixture.calls[0];
  const intent = current.h3Intents[0];
  const task = current.repositories.remote.getFormalTask(intent.taskUid);
  const bundle = createH3TextToVideoWorkflowBundle();
  assert.equal(call.taskUid, intent.taskUid);
  assert.equal(call.request.expectedStateVersion, task.stateVersion);
  assert.equal(Buffer.from(call.request.workflowBase64, 'base64').toString('utf8'), bundle.workflowJson);
  assert.deepEqual(call.request.values, {
    prompt: intent.generationSpec.prompt.text,
    width: intent.generationSpec.width,
    height: intent.generationSpec.height,
    frames: intent.generationSpec.frames,
    seed: intent.generationSpec.seed,
    filenamePrefix: intent.filenamePrefix,
  });
  assert.deepEqual(call.request.uploads, []);
  assert.deepEqual(call.request.output, { logicalName: 'video', assetUid: intent.assetUid });

  const second = await fixture.service.executeNext(executionRequest(authorization, session, batch, 1));
  assert.equal(second.completedCount, 2);
  assert.equal(second.item.itemUid, session.h3Tasks[1].taskUid);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.inspections(), 2);
});

test('read-only progress reconstructs a lost success receipt without new external work', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, batch, session } = await preparedBatch(current);
  const execution = executionFixture(current);
  const request = progressRequest(authorization, session, batch);

  const initial = await execution.service.readProgress(request);
  const validateProgress = new Ajv2020({ strict: true }).compile(executionProgressSchema);
  assert.equal(validateProgress(initial), true, JSON.stringify(validateProgress.errors));
  assert.deepEqual(initial, {
    schemaVersion: 'mvp-benchmark-production-execution-progress.v1',
    authorizationUid: authorization.uid,
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    batchSha256: batch.batchSha256,
    completedCount: 0,
    totalCount: batch.reservations.length,
    batchComplete: false,
    nextItem: {
      ordinal: 0,
      itemKind: batch.reservations[0].itemKind,
      itemUid: batch.reservations[0].itemUid,
    },
  });
  assert.equal(execution.inspections(), 0);
  assert.equal(execution.calls.length, 0);

  await execution.service.executeNext(executionRequest(authorization, session, batch, 0));
  const inspectionsAfterExecution = execution.inspections();
  const callsAfterExecution = execution.calls.length;

  const recovered = await execution.service.readProgress(request);
  assert.equal(validateProgress(recovered), true, JSON.stringify(validateProgress.errors));
  assert.equal(recovered.completedCount, 1);
  assert.equal(recovered.batchComplete, false);
  assert.deepEqual(recovered.nextItem, {
    ordinal: 1,
    itemKind: batch.reservations[1].itemKind,
    itemUid: batch.reservations[1].itemUid,
  });
  assert.equal(execution.inspections(), inspectionsAfterExecution);
  assert.equal(execution.calls.length, callsAfterExecution);
});

test('read-only progress rejects a started item and never reads or probes TTS media', async (t) => {
  const started = createMvpBenchmarkSessionFixture(t);
  const startedBatch = await preparedBatch(started);
  const startedExecution = executionFixture(started);
  started.repositories.remote.transitionFormalTask({
    uid: startedBatch.session.h3Tasks[0].taskUid,
    expectedStateVersion: 0,
    nextStage: 'uploading',
    nextStatus: 'running',
    recoveryState: 'none',
  });
  await assert.rejects(startedExecution.service.readProgress(progressRequest(
    startedBatch.authorization, startedBatch.session, startedBatch.batch,
  )), { code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE' });
  assert.equal(startedExecution.audioMediaReads(), 0);
  assert.equal(startedExecution.inspections(), 0);
  assert.equal(startedExecution.calls.length, 0);

  const ttsStarted = createMvpBenchmarkSessionFixture(t);
  const ttsStartedBatch = await preparedBatch(ttsStarted);
  const ttsStartedExecution = executionFixture(ttsStarted);
  ttsStarted.repositories.runs.transitionNodeStatus({
    uid: ttsStarted.audioIntent.nodeRunUid,
    expectedStatus: 'queued',
    nextStatus: 'running',
    inputSnapshot: {},
  });
  await assert.rejects(ttsStartedExecution.service.readProgress(progressRequest(
    ttsStartedBatch.authorization, ttsStartedBatch.session, ttsStartedBatch.batch,
  )), { code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE' });
  assert.equal(ttsStartedExecution.audioMediaReads(), 0);
  assert.equal(ttsStartedExecution.inspections(), 0);
  assert.equal(ttsStartedExecution.calls.length, 0);

  const completed = createMvpBenchmarkSessionFixture(t);
  const completedBatch = await preparedBatch(completed);
  const completedExecution = executionFixture(completed);
  for (let index = 0; index < completedBatch.session.h3Tasks.length; index += 1) {
    const taskUid = completedBatch.session.h3Tasks[index].taskUid;
    completedExecution.h3Completed.set(taskUid, h3Result(taskUid, index + 1));
  }
  completedExecution.completeAudio();
  const terminal = await completedExecution.service.readProgress(progressRequest(
    completedBatch.authorization, completedBatch.session, completedBatch.batch,
  ));
  assert.equal(terminal.batchComplete, true);
  assert.equal(terminal.completedCount, completedBatch.batch.reservations.length);
  assert.equal(completedExecution.audioMediaReads(), 0);
  assert.ok(completedExecution.audioPersistedReads() > 0);
  assert.equal(completedExecution.inspections(), 0);
  assert.equal(completedExecution.calls.length, 0);
});

test('the terminal execute-next response is Schema-valid and does not report a second item', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, batch, session } = await preparedBatch(current);
  const fixture = executionFixture(current);
  const validateStep = new Ajv2020({ strict: true }).compile(executionStepSchema);
  let result = null;
  for (let index = 0; index < batch.reservations.length; index += 1) {
    result = await fixture.service.executeNext(executionRequest(authorization, session, batch, index));
    assert.equal(fixture.calls.length, index + 1);
    assert.equal(validateStep(result), true, JSON.stringify(validateStep.errors));
  }
  assert.deepEqual(result, Object.freeze({
    schemaVersion: 'mvp-benchmark-production-execution-step.v1',
    authorizationUid: authorization.uid,
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    batchSha256: batch.batchSha256,
    completedCount: batch.reservations.length,
    totalCount: batch.reservations.length,
    batchComplete: true,
    item: null,
  }));
  assert.equal(fixture.calls.length, batch.reservations.length);
});

test('a stale per-item confirmation cannot execute the following reserved item', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, batch, session } = await preparedBatch(current);
  const fixture = executionFixture(current);
  const confirmedFirstItem = executionRequest(authorization, session, batch);

  await fixture.service.executeNext(confirmedFirstItem);
  assert.equal(fixture.calls.length, 1);
  await assert.rejects(fixture.service.executeNext(confirmedFirstItem), {
    code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
  });
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.inspections(), 1);
});

test('execution context rejects inherited descriptor getters without executing them', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, batch, session } = await preparedBatch(current);
  const baseGate = current.repositories.mvpBenchmarkExecutionGate;
  const opened = baseGate.loadExecutionBatch(authorization.uid, { nowEpochMs: 2_200 });
  const missingBatch = {
    environmentRequest: opened.environmentRequest,
    padding: true,
  };
  const missingEnvironment = {
    batch: opened.batch,
    padding: true,
  };
  const nestedBatch = { ...opened.batch };
  delete nestedBatch.schemaVersion;
  nestedBatch.padding = true;
  const missingNestedKey = {
    batch: nestedBatch,
    environmentRequest: opened.environmentRequest,
  };
  const sparseReservations = Array.from(
    { length: 64 },
    (_, index) => opened.batch.reservations[index % opened.batch.reservations.length],
  );
  delete sparseReservations[63];
  Object.defineProperty(sparseReservations, 'padding', {
    enumerable: true,
    value: opened.batch.reservations[0],
  });
  const missingArrayIndex = {
    batch: { ...opened.batch, reservations: sparseReservations },
    environmentRequest: opened.environmentRequest,
  };

  const cases = [
    { inheritedKey: 'batch', opened: missingBatch },
    { inheritedKey: 'environmentRequest', opened: missingEnvironment },
    { inheritedKey: 'schemaVersion', opened: missingNestedKey },
    { inheritedKey: '63', opened: missingArrayIndex },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const currentCase = cases[index];
    const executionGate = Object.freeze({
      assertAudioIntentExecutionOpen(...args) {
        return baseGate.assertAudioIntentExecutionOpen(...args);
      },
      assertH3TaskExecutionOpen(...args) {
        return baseGate.assertH3TaskExecutionOpen(...args);
      },
      loadExecutionBatch() { return currentCase.opened; },
      openExecutionItem(...args) { return baseGate.openExecutionItem(...args); },
    });
    const fixture = executionFixture(current, { executionGate });
    let reads = 0;
    Object.defineProperty(Object.prototype, currentCase.inheritedKey, {
      configurable: true,
      get() { reads += 1; return undefined; },
      set(value) {
        Object.defineProperty(this, currentCase.inheritedKey, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        });
      },
    });
    try {
      await assert.rejects(
        fixture.service.executeNext(executionRequest(authorization, session, batch)),
        { code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE' },
      );
      assert.equal(reads, 0);
      assert.equal(fixture.inspections(), 0);
      assert.equal(fixture.calls.length, 0);
    } finally {
      delete Object.prototype[currentCase.inheritedKey];
    }
  }
});

test('a warmed execution context revalidates authorization and sources before inspection', async (t) => {
  const expired = createMvpBenchmarkSessionFixture(t);
  const expiredBatch = await preparedBatch(expired);
  let currentNowEpochMs = 2_200;
  const expiredFixture = executionFixture(expired, {
    nowEpochMs: () => currentNowEpochMs,
  });
  const expiredRequest = executionRequest(
    expiredBatch.authorization, expiredBatch.session, expiredBatch.batch,
  );
  await expiredFixture.service.executeNext(expiredRequest);
  assert.equal(expiredFixture.inspections(), 1);
  assert.equal(expiredFixture.calls.length, 1);
  currentNowEpochMs = expiredBatch.authorization.expiresAtEpochMs + 1;
  await assert.rejects(expiredFixture.service.executeNext(executionRequest(
    expiredBatch.authorization, expiredBatch.session, expiredBatch.batch, 1,
  )), {
    code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
  });
  assert.equal(expiredFixture.inspections(), 1);
  assert.equal(expiredFixture.calls.length, 1);

  const connection = createMvpBenchmarkSessionFixture(t);
  const connectionBatch = await preparedBatch(connection);
  const connectionFixture = executionFixture(connection);
  const connectionRequest = executionRequest(
    connectionBatch.authorization,
    connectionBatch.session,
    connectionBatch.batch,
  );
  await connectionFixture.service.executeNext(connectionRequest);
  connection.repositories.remote.updateConnection({
    uid: connection.connection.uid,
    expectedStateVersion: connection.connection.stateVersion,
    name: connection.connection.name,
    host: 'replacement.example.invalid',
    port: connection.connection.port,
    username: connection.connection.username,
    comfyHost: connection.connection.comfyHost,
    comfyPort: connection.connection.comfyPort,
    remoteWorkDir: connection.connection.remoteWorkDir,
  });
  await assert.rejects(connectionFixture.service.executeNext(executionRequest(
    connectionBatch.authorization, connectionBatch.session, connectionBatch.batch, 1,
  )), {
    code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
  });
  assert.equal(connectionFixture.inspections(), 1);
  assert.equal(connectionFixture.calls.length, 1);

  const source = createMvpBenchmarkSessionFixture(t);
  const sourceBatch = await preparedBatch(source);
  const sourceFixture = executionFixture(source);
  const sourceRequest = executionRequest(
    sourceBatch.authorization, sourceBatch.session, sourceBatch.batch,
  );
  await sourceFixture.service.executeNext(sourceRequest);
  makeCurrentReplacement(source, source.h3Intents[0], uid(99049));
  await assert.rejects(sourceFixture.service.executeNext(executionRequest(
    sourceBatch.authorization, sourceBatch.session, sourceBatch.batch, 1,
  )), {
    code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
  });
  assert.equal(sourceFixture.inspections(), 1);
  assert.equal(sourceFixture.calls.length, 1);
});

test('execute-next coalesces concurrent calls and a recreated service skips durable completions', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, batch, session } = await preparedBatch(current);
  const completed = new Map();
  let resolveFirst;
  let executeCalls = 0;
  const h3 = Object.freeze({
    get(taskUid) { return completed.get(taskUid) ?? null; },
    execute(taskUid) {
      executeCalls += 1;
      if (executeCalls > 1) {
        const result = h3Result(taskUid, executeCalls);
        completed.set(taskUid, result);
        return Promise.resolve(result);
      }
      return new Promise((resolve) => {
        resolveFirst = () => {
          const result = h3Result(taskUid, 1);
          completed.set(taskUid, result);
          resolve(result);
        };
      });
    },
  });
  const audio = Object.freeze({
    get() { return Promise.resolve(null); },
    getPersisted() { return null; },
    execute() { throw new Error('not reached'); },
  });
  function service() {
    const fresh = freshExecutionDependencies(current);
    return createMvpBenchmarkProductionExecutionService({
      repositories: current.repositories,
      executionGate: current.repositories.mvpBenchmarkExecutionGate,
      h3LocalExecution: h3,
      audioTtsExecution: audio,
      liveEnvironmentVerifier: fresh.liveEnvironmentVerifier,
      createUid: fresh.createUid,
      nowEpochMs: () => 2_200,
    });
  }
  const initial = service();
  const input = executionRequest(authorization, session, batch);
  const first = initial.executeNext(input);
  const duplicate = initial.executeNext(input);
  assert.equal(first, duplicate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executeCalls, 1);
  const conflicting = initial.executeNext(executionRequest(authorization, session, batch, 1));
  assert.notEqual(conflicting, first);
  await assert.rejects(conflicting, {
    code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_IN_PROGRESS',
  });
  assert.equal(executeCalls, 1);
  resolveFirst();
  await first;

  const restarted = service();
  const second = await restarted.executeNext(executionRequest(authorization, session, batch, 1));
  assert.equal(second.item.itemUid, session.h3Tasks[1].taskUid);
  assert.equal(executeCalls, 2);
});

test('a restarted batch uses a fresh item attestation after the original preflight expires', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, batch, session } = await preparedBatch(current);
  const first = current.repositories.mvpBenchmarkExecutionGate.openExecutionBatch(
    authorization.uid,
    { nowEpochMs: 2_200 },
  );
  assert.equal(first.batch.batchSha256, batch.batchSha256);
  assert.equal(first.permits.length, batch.reservations.length);

  current.repositories.remote.transitionFormalTask({
    uid: session.h3Tasks[0].taskUid,
    expectedStateVersion: 0,
    nextStage: 'uploading',
    nextStatus: 'running',
    recoveryState: 'none',
  });
  assert.throws(
    () => current.repositories.mvpBenchmarkExecutionPreflights.getBatchByAuthorization(
      authorization.uid,
    ),
  );
  const resumed = current.repositories.mvpBenchmarkExecutionGate.loadExecutionBatch(
    authorization.uid,
    { nowEpochMs: 302_001 },
  );
  assert.equal(resumed.batch.batchSha256, batch.batchSha256);
  const permit = current.repositories.mvpBenchmarkExecutionGate.openExecutionItem({
    attestationUid: uid(99000),
    authorizationUid: authorization.uid,
    itemKind: batch.reservations[0].itemKind,
    itemUid: batch.reservations[0].itemUid,
    observation: rawObservation(current, 302_001),
    reservationUid: batch.reservations[0].uid,
  }, { nowEpochMs: 302_001 });
  assert.equal(current.repositories.mvpBenchmarkExecutionGate.assertH3TaskExecutionOpen(
    session.h3Tasks[0].taskUid,
    permit,
  ), true);
});

test('missing preflight and a failed current item never reach a later executor', async (t) => {
  const missing = createMvpBenchmarkSessionFixture(t);
  const missingSession = missing.repositories.mvpBenchmarkSessions.prepare(missing.request);
  const missingAuthorization = missing.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(missing, missingSession),
    { nowEpochMs: 1_000 },
  );
  let missingCalls = 0;
  const missingFresh = freshExecutionDependencies(missing);
  const missingService = createMvpBenchmarkProductionExecutionService({
    repositories: missing.repositories,
    executionGate: missing.repositories.mvpBenchmarkExecutionGate,
    h3LocalExecution: Object.freeze({
      get() { missingCalls += 1; return null; },
      execute() { missingCalls += 1; return Promise.resolve(null); },
    }),
    audioTtsExecution: Object.freeze({
      get() { missingCalls += 1; return Promise.resolve(null); },
      getPersisted() { missingCalls += 1; return null; },
      execute() { missingCalls += 1; return Promise.resolve(null); },
    }),
    liveEnvironmentVerifier: missingFresh.liveEnvironmentVerifier,
    createUid: missingFresh.createUid,
    nowEpochMs: () => 2_200,
  });
  await assert.rejects(missingService.executeNext(
    Object.freeze({
      schemaVersion: 'mvp-benchmark-production-execution-request.v1',
      authorizationUid: missingAuthorization.uid,
      dramaUid: missingSession.dramaUid,
      sessionUid: missingSession.uid,
      expectedBatchSha256: '0'.repeat(64),
      expectedOrdinal: 0,
      expectedItemKind: 'h3',
      expectedItemUid: missingSession.h3Tasks[0].taskUid,
    }),
  ), {
    code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
  });
  assert.equal(missingCalls, 0);

  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, batch, session } = await preparedBatch(current);
  let laterCalls = 0;
  const failedFresh = freshExecutionDependencies(current);
  const failed = createMvpBenchmarkProductionExecutionService({
    repositories: current.repositories,
    executionGate: current.repositories.mvpBenchmarkExecutionGate,
    h3LocalExecution: Object.freeze({
      get() { return null; },
      execute() { return Promise.reject(new Error('synthetic raw provider detail')); },
    }),
    audioTtsExecution: Object.freeze({
      get() { return Promise.resolve(null); },
      getPersisted() { return null; },
      execute() { laterCalls += 1; return Promise.resolve(null); },
    }),
    liveEnvironmentVerifier: failedFresh.liveEnvironmentVerifier,
    createUid: failedFresh.createUid,
    nowEpochMs: () => 2_200,
  });
  await assert.rejects(failed.executeNext(executionRequest(authorization, session, batch)), (error) => {
    assert.equal(error.code, 'MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED');
    assert.equal(JSON.stringify(error).includes('provider'), false);
    return true;
  });
  assert.equal(laterCalls, 0);
});

test('source drift during the fresh inspection is rejected before the item executor', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, batch, session } = await preparedBatch(current);
  const intent = current.h3Intents[0];
  let executeCalls = 0;
  const service = createMvpBenchmarkProductionExecutionService({
    repositories: current.repositories,
    executionGate: current.repositories.mvpBenchmarkExecutionGate,
    h3LocalExecution: Object.freeze({
      get() { return null; },
      execute() { executeCalls += 1; return Promise.resolve(null); },
    }),
    audioTtsExecution: Object.freeze({
      get() { return Promise.resolve(null); },
      getPersisted() { return null; },
      execute() { executeCalls += 1; return Promise.resolve(null); },
    }),
    liveEnvironmentVerifier: Object.freeze({
      inspect() {
        const replacementVersionUid = uid(99050);
        makeCurrentReplacement(current, intent, replacementVersionUid);
        return Promise.resolve(rawObservation(current, 2_200));
      },
    }),
    createUid: () => uid(99051),
    nowEpochMs: () => 2_200,
  });
  await assert.rejects(service.executeNext(executionRequest(authorization, session, batch)), {
    code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
  });
  assert.equal(executeCalls, 0);
});

test('a durable out-of-order completion is rejected instead of being normalized', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, batch, session } = await preparedBatch(current);
  const completed = new Map([
    [session.h3Tasks[1].taskUid, h3Result(session.h3Tasks[1].taskUid, 2)],
  ]);
  const fresh = freshExecutionDependencies(current);
  let executeCalls = 0;
  const service = createMvpBenchmarkProductionExecutionService({
    repositories: current.repositories,
    executionGate: current.repositories.mvpBenchmarkExecutionGate,
    h3LocalExecution: Object.freeze({
      get(taskUid) { return completed.get(taskUid) ?? null; },
      execute() { executeCalls += 1; return Promise.resolve(null); },
    }),
    audioTtsExecution: Object.freeze({
      get() { return Promise.resolve(null); },
      getPersisted() { return null; },
      execute() { executeCalls += 1; return Promise.resolve(null); },
    }),
    liveEnvironmentVerifier: fresh.liveEnvironmentVerifier,
    createUid: fresh.createUid,
    nowEpochMs: () => 2_200,
  });
  await assert.rejects(service.executeNext(executionRequest(authorization, session, batch)), {
    code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
  });
  assert.equal(fresh.inspections(), 0);
  assert.equal(executeCalls, 0);
});

test('localhost execute-next accepts only an exact expected item and path-bound frozen batch', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, batch, session } = await preparedBatch(current);
  const fixture = executionFixture(current);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/v2', mvpBenchmarkRoutes(
    Object.freeze({ error() {} }),
    Object.freeze({ mvpBenchmark: Object.freeze({ execution: fixture.service }) }),
    current.database,
  ));
  const { server, base } = await listen(app);
  t.after(() => server.close());
  const suffix = `mvp-benchmark/sessions/${session.uid}/authorizations/${authorization.uid}/execute-next`;
  const seed = executionSeed(executionRequest(authorization, session, batch));
  const validateRequest = new Ajv2020({ strict: true }).compile(executionRequestSchema);
  assert.equal(validateRequest(seed), true, JSON.stringify(validateRequest.errors));
  assert.equal(validateRequest({ ...seed, extra: true }), false);

  const wrongDrama = await fetch(`${base}/api/v1/v2/dramas/${uid(99899)}/${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(seed),
  });
  assert.equal(wrongDrama.status, 503);
  assert.equal(fixture.inspections(), 0);
  assert.equal(fixture.calls.length, 0);

  const extra = await fetch(`${base}/api/v1/v2/dramas/${session.dramaUid}/${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...seed, extra: true }),
  });
  assert.equal(extra.status, 400);
  assert.equal(fixture.inspections(), 0);

  const wrongVersion = await fetch(`${base}/api/v1/v2/dramas/${session.dramaUid}/${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...seed, schemaVersion: 'mvp-benchmark-production-execution-request.v2',
    }),
  });
  assert.equal(wrongVersion.status, 400);
  assert.equal(fixture.inspections(), 0);

  const accepted = await fetch(`${base}/api/v1/v2/dramas/${session.dramaUid}/${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(seed),
  });
  const body = await accepted.json();
  assert.equal(accepted.status, 200, JSON.stringify(body));
  assert.equal(body.data.item.itemUid, session.h3Tasks[0].taskUid);
  assert.equal(fixture.inspections(), 1);
  assert.equal(fixture.calls.length, 1);

  const progressSuffix = `mvp-benchmark/sessions/${session.uid}/authorizations/${authorization.uid}/execution-progress/${batch.batchSha256}`;
  const progress = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/${progressSuffix}`,
  );
  const progressBody = await progress.json();
  assert.equal(progress.status, 200, JSON.stringify(progressBody));
  assert.equal(progressBody.data.completedCount, 1);
  assert.equal(progressBody.data.nextItem.itemUid, batch.reservations[1].itemUid);
  assert.equal(fixture.inspections(), 1);
  assert.equal(fixture.calls.length, 1);

  const wrongProgress = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/mvp-benchmark/sessions/${session.uid}/authorizations/${authorization.uid}/execution-progress/${'0'.repeat(64)}`,
  );
  assert.equal(wrongProgress.status, 503);
  assert.equal(fixture.inspections(), 1);
  assert.equal(fixture.calls.length, 1);

  const stale = await fetch(`${base}/api/v1/v2/dramas/${session.dramaUid}/${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(seed),
  });
  assert.equal(stale.status, 503);
  assert.equal(fixture.inspections(), 1);
  assert.equal(fixture.calls.length, 1);
});

test('localhost rejects a concurrent different-item confirmation before new side effects', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, batch, session } = await preparedBatch(current);
  let inspectionCalls = 0;
  let releaseFirstInspection = null;
  let markInspectionStarted;
  const inspectionStarted = new Promise((resolve) => { markInspectionStarted = resolve; });
  const fixture = executionFixture(current, {
    inspections: () => inspectionCalls,
    liveEnvironmentVerifier: Object.freeze({
      inspect() {
        inspectionCalls += 1;
        if (inspectionCalls > 1) return Promise.resolve(rawObservation(current, 2_200));
        markInspectionStarted();
        return new Promise((resolve) => {
          releaseFirstInspection = () => resolve(rawObservation(current, 2_200));
        });
      },
    }),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/v2', mvpBenchmarkRoutes(
    Object.freeze({ error() {} }),
    Object.freeze({ mvpBenchmark: Object.freeze({ execution: fixture.service }) }),
    current.database,
  ));
  const { server, base } = await listen(app);
  t.after(() => server.close());
  const suffix = `mvp-benchmark/sessions/${session.uid}/authorizations/${authorization.uid}/execute-next`;
  const endpoint = `${base}/api/v1/v2/dramas/${session.dramaUid}/${suffix}`;
  const firstSeed = executionSeed(executionRequest(authorization, session, batch));
  const secondSeed = executionSeed(executionRequest(authorization, session, batch, 1));
  const firstResponse = fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(firstSeed),
  });
  let startDeadline;
  await Promise.race([
    inspectionStarted,
    firstResponse.then(async (responseValue) => {
      throw new Error(`first request ended before inspection: ${responseValue.status} ${await responseValue.text()}`);
    }),
    new Promise((_, reject) => {
      startDeadline = setTimeout(() => reject(new Error('inspection did not start')), 30_000);
    }),
  ]);
  clearTimeout(startDeadline);
  assert.equal(typeof releaseFirstInspection, 'function');
  assert.equal(fixture.inspections(), 1);
  assert.equal(fixture.calls.length, 0);

  const progressEndpoint = `${base}/api/v1/v2/dramas/${session.dramaUid}/mvp-benchmark/sessions/${session.uid}/authorizations/${authorization.uid}/execution-progress/${batch.batchSha256}`;
  const activeProgress = await fetch(progressEndpoint);
  assert.equal(activeProgress.status, 409);
  assert.equal(fixture.inspections(), 1);
  assert.equal(fixture.calls.length, 0);

  const conflicting = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(secondSeed),
  });
  assert.equal(conflicting.status, 409);
  assert.equal(fixture.inspections(), 1);
  assert.equal(fixture.calls.length, 0);

  releaseFirstInspection();
  const first = await firstResponse;
  assert.equal(first.status, 200);
  const recoveredProgress = await fetch(progressEndpoint);
  const recoveredBody = await recoveredProgress.json();
  assert.equal(recoveredProgress.status, 200, JSON.stringify(recoveredBody));
  assert.equal(recoveredBody.data.completedCount, 1);
  assert.equal(fixture.inspections(), 1);
  assert.equal(fixture.calls.length, 1);
  const second = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(secondSeed),
  });
  assert.equal(second.status, 200);
  assert.equal(fixture.inspections(), 2);
  assert.equal(fixture.calls.length, 2);
});
