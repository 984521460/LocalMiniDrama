'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');
const Ajv2020 = require('ajv/dist/2020');

const executionStepSchema = require('../../schemas/v9/mvp-benchmark-production-execution-step.schema.json');

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
      '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
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
    schemaVersion: 'h3-local-execution-result.v1',
    taskUid,
    taskStateVersion: 7,
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

function executionRequest(authorization, session) {
  return Object.freeze({
    authorizationUid: authorization.uid,
    dramaUid: session.dramaUid,
    sessionUid: session.uid,
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
      assert.equal(intentUid, current.audioIntent.uid);
      assert.equal(dramaUid, current.audioIntent.dramaUid);
      return Promise.resolve(completedAudio);
    },
    execute(intentUid, dramaUid, permit) {
      calls.push(Object.freeze({ kind: 'tts', intentUid, dramaUid, permit }));
      completedAudio = audioResult(current);
      return Promise.resolve(completedAudio);
    },
  });
  return Object.freeze({
    calls,
    h3Completed,
    inspections: fresh.inspections,
    service: createMvpBenchmarkProductionExecutionService({
      repositories: current.repositories,
      executionGate: current.repositories.mvpBenchmarkExecutionGate,
      h3LocalExecution,
      audioTtsExecution,
      liveEnvironmentVerifier: fresh.liveEnvironmentVerifier,
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
  const first = await fixture.service.executeNext(executionRequest(authorization, session));

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

  const second = await fixture.service.executeNext(executionRequest(authorization, session));
  assert.equal(second.completedCount, 2);
  assert.equal(second.item.itemUid, session.h3Tasks[1].taskUid);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.inspections(), 2);
});

test('a warmed execution context revalidates authorization and sources before inspection', async (t) => {
  const expired = createMvpBenchmarkSessionFixture(t);
  const expiredBatch = await preparedBatch(expired);
  let currentNowEpochMs = 2_200;
  const expiredFixture = executionFixture(expired, {
    nowEpochMs: () => currentNowEpochMs,
  });
  const expiredRequest = executionRequest(expiredBatch.authorization, expiredBatch.session);
  await expiredFixture.service.executeNext(expiredRequest);
  assert.equal(expiredFixture.inspections(), 1);
  assert.equal(expiredFixture.calls.length, 1);
  currentNowEpochMs = expiredBatch.authorization.expiresAtEpochMs + 1;
  await assert.rejects(expiredFixture.service.executeNext(expiredRequest), {
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
  await assert.rejects(connectionFixture.service.executeNext(connectionRequest), {
    code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
  });
  assert.equal(connectionFixture.inspections(), 1);
  assert.equal(connectionFixture.calls.length, 1);

  const source = createMvpBenchmarkSessionFixture(t);
  const sourceBatch = await preparedBatch(source);
  const sourceFixture = executionFixture(source);
  const sourceRequest = executionRequest(sourceBatch.authorization, sourceBatch.session);
  await sourceFixture.service.executeNext(sourceRequest);
  makeCurrentReplacement(source, source.h3Intents[0], uid(99049));
  await assert.rejects(sourceFixture.service.executeNext(sourceRequest), {
    code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
  });
  assert.equal(sourceFixture.inspections(), 1);
  assert.equal(sourceFixture.calls.length, 1);
});

test('execute-next coalesces concurrent calls and a recreated service skips durable completions', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, session } = await preparedBatch(current);
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
  const input = executionRequest(authorization, session);
  const first = initial.executeNext(input);
  const duplicate = initial.executeNext(input);
  assert.equal(first, duplicate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executeCalls, 1);
  resolveFirst();
  await first;

  const restarted = service();
  const second = await restarted.executeNext(input);
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
      execute() { missingCalls += 1; return Promise.resolve(null); },
    }),
    liveEnvironmentVerifier: missingFresh.liveEnvironmentVerifier,
    createUid: missingFresh.createUid,
    nowEpochMs: () => 2_200,
  });
  await assert.rejects(missingService.executeNext(
    executionRequest(missingAuthorization, missingSession),
  ), {
    code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
  });
  assert.equal(missingCalls, 0);

  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, session } = await preparedBatch(current);
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
      execute() { laterCalls += 1; return Promise.resolve(null); },
    }),
    liveEnvironmentVerifier: failedFresh.liveEnvironmentVerifier,
    createUid: failedFresh.createUid,
    nowEpochMs: () => 2_200,
  });
  await assert.rejects(failed.executeNext(executionRequest(authorization, session)), (error) => {
    assert.equal(error.code, 'MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED');
    assert.equal(JSON.stringify(error).includes('provider'), false);
    return true;
  });
  assert.equal(laterCalls, 0);
});

test('source drift during the fresh inspection is rejected before the item executor', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, session } = await preparedBatch(current);
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
  await assert.rejects(service.executeNext(executionRequest(authorization, session)), {
    code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
  });
  assert.equal(executeCalls, 0);
});

test('a durable out-of-order completion is rejected instead of being normalized', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, session } = await preparedBatch(current);
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
      execute() { executeCalls += 1; return Promise.resolve(null); },
    }),
    liveEnvironmentVerifier: fresh.liveEnvironmentVerifier,
    createUid: fresh.createUid,
    nowEpochMs: () => 2_200,
  });
  await assert.rejects(service.executeNext(executionRequest(authorization, session)), {
    code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
  });
  assert.equal(fresh.inspections(), 0);
  assert.equal(executeCalls, 0);
});

test('localhost execute-next accepts only an empty request and path-bound frozen batch', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, session } = await preparedBatch(current);
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

  const wrongDrama = await fetch(`${base}/api/v1/v2/dramas/${uid(99899)}/${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(wrongDrama.status, 503);
  assert.equal(fixture.inspections(), 0);
  assert.equal(fixture.calls.length, 0);

  const extra = await fetch(`${base}/api/v1/v2/dramas/${session.dramaUid}/${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"seed":1}',
  });
  assert.equal(extra.status, 400);
  assert.equal(fixture.inspections(), 0);

  const accepted = await fetch(`${base}/api/v1/v2/dramas/${session.dramaUid}/${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const body = await accepted.json();
  assert.equal(accepted.status, 200, JSON.stringify(body));
  assert.equal(body.data.item.itemUid, session.h3Tasks[0].taskUid);
  assert.equal(fixture.inspections(), 1);
  assert.equal(fixture.calls.length, 1);
});
