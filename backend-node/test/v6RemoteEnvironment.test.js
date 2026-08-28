'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const {
  createEnvironmentReport,
} = require('../src/remote/environmentReport');
const {
  createInitializationPlan,
  createInitializationRequest,
  createModelInstallationRequest,
} = require('../src/remote/initializationPlan');
const {
  createRemoteEnvironmentService,
} = require('../src/remote/remoteEnvironmentService');
const { createSshEnvironmentAdapter } = require('../src/remote/sshEnvironmentAdapter');
const remoteEnvironmentRoutes = require('../src/routes/v2/remoteEnvironment');
const { uid } = require('./helpers/v2RepositoryDatabase');

const CONNECTION_UID = uid(9901);
const NOW_EPOCH_MS = Date.parse('2026-08-28T08:00:00.000Z');
const SENTINEL = 'synthetic-secret-private-path';

function summary(overrides = {}) {
  return {
    platform: 'linux',
    architecture: 'x64',
    gpuVendor: 'nvidia',
    gpuCount: 1,
    totalVramMiB: 24564,
    systemMemoryMiB: 65536,
    diskFreeMiB: 524288,
    pythonVersion: '3.11.9',
    torchVersion: '2.7.1',
    cudaVersion: '12.8',
    ffmpegVersion: '7.1.1',
    comfyUiVersion: '0.3.50',
    workspaceWritable: true,
    directoriesReady: true,
    comfyUiReachable: true,
    ...overrides,
  };
}

test('production SSH environment actions use one bounded fixed runtime command', async () => {
  const commands = [];
  const session = Object.freeze({
    async close() {},
    async exec(command) {
      commands.push(command);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      setImmediate(() => {
        stream.emit('data', Buffer.from(JSON.stringify(summary()), 'utf8'));
        stream.emit('close', 0);
      });
      return stream;
    },
  });
  const adapter = createSshEnvironmentAdapter({
    sessionService: Object.freeze({
      async openSession() {
        return Object.freeze({
          connection: Object.freeze({
            remoteWorkDir: 'workspace/local-mini-drama',
            comfyPort: 8188,
          }),
          session,
        });
      },
    }),
  });

  const opened = await adapter.sessionService.openSession(CONNECTION_UID);
  assert.deepEqual(await adapter.probe.inspect(opened.session), summary());
  await opened.session.close();
  assert.equal(commands.length, 1);
  assert.ok(commands[0].length <= 8192);
  assert.equal(commands[0].includes('workspace/local-mini-drama'), false);
  assert.match(commands[0], /^python3 -c /u);
});

function modelCatalog() {
  return [{
    modelId: 'minimax-h3-text-encoder',
    version: '1.0.0',
    sizeBytes: 17_179_869_184,
    licenseId: 'H3-community-license',
    artifactSha256: 'a'.repeat(64),
  }];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, reject, resolve });
}

function serviceFixture(overrides = {}) {
  const installed = new Set();
  const calls = [];
  let closeCalls = 0;
  const session = Object.freeze({
    close: async () => { closeCalls += 1; },
  });
  const sessionService = {
    async openSession(connectionUid) {
      assert.equal(connectionUid, CONNECTION_UID);
      return Object.freeze({ session });
    },
  };
  const probe = {
    async inspect() {
      return summary({
        workspaceWritable: installed.has('ensureWorkspaceLayout'),
        directoriesReady: installed.has('ensureWorkspaceLayout'),
        pythonVersion: installed.has('ensurePythonRuntime') ? '3.11.9' : null,
        torchVersion: installed.has('ensurePythonRuntime') ? '2.7.1' : null,
        cudaVersion: installed.has('ensurePythonRuntime') ? '12.8' : null,
        ffmpegVersion: installed.has('verifyFfmpeg') ? '7.1.1' : null,
        comfyUiVersion: installed.has('ensureComfyUiVersion') ? '0.3.50' : null,
        comfyUiReachable: installed.has('ensureComfyUiVersion'),
      });
    },
  };
  const action = (name) => async (_session, parameters) => {
    calls.push(Object.freeze({ name, parameters }));
    const changed = !installed.has(name);
    installed.add(name);
    return Object.freeze({ changed });
  };
  const initializer = {
    ensureWorkspaceLayout: action('ensureWorkspaceLayout'),
    ensurePythonRuntime: action('ensurePythonRuntime'),
    ensureComfyUiVersion: action('ensureComfyUiVersion'),
    ensureCustomNodes: action('ensureCustomNodes'),
    verifyFfmpeg: action('verifyFfmpeg'),
    installBundledWorkflows: action('installBundledWorkflows'),
    verifyEnvironment: action('verifyEnvironment'),
    installModel: action('installModel'),
  };
  const service = createRemoteEnvironmentService({
    sessionService,
    probe,
    initializer,
    nowEpochMs: () => NOW_EPOCH_MS,
    modelCatalog: overrides.modelCatalog || [],
    ...overrides,
  });
  return { calls, get closeCalls() { return closeCalls; }, installed, service };
}

test('environment reports expose only exact sanitized capability facts', () => {
  const report = createEnvironmentReport({
    connectionUid: CONNECTION_UID,
    collectedAtEpochMs: NOW_EPOCH_MS,
    summary: summary(),
  });
  assert.equal(report.contractVersion, 'remote-environment-report.v1');
  assert.equal(report.ready, true);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(JSON.stringify(report).includes(SENTINEL), false);
  assert.throws(() => createEnvironmentReport({
    connectionUid: CONNECTION_UID,
    collectedAtEpochMs: NOW_EPOCH_MS,
    summary: { ...summary(), homePath: `/home/${SENTINEL}` },
  }));
  assert.throws(() => createEnvironmentReport({
    connectionUid: CONNECTION_UID,
    collectedAtEpochMs: NOW_EPOCH_MS,
    summary: { ...summary(), pythonVersion: `/home/${SENTINEL}` },
  }));
  assert.equal(createEnvironmentReport({
    connectionUid: CONNECTION_UID,
    collectedAtEpochMs: NOW_EPOCH_MS,
    summary: summary({ comfyUiVersion: '0.3.49' }),
  }).ready, false);

  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v6/remote-environment-report.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(JSON.parse(JSON.stringify(report))), true, JSON.stringify(validate.errors));

  let reads = 0;
  const hostileSummary = { ...summary() };
  Object.defineProperty(hostileSummary, 'pythonVersion', {
    enumerable: true,
    get() { reads += 1; return '3.11.9'; },
  });
  assert.throws(() => createEnvironmentReport({
    connectionUid: CONNECTION_UID,
    collectedAtEpochMs: NOW_EPOCH_MS,
    summary: hostileSummary,
  }));
  assert.equal(reads, 0);
});

test('initialization plans are deterministic fixed action lists without caller shell input', () => {
  const first = createInitializationPlan({
    connectionUid: CONNECTION_UID,
    modelCatalog: modelCatalog(),
  });
  const second = createInitializationPlan({
    connectionUid: CONNECTION_UID,
    modelCatalog: modelCatalog(),
  });
  assert.deepEqual(first, second);
  assert.equal(first.planHash, second.planHash);
  assert.equal(first.contractVersion, 'remote-initialization-plan.v1');
  assert.equal(first.requiresLargeModelConfirmation, true);
  assert.deepEqual(first.steps.map((step) => step.action), [
    'ensure-workspace-layout',
    'ensure-python-runtime',
    'ensure-comfyui-version',
    'ensure-custom-nodes',
    'verify-ffmpeg',
    'install-bundled-workflows',
    'verify-environment',
  ]);
  assert.equal(JSON.stringify(first).includes('command'), false);
  assert.equal(JSON.stringify(first).includes('shell'), false);
  assert.throws(() => createInitializationRequest({ planHash: first.planHash, command: 'ignored' }));
  assert.throws(() => createModelInstallationRequest({
    planHash: first.planHash,
    confirmation: 'yes',
  }));

  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v6/remote-initialization-plan.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(JSON.parse(JSON.stringify(first))), true, JSON.stringify(validate.errors));
  let reads = 0;
  const hostileModel = { ...modelCatalog()[0] };
  Object.defineProperty(hostileModel, 'modelId', {
    enumerable: true,
    get() { reads += 1; return 'hostile-model'; },
  });
  assert.throws(() => createInitializationPlan({
    connectionUid: CONNECTION_UID,
    modelCatalog: [hostileModel],
  }));
  assert.equal(reads, 0);
  assert.throws(() => createInitializationPlan({
    connectionUid: CONNECTION_UID,
    modelCatalog: [modelCatalog()[0], { ...modelCatalog()[0], version: '2.0.0' }],
  }));
});

test('core initialization is idempotent and never installs large models implicitly', async () => {
  const fixture = serviceFixture({ modelCatalog: modelCatalog() });
  const plan = fixture.service.getInitializationPlan(CONNECTION_UID);
  const first = await fixture.service.initialize(CONNECTION_UID, { planHash: plan.planHash });
  const second = await fixture.service.initialize(CONNECTION_UID, { planHash: plan.planHash });
  assert.equal(first.status, 'completed');
  assert.equal(first.report.ready, true);
  assert.equal(first.steps.every((step) => step.status === 'completed'), true);
  assert.equal(second.steps.every((step) => step.status === 'already-satisfied'), true);
  assert.equal(fixture.calls.some((call) => call.name === 'installModel'), false);
  assert.equal(fixture.closeCalls, 2);

  const concurrentFixture = serviceFixture();
  const concurrentPlan = concurrentFixture.service.getInitializationPlan(CONNECTION_UID);
  const [left, right] = await Promise.all([
    concurrentFixture.service.initialize(CONNECTION_UID, { planHash: concurrentPlan.planHash }),
    concurrentFixture.service.initialize(CONNECTION_UID, { planHash: concurrentPlan.planHash }),
  ]);
  assert.deepEqual(left, right);
  assert.equal(concurrentFixture.calls.length, 7);
  assert.equal(concurrentFixture.closeCalls, 1);
});

test('plan conflicts and initializer failures occur before unsafe follow-up work', async () => {
  const conflictFixture = serviceFixture();
  await assert.rejects(
    conflictFixture.service.initialize(CONNECTION_UID, { planHash: 'f'.repeat(64) }),
    (error) => error.code === 'REMOTE_ENVIRONMENT_PLAN_CONFLICT',
  );
  assert.equal(conflictFixture.calls.length, 0);
  assert.equal(conflictFixture.closeCalls, 0);

  const failingFixture = serviceFixture({
    initializer: {
      async ensureWorkspaceLayout() { throw new Error(SENTINEL); },
      async ensurePythonRuntime() { return { changed: false }; },
      async ensureComfyUiVersion() { return { changed: false }; },
      async ensureCustomNodes() { return { changed: false }; },
      async verifyFfmpeg() { return { changed: false }; },
      async installBundledWorkflows() { return { changed: false }; },
      async verifyEnvironment() { return { changed: false }; },
      async installModel() { return { changed: false }; },
    },
  });
  const plan = failingFixture.service.getInitializationPlan(CONNECTION_UID);
  await assert.rejects(
    failingFixture.service.initialize(CONNECTION_UID, { planHash: plan.planHash }),
    (error) => error.code === 'REMOTE_ENVIRONMENT_INITIALIZATION_FAILED'
      && !JSON.stringify(error).includes(SENTINEL),
  );
  assert.equal(failingFixture.closeCalls, 1);
});

test('large model actions require a separate exact confirmation and remain idempotent', async () => {
  const fixture = serviceFixture({ modelCatalog: modelCatalog() });
  const plan = fixture.service.getInitializationPlan(CONNECTION_UID);
  await assert.rejects(
    fixture.service.installModels(CONNECTION_UID, {
      planHash: plan.planHash,
      confirmation: 'confirm',
    }),
    (error) => error.code === 'REMOTE_ENVIRONMENT_INPUT_INVALID',
  );
  assert.equal(fixture.calls.some((call) => call.name === 'installModel'), false);
  const first = await fixture.service.installModels(CONNECTION_UID, {
    planHash: plan.planHash,
    confirmation: 'confirm-large-model-downloads',
  });
  const second = await fixture.service.installModels(CONNECTION_UID, {
    planHash: plan.planHash,
    confirmation: 'confirm-large-model-downloads',
  });
  assert.equal(first.steps[0].status, 'completed');
  assert.equal(second.steps[0].status, 'already-satisfied');
});

test('probe and initializer failures use fixed errors without raw output or hung thenables', async () => {
  const pending = deferred();
  const fixture = serviceFixture({
    timeoutMs: 25,
    probe: {
      async inspect() {
        await pending.promise;
        throw new Error(SENTINEL);
      },
    },
  });
  await assert.rejects(
    fixture.service.inspect(CONNECTION_UID),
    (error) => error.code === 'REMOTE_ENVIRONMENT_PROBE_FAILED'
      && !JSON.stringify(error).includes(SENTINEL),
  );
  pending.reject(new Error(SENTINEL));
});

test('localhost environment routes return fixed public envelopes', async (t) => {
  const fixture = serviceFixture({ modelCatalog: modelCatalog() });
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/v2', remoteEnvironmentRoutes({ error() {} }, { remoteEnvironment: fixture.service }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v2/remote-connections/${CONNECTION_UID}`;

  const planResponse = await fetch(`${base}/initialization-plan`);
  assert.equal(planResponse.status, 200);
  const plan = (await planResponse.json()).data;
  assert.equal(plan.contractVersion, 'remote-initialization-plan.v1');

  const rejected = await fetch(`${base}/initialize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planHash: plan.planHash, command: SENTINEL }),
  });
  assert.equal(rejected.status, 400);
  const rejectedText = await rejected.text();
  assert.equal(rejectedText.includes(SENTINEL), false);
  assert.equal(JSON.parse(rejectedText).error.code, 'REMOTE_ENVIRONMENT_INPUT_INVALID');
});
