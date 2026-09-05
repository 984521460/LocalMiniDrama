'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const {
  createEnvironmentReport,
} = require('../src/remote/environmentReport');
const {
  createInitializationPlan,
  createInitializationRequest,
  createModelVerificationRequest,
} = require('../src/remote/initializationPlan');
const {
  createRemoteEnvironmentService,
} = require('../src/remote/remoteEnvironmentService');
const { createSshEnvironmentAdapter } = require('../src/remote/sshEnvironmentAdapter');
const { createH3RemoteModelCatalog } = require('../src/remote/h3EnvironmentProfile');
const remoteEnvironmentRoutes = require('../src/routes/v2/remoteEnvironment');
const { uid } = require('./helpers/v2RepositoryDatabase');

const CONNECTION_UID = uid(9901);
const NOW_EPOCH_MS = Date.parse('2026-08-28T08:00:00.000Z');
const SENTINEL = 'synthetic-secret-private-path';

function decodeRemoteCommand(command) {
  const match = /^python3 -c "import base64,zlib;exec\(zlib\.decompress\(base64\.b64decode\('([A-Za-z0-9+/=]+)'\),-15\)\)" '([A-Za-z0-9+/=]+)'$/u.exec(command);
  assert.ok(match);
  return Object.freeze({
    runtime: zlib.inflateRawSync(Buffer.from(match[1], 'base64')).toString('utf8'),
    request: JSON.parse(zlib.inflateRawSync(Buffer.from(match[2], 'base64')).toString('utf8')),
  });
}

function summary(overrides = {}) {
  return {
    platform: 'linux',
    architecture: 'x64',
    gpuVendor: 'nvidia',
    gpuName: 'NVIDIA GeForce RTX 4090',
    gpuCount: 1,
    totalVramMiB: 24564,
    driverVersion: '595.84',
    systemMemoryMiB: 65536,
    diskFreeMiB: 524288,
    pythonVersion: '3.12.12',
    torchVersion: '2.11.0+cu130',
    cudaVersion: '13.0',
    ffmpegVersion: '8.1.2',
    comfyUiVersion: '0.33.0',
    comfyUiRevision: '0696f61d953d09878988ebc4ca46e263f73ff65f',
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
      const decoded = decodeRemoteCommand(command);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      setImmediate(() => {
        const output = decoded.request.action === 'probe' ? summary() : { changed: false };
        stream.emit('data', Buffer.from(JSON.stringify(output), 'utf8'));
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
  assert.deepEqual(
    await adapter.initializer.verifyModel(opened.session, modelCatalog()[0]),
    { changed: false },
  );
  await opened.session.close();
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.ok(command.length <= 8192);
    assert.equal(command.includes('workspace/local-mini-drama'), false);
    assert.match(command, /^python3 -c /u);
  }
  const modelCommand = decodeRemoteCommand(commands[1]);
  assert.equal(modelCommand.request.action, 'verify-model');
  assert.equal(modelCommand.request.parameters.relativePath,
    'models/vae/minimax_h3_audio_vae_fp32.safetensors');
  assert.equal(modelCommand.runtime.includes('os.killpg'), true);
  assert.equal(modelCommand.runtime.includes('http://127.0.0.1:'), true);
  assert.equal(modelCommand.runtime.includes('os.lstat'), true);
  assert.equal(modelCommand.runtime.includes("getattr(os,'O_NOFOLLOW',0)"), true);
  assert.equal(modelCommand.runtime.includes("'status','--porcelain=v1','--untracked-files=all'"), true);
  assert.equal(modelCommand.runtime.includes('os.makedirs'), false);
  assert.equal(/pip\s+install|apt(?:-get)?\s+install|wget\s|curl\s|huggingface\.co/u
    .test(modelCommand.runtime), false);
});

function modelCatalog() {
  return createH3RemoteModelCatalog();
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
        pythonVersion: installed.has('verifyPythonRuntime') ? '3.12.12' : null,
        torchVersion: installed.has('verifyPythonRuntime') ? '2.11.0+cu130' : null,
        cudaVersion: installed.has('verifyPythonRuntime') ? '13.0' : null,
        ffmpegVersion: installed.has('verifyFfmpeg') ? '8.1.2' : null,
        comfyUiVersion: installed.has('ensureComfyUiService') ? '0.33.0' : null,
        comfyUiRevision: installed.has('ensureComfyUiService')
          ? '0696f61d953d09878988ebc4ca46e263f73ff65f' : null,
        comfyUiReachable: installed.has('ensureComfyUiService'),
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
    verifyPythonRuntime: action('verifyPythonRuntime'),
    ensureComfyUiService: action('ensureComfyUiService'),
    verifyCustomNodes: action('verifyCustomNodes'),
    verifyFfmpeg: action('verifyFfmpeg'),
    installBundledWorkflows: action('installBundledWorkflows'),
    verifyEnvironment: action('verifyEnvironment'),
    verifyModel: action('verifyModel'),
  };
  const service = createRemoteEnvironmentService({
    sessionService,
    probe,
    initializer,
    nowEpochMs: () => NOW_EPOCH_MS,
    modelCatalog: overrides.modelCatalog || modelCatalog(),
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
  assert.equal(report.contractVersion, 'remote-environment-report.v2');
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
    summary: summary({ comfyUiVersion: '0.32.9' }),
  }).ready, false);
  const mismatchedGpuReport = createEnvironmentReport({
    connectionUid: CONNECTION_UID,
    collectedAtEpochMs: NOW_EPOCH_MS,
    summary: summary({ gpuName: 'NVIDIA RTX 6000 Ada' }),
  });
  assert.equal(mismatchedGpuReport.ready, false);

  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v6/remote-environment-report.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(JSON.parse(JSON.stringify(report))), true, JSON.stringify(validate.errors));
  assert.equal(validate(JSON.parse(JSON.stringify(mismatchedGpuReport))), true,
    JSON.stringify(validate.errors));
  assert.equal(validate({ ...JSON.parse(JSON.stringify(mismatchedGpuReport)), ready: true }), false);
  assert.equal(validate({ ...JSON.parse(JSON.stringify(report)), ready: false }), false);

  let reads = 0;
  const hostileSummary = { ...summary() };
  Object.defineProperty(hostileSummary, 'pythonVersion', {
    enumerable: true,
    get() { reads += 1; return '3.12.12'; },
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
  assert.equal(first.contractVersion, 'remote-initialization-plan.v2');
  assert.equal(first.requiresModelVerificationConfirmation, true);
  assert.deepEqual(first.steps.map((step) => step.action), [
    'ensure-workspace-layout',
    'verify-python-runtime',
    'verify-ffmpeg',
    'install-bundled-workflows',
    'ensure-comfyui-service',
    'verify-custom-nodes',
    'verify-environment',
  ]);
  assert.equal(JSON.stringify(first).includes('command'), false);
  assert.equal(JSON.stringify(first).includes('shell'), false);
  assert.throws(() => createInitializationRequest({ planHash: first.planHash, command: 'ignored' }));
  assert.throws(() => createModelVerificationRequest({
    planHash: first.planHash,
    confirmation: 'yes',
  }));

  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v6/remote-initialization-plan.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(JSON.parse(JSON.stringify(first))), true, JSON.stringify(validate.errors));
  const schemaDrift = JSON.parse(JSON.stringify(first));
  schemaDrift.modelFiles[0].artifactSha256 = 'b'.repeat(64);
  assert.equal(validate(schemaDrift), false);
  let reads = 0;
  const hostileModel = { ...modelCatalog()[0] };
  Object.defineProperty(hostileModel, 'modelId', {
    enumerable: true,
    get() { reads += 1; return 'hostile-model'; },
  });
  assert.throws(() => createInitializationPlan({
    connectionUid: CONNECTION_UID,
    modelCatalog: [hostileModel, ...modelCatalog().slice(1)],
  }));
  assert.equal(reads, 0);
  assert.throws(() => createInitializationPlan({
    connectionUid: CONNECTION_UID,
    modelCatalog: [modelCatalog()[0], { ...modelCatalog()[0], version: '2.0.0' }],
  }));
  assert.throws(() => createInitializationPlan({
    connectionUid: CONNECTION_UID,
    modelCatalog: [
      { ...modelCatalog()[0], artifactSha256: 'b'.repeat(64) },
      ...modelCatalog().slice(1),
    ],
  }));
  assert.throws(() => serviceFixture({ modelCatalog: [] }));
});

test('core initialization is idempotent and never verifies model files implicitly', async () => {
  const fixture = serviceFixture({ modelCatalog: modelCatalog() });
  const plan = fixture.service.getInitializationPlan(CONNECTION_UID);
  const first = await fixture.service.initialize(CONNECTION_UID, { planHash: plan.planHash });
  const second = await fixture.service.initialize(CONNECTION_UID, { planHash: plan.planHash });
  assert.equal(first.status, 'completed');
  assert.equal(first.report.ready, true);
  assert.equal(first.steps.every((step) => step.status === 'completed'), true);
  assert.equal(second.steps.every((step) => step.status === 'already-satisfied'), true);
  assert.equal(fixture.calls.some((call) => call.name === 'verifyModel'), false);
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
      async verifyPythonRuntime() { return { changed: false }; },
      async ensureComfyUiService() { return { changed: false }; },
      async verifyCustomNodes() { return { changed: false }; },
      async verifyFfmpeg() { return { changed: false }; },
      async installBundledWorkflows() { return { changed: false }; },
      async verifyEnvironment() { return { changed: false }; },
      async verifyModel() { return { changed: false }; },
    },
  });
  const plan = failingFixture.service.getInitializationPlan(CONNECTION_UID);
  await assert.rejects(
    failingFixture.service.initialize(CONNECTION_UID, { planHash: plan.planHash }),
    (error) => error.code === 'REMOTE_ENVIRONMENT_INITIALIZATION_FAILED'
      && !JSON.stringify(error).includes(SENTINEL),
  );
  assert.equal(failingFixture.closeCalls, 1);

  const orderedCalls = [];
  const orderedAction = (name) => async () => {
    orderedCalls.push(name);
    if (name === 'verifyFfmpeg') throw new Error(SENTINEL);
    return { changed: false };
  };
  const prerequisiteFixture = serviceFixture({
    initializer: {
      ensureWorkspaceLayout: orderedAction('ensureWorkspaceLayout'),
      verifyPythonRuntime: orderedAction('verifyPythonRuntime'),
      verifyFfmpeg: orderedAction('verifyFfmpeg'),
      installBundledWorkflows: orderedAction('installBundledWorkflows'),
      ensureComfyUiService: orderedAction('ensureComfyUiService'),
      verifyCustomNodes: orderedAction('verifyCustomNodes'),
      verifyEnvironment: orderedAction('verifyEnvironment'),
      verifyModel: orderedAction('verifyModel'),
    },
  });
  const prerequisitePlan = prerequisiteFixture.service.getInitializationPlan(CONNECTION_UID);
  await assert.rejects(
    prerequisiteFixture.service.initialize(CONNECTION_UID, { planHash: prerequisitePlan.planHash }),
    (error) => error.code === 'REMOTE_ENVIRONMENT_INITIALIZATION_FAILED',
  );
  assert.deepEqual(orderedCalls, [
    'ensureWorkspaceLayout', 'verifyPythonRuntime', 'verifyFfmpeg',
  ]);
});

test('model file verification requires a separate exact confirmation and remains idempotent', async () => {
  const fixture = serviceFixture({ modelCatalog: modelCatalog() });
  const plan = fixture.service.getInitializationPlan(CONNECTION_UID);
  await assert.rejects(
    fixture.service.verifyModels(CONNECTION_UID, {
      planHash: plan.planHash,
      confirmation: 'confirm',
    }),
    (error) => error.code === 'REMOTE_ENVIRONMENT_INPUT_INVALID',
  );
  assert.equal(fixture.calls.some((call) => call.name === 'verifyModel'), false);
  await assert.rejects(
    fixture.service.verifyModels(CONNECTION_UID, {
      planHash: plan.planHash,
      confirmation: 'confirm-model-file-verification',
    }),
    (error) => error.code === 'REMOTE_ENVIRONMENT_INITIALIZATION_FAILED',
  );
  assert.equal(fixture.calls.some((call) => call.name === 'verifyModel'), false);
  await fixture.service.initialize(CONNECTION_UID, { planHash: plan.planHash });
  const first = await fixture.service.verifyModels(CONNECTION_UID, {
    planHash: plan.planHash,
    confirmation: 'confirm-model-file-verification',
  });
  const second = await fixture.service.verifyModels(CONNECTION_UID, {
    planHash: plan.planHash,
    confirmation: 'confirm-model-file-verification',
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
  assert.equal(plan.contractVersion, 'remote-initialization-plan.v2');

  const rejected = await fetch(`${base}/initialize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planHash: plan.planHash, command: SENTINEL }),
  });
  assert.equal(rejected.status, 400);
  const rejectedText = await rejected.text();
  assert.equal(rejectedText.includes(SENTINEL), false);
  assert.equal(JSON.parse(rejectedText).error.code, 'REMOTE_ENVIRONMENT_INPUT_INVALID');

  const initialized = await fetch(`${base}/initialize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planHash: plan.planHash }),
  });
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).data.kind, 'core');

  const verified = await fetch(`${base}/verify-models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      planHash: plan.planHash,
      confirmation: 'confirm-model-file-verification',
    }),
  });
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).data.kind, 'model-verification');

  const removedLegacyRoute = await fetch(`${base}/install-models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planHash: plan.planHash }),
  });
  assert.equal(removedLegacyRoute.status, 404);
});
