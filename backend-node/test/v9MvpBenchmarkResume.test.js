'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const resumeSchema = require('../../schemas/v9/mvp-benchmark-resume-snapshot.schema.json');
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
const {
  createProductionMvpBenchmarkRuntime,
} = require('../src/benchmark/productionRuntime');
const {
  MvpBenchmarkResumeError,
  createMvpBenchmarkResumeService,
} = require('../src/benchmark/mvpBenchmarkResumeService');
const { parseMvpBenchmarkExternalAuthorization } = require('../src/benchmark/mvpBenchmarkExternalAuthorization');
const {
  serializeMvpBenchmarkExecutionPreflightJson,
} = require('../src/benchmark/mvpBenchmarkExecutionPreflight');
const { parseMvpBenchmarkSessionPlan } = require('../src/benchmark/mvpBenchmarkSession');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const mvpBenchmarkRoutes = require('../src/routes/v2/mvpBenchmark');
const { createMvpBenchmarkSessionFixture } = require('./helpers/v9MvpBenchmarkSessionFixture');
const { uid } = require('./helpers/v2RepositoryDatabase');

function authorizationRequest(current, session) {
  return {
    schemaVersion: 'mvp-benchmark-external-authorization-request.v1',
    uid: uid(99800),
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    sessionPlanSha256: session.planSha256,
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    maximumCostCnyFen: 1_000,
    validityDurationMs: 60 * 60 * 1000,
  };
}

function observation(current) {
  const result = createMvpBenchmarkLiveEnvironmentObservation({
    schemaVersion: 'mvp-benchmark-live-environment-observation.v1',
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    observedAtEpochMs: 2_000,
    approvedEnvironmentSha256:
      '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43',
    gpu: structuredClone(APPROVED_LIVE_ENVIRONMENT.gpu),
    comfyUI: structuredClone(APPROVED_LIVE_ENVIRONMENT.comfyUI),
    runtime: structuredClone(APPROVED_LIVE_ENVIRONMENT.runtime),
    models: structuredClone(APPROVED_LIVE_ENVIRONMENT.models),
  });
  const { observationSha256: _digest, ...raw } = result;
  return raw;
}

async function prepareBatch(current, authorization) {
  let nextUid = 99810;
  const preflight = createMvpBenchmarkExecutionPreflightService({
    repositories: current.repositories,
    liveEnvironmentVerifier: Object.freeze({
      inspect() { return Promise.resolve(observation(current)); },
    }),
    costEstimator: Object.freeze({
      estimateH3() {
        return Promise.resolve({ estimatedCostCnyFen: 10, policyUid: uid(99890) });
      },
      estimateTts() {
        return Promise.resolve({ estimatedCostCnyFen: 5, policyUid: uid(99891) });
      },
    }),
    createUid: () => uid(nextUid++),
    nowEpochMs: () => 2_100,
  });
  return preflight.prepareBatch(authorization.uid);
}

function execution(current, counters, nowEpochMs = () => 2_200) {
  return createMvpBenchmarkProductionExecutionService({
    repositories: current.repositories,
    executionGate: current.repositories.mvpBenchmarkExecutionGate,
    h3LocalExecution: Object.freeze({
      execute() { counters.executions += 1; return Promise.reject(new Error('not allowed')); },
      get() { return null; },
    }),
    audioTtsExecution: Object.freeze({
      execute() { counters.executions += 1; return Promise.reject(new Error('not allowed')); },
      get() { counters.mediaReads += 1; return Promise.resolve(null); },
      getPersisted() { counters.persistedReads += 1; return null; },
    }),
    liveEnvironmentVerifier: Object.freeze({
      inspect() { counters.inspections += 1; return Promise.reject(new Error('not allowed')); },
    }),
    nowEpochMs,
  });
}

function service(current, counters, nowEpochMs = () => 2_200) {
  return createMvpBenchmarkResumeService({
    repositories: current.repositories,
    execution: execution(current, counters, nowEpochMs),
    nowEpochMs,
  });
}

function request(current) {
  return Object.freeze({
    dramaUid: current.request.dramaUid,
    workflowRunUid: current.request.workflowRunUid,
  });
}

function assertNoSideEffects(counters) {
  assert.equal(counters.executions, 0);
  assert.equal(counters.inspections, 0);
  assert.equal(counters.mediaReads, 0);
}

function counters() {
  return { executions: 0, inspections: 0, mediaReads: 0, persistedReads: 0 };
}

async function readWithoutDatabaseWrite(resume, input, database) {
  const before = database.serialize();
  const result = await resume.read(input);
  assert.deepEqual(database.serialize(), before);
  return result;
}

test('resume returns the exact valid local evidence prefix without writes or external work', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const measured = counters();
  const resume = service(current, measured);

  const empty = await readWithoutDatabaseWrite(resume, request(current), current.database);
  assert.equal(empty.state, 'empty');
  assert.equal(empty.sessionJson, null);
  const emptyDatabase = current.database.serialize();
  await assert.rejects(resume.read({
    dramaUid: uid(99790),
    workflowRunUid: current.request.workflowRunUid,
  }), { code: 'MVP_BENCHMARK_RESUME_UNAVAILABLE' });
  await assert.rejects(resume.read({
    dramaUid: current.request.dramaUid,
    workflowRunUid: uid(99791),
  }), { code: 'MVP_BENCHMARK_RESUME_UNAVAILABLE' });
  assert.deepEqual(current.database.serialize(), emptyDatabase);

  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const sessionOnly = await readWithoutDatabaseWrite(resume, request(current), current.database);
  assert.equal(sessionOnly.state, 'session');
  assert.deepEqual(parseMvpBenchmarkSessionPlan(JSON.parse(sessionOnly.sessionJson)), session);
  assert.equal(sessionOnly.authorizationJson, null);

  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  const authorized = await readWithoutDatabaseWrite(resume, request(current), current.database);
  assert.equal(authorized.state, 'authorization');
  assert.deepEqual(
    parseMvpBenchmarkExternalAuthorization(JSON.parse(authorized.authorizationJson)),
    authorization,
  );
  assert.equal(authorized.batchJson, null);

  const batch = await prepareBatch(current, authorization);
  const storedSession = current.repositories.mvpBenchmarkSessions.getStoredByWorkflowRun(
    current.request.workflowRunUid,
  );
  const storedAuthorization = current.repositories.mvpBenchmarkExternalAuthorizations
    .getStoredBySession(session.uid);
  const storedBatch = current.repositories.mvpBenchmarkExecutionPreflights
    .getStoredBatchByAuthorization(authorization.uid);
  assert.equal(storedSession.planSha256, session.planSha256);
  assert.equal(storedAuthorization.authorizationSha256, authorization.authorizationSha256);
  assert.equal(storedBatch.batchSha256, batch.batchSha256);
  const directProgress = await execution(current, counters()).readProgress({
    schemaVersion: 'mvp-benchmark-production-execution-progress-request.v1',
    authorizationUid: authorization.uid,
    dramaUid: session.dramaUid,
    sessionUid: session.uid,
    expectedBatchSha256: batch.batchSha256,
  });
  assert.equal(directProgress.completedCount, 0);
  const recovered = await readWithoutDatabaseWrite(resume, request(current), current.database);
  assert.equal(recovered.state, 'execution');
  assert.equal(recovered.batchJson, serializeMvpBenchmarkExecutionPreflightJson(batch));
  assert.deepEqual(JSON.parse(recovered.progressJson), {
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
  assert.equal(measured.persistedReads, 1);
  assertNoSideEffects(measured);

  const ajv = new Ajv2020({ strict: true });
  const validateResume = ajv.compile(resumeSchema);
  assert.equal(validateResume(recovered), true, JSON.stringify(validateResume.errors));
  assert.equal(validateResume({ ...recovered, state: 'empty' }), false);
  assert.equal(validateResume({ ...recovered, progressJson: null }), false);
});

test('resume fails closed for running work, expiry, drift, and partial preflight', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  const batch = await prepareBatch(current, authorization);
  const measured = counters();
  const resume = service(current, measured);

  current.repositories.remote.transitionFormalTask({
    uid: batch.reservations[0].itemUid,
    expectedStateVersion: 0,
    nextStage: 'uploading',
    nextStatus: 'running',
    recoveryState: 'none',
  });
  const runningBefore = current.database.serialize();
  await assert.rejects(
    resume.read(request(current)),
    (error) => error instanceof MvpBenchmarkResumeError
      && error.code === 'MVP_BENCHMARK_RESUME_UNAVAILABLE',
  );
  assert.deepEqual(current.database.serialize(), runningBefore);
  assertNoSideEffects(measured);

  const expired = createMvpBenchmarkSessionFixture(t);
  const expiredSession = expired.repositories.mvpBenchmarkSessions.prepare(expired.request);
  const expiredAuthorization = expired.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(expired, expiredSession),
    { nowEpochMs: 1_000 },
  );
  const expiredCounters = counters();
  const expiredBefore = expired.database.serialize();
  await assert.rejects(
    service(expired, expiredCounters, () => expiredAuthorization.expiresAtEpochMs + 1)
      .read(request(expired)),
    { code: 'MVP_BENCHMARK_RESUME_UNAVAILABLE' },
  );
  assert.deepEqual(expired.database.serialize(), expiredBefore);
  assertNoSideEffects(expiredCounters);

  const drifted = createMvpBenchmarkSessionFixture(t);
  const driftedSession = drifted.repositories.mvpBenchmarkSessions.prepare(drifted.request);
  drifted.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(drifted, driftedSession),
    { nowEpochMs: 1_000 },
  );
  drifted.repositories.remote.updateConnection({
    uid: drifted.connection.uid,
    expectedStateVersion: drifted.connection.stateVersion,
    name: drifted.connection.name,
    host: 'replacement.example.invalid',
    port: drifted.connection.port,
    username: drifted.connection.username,
    comfyHost: drifted.connection.comfyHost,
    comfyPort: drifted.connection.comfyPort,
    remoteWorkDir: drifted.connection.remoteWorkDir,
  });
  const driftedCounters = counters();
  const driftedBefore = drifted.database.serialize();
  await assert.rejects(service(drifted, driftedCounters).read(request(drifted)), {
    code: 'MVP_BENCHMARK_RESUME_UNAVAILABLE',
  });
  assert.deepEqual(drifted.database.serialize(), driftedBefore);
  assertNoSideEffects(driftedCounters);

  const partial = createMvpBenchmarkSessionFixture(t);
  const partialSession = partial.repositories.mvpBenchmarkSessions.prepare(partial.request);
  const partialAuthorization = partial.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(partial, partialSession),
    { nowEpochMs: 1_000 },
  );
  await prepareBatch(partial, partialAuthorization);
  partial.database.exec(`
    DROP TRIGGER v2_mvp_benchmark_execution_reservation_seals_append_only;
    DROP TRIGGER v2_mvp_benchmark_execution_reservations_append_only;
    DELETE FROM mvp_benchmark_execution_reservation_seals
    WHERE reservation_uid=(SELECT uid FROM mvp_benchmark_execution_reservations LIMIT 1);
    DELETE FROM mvp_benchmark_execution_reservations
    WHERE uid=(SELECT uid FROM mvp_benchmark_execution_reservations LIMIT 1);
  `);
  const partialCounters = counters();
  const partialBefore = partial.database.serialize();
  await assert.rejects(service(partial, partialCounters).read(request(partial)), {
    code: 'MVP_BENCHMARK_RESUME_UNAVAILABLE',
  });
  assert.deepEqual(partial.database.serialize(), partialBefore);
  assertNoSideEffects(partialCounters);

  partial.database.exec(`
    DELETE FROM mvp_benchmark_execution_reservation_seals;
    DELETE FROM mvp_benchmark_execution_reservations;
  `);
  const emptyReservationBefore = partial.database.serialize();
  await assert.rejects(service(partial, partialCounters).read(request(partial)), {
    code: 'MVP_BENCHMARK_RESUME_UNAVAILABLE',
  });
  assert.deepEqual(partial.database.serialize(), emptyReservationBefore);
  assertNoSideEffects(partialCounters);
});

test('resume route is GET-only, path-bound, and unavailable without production wiring', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const measured = counters();
  const production = createProductionMvpBenchmarkRuntime({
    database: current.database,
    sessionService: Object.freeze({ openSession() { throw new Error('not allowed'); } }),
    h3LocalExecution: Object.freeze({
      execute() { measured.executions += 1; throw new Error('not allowed'); },
      get() { return null; },
    }),
    audioTtsExecution: Object.freeze({
      execute() { measured.executions += 1; throw new Error('not allowed'); },
      get() { measured.mediaReads += 1; return Promise.resolve(null); },
      getPersisted() { measured.persistedReads += 1; return null; },
    }),
    dependencies: Object.freeze({
      liveEnvironmentVerifier: Object.freeze({
        inspect() { measured.inspections += 1; throw new Error('not allowed'); },
      }),
      nowEpochMs: () => 2_200,
    }),
  });
  assert.equal(typeof production.resume.read, 'function');
  assert.equal(typeof production.accountingStatus.read, 'function');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/v2', mvpBenchmarkRoutes(Object.freeze({}), Object.freeze({
    mvpBenchmark: production,
  }), current.database));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/api/v1/v2`;
  const path = `/dramas/${current.request.dramaUid}/mvp-benchmark/workflow-runs/${current.request.workflowRunUid}/resume`;
  const response = await fetch(`${base}${path}`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.state, 'empty');
  assertNoSideEffects(measured);
  const rejectedPost = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(rejectedPost.status, 404);
  assertNoSideEffects(measured);

  const missing = express();
  missing.use('/api/v1/v2', mvpBenchmarkRoutes(Object.freeze({}), Object.freeze({}), current.database));
  const missingServer = await new Promise((resolve) => {
    const listening = missing.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => missingServer.close());
  const missingAddress = missingServer.address();
  const unavailable = await fetch(
    `http://127.0.0.1:${missingAddress.port}/api/v1/v2${path}`,
  );
  assert.equal(unavailable.status, 503);
});
