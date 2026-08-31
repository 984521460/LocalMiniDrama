'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const {
  MvpBenchmarkExternalAuthorizationError,
} = require('../src/benchmark/mvpBenchmarkExternalAuthorization');
const {
  createRemoteTaskRequest,
  createRemoteTaskRecord,
  hashRemoteTaskPrompt,
  hashRemoteTaskRequest,
  isRemoteTaskError,
} = require('../src/remote/remoteTask');
const { createRemoteTaskService } = require('../src/remote/remoteTaskService');
const { createV2Repositories } = require('../src/repositories/v2');
const remoteTaskRoutes = require('../src/routes/v2/remoteTasks');
const { createMigratedV2Database, insertDrama, uid } = require('./helpers/v2RepositoryDatabase');

const CONNECTION_UID = uid(9801);
const MANIFEST_UID = uid(9802);
const TASK_UID = uid(9803);
const IDEMPOTENCY_KEY = `remote-task:v1:${uid(9804)}`;
const CONNECTION_EVIDENCE_SHA256 = 'e'.repeat(64);
const PROMPT = Object.freeze({ 1: Object.freeze({ class_type: 'Prompt' }) });
const ACTIVE_SUBMISSION_LEASE = Date.parse('2026-08-28T08:01:00.000Z');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, reject, resolve });
}

function insertConnection(database) {
  database.prepare(`
    INSERT INTO remote_connections
      (uid, name, host, port, username, credential_ref, status)
    VALUES (?, 'Synthetic worker', 'worker.example.invalid', 22, 'fixture', ?, 'ready')
  `).run(CONNECTION_UID, `credential:v1:${uid(9805)}`);
}

function insertManifest(database) {
  database.prepare(`
    INSERT INTO workflow_manifests
      (uid, manifest_id, version, engine, workflow_file, workflow_sha256,
       model_family, requirements_json, inputs_json, outputs_json, validation_json, status)
    VALUES (?, 'remote-task-fixture', '1.0.0', 'comfyui', 'fixtures/workflow.json', ?,
            'fixture', ?, ?, ?, ?, 'validated')
  `).run(
    MANIFEST_UID,
    'a'.repeat(64),
    '[{"kind":"node","nodeType":"PromptNode"}]',
    '{"prompt":{"marker":"APP_INPUT","inputName":"text","valueType":"string","required":true}}',
    '{"video":{"marker":"APP_OUTPUT"}}',
    '{"schemaVersion":"comfy-workflow-manifest.v1","workflowFormat":"api","markersValidated":true}',
  );
}

function requestFixture(overrides = {}) {
  return {
    connectionUid: CONNECTION_UID,
    connectionEvidenceSha256: CONNECTION_EVIDENCE_SHA256,
    workflowRunUid: null,
    workflowManifestUid: MANIFEST_UID,
    idempotencyKey: IDEMPOTENCY_KEY,
    promptSha256: hashRemoteTaskPrompt(PROMPT),
    remoteRelativeDir: 'tasks/synthetic-run',
    ...overrides,
  };
}

function createDatabaseFixture(t) {
  const database = createMigratedV2Database(t);
  insertConnection(database);
  insertManifest(database);
  return database;
}

function createServiceFixture(t, overrides = {}) {
  const database = createDatabaseFixture(t);
  const repository = createV2Repositories(database).remote;
  const calls = { submit: 0, state: 0, queue: 0, dependency: 0 };
  const client = {
    async submitPrompt() {
      calls.submit += 1;
      return { promptId: 'synthetic-prompt-1' };
    },
    async getPromptState() {
      calls.state += 1;
      return { promptId: 'synthetic-prompt-1', state: 'running', outputs: [] };
    },
    async queueSnapshot() {
      calls.queue += 1;
      return { queue_running: [], queue_pending: [] };
    },
  };
  const dependencyChecker = {
    async requireReady() {
      calls.dependency += 1;
      return { ready: true, missingNodes: [], missingModels: [] };
    },
  };
  const manifestRepository = { get: () => Object.freeze({ uid: MANIFEST_UID }) };
  const service = createRemoteTaskService({
    repository,
    manifestRepository,
    client,
    dependencyChecker,
    createUid: () => TASK_UID,
    now: () => '2026-08-28T08:00:00.000Z',
    ...overrides,
  });
  return {
    calls,
    client,
    database,
    dependencyChecker,
    manifestRepository,
    repository,
    service,
  };
}

test('remote task contract is exact, secret-free, and state-versioned', () => {
  const request = createRemoteTaskRequest(requestFixture());
  assert.equal(Object.isFrozen(request), true);
  assert.equal(request.idempotencyKey, IDEMPOTENCY_KEY);
  assert.throws(() => createRemoteTaskRequest({ ...requestFixture(), apiKey: 'synthetic-secret' }));
  assert.throws(() => createRemoteTaskRequest({
    ...requestFixture(), connectionEvidenceSha256: 'E'.repeat(64),
  }));
  assert.throws(() => createRemoteTaskRequest({
    ...requestFixture(), idempotencyKey: 'plain-idempotency-value',
  }));

  const record = createRemoteTaskRecord({
    uid: TASK_UID,
    ...request,
    contractVersion: 'remote-task.v1',
    requestSha256: hashRemoteTaskRequest(request),
    provider: 'comfyui',
    promptId: null,
    stage: 'prepared',
    status: 'queued',
    heartbeatAt: null,
    retryCount: 0,
    outputAssetVersionUid: null,
    errorCode: null,
    errorDetailRef: null,
    errorPhase: null,
    errorRetryable: null,
    recoveryState: 'none',
    stateVersion: 0,
    submissionLeaseExpiresAtEpochMs: null,
    createdAt: '2026-08-28T08:00:00.000Z',
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-08-28T08:00:00.000Z',
  });
  assert.equal(record.stage, 'prepared');
  assert.equal(Object.isFrozen(record), true);

  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v6/remote-task.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(JSON.parse(JSON.stringify(record))), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...record, stateVersion: -1 }), false);
  assert.equal(validate({ ...record, connectionEvidenceSha256: 'E'.repeat(64) }), false);
});

test('formal remote task repository is idempotent and enforces optimistic terminal state', (t) => {
  const database = createDatabaseFixture(t);
  const repository = createV2Repositories(database).remote;
  const request = createRemoteTaskRequest(requestFixture());
  const requestSha256 = hashRemoteTaskRequest(request);
  const created = repository.createFormalTaskIdempotent({
    uid: TASK_UID,
    ...request,
    requestSha256,
  });
  assert.equal(created.created, true);
  assert.equal(created.task.stateVersion, 0);

  const repeated = repository.createFormalTaskIdempotent({
    uid: uid(9806),
    ...request,
    requestSha256,
  });
  assert.equal(repeated.created, false);
  assert.equal(repeated.task.uid, TASK_UID);
  assert.throws(() => repository.createFormalTaskIdempotent({
    uid: uid(9807),
    ...request,
    requestSha256: 'b'.repeat(64),
  }));

  const running = repository.transitionFormalTask({
    uid: TASK_UID,
    expectedStateVersion: 0,
    nextStage: 'uploading',
    nextStatus: 'running',
    recoveryState: 'none',
  });
  assert.equal(running.stateVersion, 1);
  assert.throws(() => repository.transitionFormalTask({
    uid: TASK_UID,
    expectedStateVersion: 0,
    nextStage: 'submitted',
    nextStatus: 'running',
    recoveryState: 'none',
  }));

  const failed = repository.transitionFormalTask({
    uid: TASK_UID,
    expectedStateVersion: 1,
    nextStage: 'failed',
    nextStatus: 'failed',
    recoveryState: 'retryable',
    errorPhase: 'upload',
    errorCode: 'ERR_REMOTE_UPLOAD_FAILED',
    errorRetryable: true,
  });
  assert.equal(failed.status, 'failed');
  assert.throws(() => repository.transitionFormalTask({
    uid: TASK_UID,
    expectedStateVersion: 2,
    nextStage: 'completed',
    nextStatus: 'succeeded',
    recoveryState: 'completed',
  }));
  assert.throws(() => database.prepare(`
    INSERT OR REPLACE INTO remote_tasks
      (uid, connection_uid, connection_evidence_sha256, workflow_run_uid, workflow_manifest_uid, contract_version,
       idempotency_key, request_sha256, prompt_sha256, provider, remote_relative_dir, stage, status)
    VALUES (?, ?, ?, NULL, ?, 'remote-task.v1', ?, ?, ?, 'comfyui', 'tasks/replaced', 'prepared', 'queued')
  `).run(
    uid(9808), CONNECTION_UID, CONNECTION_EVIDENCE_SHA256, MANIFEST_UID, IDEMPOTENCY_KEY,
    requestSha256, request.promptSha256,
  ));
  assert.throws(() => database.prepare(`
    UPDATE remote_tasks
    SET prompt_sha256=?, state_version=state_version+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE uid=?
  `).run('c'.repeat(64), TASK_UID));
  assert.throws(() => database.prepare(`
    UPDATE remote_tasks
    SET connection_evidence_sha256=?, state_version=state_version+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE uid=?
  `).run('f'.repeat(64), TASK_UID));
});

test('formal remote task graph covers every processing stage and rejects persisted drift', (t) => {
  const database = createDatabaseFixture(t);
  const repository = createV2Repositories(database).remote;
  const request = createRemoteTaskRequest(requestFixture({
    idempotencyKey: `remote-task:v1:${uid(9820)}`,
    remoteRelativeDir: 'tasks/full-graph',
  }));
  let task = repository.createFormalTaskIdempotent({
    uid: uid(9821),
    ...request,
    requestSha256: hashRemoteTaskRequest(request),
  }).task;
  for (const [stage, status] of [
    ['uploading', 'running'],
    ['submitted', 'running'],
  ]) {
    task = repository.transitionFormalTask({
      uid: task.uid,
      expectedStateVersion: task.stateVersion,
      nextStage: stage,
      nextStatus: status,
      recoveryState: 'none',
      ...(stage === 'submitted'
        ? { submissionLeaseExpiresAtEpochMs: ACTIVE_SUBMISSION_LEASE } : {}),
    });
  }
  task = repository.assignFormalPrompt({
    uid: task.uid,
    expectedStateVersion: task.stateVersion,
    promptId: 'prompt-full-graph',
  });
  for (const [stage, status] of [
    ['executing', 'running'],
    ['downloading', 'running'],
    ['verifying', 'running'],
    ['completed', 'succeeded'],
  ]) {
    task = repository.transitionFormalTask({
      uid: task.uid,
      expectedStateVersion: task.stateVersion,
      nextStage: stage,
      nextStatus: status,
      recoveryState: 'none',
    });
  }
  assert.equal(task.stage, 'completed');
  assert.equal(task.status, 'succeeded');
  assert.throws(() => database.prepare(`
    UPDATE remote_tasks SET stage='failed', status='failed', state_version=state_version+1,
      error_code='ERR_FORGED', error_phase='recovery', error_retryable=1,
      recovery_state='retryable', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE uid=?
  `).run(task.uid));

  const driftRequest = createRemoteTaskRequest(requestFixture({
    idempotencyKey: `remote-task:v1:${uid(9822)}`,
    remoteRelativeDir: 'tasks/drift',
  }));
  let drift = repository.createFormalTaskIdempotent({
    uid: uid(9823),
    ...driftRequest,
    requestSha256: hashRemoteTaskRequest(driftRequest),
  }).task;
  drift = repository.transitionFormalTask({
    uid: drift.uid,
    expectedStateVersion: drift.stateVersion,
    nextStage: 'uploading',
    nextStatus: 'running',
    recoveryState: 'none',
  });
  assert.throws(() => database.prepare(`
    UPDATE remote_tasks SET request_sha256=?, state_version=state_version+1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE uid=?
  `).run('d'.repeat(64), drift.uid));
  database.exec('DROP TRIGGER v2_remote_tasks_formal_immutable_identity');
  database.prepare(`
    UPDATE remote_tasks SET request_sha256=?, state_version=state_version+1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE uid=?
  `).run('d'.repeat(64), drift.uid);
  assert.throws(
    () => repository.getFormalTask(drift.uid),
    (error) => error.code === 'V2_REPOSITORY_DATA_INVALID',
  );
});

test('submission is dependency-gated and one idempotent winner contacts ComfyUI', async (t) => {
  const { calls, service } = createServiceFixture(t);
  const prepared = await service.prepare(requestFixture());
  assert.equal(prepared.created, true);
  await assert.rejects(
    service.submit(TASK_UID, {
      expectedStateVersion: 0,
      prompt: { 1: { class_type: 'DifferentPrompt' } },
    }),
    (error) => error.code === 'REMOTE_TASK_INPUT_INVALID',
  );
  assert.equal(calls.dependency, 0);
  assert.equal(calls.submit, 0);

  const [first, second] = await Promise.all([
    service.submit(TASK_UID, { expectedStateVersion: 0, prompt: PROMPT }),
    service.submit(TASK_UID, { expectedStateVersion: 0, prompt: PROMPT }),
  ]);
  assert.equal(calls.dependency, 1);
  assert.equal(calls.submit, 1);
  assert.equal(first.promptId ?? second.promptId, 'synthetic-prompt-1');

  const again = await service.submit(TASK_UID, {
    expectedStateVersion: Math.max(first.stateVersion, second.stateVersion),
    prompt: PROMPT,
  });
  assert.equal(again.promptId, 'synthetic-prompt-1');
  assert.equal(calls.submit, 1);
});

test('task preparation accepts a caller-bound canonical task identity for an isolated job directory', async (t) => {
  const { database, service } = createServiceFixture(t);
  const requestedUid = uid(9838);
  const request = requestFixture({
    taskUid: requestedUid,
    remoteRelativeDir: `jobs/${requestedUid}`,
  });
  const created = await service.prepare(request);
  assert.equal(created.created, true);
  assert.equal(created.task.uid, requestedUid);
  assert.equal(created.task.remoteRelativeDir, `jobs/${requestedUid}`);
  const repeated = await service.prepare(request);
  assert.equal(repeated.created, false);
  assert.equal(repeated.task.uid, requestedUid);
  await assert.rejects(
    service.prepare({ ...request, taskUid: 'not-a-uuid' }),
    (error) => error.code === 'REMOTE_TASK_INPUT_INVALID',
  );
  assert.equal(database.prepare('SELECT count(*) FROM remote_tasks').pluck().get(), 1);
});

test('production remote task operations retain the owning connection boundary', async (t) => {
  const database = createDatabaseFixture(t);
  const repositories = createV2Repositories(database);
  const calls = [];
  const remoteClient = Object.freeze({
    async requireReady(connectionUid, connectionEvidenceSha256, manifest) {
      calls.push(['dependency', connectionUid, connectionEvidenceSha256, manifest.uid]);
      return { ready: true, missingNodes: [], missingModels: [] };
    },
    async submitPrompt(connectionUid, connectionEvidenceSha256, prompt) {
      calls.push(['submit', connectionUid, connectionEvidenceSha256, hashRemoteTaskPrompt(prompt)]);
      return { promptId: 'connection-bound-prompt' };
    },
    async getPromptState(connectionUid, connectionEvidenceSha256, promptId) {
      calls.push(['state', connectionUid, connectionEvidenceSha256, promptId]);
      return { promptId, state: 'running', outputs: [] };
    },
    async queueSnapshot(connectionUid, connectionEvidenceSha256) {
      calls.push(['queue', connectionUid, connectionEvidenceSha256]);
      return { queue_running: [], queue_pending: [] };
    },
  });
  const service = createRemoteTaskService({
    repository: repositories.remote,
    manifestRepository: repositories.comfyManifests,
    remoteClient,
    createUid: () => uid(9898),
    now: () => '2026-08-28T08:00:00.000Z',
  });
  const prepared = await service.prepare(requestFixture({
    idempotencyKey: `remote-task:v1:${uid(9899)}`,
    remoteRelativeDir: 'tasks/connection-bound',
  }));
  const submitted = await service.submit(prepared.task.uid, {
    expectedStateVersion: 0,
    prompt: PROMPT,
  });

  assert.equal(submitted.promptId, 'connection-bound-prompt');
  assert.deepEqual(calls, [
    ['dependency', CONNECTION_UID, CONNECTION_EVIDENCE_SHA256, MANIFEST_UID],
    ['submit', CONNECTION_UID, CONNECTION_EVIDENCE_SHA256, hashRemoteTaskPrompt(PROMPT)],
  ]);
});

test('task service owns upload, execution, download, verification, and output backfill transitions', async (t) => {
  const fixture = createServiceFixture(t);
  let task = (await fixture.service.prepare(requestFixture())).task;
  task = fixture.service.beginUpload(task.uid, { expectedStateVersion: task.stateVersion });
  assert.equal(task.stage, 'uploading');
  task = await fixture.service.submit(task.uid, {
    expectedStateVersion: task.stateVersion,
    prompt: PROMPT,
  });
  assert.equal(task.stage, 'submitted');
  assert.equal(task.promptId, 'synthetic-prompt-1');
  task = fixture.service.markExecuting(task.uid, { expectedStateVersion: task.stateVersion });
  task = fixture.service.markDownloading(task.uid, { expectedStateVersion: task.stateVersion });
  task = fixture.service.markVerifying(task.uid, { expectedStateVersion: task.stateVersion });

  const dramaUid = uid(9850);
  const assetUid = uid(9851);
  const versionUid = uid(9852);
  insertDrama(fixture.database, dramaUid);
  const assets = createV2Repositories(fixture.database).assets;
  assets.create({
    uid: assetUid,
    ownerType: 'drama',
    ownerUid: dramaUid,
    assetType: 'video',
    status: 'draft',
  });
  assets.addVersion({
    uid: versionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${dramaUid}/videos/${versionUid}`,
    relativePath: `projects/${dramaUid}/assets/${versionUid}.mp4`,
    sha256: 'e'.repeat(64),
    mimeType: 'video/mp4',
    width: 1280,
    height: 720,
    durationMs: 1000,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  task = fixture.service.complete(task.uid, {
    expectedStateVersion: task.stateVersion,
    outputAssetVersionUid: versionUid,
  });
  assert.equal(task.stage, 'completed');
  assert.equal(task.outputAssetVersionUid, versionUid);
  assert.throws(
    () => fixture.service.markDownloading(task.uid, { expectedStateVersion: task.stateVersion }),
    (error) => error.code === 'REMOTE_TASK_CONFLICT',
  );
});

test('task service records fixed phase failures without accepting raw detail', async (t) => {
  const fixture = createServiceFixture(t, { createUid: () => uid(9853) });
  let task = (await fixture.service.prepare(requestFixture({
    idempotencyKey: `remote-task:v1:${uid(9854)}`,
    remoteRelativeDir: 'tasks/failing-upload',
  }))).task;
  task = fixture.service.beginUpload(task.uid, { expectedStateVersion: task.stateVersion });
  const failed = fixture.service.fail(task.uid, {
    expectedStateVersion: task.stateVersion,
    phase: 'upload',
    errorCode: 'ERR_REMOTE_UPLOAD_FAILED',
    retryable: true,
  });
  assert.equal(failed.stage, 'failed');
  assert.equal(failed.errorPhase, 'upload');
  assert.equal(failed.errorRetryable, true);
  assert.throws(() => fixture.service.fail(task.uid, {
    expectedStateVersion: task.stateVersion,
    phase: 'upload',
    errorCode: 'ERR_REMOTE_UPLOAD_FAILED',
    retryable: true,
    detail: 'synthetic-secret-must-not-persist',
  }));
  assert.equal(JSON.stringify(fixture.repository.getFormalTask(task.uid)).includes('synthetic-secret'), false);
});

test('dependency and indeterminate submission failures are fixed and never retried blindly', async (t) => {
  let submitCalls = 0;
  const dependencyFixture = createServiceFixture(t, {
    createUid: () => uid(9824),
    dependencyChecker: {
      async requireReady() { throw new Error('synthetic-dependency-secret'); },
    },
    client: {
      async submitPrompt() { submitCalls += 1; return { promptId: 'must-not-submit' }; },
      async getPromptState() { return { promptId: 'unused', state: 'missing', outputs: [] }; },
      async queueSnapshot() { return { queue_running: [], queue_pending: [] }; },
    },
  });
  await dependencyFixture.service.prepare(requestFixture({
    idempotencyKey: `remote-task:v1:${uid(9825)}`,
    remoteRelativeDir: 'tasks/dependency-failure',
  }));
  await assert.rejects(
    dependencyFixture.service.submit(uid(9824), { expectedStateVersion: 0, prompt: PROMPT }),
    (error) => error.code === 'REMOTE_TASK_DEPENDENCY_NOT_READY'
      && !JSON.stringify(error).includes('synthetic-dependency-secret'),
  );
  assert.equal(submitCalls, 0);
  assert.equal(dependencyFixture.repository.getFormalTask(uid(9824)).recoveryState, 'retryable');

  const submissionFixture = createServiceFixture(t, {
    createUid: () => uid(9826),
    client: {
      async submitPrompt() { throw new Error('synthetic-upstream-secret'); },
      async getPromptState() { return { promptId: 'unused', state: 'missing', outputs: [] }; },
      async queueSnapshot() { return { queue_running: [], queue_pending: [] }; },
    },
  });
  await submissionFixture.service.prepare(requestFixture({
    idempotencyKey: `remote-task:v1:${uid(9827)}`,
    remoteRelativeDir: 'tasks/submission-failure',
  }));
  await assert.rejects(
    submissionFixture.service.submit(uid(9826), { expectedStateVersion: 0, prompt: PROMPT }),
    (error) => error.code === 'REMOTE_TASK_SUBMISSION_FAILED'
      && !JSON.stringify(error).includes('synthetic-upstream-secret'),
  );
  const indeterminate = submissionFixture.repository.getFormalTask(uid(9826));
  assert.equal(indeterminate.recoveryState, 'orphaned');
  assert.equal(indeterminate.errorRetryable, false);
});

test('active submission leases prevent recovery from orphaning in-flight remote work', async (t) => {
  const dependencyEntered = deferred();
  const dependencyGate = deferred();
  let submitCalls = 0;
  const dependencyFixture = createServiceFixture(t, {
    createUid: () => uid(9830),
    dependencyChecker: {
      async requireReady() {
        dependencyEntered.resolve();
        await dependencyGate.promise;
        return { ready: true, missingNodes: [], missingModels: [] };
      },
    },
    client: {
      async submitPrompt() {
        submitCalls += 1;
        return { promptId: 'lease-dependency-prompt' };
      },
      async getPromptState(promptId) { return { promptId, state: 'missing', outputs: [] }; },
      async queueSnapshot() { return { queue_running: [], queue_pending: [] }; },
    },
  });
  await dependencyFixture.service.prepare(requestFixture({
    idempotencyKey: `remote-task:v1:${uid(9831)}`,
    remoteRelativeDir: 'tasks/dependency-lease',
  }));
  const pendingDependencySubmit = dependencyFixture.service.submit(uid(9830), {
    expectedStateVersion: 0,
    prompt: PROMPT,
  });
  await dependencyEntered.promise;
  const localRecovery = await dependencyFixture.service.recover(uid(9830));
  assert.equal(localRecovery.stage, 'submitted');
  assert.equal(localRecovery.promptId, null);
  assert.equal(submitCalls, 0);

  const secondDependencyService = createRemoteTaskService({
    repository: dependencyFixture.repository,
    manifestRepository: dependencyFixture.manifestRepository,
    client: dependencyFixture.client,
    dependencyChecker: dependencyFixture.dependencyChecker,
    createUid: () => uid(9832),
    now: () => '2026-08-28T08:00:00.000Z',
  });
  const crossProcessRecovery = await secondDependencyService.recover(uid(9830));
  assert.equal(crossProcessRecovery.stage, 'submitted');
  assert.equal(crossProcessRecovery.recoveryState, 'none');
  assert.equal(submitCalls, 0);

  dependencyGate.resolve();
  const dependencyCompleted = await pendingDependencySubmit;
  assert.equal(dependencyCompleted.promptId, 'lease-dependency-prompt');
  assert.equal(submitCalls, 1);

  const submitEntered = deferred();
  const submitGate = deferred();
  const submissionFixture = createServiceFixture(t, {
    createUid: () => uid(9833),
    client: {
      async submitPrompt() {
        submitEntered.resolve();
        await submitGate.promise;
        return { promptId: 'lease-submit-prompt' };
      },
      async getPromptState(promptId) { return { promptId, state: 'missing', outputs: [] }; },
      async queueSnapshot() { return { queue_running: [], queue_pending: [] }; },
    },
  });
  await submissionFixture.service.prepare(requestFixture({
    idempotencyKey: `remote-task:v1:${uid(9834)}`,
    remoteRelativeDir: 'tasks/submission-lease',
  }));
  const pendingRemoteSubmit = submissionFixture.service.submit(uid(9833), {
    expectedStateVersion: 0,
    prompt: PROMPT,
  });
  await submitEntered.promise;
  const submittingRecovery = await submissionFixture.service.recover(uid(9833));
  assert.equal(submittingRecovery.stage, 'submitted');
  assert.equal(submittingRecovery.promptId, null);
  const secondSubmissionService = createRemoteTaskService({
    repository: submissionFixture.repository,
    manifestRepository: submissionFixture.manifestRepository,
    client: submissionFixture.client,
    dependencyChecker: submissionFixture.dependencyChecker,
    createUid: () => uid(9835),
    now: () => '2026-08-28T08:00:00.000Z',
  });
  const crossProcessSubmittingRecovery = await secondSubmissionService.recover(uid(9833));
  assert.equal(crossProcessSubmittingRecovery.stage, 'submitted');
  assert.throws(
    () => submissionFixture.service.heartbeat(uid(9833), {
      expectedStateVersion: crossProcessSubmittingRecovery.stateVersion,
    }),
    (error) => error.code === 'REMOTE_TASK_CONFLICT',
  );
  submitGate.resolve();
  const submissionCompleted = await pendingRemoteSubmit;
  assert.equal(submissionCompleted.promptId, 'lease-submit-prompt');
  assert.equal(submissionCompleted.submissionLeaseExpiresAtEpochMs, null);
});

test('startup recovery classifies history, queue, retryable, and orphaned without raw errors', async (t) => {
  const states = new Map();
  const queues = new Map();
  const { service, repository } = createServiceFixture(t, {
    client: {
      async submitPrompt() { return { promptId: 'unused' }; },
      async getPromptState(promptId) {
        return states.get(promptId) || { promptId, state: 'missing', outputs: [] };
      },
      async queueSnapshot() {
        return { queue_running: [...queues.values()], queue_pending: [] };
      },
    },
  });
  await service.prepare(requestFixture());
  let task = repository.transitionFormalTask({
    uid: TASK_UID, expectedStateVersion: 0, nextStage: 'submitted', nextStatus: 'running', recoveryState: 'none',
    submissionLeaseExpiresAtEpochMs: ACTIVE_SUBMISSION_LEASE,
  });
  task = repository.assignFormalPrompt({
    uid: TASK_UID, expectedStateVersion: task.stateVersion, promptId: 'prompt-done',
  });
  states.set('prompt-done', { promptId: 'prompt-done', state: 'succeeded', outputs: [] });
  const completed = await service.recover(TASK_UID);
  assert.equal(completed.recoveryState, 'completed');
  assert.equal(completed.stage, 'downloading');

  const orphanedFixture = createServiceFixture(t, { createUid: () => uid(9810) });
  await orphanedFixture.service.prepare(requestFixture({
    idempotencyKey: `remote-task:v1:${uid(9811)}`,
    remoteRelativeDir: 'tasks/orphaned',
  }));
  const orphaned = await orphanedFixture.service.recover(uid(9810));
  assert.equal(orphaned.recoveryState, 'retryable');
  assert.equal(orphaned.errorCode, 'ERR_REMOTE_RECOVERY_RETRYABLE');
  assert.equal(JSON.stringify(orphaned).includes('synthetic-secret'), false);

  const expiredLeaseFixture = createServiceFixture(t, { createUid: () => uid(9836) });
  await expiredLeaseFixture.service.prepare(requestFixture({
    idempotencyKey: `remote-task:v1:${uid(9837)}`,
    remoteRelativeDir: 'tasks/expired-submission-lease',
  }));
  expiredLeaseFixture.repository.transitionFormalTask({
    uid: uid(9836),
    expectedStateVersion: 0,
    nextStage: 'submitted',
    nextStatus: 'running',
    recoveryState: 'none',
    submissionLeaseExpiresAtEpochMs: Date.parse('2026-08-28T07:59:59.999Z'),
  });
  const expiredLease = await expiredLeaseFixture.service.recover(uid(9836));
  assert.equal(expiredLease.recoveryState, 'orphaned');
  assert.equal(expiredLease.errorCode, 'ERR_REMOTE_RECOVERY_ORPHANED');

  const queuedFixture = createServiceFixture(t, {
    createUid: () => uid(9812),
    client: {
      async submitPrompt() { return { promptId: 'unused' }; },
      async getPromptState(promptId) {
        return { promptId, state: 'missing', outputs: [] };
      },
      async queueSnapshot() {
        return { queue_running: [[1, 'prompt-queued', {}, {}, []]], queue_pending: [] };
      },
    },
  });
  await queuedFixture.service.prepare(requestFixture({
    idempotencyKey: `remote-task:v1:${uid(9813)}`,
    remoteRelativeDir: 'tasks/queued',
  }));
  let queuedTask = queuedFixture.repository.transitionFormalTask({
    uid: uid(9812), expectedStateVersion: 0, nextStage: 'submitted', nextStatus: 'running', recoveryState: 'none',
    submissionLeaseExpiresAtEpochMs: ACTIVE_SUBMISSION_LEASE,
  });
  queuedTask = queuedFixture.repository.assignFormalPrompt({
    uid: uid(9812), expectedStateVersion: queuedTask.stateVersion, promptId: 'prompt-queued',
  });
  const stillQueued = await queuedFixture.service.recover(uid(9812));
  assert.equal(stillQueued.stage, 'submitted');
  assert.equal(stillQueued.stateVersion, queuedTask.stateVersion);
});

test('remote task errors are trusted fixed envelopes', () => {
  let captured;
  try { createRemoteTaskRequest({ ...requestFixture(), remoteRelativeDir: '../escape' }); } catch (error) {
    captured = error;
  }
  assert.equal(isRemoteTaskError(captured), true);
  assert.equal(JSON.stringify(captured).includes('../escape'), false);
});

test('remote recovery paginates a bounded snapshot and returns only aggregate counts', async () => {
  const createdAt = '2026-08-28T08:00:00.000Z';
  const tasks = Array.from({ length: 101 }, (_, index) => Object.freeze({
    uid: uid(9900 + index),
    createdAt,
    stage: 'prepared',
    status: 'queued',
    stateVersion: 0,
    promptId: null,
    submissionLeaseExpiresAtEpochMs: null,
  }));
  const tasksByUid = new Map(tasks.map((task) => [task.uid, task]));
  const pages = [];
  const repository = {
    createFormalTaskIdempotent() { throw new Error('not used'); },
    getFormalTask(taskUid) { return tasksByUid.get(taskUid); },
    transitionFormalTask(request) {
      const current = tasksByUid.get(request.uid);
      const next = Object.freeze({
        ...current,
        stage: request.nextStage,
        status: request.nextStatus,
        stateVersion: current.stateVersion + 1,
      });
      tasksByUid.set(request.uid, next);
      return next;
    },
    assignFormalPrompt() { throw new Error('not used'); },
    heartbeatFormalTask() { throw new Error('not used'); },
    renewFormalSubmissionLease() { throw new Error('not used'); },
    retryFormalTask() { throw new Error('not used'); },
    listRecoverableFormalTasks(cursor) {
      pages.push(cursor);
      const start = cursor.afterUid === null
        ? 0 : tasks.findIndex((task) => task.uid === cursor.afterUid) + 1;
      return Object.freeze(tasks.slice(start, start + cursor.limit));
    },
  };
  const service = createRemoteTaskService({
    repository,
    manifestRepository: { get() { return Object.freeze({ uid: MANIFEST_UID }); } },
    executionGate: Object.freeze({
      assertH3TaskExecutionOpen(taskUid) {
        if (taskUid === tasks[0].uid) {
          throw new MvpBenchmarkExternalAuthorizationError(
            'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE',
          );
        }
        return true;
      },
    }),
    client: {
      async submitPrompt() { throw new Error('not used'); },
      async getPromptState() { throw new Error('not used'); },
      async queueSnapshot() { throw new Error('not used'); },
    },
    dependencyChecker: { async requireReady() { throw new Error('not used'); } },
  });

  assert.deepEqual(await service.recoverAll(), { recoveredCount: 100, failedCount: 1 });
  assert.deepEqual(pages.map((page) => page.limit), [100, 100]);
  assert.equal(pages[0].afterUid, null);
  assert.equal(pages[1].afterUid, tasks[99].uid);
});

test('remote recovery never reads an inherited Array iterator', () => {
  const script = String.raw`
    'use strict';
    const { createRemoteTaskService } = require('./src/remote/remoteTaskService');
    const task = Object.freeze({
      uid: '00000000-0000-4000-8000-000000009999',
      createdAt: '2026-08-28T08:00:00.000Z',
      stage: 'prepared', status: 'queued', stateVersion: 0,
      promptId: null, submissionLeaseExpiresAtEpochMs: null,
    });
    function serviceFor(page) {
      const repository = {
        createFormalTaskIdempotent() { throw new Error('not used'); },
        getFormalTask() { return task; },
        transitionFormalTask(request) {
          return Object.freeze({
            ...task, stage: request.nextStage, status: request.nextStatus, stateVersion: 1,
          });
        },
        assignFormalPrompt() { throw new Error('not used'); },
        heartbeatFormalTask() { throw new Error('not used'); },
        renewFormalSubmissionLease() { throw new Error('not used'); },
        retryFormalTask() { throw new Error('not used'); },
        listRecoverableFormalTasks() { return page; },
      };
      return createRemoteTaskService({
        repository,
        manifestRepository: { get() { return Object.freeze({ uid: task.uid }); } },
        client: {
          async submitPrompt() { throw new Error('not used'); },
          async getPromptState() { throw new Error('not used'); },
          async queueSnapshot() { throw new Error('not used'); },
        },
        dependencyChecker: { async requireReady() { throw new Error('not used'); } },
      });
    }
    async function probe(page) {
      const service = serviceFor(page);
      const original = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
      let reads = 0;
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        get() { reads += 1; return original.value; },
      });
      try {
        const result = await service.recoverAll();
        return { reads, result };
      }
      finally { Object.defineProperty(Array.prototype, Symbol.iterator, original); }
    }
    (async () => {
      const empty = await probe(Object.freeze([]));
      const nonempty = await probe(Object.freeze([task]));
      process.stdout.write(JSON.stringify({ empty, nonempty }));
    })().catch((error) => {
      process.stderr.write(error?.stack || String(error));
      process.exitCode = 1;
    });
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    empty: { reads: 0, result: { recoveredCount: 0, failedCount: 0 } },
    nonempty: { reads: 0, result: { recoveredCount: 1, failedCount: 0 } },
  });
});

test('localhost remote task routes preserve fixed public error envelopes', async (t) => {
  const { service } = createServiceFixture(t);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v2', remoteTaskRoutes({ error() {} }, { remoteTasks: service }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/v2`;

  const createdResponse = await fetch(`${baseUrl}/remote-tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestFixture()),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.data.task.uid, TASK_UID);

  const detailResponse = await fetch(`${baseUrl}/remote-tasks/${TASK_UID}`);
  assert.equal(detailResponse.status, 200);
  assert.equal((await detailResponse.json()).data.stateVersion, 0);

  const sentinel = 'synthetic-secret-must-not-leak';
  const rejectedResponse = await fetch(`${baseUrl}/remote-tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...requestFixture(), remoteRelativeDir: `../${sentinel}` }),
  });
  assert.equal(rejectedResponse.status, 400);
  const rejectedText = await rejectedResponse.text();
  assert.equal(rejectedText.includes(sentinel), false);
  assert.equal(JSON.parse(rejectedText).error.code, 'REMOTE_TASK_INPUT_INVALID');
});
