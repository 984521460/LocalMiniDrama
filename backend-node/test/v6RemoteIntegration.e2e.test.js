'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const express = require('express');

const remoteExecutionRoutes = require('../src/routes/v2/remoteExecution');

const CONNECTION_UID = '00000000-0000-4000-8000-000000009950';
const TASK_UID = '00000000-0000-4000-8000-000000009951';

async function listen(t, app) {
  const server = await new Promise((resolve) => {
    const active = app.listen(0, '127.0.0.1', () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/v2`;
}

test('remote execution router mounts environment and task APIs as one bounded v2 module', async (t) => {
  const calls = [];
  const remoteEnvironment = Object.freeze({
    async inspect(connectionUid) {
      calls.push(['inspect', connectionUid]);
      return Object.freeze({ kind: 'sanitized-report' });
    },
    getInitializationPlan(connectionUid) {
      calls.push(['plan', connectionUid]);
      return Object.freeze({ kind: 'fixed-plan' });
    },
    async initialize() { throw new Error('not used'); },
    async verifyModels() { throw new Error('not used'); },
  });
  const remoteTasks = Object.freeze({
    async get(taskUid) {
      calls.push(['task', taskUid]);
      return Object.freeze({ uid: taskUid, stage: 'prepared' });
    },
    async prepare() { throw new Error('not used'); },
    async recoverAll() { throw new Error('not used'); },
    async submit() { throw new Error('not used'); },
    async heartbeat() { throw new Error('not used'); },
    async recover() { throw new Error('not used'); },
  });
  const remoteCoordinator = Object.freeze({
    async execute(taskUid, request) {
      calls.push(['execute', taskUid, request]);
      return Object.freeze({ taskUid, completed: true });
    },
  });
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/v2', remoteExecutionRoutes(
    { error() {} },
    { remoteCoordinator, remoteEnvironment, remoteTasks },
  ));
  const base = await listen(t, app);

  const report = await fetch(
    `${base}/remote-connections/${CONNECTION_UID}/environment-report`,
  );
  assert.equal(report.status, 200);
  assert.deepEqual((await report.json()).data, { kind: 'sanitized-report' });

  const plan = await fetch(
    `${base}/remote-connections/${CONNECTION_UID}/initialization-plan`,
  );
  assert.equal(plan.status, 200);
  assert.deepEqual((await plan.json()).data, { kind: 'fixed-plan' });

  const task = await fetch(`${base}/remote-tasks/${TASK_UID}`);
  assert.equal(task.status, 200);
  assert.deepEqual((await task.json()).data, { uid: TASK_UID, stage: 'prepared' });
  const execute = await fetch(`${base}/remote-tasks/${TASK_UID}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixed: 'request' }),
  });
  assert.equal(execute.status, 200);
  assert.deepEqual((await execute.json()).data, { taskUid: TASK_UID, completed: true });
  assert.deepEqual(calls, [
    ['inspect', CONNECTION_UID],
    ['plan', CONNECTION_UID],
    ['task', TASK_UID],
    ['execute', TASK_UID, { fixed: 'request' }],
  ]);
});

test('the main API router mounts the bounded remote execution router', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/routes/index.js'),
    'utf8',
  );
  assert.match(source, /remoteExecutionRoutes/u);
  assert.match(source, /r\.use\('\/v2', remoteExecution\)/u);
});

test('the actual application composes production remote environment and task services', async (t) => {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-p6-production-runtime-'));
  const databasePath = path.join(tempRoot, 'data', 'runtime.sqlite').replace(/\\/gu, '/');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/gu, '/');
  fs.mkdirSync(path.join(tempRoot, 'configs'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'configs', 'config.yaml'), [
    'app:',
    '  name: LocalMiniDrama-P6-Runtime',
    '  version: 0.0.0-test',
    'server:',
    '  port: 0',
    '  host: 127.0.0.1',
    '  insecure_tls: false',
    'database:',
    '  type: sqlite',
    `  path: "${databasePath}"`,
    'storage:',
    `  local_path: "${storagePath}"`,
    '',
  ].join('\n'), 'utf8');

  let closeDatabase = () => {};
  try {
    process.chdir(tempRoot);
    const { createApp } = require('../src/app');
    const { closeDb } = require('../src/db');
    closeDatabase = closeDb;
    const { app } = createApp();
    const testBase = await listen(t, app);
    const base = `${testBase.replace(/\/api\/v2$/u, '')}/api/v1/v2`;

    const plan = await fetch(
      `${base}/remote-connections/${CONNECTION_UID}/initialization-plan`,
    );
    assert.equal(plan.status, 200);
    assert.equal((await plan.json()).data.contractVersion, 'remote-initialization-plan.v2');

    const task = await fetch(`${base}/remote-tasks/${TASK_UID}`);
    assert.equal(task.status, 404);
    assert.equal((await task.json()).error.code, 'REMOTE_TASK_NOT_FOUND');
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
