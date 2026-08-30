'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const { createRemoteTaskService } = require('../src/remote/remoteTaskService');
const { runWithRemoteTaskHeartbeat } = require('../src/remote/remoteHeartbeatLease');
const { createRemoteTaskRetryClassification } = require('../src/remote/remoteRetryPolicy');
const { hashRemoteTaskPrompt } = require('../src/remote/remoteTask');
const { createV2Repositories } = require('../src/repositories/v2');
const { createMigratedV2Database, uid } = require('./helpers/v2RepositoryDatabase');

const CONNECTION_UID = uid(9901);
const MANIFEST_UID = uid(9902);
const TASK_UID = uid(9903);
const NODE_RUN_UID = uid(9904);
const PROMPT = Object.freeze({ 1: Object.freeze({ class_type: 'Prompt' }) });

function createFixture(t) {
  const database = createMigratedV2Database(t);
  database.prepare(`
    INSERT INTO remote_connections
      (uid, name, host, port, username, credential_ref, status)
    VALUES (?, 'Reliability worker', 'worker.example.invalid', 22, 'fixture', ?, 'ready')
  `).run(CONNECTION_UID, `credential:v1:${uid(9905)}`);
  database.prepare(`
    INSERT INTO workflow_manifests
      (uid, manifest_id, version, engine, workflow_file, workflow_sha256,
       model_family, requirements_json, inputs_json, outputs_json, validation_json, status)
    VALUES (?, 'reliability-fixture', '1.0.0', 'comfyui', 'fixtures/workflow.json', ?,
            'fixture', ?, ?, ?, ?, 'validated')
  `).run(
    MANIFEST_UID,
    'a'.repeat(64),
    '[{"kind":"node","nodeType":"PromptNode"}]',
    '{"prompt":{"marker":"APP_INPUT","inputName":"text","valueType":"string","required":true}}',
    '{"video":{"marker":"APP_OUTPUT"}}',
    '{"schemaVersion":"comfy-workflow-manifest.v1","workflowFormat":"api","markersValidated":true}',
  );
  const repositories = createV2Repositories(database);
  const service = createRemoteTaskService({
    repository: repositories.remote,
    manifestRepository: { get: () => Object.freeze({ uid: MANIFEST_UID }) },
    client: {
      async submitPrompt() { return { promptId: 'reliability-prompt' }; },
      async getPromptState() {
        return { promptId: 'reliability-prompt', state: 'running', outputs: [] };
      },
      async queueSnapshot() { return { queue_running: [], queue_pending: [] }; },
    },
    dependencyChecker: { async requireReady() { return { ready: true }; } },
    createUid: () => TASK_UID,
    now: () => new Date().toISOString(),
  });
  return { database, repositories, service };
}

function request() {
  return {
    connectionUid: CONNECTION_UID,
    connectionEvidenceSha256: 'e'.repeat(64),
    workflowRunUid: null,
    workflowManifestUid: MANIFEST_UID,
    idempotencyKey: `remote-task:v1:${NODE_RUN_UID}`,
    promptSha256: hashRemoteTaskPrompt(PROMPT),
    remoteRelativeDir: `jobs/${TASK_UID}`,
    maxRetries: 2,
  };
}

test('P9-02 persists an exact retry budget and exposes a fixed secret-free classification', async (t) => {
  const fixture = createFixture(t);
  const prepared = (await fixture.service.prepare(request())).task;
  assert.equal(prepared.maxRetries, 2);

  const failed = fixture.service.fail(prepared.uid, {
    expectedStateVersion: prepared.stateVersion,
    phase: 'dependency',
    errorCode: 'ERR_REMOTE_DEPENDENCY_FAILED',
    retryable: true,
  });
  const classification = createRemoteTaskRetryClassification(failed);
  assert.deepEqual(classification, {
    taskUid: TASK_UID,
    stateVersion: failed.stateVersion,
    disposition: 'safe_replay',
    allowed: true,
    retryCount: 0,
    maxRetries: 2,
    reasonCode: 'REMOTE_RETRY_SAFE_BEFORE_SUBMISSION',
  });
  assert.equal(JSON.stringify(classification).includes('worker.example.invalid'), false);
});

test('P9-02 heartbeat is liveness metadata and does not advance business stateVersion', async (t) => {
  const fixture = createFixture(t);
  const prepared = (await fixture.service.prepare(request())).task;
  const uploading = fixture.service.beginUpload(prepared.uid, {
    expectedStateVersion: prepared.stateVersion,
  });
  const heartbeat = fixture.service.heartbeat(uploading.uid, {
    expectedStateVersion: uploading.stateVersion,
  });
  assert.equal(heartbeat.stateVersion, uploading.stateVersion);
  assert.equal(new Date(heartbeat.heartbeatAt).toISOString(), heartbeat.heartbeatAt);
  assert.throws(
    () => fixture.database.prepare(`
      UPDATE remote_tasks
      SET heartbeat_at = '2000-01-01T00:00:00.000Z',
          updated_at = '2000-01-01T00:00:00.000Z'
      WHERE uid = ?
    `).run(uploading.uid),
  );
  assert.equal(fixture.service.get(uploading.uid).heartbeatAt, heartbeat.heartbeatAt);
});

test('P9-02 automatically heartbeats a long phase and stops the lease afterward', async (t) => {
  const fixture = createFixture(t);
  const prepared = (await fixture.service.prepare(request())).task;
  const uploading = fixture.service.beginUpload(prepared.uid, {
    expectedStateVersion: prepared.stateVersion,
  });
  let calls = 0;
  let release;
  const operation = new Promise((resolve) => { release = resolve; });
  const service = Object.freeze({
    heartbeat(uidValue, value) {
      calls += 1;
      const result = fixture.service.heartbeat(uidValue, value);
      if (calls === 2) release('done');
      return result;
    },
  });
  const watchdog = setTimeout(() => release('heartbeat-timeout'), 2000);
  t.after(() => clearTimeout(watchdog));
  const phase = await runWithRemoteTaskHeartbeat({
    service,
    task: uploading,
    intervalMs: 5,
  }, () => operation);
  clearTimeout(watchdog);
  assert.equal(phase.result, 'done');
  assert.equal(phase.task.stateVersion, uploading.stateVersion);
  assert.equal(calls, 2);
  const stoppedAt = calls;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, stoppedAt);
});

test('P9-02 heartbeat fails closed when a semantic transition wins the race', async (t) => {
  const fixture = createFixture(t);
  const prepared = (await fixture.service.prepare(request())).task;
  const uploading = fixture.service.beginUpload(prepared.uid, {
    expectedStateVersion: prepared.stateVersion,
  });
  let release;
  const operation = new Promise((resolve) => { release = resolve; });
  const phase = runWithRemoteTaskHeartbeat({
    service: fixture.service,
    task: uploading,
    intervalMs: 5,
  }, () => operation);
  await new Promise((resolve) => setTimeout(resolve, 8));
  const failed = fixture.service.fail(uploading.uid, {
    expectedStateVersion: uploading.stateVersion,
    phase: 'upload',
    errorCode: 'ERR_REMOTE_UPLOAD_FAILED',
    retryable: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 8));
  release('late-result');
  await assert.rejects(phase, (error) => error?.code === 'REMOTE_TASK_CONFLICT');
  assert.equal(fixture.service.get(uploading.uid).stateVersion, failed.stateVersion);
});

test('P9-02 retries only a confirmed pre-submission failure and enforces the persisted limit', async (t) => {
  const fixture = createFixture(t);
  let task = (await fixture.service.prepare(request())).task;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    task = fixture.service.fail(task.uid, {
      expectedStateVersion: task.stateVersion,
      phase: 'upload',
      errorCode: 'ERR_REMOTE_UPLOAD_FAILED',
      retryable: true,
    });
    task = fixture.repositories.remote.retryFormalTask({
      uid: task.uid,
      expectedStateVersion: task.stateVersion,
    });
    assert.equal(task.stage, 'prepared');
    assert.equal(task.retryCount, attempt);
    assert.equal(task.recoveryState, 'none');
  }
  task = fixture.service.fail(task.uid, {
    expectedStateVersion: task.stateVersion,
    phase: 'dependency',
    errorCode: 'ERR_REMOTE_DEPENDENCY_FAILED',
    retryable: true,
  });
  assert.equal(createRemoteTaskRetryClassification(task).disposition, 'exhausted');
  assert.throws(() => fixture.repositories.remote.retryFormalTask({
    uid: task.uid,
    expectedStateVersion: task.stateVersion,
  }));
});

test('P9-02 never replays an uncertain or post-submission failure', async (t) => {
  const fixture = createFixture(t);
  let task = (await fixture.service.prepare(request())).task;
  task = await fixture.service.submit(task.uid, {
    expectedStateVersion: task.stateVersion,
    prompt: PROMPT,
  });
  task = fixture.service.markExecuting(task.uid, {
    expectedStateVersion: task.stateVersion,
  });
  task = fixture.service.fail(task.uid, {
    expectedStateVersion: task.stateVersion,
    phase: 'execution',
    errorCode: 'ERR_REMOTE_EXECUTION_FAILED',
    retryable: true,
  });
  assert.equal(task.promptId, 'reliability-prompt');
  assert.equal(createRemoteTaskRetryClassification(task).disposition, 'manual_reconcile');
  assert.throws(() => fixture.repositories.remote.retryFormalTask({
    uid: task.uid,
    expectedStateVersion: task.stateVersion,
  }));
});

test('P9-02 permits only one submit across independent service instances', async (t) => {
  const fixture = createFixture(t);
  let task = (await fixture.service.prepare(request())).task;
  task = fixture.service.beginUpload(task.uid, { expectedStateVersion: task.stateVersion });
  let submitCalls = 0;
  const client = Object.freeze({
    async submitPrompt() {
      submitCalls += 1;
      return { promptId: 'cross-process-prompt' };
    },
    async getPromptState() {
      return { promptId: 'cross-process-prompt', state: 'running', outputs: [] };
    },
    async queueSnapshot() { return { queue_running: [], queue_pending: [] }; },
  });
  const service = () => createRemoteTaskService({
    repository: fixture.repositories.remote,
    manifestRepository: { get: () => Object.freeze({ uid: MANIFEST_UID }) },
    client,
    dependencyChecker: { async requireReady() { return { ready: true }; } },
    now: () => '2026-08-30T05:30:00.000Z',
  });
  const first = service();
  const second = service();
  const results = await Promise.all([
    first.submit(task.uid, { expectedStateVersion: task.stateVersion, prompt: PROMPT }),
    second.submit(task.uid, { expectedStateVersion: task.stateVersion, prompt: PROMPT }),
  ]);
  assert.equal(submitCalls, 1);
  assert.equal(fixture.repositories.remote.getFormalTask(task.uid).promptId, 'cross-process-prompt');
  assert.ok(results.some((result) => result.promptId === 'cross-process-prompt'));
});

test('P9-02 retry classification Schema matches the runtime projection exactly', async (t) => {
  const fixture = createFixture(t);
  const prepared = (await fixture.service.prepare(request())).task;
  const failed = fixture.service.fail(prepared.uid, {
    expectedStateVersion: prepared.stateVersion,
    phase: 'recovery',
    errorCode: 'ERR_REMOTE_RECOVERY_RETRYABLE',
    retryable: true,
  });
  const classification = createRemoteTaskRetryClassification(failed);
  const schema = JSON.parse(fs.readFileSync(path.resolve(
    __dirname,
    '../../schemas/v6/remote-task-retry-classification.schema.json',
  ), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(classification), true, JSON.stringify(validate.errors));
  for (const invalid of [
    { ...classification, allowed: false },
    { ...classification, reasonCode: 'REMOTE_RETRY_TASK_TERMINAL' },
    { ...classification, retryCount: 11 },
    { ...classification, unexpected: true },
  ]) assert.equal(validate(invalid), false);

  for (let maxRetries = 0; maxRetries <= 10; maxRetries += 1) {
    const exhausted = {
      ...classification,
      disposition: 'exhausted',
      allowed: false,
      reasonCode: 'REMOTE_RETRY_LIMIT_EXHAUSTED',
      retryCount: maxRetries,
      maxRetries,
    };
    assert.equal(validate(exhausted), true, JSON.stringify(validate.errors));
    if (maxRetries === 0) {
      assert.equal(validate({
        ...classification,
        retryCount: 0,
        maxRetries: 0,
      }), false);
      continue;
    }
    assert.equal(validate({
      ...classification,
      retryCount: maxRetries - 1,
      maxRetries,
    }), true, JSON.stringify(validate.errors));
    assert.equal(validate({
      ...classification,
      retryCount: maxRetries,
      maxRetries,
    }), false);
    assert.equal(validate({ ...exhausted, retryCount: maxRetries - 1 }), false);
  }
});
