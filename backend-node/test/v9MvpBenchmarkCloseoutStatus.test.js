'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const statusSchema = require('../../schemas/v9/mvp-benchmark-closeout-status.schema.json');
const {
  createMvpBenchmarkExternalAuthorization,
} = require('../src/benchmark/mvpBenchmarkExternalAuthorization');
const {
  MvpBenchmarkCloseoutStatusError,
  createMvpBenchmarkCloseoutStatus,
} = require('../src/benchmark/mvpBenchmarkCloseoutStatus');
const {
  createMvpBenchmarkCloseoutStatusService,
} = require('../src/benchmark/mvpBenchmarkCloseoutStatusService');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const mvpBenchmarkRoutes = require('../src/routes/v2/mvpBenchmark');
const { createMvpBenchmarkSessionFixture } = require('./helpers/v9MvpBenchmarkSessionFixture');

function uid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function succeededAggregate(value) {
  const aggregate = structuredClone(value);
  aggregate.run.status = 'succeeded';
  aggregate.run.startedAt = aggregate.run.createdAt;
  aggregate.run.completedAt = aggregate.run.createdAt;
  aggregate.run.updatedAt = aggregate.run.createdAt;
  for (let index = 0; index < aggregate.nodes.length; index += 1) {
    const node = aggregate.nodes[index];
    node.status = 'succeeded';
    node.inputSnapshot = {};
    node.output = { synthetic: true };
    node.cacheKey = String((index % 9) + 1).repeat(64);
    node.startedAt = node.createdAt;
    node.completedAt = node.createdAt;
    node.updatedAt = node.createdAt;
  }
  return aggregate;
}

function serviceFixture(t, completed = false) {
  const current = createMvpBenchmarkSessionFixture(t, { includeExportFinal: true });
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = createMvpBenchmarkExternalAuthorization({
    request: {
      schemaVersion: 'mvp-benchmark-external-authorization-request.v1',
      uid: uid(99500),
      sessionUid: session.uid,
      dramaUid: session.dramaUid,
      sessionPlanSha256: session.planSha256,
      connectionUid: current.connection.uid,
      connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
      maximumCostCnyFen: 374,
      validityDurationMs: 7_200_000,
    },
    h3SubmissionLimit: session.h3Tasks.length,
    ttsSubmissionLimit: session.audioIntents.length,
    authorizedAtEpochMs: 1_000,
  });
  const reservations = [
    ...session.h3Tasks.map((item, index) => Object.freeze({
      uid: uid(99510 + index), itemKind: 'h3', itemUid: item.taskUid,
      requestSha256: item.planEvidenceSha256,
    })),
    ...session.audioIntents.map((item, index) => Object.freeze({
      uid: uid(99520 + index), itemKind: 'tts', itemUid: item.intentUid,
      requestSha256: item.planSha256,
    })),
  ];
  const batch = Object.freeze({
    schemaVersion: 'mvp-benchmark-execution-preflight-batch.v1',
    authorizationUid: authorization.uid,
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    attestationUid: uid(99530),
    reservations: Object.freeze(reservations),
    estimatedCostCnyFen: 374,
    preparedAtEpochMs: 2_000,
    batchSha256: 'e'.repeat(64),
  });
  const output = Object.freeze({
    assetUid: uid(99540), assetVersionUid: uid(99541), sha256: '8'.repeat(64),
    bytes: 8_192, durationMs: 4_000, mimeType: 'video/mp4', width: 1920, height: 1080,
  });
  const exportRun = Object.freeze({
    schemaVersion: 'media-export-run.v1', uid: uid(99542), dramaUid: session.dramaUid,
    workflowRunUid: session.workflowRunUid, sourceNodeRunUid: current.exportNodeRun.uid,
    executionPlanSha256: '7'.repeat(64), status: 'succeeded',
    outputAssetUid: output.assetUid, outputAssetVersionUid: output.assetVersionUid,
    output, errorCode: null, createdAt: '1970-01-01T00:00:00.000Z',
    startedAt: '1970-01-01T00:00:00.000Z', completedAt: '1970-01-01T00:00:00.000Z',
  });
  const review = Object.freeze({
    schemaVersion: 'mvp-benchmark-human-av-review.v1', uid: uid(99543),
    sessionUid: session.uid, authorizationUid: authorization.uid,
    batchSha256: batch.batchSha256, dramaUid: session.dramaUid,
    workflowRunUid: session.workflowRunUid, exportRunUid: exportRun.uid,
    exportExecutionPlanSha256: exportRun.executionPlanSha256,
    outputAssetUid: output.assetUid, outputAssetVersionUid: output.assetVersionUid,
    outputSha256: output.sha256, outputBytes: output.bytes,
    outputDurationMs: output.durationMs, outputWidth: 1920, outputHeight: 1080,
    exportCompletedAtEpochMs: 3_000, videoPlaybackAccepted: true,
    subtitleSyncAccepted: true, bgmBalanceAccepted: true,
    reviewNote: 'Synthetic complete playback review.', reviewedAtEpochMs: 4_000,
    reviewSha256: '9'.repeat(64),
  });
  const accounting = Object.freeze({
    schemaVersion: 'mvp-benchmark-accounting-status.v1', dramaUid: session.dramaUid,
    sessionUid: session.uid, authorizationUid: authorization.uid,
    batchSha256: batch.batchSha256, totalCount: reservations.length,
    settledCount: completed ? reservations.length : 0,
    actualCostCnyFen: completed ? 300 : 0, allSettled: completed,
    releaseState: completed ? 'released' : 'required',
    obligationSha256: 'a'.repeat(64), receiptSha256: completed ? 'b'.repeat(64) : null,
    items: Object.freeze(reservations.map((item, index) => Object.freeze({
      ordinal: index, itemKind: item.itemKind, itemUid: item.itemUid,
      reservationUid: item.uid, settlementState: completed ? 'settled' : 'pending',
      settlementUid: completed ? uid(99600 + index) : null,
      settlementSha256: completed ? String((index % 8) + 1).repeat(64) : null,
      actualCostCnyFen: completed ? 60 : null,
    }))),
  });
  const aggregate = completed ? succeededAggregate(current.run) : current.run;
  const repositories = Object.freeze({
    mvpBenchmarkSessions: Object.freeze({ getStored() { return session; } }),
    mvpBenchmarkExternalAuthorizations: Object.freeze({
      getStoredBySession() { return authorization; },
    }),
    mvpBenchmarkExecutionPreflights: Object.freeze({
      getStoredBatchByAuthorization() { return batch; },
    }),
    runs: Object.freeze({ getWorkflowWithNodes() { return aggregate; } }),
    mediaExportRuns: Object.freeze({
      getBySourceNodeRun() { return completed ? exportRun : null; },
    }),
    mvpBenchmarkHumanAvReviews: Object.freeze({
      getByAuthorization() { return completed ? review : null; },
    }),
  });
  const h3Results = new Map(session.h3Tasks.map((item, index) => [item.taskUid, Object.freeze({
    schemaVersion: 'h3-local-execution-result.v2', taskUid: item.taskUid,
    taskStateVersion: 1, workflowRunUid: session.workflowRunUid,
    generationRunUid: uid(99700 + index), historyUid: uid(99710 + index),
    assetUid: item.assetUid, assetVersionUid: uid(99720 + index),
    nodeRunUid: item.nodeRunUid, status: 'succeeded',
  })]));
  const audioResults = new Map(session.audioIntents.map((item, index) => [item.intentUid,
    Object.freeze({
      schemaVersion: 'audio-tts-execution-record.v1', intentUid: item.intentUid,
      dramaUid: session.dramaUid, workflowRunUid: session.workflowRunUid,
      nodeRunUid: item.nodeRunUid,
      evidence: Object.freeze({ executionSha256: String(index + 3).repeat(64) }),
    })]));
  const counters = { h3: 0, audio: 0, accounting: 0 };
  const accountingState = { value: accounting };
  const service = createMvpBenchmarkCloseoutStatusService({
    repositories,
    h3LocalExecution: Object.freeze({
      get(taskUid) { counters.h3 += 1; return h3Results.get(taskUid) ?? null; },
    }),
    audioTtsExecution: Object.freeze({
      getPersisted(intentUid) { counters.audio += 1; return audioResults.get(intentUid) ?? null; },
    }),
    accountingStatus: Object.freeze({
      read() { counters.accounting += 1; return accountingState.value; },
    }),
  });
  return Object.freeze({
    accounting, accountingState, audioResults, authorization, batch, counters, current,
    exportRun, h3Results, repositories, review, service, session,
    request: Object.freeze({
      schemaVersion: 'mvp-benchmark-closeout-status-request.v1',
      dramaUid: session.dramaUid, sessionUid: session.uid,
      authorizationUid: authorization.uid, batchSha256: batch.batchSha256,
    }),
  });
}

test('closeout status reports pending evidence without touching execution or media', (t) => {
  const current = serviceFixture(t, false);
  const status = current.service.read(current.request);
  assert.equal(status.benchmarkEvidenceComplete, false);
  assert.equal(status.mvpComplete, false);
  assert.equal(status.completedGateCount, 0);
  assert.deepEqual(status.gates.map((gate) => gate.status), [
    'pending', 'pending', 'pending', 'pending', 'pending',
  ]);
  assert.deepEqual(status.remainingMvpEvidenceIds.slice(-4), [
    'windows-release-lifecycle', 'section-19-project-evidence',
    'licenses-and-sources', 'accepted-residual-risks',
  ]);
  assert.deepEqual(current.counters, { h3: 0, audio: 0, accounting: 1 });
});

test('closeout status binds five complete gates but never claims project MVP completion', (t) => {
  const current = serviceFixture(t, true);
  const status = current.service.read(current.request);
  assert.equal(status.benchmarkEvidenceComplete, true);
  assert.equal(status.mvpComplete, false);
  assert.equal(status.completedGateCount, 5);
  assert.deepEqual(status.gates.map((gate) => gate.status), [
    'complete', 'complete', 'complete', 'complete', 'complete',
  ]);
  assert.deepEqual(status.remainingMvpEvidenceIds, [
    'windows-release-lifecycle', 'section-19-project-evidence',
    'licenses-and-sources', 'accepted-residual-risks',
  ]);
  assert.deepEqual(current.counters, { h3: 4, audio: 1, accounting: 1 });
  const validate = new Ajv2020({ strict: true }).compile(statusSchema);
  assert.equal(validate(status), true, JSON.stringify(validate.errors));
});

test('closeout record and service reject coordinated counts, identities, and hostile input', (t) => {
  const current = serviceFixture(t, false);
  const status = current.service.read(current.request);
  assert.throws(() => createMvpBenchmarkCloseoutStatus({
    ...status, benchmarkEvidenceComplete: true,
  }), { code: 'MVP_BENCHMARK_CLOSEOUT_STATUS_UNAVAILABLE' });
  assert.throws(() => current.service.read({ ...current.request, dramaUid: uid(999999) }), {
    code: 'MVP_BENCHMARK_CLOSEOUT_STATUS_UNAVAILABLE',
  });
  let reads = 0;
  const hostile = new Proxy(current.request, {
    getOwnPropertyDescriptor() { reads += 1; throw new Error('sentinel'); },
    getPrototypeOf() { reads += 1; throw new Error('sentinel'); },
    ownKeys() { reads += 1; throw new Error('sentinel'); },
  });
  assert.throws(() => current.service.read(hostile), (error) => (
    error instanceof MvpBenchmarkCloseoutStatusError
      && error.code === 'MVP_BENCHMARK_CLOSEOUT_STATUS_INPUT_INVALID'
  ));
  assert.equal(reads, 0);

  const completed = serviceFixture(t, true);
  const audioItem = completed.session.audioIntents[0];
  let evidenceReads = 0;
  completed.audioResults.set(audioItem.intentUid, Object.freeze({
    schemaVersion: 'audio-tts-execution-record.v1', intentUid: audioItem.intentUid,
    dramaUid: completed.session.dramaUid,
    workflowRunUid: completed.session.workflowRunUid,
    nodeRunUid: audioItem.nodeRunUid,
    evidence: Object.defineProperty({}, 'executionSha256', {
      enumerable: true,
      get() { evidenceReads += 1; throw new Error('sentinel'); },
    }),
  }));
  assert.throws(() => completed.service.read(completed.request), {
    code: 'MVP_BENCHMARK_CLOSEOUT_STATUS_UNAVAILABLE',
  });
  assert.equal(evidenceReads, 0);

  completed.audioResults.set(audioItem.intentUid, Object.freeze({
    schemaVersion: 'audio-tts-execution-record.v1', intentUid: audioItem.intentUid,
    dramaUid: completed.session.dramaUid,
    workflowRunUid: completed.session.workflowRunUid,
    nodeRunUid: audioItem.nodeRunUid,
    evidence: Object.freeze({ executionSha256: '3'.repeat(64) }),
  }));
  let itemReads = 0;
  completed.accountingState.value = Object.freeze({
    ...completed.accounting,
    items: new Proxy(completed.accounting.items, {
      getOwnPropertyDescriptor() { itemReads += 1; throw new Error('sentinel'); },
      getPrototypeOf() { itemReads += 1; throw new Error('sentinel'); },
      ownKeys() { itemReads += 1; throw new Error('sentinel'); },
    }),
  });
  assert.throws(() => completed.service.read(completed.request), {
    code: 'MVP_BENCHMARK_CLOSEOUT_STATUS_UNAVAILABLE',
  });
  assert.equal(itemReads, 0);
});

test('closeout status route is GET-only and fails closed without runtime wiring', async (t) => {
  const current = serviceFixture(t, false);
  const app = express();
  app.use('/api/v1/v2', mvpBenchmarkRoutes(Object.freeze({}), Object.freeze({
    mvpBenchmark: Object.freeze({ closeoutStatus: current.service }),
  }), current.current.database));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => server.close());
  const address = server.address();
  const path = `/api/v1/v2/dramas/${current.session.dramaUid}/mvp-benchmark/sessions/${current.session.uid}/authorizations/${current.authorization.uid}/batches/${current.batch.batchSha256}/closeout-status`;
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.mvpComplete, false);
  const post = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST' });
  assert.equal(post.status, 404);

  const missing = express();
  missing.use('/api/v1/v2', mvpBenchmarkRoutes(
    Object.freeze({}), Object.freeze({}), current.current.database,
  ));
  const missingServer = await new Promise((resolve) => {
    const listening = missing.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => missingServer.close());
  const missingAddress = missingServer.address();
  const unavailable = await fetch(`http://127.0.0.1:${missingAddress.port}${path}`);
  assert.equal(unavailable.status, 503);
});
