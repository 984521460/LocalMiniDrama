'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createRemoteTaskRetryClassification } = require('../src/remote/remoteRetryPolicy');
const {
  createCoordinatorTransferFailureFixture,
  createRemoteFailureFixture,
} = require('./helpers/v9RemoteFailureFixture');

async function submittedTask(fixture) {
  const prepared = (await fixture.service.prepare(fixture.request)).task;
  return fixture.service.submit(prepared.uid, {
    expectedStateVersion: prepared.stateVersion,
    prompt: fixture.prompt,
  });
}

test('P9-03 disk exhaustion during download removes the partial file and requires reconciliation', async (t) => {
  const fixture = await createCoordinatorTransferFailureFixture(t, 'download_disk_full');
  const content = Buffer.from('synthetic remote video bytes');
  const remoteRelativePath = `ai-drama-studio/jobs/${fixture.taskUid}/output/result.mp4`;
  const remotePath = path.join(
    fixture.remoteRoot,
    ...remoteRelativePath.split('/'),
  );
  fs.mkdirSync(path.dirname(remotePath), { recursive: true });
  fs.writeFileSync(remotePath, content);

  const beforeVersions = fixture.repositories.assets.listVersions(fixture.assetUid).length;
  await assert.rejects(
    fixture.coordinator.execute(fixture.taskUid, fixture.executeRequest),
    { code: 'REMOTE_TASK_UNEXPECTED' },
  );
  assert.equal(fs.existsSync(path.join(
    fixture.localRoot, ...fixture.localOutputRelativePath.split('/'),
  )), false);
  assert.deepEqual(fixture.partialFiles(fixture.localRoot), []);
  assert.equal(fixture.sftp.ended, true);

  const task = fixture.taskService.get(fixture.taskUid);
  const aggregate = fixture.runService.getRun(fixture.runUid);
  assert.equal(task.errorPhase, 'download');
  assert.equal(task.errorCode, 'ERR_REMOTE_DOWNLOAD_FAILED');
  assert.equal(task.outputAssetVersionUid, null);
  assert.equal(fixture.submitCalls(), 1);
  assert.equal(fixture.repositories.assets.listVersions(fixture.assetUid).length, beforeVersions);
  assert.equal(
    fixture.repositories.assets.get(fixture.assetUid).currentVersionUid,
    fixture.sourceVersionUid,
  );
  assert.equal(aggregate.run.status, 'failed');
  assert.equal(fixture.runService.getNode(fixture.nodeRunUid).status, 'failed');
  assert.equal(createRemoteTaskRetryClassification(task).disposition, 'manual_reconcile');
});

test('P9-03 interrupted upload removes its remote partial and permits only safe pre-submit replay', async (t) => {
  const fixture = await createCoordinatorTransferFailureFixture(t, 'upload_network');
  const content = Buffer.from('synthetic upload payload');
  fs.mkdirSync(path.join(fixture.localRoot, 'input'), { recursive: true });
  fs.writeFileSync(path.join(fixture.localRoot, 'input', 'source.bin'), content);

  const beforeVersions = fixture.repositories.assets.listVersions(fixture.assetUid).length;
  await assert.rejects(
    fixture.coordinator.execute(fixture.taskUid, fixture.executeRequest),
    { code: 'REMOTE_TASK_UNEXPECTED' },
  );
  assert.deepEqual(fixture.partialFiles(fixture.remoteRoot), []);
  assert.equal(fs.existsSync(path.join(
    fixture.remoteRoot,
    'ai-drama-studio', 'jobs', fixture.taskUid, 'input', 'source.bin',
  )), false);
  assert.equal(fixture.sftp.ended, true);

  const task = fixture.taskService.get(fixture.taskUid);
  const aggregate = fixture.runService.getRun(fixture.runUid);
  const classification = createRemoteTaskRetryClassification(task);
  assert.equal(task.errorPhase, 'upload');
  assert.equal(task.errorCode, 'ERR_REMOTE_UPLOAD_FAILED');
  assert.equal(task.promptId, null);
  assert.equal(task.outputAssetVersionUid, null);
  assert.equal(fixture.submitCalls(), 0);
  assert.equal(fixture.repositories.assets.listVersions(fixture.assetUid).length, beforeVersions);
  assert.equal(
    fixture.repositories.assets.get(fixture.assetUid).currentVersionUid,
    fixture.sourceVersionUid,
  );
  assert.equal(aggregate.run.status, 'failed');
  assert.equal(fixture.runService.getNode(fixture.nodeRunUid).status, 'failed');
  assert.deepEqual(
    { disposition: classification.disposition, allowed: classification.allowed },
    { disposition: 'safe_replay', allowed: true },
  );
});

test('P9-03 Comfy restart after submission becomes uncertain without a duplicate submit', async (t) => {
  const fixture = createRemoteFailureFixture(t);
  let task = await submittedTask(fixture);
  task = fixture.service.markExecuting(task.uid, {
    expectedStateVersion: task.stateVersion,
  });
  fixture.setMode('restart');

  task = await fixture.service.recover(task.uid);
  const classification = createRemoteTaskRetryClassification(task);
  assert.equal(task.errorCode, 'ERR_REMOTE_RECOVERY_UNCERTAIN');
  assert.equal(task.recoveryState, 'orphaned');
  assert.equal(task.outputAssetVersionUid, null);
  assert.equal(classification.disposition, 'manual_reconcile');
  assert.equal(fixture.submitCalls(), 1);
  assert.equal(JSON.stringify(task).includes('synthetic Comfy restart transport detail'), false);
});

test('P9-03 Comfy OOM is a fixed execution failure with no raw provider detail or replay', async (t) => {
  const fixture = createRemoteFailureFixture(t);
  let task = await submittedTask(fixture);
  task = fixture.service.markExecuting(task.uid, {
    expectedStateVersion: task.stateVersion,
  });
  fixture.setMode('oom');

  task = await fixture.service.recover(task.uid);
  const classification = createRemoteTaskRetryClassification(task);
  assert.equal(task.errorCode, 'ERR_REMOTE_EXECUTION_FAILED');
  assert.equal(task.recoveryState, 'retryable');
  assert.equal(task.outputAssetVersionUid, null);
  assert.equal(classification.disposition, 'manual_reconcile');
  assert.equal(fixture.submitCalls(), 1);
  assert.equal(JSON.stringify(task).includes(fixture.providerDetail), false);
});
