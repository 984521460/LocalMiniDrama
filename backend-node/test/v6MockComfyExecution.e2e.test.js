'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const express = require('express');

const { createComfyUiClient } = require('../src/integrations/comfyui/client');
const { compileComfyWorkflow } = require('../src/integrations/comfyui/workflowCompiler');
const { convertComfyApiWorkflow } = require('../src/integrations/comfyui/workflowConverter');
const { createRemoteTaskService } = require('../src/remote/remoteTaskService');
const { hashRemoteTaskPrompt } = require('../src/remote/remoteTask');
const { createComfyDependencyChecker } = require('../src/remote/comfyDependencyChecker');
const { createSftpTransfer } = require('../src/remote/sftpTransfer');
const { createComfyWorkflowManifest } = require('../src/remote/workflowManifest');
const remoteConnectionRoutes = require('../src/routes/v2/remoteConnections');
const remoteTaskRoutes = require('../src/routes/v2/remoteTasks');
const { createV2Repositories } = require('../src/repositories/v2');
const {
  createWorkflowRunService,
  createWorkflowService,
} = require('../src/workflows');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

const CONNECTION_UID = uid(9950);
const MANIFEST_UID = uid(9951);
const TASK_UID = uid(9952);
const DRAMA_UID = uid(9953);
const WORKFLOW_UID = uid(9954);
const NODE_UID = uid(9955);
const RUN_UID = uid(9956);
const NODE_RUN_UID = uid(9957);
const ASSET_UID = uid(9958);
const VERSION_UID = uid(9959);
const FINGERPRINT = `SHA256:${'A'.repeat(43)}`;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function workflowFixture() {
  return {
    10: {
      class_type: 'PromptNode',
      inputs: { text: 'old prompt', width: 64 },
      _meta: { title: 'APP_GENERATION_INPUTS' },
    },
    15: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'models/h3.safetensors' },
      _meta: { title: 'Load H3 checkpoint' },
    },
    20: {
      class_type: 'SaveVideo',
      inputs: { video: ['10', 0] },
      _meta: { title: 'APP_OUTPUT_VIDEO' },
    },
  };
}

function manifestFixture(workflowBytes) {
  return {
    schemaVersion: 'comfy-workflow-manifest.v1',
    uid: MANIFEST_UID,
    manifestId: 'mock-comfy-video-v1',
    version: '1.0.0',
    engine: 'comfyui',
    workflowFile: 'workflows/mock-comfy-video-api.json',
    workflowSha256: sha256(workflowBytes),
    modelFamily: 'mock-h3',
    requirements: [
      { kind: 'node', nodeType: 'PromptNode' },
      { kind: 'node', nodeType: 'CheckpointLoaderSimple' },
      { kind: 'node', nodeType: 'SaveVideo' },
      {
        kind: 'model',
        nodeType: 'CheckpointLoaderSimple',
        inputName: 'ckpt_name',
        fileName: 'models/h3.safetensors',
      },
    ],
    inputs: {
      prompt: {
        marker: 'APP_GENERATION_INPUTS', inputName: 'text', valueType: 'string', required: true,
      },
      width: {
        marker: 'APP_GENERATION_INPUTS', inputName: 'width', valueType: 'integer', required: true,
      },
    },
    outputs: { video: { marker: 'APP_OUTPUT_VIDEO' } },
    validation: {
      schemaVersion: 'comfy-workflow-manifest.v1',
      workflowFormat: 'api',
      markersValidated: true,
    },
    status: 'validated',
  };
}

function objectInfoFixture() {
  return {
    PromptNode: { input: { required: {} } },
    CheckpointLoaderSimple: {
      input: { required: { ckpt_name: [['models/h3.safetensors'], {}] } },
    },
    SaveVideo: { input: { required: {} } },
  };
}

class LocalSftp {
  constructor(root) { this.root = root; }

  local(remotePath) { return path.join(this.root, ...remotePath.split('/')); }

  lstat(remotePath, callback) { fs.lstat(this.local(remotePath), callback); }

  mkdir(remotePath, callback) { fs.mkdir(this.local(remotePath), callback); }

  realpath(remotePath, callback) {
    fs.realpath(this.local(remotePath), (error, resolved) => {
      if (error) callback(error);
      else callback(null, `/sandbox/${path.relative(this.root, resolved).replace(/\\/gu, '/')}`);
    });
  }

  fastPut(localPath, remotePath, callback) { fs.copyFile(localPath, this.local(remotePath), callback); }

  fastGet(remotePath, localPath, callback) { fs.copyFile(this.local(remotePath), localPath, callback); }

  createReadStream(remotePath) { return fs.createReadStream(this.local(remotePath)); }

  rename(from, to, callback) { fs.rename(this.local(from), this.local(to), callback); }

  unlink(remotePath, callback) { fs.unlink(this.local(remotePath), callback); }

  end() {}
}

function fakeVault() {
  const records = new Map();
  return Object.freeze({
    records,
    async store({ secret }) {
      const ref = `credential:v1:${uid(9960)}`;
      records.set(ref, Buffer.from(secret));
      return Object.freeze({ ref, kind: 'ssh_password', configured: true });
    },
    async inspect(ref) {
      if (!records.has(ref)) {
        const error = new Error('missing');
        error.code = 'CREDENTIAL_NOT_FOUND';
        throw error;
      }
      return Object.freeze({ ref, kind: 'ssh_password', configured: true });
    },
    async remove(ref) { return records.delete(ref); },
  });
}

async function listen(t, app) {
  const server = await new Promise((resolve) => {
    const active = app.listen(0, '127.0.0.1', () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return Object.freeze({
    origin: `http://127.0.0.1:${server.address().port}`,
    server,
  });
}

test('Mock Comfy crosses connection, checked transfer, execution, asset, and node backfill layers', async (t) => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-p6-e2e-local-'));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-p6-e2e-remote-'));
  t.after(() => {
    fs.rmSync(localRoot, { recursive: true, force: true });
    fs.rmSync(remoteRoot, { recursive: true, force: true });
  });
  const inputBytes = Buffer.from('synthetic checked input bytes');
  const outputBytes = Buffer.from('synthetic checked mock video bytes');
  fs.writeFileSync(path.join(localRoot, 'input.bin'), inputBytes);

  const promptId = 'mock-prompt-1';
  let submittedPrompt = null;
  const comfyApp = express();
  comfyApp.use(express.json({ limit: '2mb' }));
  comfyApp.get('/object_info', (_req, res) => res.json(objectInfoFixture()));
  comfyApp.get('/queue', (_req, res) => res.json({ queue_running: [], queue_pending: [] }));
  comfyApp.post('/prompt', (req, res) => {
    submittedPrompt = req.body.prompt;
    res.json({ prompt_id: promptId, number: 1, node_errors: {} });
  });
  comfyApp.get('/history/:promptId', (req, res) => res.json({
    [req.params.promptId]: {
      status: { completed: true, status_str: 'success' },
      outputs: {
        20: {
          gifs: [{
            filename: 'result.mp4',
            subfolder: `ai-drama-studio/jobs/${TASK_UID}/output`,
            type: 'output',
          }],
        },
      },
    },
  }));
  const comfy = await listen(t, comfyApp);
  const client = createComfyUiClient({ baseUrl: comfy.origin, requestTimeoutMs: 2000 });

  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'Mock Comfy integration');
  const repositories = createV2Repositories(database);
  const workflowBytes = Buffer.from(JSON.stringify(workflowFixture()));
  repositories.comfyManifests.create(createComfyWorkflowManifest(
    manifestFixture(workflowBytes),
    workflowBytes,
  ));

  const workflowService = createWorkflowService({
    repositories,
    createUid: () => WORKFLOW_UID,
  });
  const workflow = workflowService.createWorkflow({ dramaId: 1, name: 'Mock remote workflow' });
  workflowService.replaceGraph(workflow.definition.uid, {
    expectedRevision: 0,
    nodes: [{
      uid: NODE_UID,
      nodeType: 'shot.video',
      position: { x: 0, y: 0 },
      config: {},
      status: 'disabled',
    }],
    edges: [],
  });
  const generatedUids = [RUN_UID, NODE_RUN_UID];
  const runService = createWorkflowRunService({
    repositories,
    createUid: () => generatedUids.shift(),
  });
  const createdRun = runService.createRun({ workflowUid: WORKFLOW_UID, triggerType: 'manual' });
  runService.transitionWorkflow({
    runUid: RUN_UID,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  runService.transitionNode({
    nodeRunUid: NODE_RUN_UID,
    expectedStatus: 'queued',
    nextStatus: 'running',
    inputSnapshot: { mock: true },
  });

  const compiled = compileComfyWorkflow({
    convertedWorkflow: convertComfyApiWorkflow(workflowFixture()),
    inputBindings: manifestFixture(workflowBytes).inputs,
    outputBindings: manifestFixture(workflowBytes).outputs,
    values: { prompt: 'A safe synthetic shot.', width: 1280 },
  });
  const taskService = createRemoteTaskService({
    repository: repositories.remote,
    manifestRepository: repositories.comfyManifests,
    client,
    dependencyChecker: createComfyDependencyChecker({ client, timeoutMs: 2000 }),
    createUid: () => TASK_UID,
    timeoutMs: 2000,
  });

  const vault = fakeVault();
  const apiApp = express();
  apiApp.use(express.json({ limit: '2mb' }));
  apiApp.use('/api/v2', remoteConnectionRoutes({ error() {} }, {
    credentialVault: vault,
    createUid: () => CONNECTION_UID,
    async probeHostIdentity() {
      return { algorithm: 'ssh-ed25519', fingerprint: FINGERPRINT };
    },
    remoteSessionService: Object.freeze({
      async openComfyTunnel() { throw new Error('not part of this test'); },
    }),
  }, database));
  apiApp.use('/api/v2', remoteTaskRoutes({ error() {} }, { remoteTasks: taskService }));
  const api = await listen(t, apiApp);
  const apiBase = `${api.origin}/api/v2`;

  const connectionResponse = await fetch(`${apiBase}/remote-connections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Mock Featurize',
      host: 'workspace.example.invalid',
      port: 57339,
      username: 'worker',
      authMethod: 'password',
      secret: 'synthetic-password-never-exported',
      comfyHost: '127.0.0.1',
      comfyPort: 8188,
      remoteWorkDir: 'ai-drama-studio',
    }),
  });
  assert.equal(connectionResponse.status, 201);
  const connection = (await connectionResponse.json()).data;
  const probeResponse = await fetch(`${apiBase}/remote-connections/${CONNECTION_UID}/host-identity/probe`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const probe = (await probeResponse.json()).data;
  const confirmResponse = await fetch(`${apiBase}/remote-connections/${CONNECTION_UID}/host-identity/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedStateVersion: probe.stateVersion, fingerprint: FINGERPRINT }),
  });
  assert.equal(confirmResponse.status, 200);
  assert.equal((await confirmResponse.json()).data.status, 'confirmed');
  assert.equal(JSON.stringify(connection).includes('synthetic-password'), false);
  const readyResponse = await fetch(`${apiBase}/remote-connections/${CONNECTION_UID}`);
  assert.equal(readyResponse.status, 200);
  const readyConnection = (await readyResponse.json()).data;

  const prepareResponse = await fetch(`${apiBase}/remote-tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      connectionUid: CONNECTION_UID,
      connectionEvidenceSha256: readyConnection.connectionEvidenceSha256,
      workflowRunUid: createdRun.run.uid,
      workflowManifestUid: MANIFEST_UID,
      idempotencyKey: `remote-task:v1:${NODE_RUN_UID}`,
      promptSha256: hashRemoteTaskPrompt(compiled.prompt),
      remoteRelativeDir: `tasks/${TASK_UID}`,
    }),
  });
  assert.equal(prepareResponse.status, 201);
  let task = (await prepareResponse.json()).data.task;
  task = taskService.beginUpload(task.uid, { expectedStateVersion: task.stateVersion });

  const transfer = createSftpTransfer({ localRoot });
  const session = Object.freeze({ async sftp() { return new LocalSftp(remoteRoot); } });
  const uploaded = await transfer.uploadFile({
    session,
    localRelativePath: 'input.bin',
    remoteWorkDir: 'ai-drama-studio',
    taskUid: TASK_UID,
    relativePath: 'input/source.bin',
    expectedSha256: sha256(inputBytes),
  });
  assert.equal(uploaded.sha256, sha256(inputBytes));

  const submitResponse = await fetch(`${apiBase}/remote-tasks/${TASK_UID}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedStateVersion: task.stateVersion, prompt: compiled.prompt }),
  });
  assert.equal(submitResponse.status, 200);
  task = (await submitResponse.json()).data;
  assert.equal(task.promptId, promptId);
  assert.deepEqual(
    JSON.parse(JSON.stringify(submittedPrompt)),
    JSON.parse(JSON.stringify(compiled.prompt)),
  );
  task = taskService.markExecuting(task.uid, { expectedStateVersion: task.stateVersion });

  const remoteOutput = path.join(
    remoteRoot, 'ai-drama-studio', 'jobs', TASK_UID, 'output', 'result.mp4',
  );
  fs.mkdirSync(path.dirname(remoteOutput), { recursive: true });
  fs.writeFileSync(remoteOutput, outputBytes);
  const completedPrompt = await client.waitForPrompt(promptId, {
    timeoutMs: 2000,
    pollIntervalMs: 1,
  });
  assert.equal(completedPrompt.outputs[0].fileName, 'result.mp4');
  task = taskService.markDownloading(task.uid, { expectedStateVersion: task.stateVersion });

  const localOutputRelative = `projects/${DRAMA_UID}/assets/${VERSION_UID}.mp4`;
  fs.mkdirSync(path.dirname(path.join(localRoot, ...localOutputRelative.split('/'))), { recursive: true });
  const downloaded = await transfer.downloadFile({
    session,
    localRelativePath: localOutputRelative,
    remoteWorkDir: 'ai-drama-studio',
    taskUid: TASK_UID,
    relativePath: 'output/result.mp4',
    expectedSha256: sha256(outputBytes),
  });
  assert.equal(downloaded.sha256, sha256(outputBytes));

  repositories.assets.create({
    uid: ASSET_UID,
    ownerType: 'drama',
    ownerUid: DRAMA_UID,
    assetType: 'video',
    status: 'draft',
  });
  repositories.assets.addVersion({
    uid: VERSION_UID,
    assetUid: ASSET_UID,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${DRAMA_UID}/videos/${VERSION_UID}`,
    relativePath: localOutputRelative,
    sha256: downloaded.sha256,
    mimeType: 'video/mp4',
    width: 1280,
    height: 720,
    durationMs: 1000,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  task = taskService.markVerifying(task.uid, { expectedStateVersion: task.stateVersion });
  task = taskService.complete(task.uid, {
    expectedStateVersion: task.stateVersion,
    outputAssetVersionUid: VERSION_UID,
  });
  assert.equal(task.stage, 'completed');

  const node = runService.transitionNode({
    nodeRunUid: NODE_RUN_UID,
    expectedStatus: 'running',
    nextStatus: 'succeeded',
    output: { assetVersionUid: task.outputAssetVersionUid, remoteTaskUid: task.uid },
  });
  assert.equal(node.output.assetVersionUid, VERSION_UID);
  runService.transitionWorkflow({
    runUid: RUN_UID,
    expectedStatus: 'running',
    nextStatus: 'succeeded',
  });
  assert.equal(runService.getRun(RUN_UID).run.status, 'succeeded');
  assert.equal(repositories.remote.getFormalTask(TASK_UID).outputAssetVersionUid, VERSION_UID);
  assert.deepEqual(fs.readFileSync(path.join(localRoot, ...localOutputRelative.split('/'))), outputBytes);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
  assert.equal(JSON.stringify(database.prepare('SELECT * FROM remote_tasks WHERE uid=?').get(TASK_UID))
    .includes('synthetic-password'), false);
});
