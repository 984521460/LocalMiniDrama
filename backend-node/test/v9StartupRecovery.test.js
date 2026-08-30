'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { createH3ApiSubmissionStore } = require('../src/h3/apiSubmissionStore');
const { createStartupRecoveryCoordinator } = require('../src/recovery/startupRecovery');
const { createMigratedV2Database, uid } = require('./helpers/v2RepositoryDatabase');

function coordinatorForBoundary({
  localResult = { recoveredCount: 0 },
  remoteResult = { recoveredCount: 0, failedCount: 0 },
} = {}) {
  return createStartupRecoveryCoordinator({
    legacyAsyncTasks: { recover() { return localResult; } },
    legacyVideoGenerations: { recover() { return { recoveredCount: 0 }; } },
    workflowRuns: { recoverInterruptedRuns() { return { recoveredCount: 0 }; } },
    mediaExports: { recoverInterrupted() { return { recoveredCount: 0 }; } },
    h3ApiSubmissions: { recoverInterrupted() { return { recoveredCount: 0 }; } },
    remoteTasks: { async recoverAll() { return remoteResult; } },
    log: { info() {}, warn() {} },
  });
}

test('P9-01 coordinator isolates families and returns only bounded aggregate evidence', async () => {
  const calls = [];
  const coordinator = createStartupRecoveryCoordinator({
    legacyAsyncTasks: { recover() { calls.push('legacy-async'); return { recoveredCount: 2 }; } },
    legacyVideoGenerations: { recover() { calls.push('legacy-video'); return { recoveredCount: 1 }; } },
    workflowRuns: { recoverInterruptedRuns() { calls.push('workflow'); return { recoveredCount: 3 }; } },
    mediaExports: { recoverInterrupted() { calls.push('media'); throw new Error('secret-path-C:/private'); } },
    h3ApiSubmissions: { recoverInterrupted() { calls.push('h3'); return { recoveredCount: 4 }; } },
    remoteTasks: {
      async recoverAll() {
        calls.push('remote');
        return { recoveredCount: 1, failedCount: 1 };
      },
    },
    log: { info() {}, warn() {} },
  });

  const first = await coordinator.run();
  const second = await coordinator.run();
  assert.strictEqual(second, first);
  assert.deepEqual(calls, ['legacy-async', 'legacy-video', 'workflow', 'media', 'h3', 'remote']);
  assert.equal(first.schemaVersion, 'startup-recovery.v1');
  assert.equal(first.status, 'partial_failure');
  assert.deepEqual(first.families.map((family) => family.name), [
    'legacy_async_tasks', 'legacy_video_generations', 'workflow_runs',
    'media_exports', 'h3_api_submissions', 'remote_tasks',
  ]);
  assert.deepEqual(first.families.at(-1), {
    name: 'remote_tasks', status: 'partial_failure', recoveredCount: 1, failedCount: 1,
  });
  assert.equal(JSON.stringify(first).includes(uid(9910)), false);
  assert.doesNotMatch(JSON.stringify(first), /secret|private|taskUid|errorCode/iu);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.families));
});

test('P9-01 rejects Promise-like and non-exact local recovery results without accessors', async () => {
  let accessorReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'recoveredCount', {
    enumerable: true,
    get() { accessorReads += 1; return 1; },
  });
  const withSymbol = { recoveredCount: 1 };
  Object.defineProperty(withSymbol, Symbol('synthetic'), { enumerable: true, value: true });
  const cases = [
    { recoveredCount: 1, then() {} },
    { recoveredCount: 1, extra: true },
    withSymbol,
    accessor,
    Promise.resolve({ recoveredCount: 1 }),
    vm.runInNewContext('Promise.resolve({ recoveredCount: 1 })'),
  ];
  for (const localResult of cases) {
    const report = await coordinatorForBoundary({ localResult }).run();
    assert.equal(report.families[0].status, 'failed');
  }
  assert.equal(accessorReads, 0);
});

test('P9-01 accepts only an exact bounded remote recovery summary without accessors', async () => {
  let accessorReads = 0;
  const accessor = { recoveredCount: 1 };
  Object.defineProperty(accessor, 'failedCount', {
    enumerable: true,
    get() { accessorReads += 1; return 0; },
  });
  const withSymbol = { recoveredCount: 1, failedCount: 0 };
  Object.defineProperty(withSymbol, Symbol('synthetic'), { enumerable: true, value: true });
  const cases = [
    [],
    { recoveredCount: 1, failedCount: 0, extra: true },
    { recoveredCount: -1, failedCount: 0 },
    { recoveredCount: Number.MAX_SAFE_INTEGER, failedCount: 1 },
    withSymbol,
    accessor,
  ];
  for (const remoteResult of cases) {
    const report = await coordinatorForBoundary({ remoteResult }).run();
    assert.equal(report.families.at(-1).status, 'failed');
  }
  assert.equal(accessorReads, 0);
});

test('P9-01 H3 startup recovery atomically marks only submitting reservations unknown', (t) => {
  const database = createMigratedV2Database(t);
  const store = createH3ApiSubmissionStore(database);
  const requestSha256 = 'a'.repeat(64);
  const configEvidenceSha256 = 'b'.repeat(64);
  const submittingUid = uid(9920);
  const acceptedUid = uid(9921);
  const unknownUid = uid(9922);
  for (const operationUid of [submittingUid, acceptedUid, unknownUid]) {
    store.reserve({ operationUid, requestSha256, configId: 1, configEvidenceSha256 });
  }
  store.accept(acceptedUid, requestSha256, configEvidenceSha256, 'accepted-task');
  store.markUnknown(unknownUid, requestSha256, configEvidenceSha256);

  assert.deepEqual(store.recoverInterrupted(), { recoveredCount: 1 });
  const state = (operationUid) => store.reserve({
    operationUid, requestSha256, configId: 1, configEvidenceSha256,
  }).submission.state;
  assert.equal(state(submittingUid), 'submission_unknown');
  assert.equal(state(acceptedUid), 'accepted');
  assert.equal(state(unknownUid), 'submission_unknown');
  assert.deepEqual(store.recoverInterrupted(), { recoveredCount: 0 });
});

test('P9-01 actual createApp runs startup recovery before serving paid submission retries', async (t) => {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-recovery-'));
  const configDir = path.join(tempRoot, 'configs');
  const databasePath = path.join(tempRoot, 'data', 'recovery.sqlite').replace(/\\/gu, '/');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/gu, '/');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), [
    'app:',
    '  name: LocalMiniDrama-Recovery-E2E',
    '  version: 0.0.0-test',
    'server:',
    '  port: 0',
    '  insecure_tls: false',
    'database:',
    '  type: sqlite',
    `  path: "${databasePath}"`,
    'storage:',
    `  local_path: "${storagePath}"`,
    '',
  ].join('\n'), 'utf8');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const operationUid = uid(9930);
  let closeDatabase = () => {};
  try {
    process.chdir(tempRoot);
    const { createApp } = require('../src/app');
    const { closeDb } = require('../src/db');
    closeDatabase = closeDb;
    const first = createApp();
    await first.startupRecoveryPromise;
    createH3ApiSubmissionStore(first.db).reserve({
      operationUid,
      requestSha256: 'c'.repeat(64),
      configId: 1,
      configEvidenceSha256: 'd'.repeat(64),
    });
    first.db.prepare(`
      INSERT INTO async_tasks (id,type,status,deleted_at)
      VALUES ('startup-async-fixture','synthetic','processing',NULL)
    `).run();
    const videoGenerationId = first.db.prepare(`
      INSERT INTO video_generations (status,provider_task_id,deleted_at)
      VALUES ('processing',NULL,NULL)
    `).run().lastInsertRowid;
    closeDatabase();
    const second = createApp();
    assert.equal(second.db.prepare(
      'SELECT state FROM h3_api_submissions WHERE operation_uid=?',
    ).pluck().get(operationUid), 'submission_unknown');
    const report = await second.startupRecoveryPromise;
    assert.equal(report.status, 'completed');
    assert.equal(
      report.families.find((family) => family.name === 'h3_api_submissions').recoveredCount,
      1,
    );
    assert.equal(
      report.families.find((family) => family.name === 'legacy_async_tasks').recoveredCount,
      1,
    );
    assert.equal(
      report.families.find((family) => family.name === 'legacy_video_generations').recoveredCount,
      1,
    );
    assert.equal(second.db.prepare(
      "SELECT status FROM async_tasks WHERE id='startup-async-fixture'",
    ).pluck().get(), 'failed');
    assert.equal(second.db.prepare(
      'SELECT status FROM video_generations WHERE id=?',
    ).pluck().get(videoGenerationId), 'failed');
    assert.strictEqual(await second.startupRecovery.run(), report);
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
  }
});
