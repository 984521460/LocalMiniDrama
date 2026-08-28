'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const express = require('express');

const { compileComfyWorkflow } = require('../src/integrations/comfyui/workflowCompiler');
const { convertComfyApiWorkflow } = require('../src/integrations/comfyui/workflowConverter');
const { createV2Repositories } = require('../src/repositories/v2');
const { createSourceDocumentService } = require('../src/narrative/sourceDocuments');
const { hashRemoteTaskPrompt } = require('../src/remote/remoteTask');
const { createComfyWorkflowManifest } = require('../src/remote/workflowManifest');
const { createWorkflowRunService, createWorkflowService } = require('../src/workflows');
const { insertDrama } = require('./helpers/v2RepositoryDatabase');

const FINGERPRINT = `SHA256:${'A'.repeat(43)}`;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return Object.freeze({ promise, resolve });
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

function manifestFixture(uid, workflowBytes) {
  return {
    schemaVersion: 'comfy-workflow-manifest.v1',
    uid,
    manifestId: `mock-production-${uid.slice(-8)}`,
    version: '1.0.0',
    engine: 'comfyui',
    workflowFile: `workflows/${uid}.json`,
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

function fakeCredentialVault() {
  const records = new Map();
  return Object.freeze({
    async store({ kind, secret }) {
      const ref = `credential:v1:${crypto.randomUUID()}`;
      records.set(ref, Object.freeze({ kind, secret: Buffer.from(secret) }));
      return Object.freeze({ ref, kind, configured: true });
    },
    async read(ref) {
      const record = records.get(ref);
      if (!record) throw new Error('synthetic missing credential');
      return Buffer.from(record.secret);
    },
    async inspect(ref) {
      const record = records.get(ref);
      if (!record) throw new Error('synthetic missing credential');
      return Object.freeze({ ref, kind: record.kind, configured: true });
    },
    async remove(ref) { return records.delete(ref); },
  });
}

function remoteDependencies(remoteRoot, comfyOrigin, connectionEndpoints) {
  const origin = new URL(comfyOrigin);
  const sshTransport = Object.freeze({
    async probeHostIdentity() {
      return Object.freeze({ algorithm: 'ssh-ed25519', fingerprint: FINGERPRINT });
    },
    async connect(input) {
      connectionEndpoints.push(Object.freeze({ ...input.endpoint }));
      return Object.freeze({
        async sftp() { return new LocalSftp(remoteRoot); },
        async close() {},
      });
    },
  });
  const tunnelManager = Object.freeze({
    async open({ session }) {
      return Object.freeze({
        host: '127.0.0.1',
        port: Number(origin.port),
        origin: comfyOrigin,
        async close() { await session.close(); },
      });
    },
  });
  return Object.freeze({
    credentialVault: fakeCredentialVault(),
    sshTransport,
    tunnelManager,
    remoteTimeoutMs: 2000,
    executionTimeoutMs: 2000,
  });
}

async function listen(t, app) {
  const server = await new Promise((resolve) => {
    const active = app.listen(0, '127.0.0.1', () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function jsonRequest(url, method, body) {
  const result = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return Object.freeze({ response: result, body: await result.json() });
}

test('the actual application production runtime executes and phase-fails Mock Comfy work', async (t) => {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-p6-production-execution-'));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-p6-production-remote-'));
  const databasePath = path.join(tempRoot, 'data', 'runtime.sqlite').replace(/\\/gu, '/');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/gu, '/');
  const outputBytes = Buffer.from('synthetic production coordinator video');
  let dependencyReady = true;
  let dependencyDelay = null;
  let promptOrdinal = 0;
  const prompts = new Map();
  const connectionEndpoints = [];

  const comfyApp = express();
  comfyApp.use(express.json({ limit: '2mb' }));
  comfyApp.get('/object_info', async (_req, res) => {
    const delay = dependencyDelay;
    if (delay) {
      delay.entered.resolve();
      await delay.release.promise;
      if (dependencyDelay === delay) dependencyDelay = null;
    }
    return res.json(
      dependencyReady ? objectInfoFixture() : { PromptNode: { input: { required: {} } } },
    );
  });
  comfyApp.get('/queue', (_req, res) => res.json({ queue_running: [], queue_pending: [] }));
  comfyApp.post('/prompt', (req, res) => {
    promptOrdinal += 1;
    const promptId = `production-prompt-${promptOrdinal}`;
    const taskUid = req.body.client_id;
    prompts.set(promptId, taskUid);
    const target = path.join(
      remoteRoot, 'ai-drama-studio', 'jobs', taskUid, 'output', 'result.mp4',
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, outputBytes);
    res.json({ prompt_id: promptId, number: promptOrdinal, node_errors: {} });
  });
  comfyApp.get('/history/:promptId', (req, res) => {
    const taskUid = prompts.get(req.params.promptId);
    if (!taskUid) return res.json({});
    return res.json({
      [req.params.promptId]: {
        status: { completed: true, status_str: 'success' },
        outputs: {
          20: {
            gifs: [{
              filename: 'result.mp4',
              subfolder: `ai-drama-studio/jobs/${taskUid}/output`,
              type: 'output',
            }],
          },
        },
      },
    });
  });
  const comfyOrigin = await listen(t, comfyApp);

  fs.mkdirSync(path.join(tempRoot, 'configs'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'configs', 'config.yaml'), [
    'app:',
    '  name: LocalMiniDrama-P6-Production-Execution',
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
    const { app, db } = createApp({
      remoteDependencies: remoteDependencies(remoteRoot, comfyOrigin, connectionEndpoints),
    });
    const origin = await listen(t, app);
    const base = `${origin}/api/v1/v2`;
    const dramaUid = crypto.randomUUID();
    insertDrama(db, dramaUid, 'Production coordinator fixture');
    const repositories = createV2Repositories(db);
    const workflowBytes = Buffer.from(JSON.stringify(workflowFixture()));
    const manifestUid = crypto.randomUUID();
    const manifest = createComfyWorkflowManifest(
      manifestFixture(manifestUid, workflowBytes),
      workflowBytes,
    );
    repositories.comfyManifests.create(manifest);

    const connectionCreate = await jsonRequest(`${base}/remote-connections`, 'POST', {
      name: 'Synthetic production SSH',
      host: 'workspace.example.invalid',
      port: 57339,
      username: 'worker',
      authMethod: 'password',
      secret: 'synthetic-password-never-exported',
      comfyHost: '127.0.0.1',
      comfyPort: 8188,
      remoteWorkDir: 'ai-drama-studio',
    });
    assert.equal(connectionCreate.response.status, 201);
    const connectionUid = connectionCreate.body.data.uid;
    const probed = await jsonRequest(
      `${base}/remote-connections/${connectionUid}/host-identity/probe`, 'POST', {},
    );
    assert.equal(probed.response.status, 200);
    const confirmed = await jsonRequest(
      `${base}/remote-connections/${connectionUid}/host-identity/confirm`,
      'POST',
      { expectedStateVersion: probed.body.data.stateVersion, fingerprint: FINGERPRINT },
    );
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.data.status, 'confirmed');

    const readyResponse = await fetch(`${base}/remote-connections/${connectionUid}`);
    assert.equal(readyResponse.status, 200);
    const readyConnection = (await readyResponse.json()).data;
    assert.match(readyConnection.connectionEvidenceSha256, /^[0-9a-f]{64}$/u);
    const frozenConnectionEvidenceSha256 = readyConnection.connectionEvidenceSha256;

    const connection = repositories.remote.getConnection(connectionUid);
    const outputAssetUid = crypto.randomUUID();
    repositories.assets.create({
      uid: outputAssetUid,
      ownerType: 'drama',
      ownerUid: dramaUid,
      assetType: 'video',
      status: 'draft',
    });
    const workflowService = createWorkflowService({ repositories });
    const workflow = workflowService.createWorkflow({ dramaId: 1, name: 'Remote execution' });
    const sourceService = createSourceDocumentService({ repositories });
    const source = sourceService.importDocument({
      dramaId: 1,
      fileName: 'production-source.md',
      bytes: Buffer.from('# Production source\n\nA bounded local execution fixture.', 'utf8'),
    });
    const selection = sourceService.createSelection({
      documentUid: source.document.uid,
      startBlockUid: source.blocks[0].uid,
      endBlockUid: source.blocks[0].uid,
      startOffset: 0,
      endOffset: Array.from(source.blocks[0].text).length,
    });
    const nodeUid = crypto.randomUUID();
    function videoNode(status = 'ready', config = {}) {
      return {
        uid: nodeUid,
        nodeType: 'shot.video',
        position: { x: 0, y: 0 },
        config: {
          connectionEvidenceSha256: frozenConnectionEvidenceSha256,
          connectionUid,
          credentialRef: connection.credentialRef,
          manifestUid,
          ...config,
        },
        domainRef: { type: 'asset', uid: outputAssetUid },
        status,
      };
    }
    workflowService.replaceGraph(workflow.definition.uid, {
      expectedRevision: 0,
      nodes: [videoNode()],
      edges: [],
    });
    const runService = createWorkflowRunService({ repositories });

    fs.mkdirSync(path.join(storagePath, 'input'), { recursive: true });
    const inputBytes = Buffer.from('synthetic production checked input');
    fs.writeFileSync(path.join(storagePath, 'input', 'source.bin'), inputBytes);
    const compiled = compileComfyWorkflow({
      convertedWorkflow: convertComfyApiWorkflow(workflowFixture()),
      inputBindings: manifest.inputs,
      outputBindings: manifest.outputs,
      values: { prompt: 'A local synthetic shot.', width: 1280 },
    });

    async function preparedExecution(
      connectionEvidenceSha256 = frozenConnectionEvidenceSha256,
    ) {
      const run = runService.createRun({ workflowUid: workflow.definition.uid, triggerType: 'manual' });
      const taskUid = crypto.randomUUID();
      const prepared = await jsonRequest(`${base}/remote-tasks`, 'POST', {
        taskUid,
        connectionUid,
        connectionEvidenceSha256,
        workflowRunUid: run.run.uid,
        workflowManifestUid: manifestUid,
        idempotencyKey: `remote-task:v1:${run.nodes[0].uid}`,
        promptSha256: hashRemoteTaskPrompt(compiled.prompt),
        remoteRelativeDir: `jobs/${taskUid}`,
      });
      assert.equal(prepared.response.status, 201);
      assert.equal(prepared.body.data.task.uid, taskUid);
      return Object.freeze({ run, task: prepared.body.data.task, assetUid: outputAssetUid });
    }

    function executeBody(execution) {
      return {
        expectedStateVersion: execution.task.stateVersion,
        workflowBase64: workflowBytes.toString('base64'),
        values: { prompt: 'A local synthetic shot.', width: 1280 },
        uploads: [{
          localRelativePath: 'input/source.bin',
          remoteRelativePath: 'input/source.bin',
          sha256: sha256(inputBytes),
        }],
        output: { logicalName: 'video', assetUid: execution.assetUid },
      };
    }

    const successful = await preparedExecution();
    const executed = await jsonRequest(
      `${base}/remote-tasks/${successful.task.uid}/execute`,
      'POST',
      executeBody(successful),
    );
    assert.equal(executed.response.status, 200);
    assert.equal(executed.body.data.task.stage, 'completed');
    assert.equal(executed.body.data.node.status, 'succeeded');
    assert.equal(runService.getRun(successful.run.run.uid).run.status, 'succeeded');
    const version = repositories.assets.getVersion(executed.body.data.assetVersion.uid);
    assert.equal(version.sha256, sha256(outputBytes));
    assert.deepEqual(
      fs.readFileSync(path.join(storagePath, ...version.relativePath.split('/'))),
      outputBytes,
    );

    dependencyReady = false;
    const failed = await preparedExecution();
    const rejected = await jsonRequest(
      `${base}/remote-tasks/${failed.task.uid}/execute`,
      'POST',
      executeBody(failed),
    );
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.error.code, 'REMOTE_TASK_DEPENDENCY_NOT_READY');
    const failedTaskResponse = await fetch(`${base}/remote-tasks/${failed.task.uid}`);
    const failedTask = (await failedTaskResponse.json()).data;
    assert.equal(failedTask.stage, 'failed');
    assert.equal(failedTask.errorPhase, 'dependency');
    assert.equal(failedTask.errorCode, 'ERR_REMOTE_DEPENDENCY_FAILED');
    assert.equal(runService.getRun(failed.run.run.uid).run.status, 'failed');
    assert.equal(repositories.assets.listVersions(failed.assetUid).length, 1);
    assert.equal(JSON.stringify(failedTask).includes('synthetic-password'), false);

    dependencyReady = true;
    workflowService.replaceGraph(workflow.definition.uid, {
      expectedRevision: 1,
      nodes: [videoNode('disabled')],
      edges: [],
    });

    async function rejectsBeforeRemote(execution, body = executeBody(execution)) {
      const response = await jsonRequest(
        `${base}/remote-tasks/${execution.task.uid}/execute`,
        'POST',
        body,
      );
      assert.equal(response.response.status, 409);
      assert.equal(response.body.error.code, 'REMOTE_TASK_CONFLICT');
      assert.equal(repositories.remote.getTask(execution.task.uid).stage, 'prepared');
      assert.equal(runService.getRun(execution.run.run.uid).run.status, 'queued');
      assert.equal(fs.existsSync(path.join(
        remoteRoot, 'ai-drama-studio', 'jobs', execution.task.uid,
      )), false);
      assert.equal(promptOrdinal, 1);
    }

    await rejectsBeforeRemote(await preparedExecution());

    workflowService.replaceGraph(workflow.definition.uid, {
      expectedRevision: 2,
      nodes: [{
        uid: nodeUid,
        nodeType: 'source.selection',
        position: { x: 0, y: 0 },
        config: {},
        domainRef: { type: 'source_selection', uid: selection.selection.uid },
        status: 'ready',
      }],
      edges: [],
    });
    await rejectsBeforeRemote(await preparedExecution());

    workflowService.replaceGraph(workflow.definition.uid, {
      expectedRevision: 3,
      nodes: [videoNode('ready', { manifestUid: crypto.randomUUID() })],
      edges: [],
    });
    await rejectsBeforeRemote(await preparedExecution());

    workflowService.replaceGraph(workflow.definition.uid, {
      expectedRevision: 4,
      nodes: [videoNode('ready', { connectionUid: crypto.randomUUID() })],
      edges: [],
    });
    await rejectsBeforeRemote(await preparedExecution());

    workflowService.replaceGraph(workflow.definition.uid, {
      expectedRevision: 5,
      nodes: [videoNode('ready', {
        credentialRef: `credential:v1:${crypto.randomUUID()}`,
      })],
      edges: [],
    });
    await rejectsBeforeRemote(await preparedExecution());

    workflowService.replaceGraph(workflow.definition.uid, {
      expectedRevision: 6,
      nodes: [videoNode()],
      edges: [],
    });
    const otherAssetUid = crypto.randomUUID();
    repositories.assets.create({
      uid: otherAssetUid,
      ownerType: 'drama',
      ownerUid: dramaUid,
      assetType: 'video',
      status: 'draft',
    });
    const wrongAsset = await preparedExecution();
    await rejectsBeforeRemote(wrongAsset, {
      ...executeBody(wrongAsset),
      output: { logicalName: 'video', assetUid: otherAssetUid },
    });

    workflowService.replaceGraph(workflow.definition.uid, {
      expectedRevision: 7,
      nodes: [videoNode()],
      edges: [],
    });
    const staleConnectionExecution = await preparedExecution();
    const currentConnection = repositories.remote.getConnection(connectionUid);
    const updatedConnection = await jsonRequest(
      `${base}/remote-connections/${connectionUid}`,
      'PUT',
      {
        expectedStateVersion: currentConnection.stateVersion,
        name: 'Synthetic production SSH rotated',
        host: 'rotated.example.invalid',
        port: 57340,
        username: 'worker2',
        comfyHost: '127.0.0.1',
        comfyPort: 9199,
        remoteWorkDir: 'ai-drama-studio-v2',
      },
    );
    assert.equal(updatedConnection.response.status, 200);
    assert.equal(updatedConnection.body.data.status, 'unverified');
    const reprobed = await jsonRequest(
      `${base}/remote-connections/${connectionUid}/host-identity/probe`, 'POST', {},
    );
    assert.equal(reprobed.response.status, 200);
    const reconfirmed = await jsonRequest(
      `${base}/remote-connections/${connectionUid}/host-identity/confirm`,
      'POST',
      { expectedStateVersion: reprobed.body.data.stateVersion, fingerprint: FINGERPRINT },
    );
    assert.equal(reconfirmed.response.status, 200);
    assert.equal(reconfirmed.body.data.status, 'confirmed');
    const rotatedResponse = await fetch(`${base}/remote-connections/${connectionUid}`);
    assert.equal(rotatedResponse.status, 200);
    const rotatedConnection = (await rotatedResponse.json()).data;
    assert.notEqual(rotatedConnection.connectionEvidenceSha256, frozenConnectionEvidenceSha256);
    await rejectsBeforeRemote(staleConnectionExecution);

    workflowService.replaceGraph(workflow.definition.uid, {
      expectedRevision: 8,
      nodes: [videoNode('ready', {
        connectionEvidenceSha256: rotatedConnection.connectionEvidenceSha256,
      })],
      edges: [],
    });
    const racingExecution = await preparedExecution(
      rotatedConnection.connectionEvidenceSha256,
    );
    const entered = deferred();
    const release = deferred();
    dependencyDelay = Object.freeze({ entered, release });
    const racingRequest = jsonRequest(
      `${base}/remote-tasks/${racingExecution.task.uid}/execute`,
      'POST',
      executeBody(racingExecution),
    );
    await entered.promise;

    const beforeRaceUpdate = repositories.remote.getConnection(connectionUid);
    const raceUpdated = await jsonRequest(
      `${base}/remote-connections/${connectionUid}`,
      'PUT',
      {
        expectedStateVersion: beforeRaceUpdate.stateVersion,
        name: 'Synthetic production SSH race target',
        host: 'race-new.example.invalid',
        port: 57341,
        username: 'worker3',
        comfyHost: '127.0.0.1',
        comfyPort: 9299,
        remoteWorkDir: 'ai-drama-studio-v3',
      },
    );
    assert.equal(raceUpdated.response.status, 200);
    const raceProbed = await jsonRequest(
      `${base}/remote-connections/${connectionUid}/host-identity/probe`, 'POST', {},
    );
    assert.equal(raceProbed.response.status, 200);
    const raceConfirmed = await jsonRequest(
      `${base}/remote-connections/${connectionUid}/host-identity/confirm`,
      'POST',
      { expectedStateVersion: raceProbed.body.data.stateVersion, fingerprint: FINGERPRINT },
    );
    assert.equal(raceConfirmed.response.status, 200);
    release.resolve();

    const raced = await racingRequest;
    assert.equal(raced.response.status, 502);
    assert.equal(raced.body.error.code, 'REMOTE_TASK_SUBMISSION_FAILED');
    const racedTask = repositories.remote.getFormalTask(racingExecution.task.uid);
    assert.equal(racedTask.promptId, null);
    assert.equal(racedTask.stage, 'failed');
    assert.equal(promptOrdinal, 1);
    assert.equal(fs.existsSync(path.join(
      remoteRoot,
      'ai-drama-studio-v2',
      'jobs',
      racingExecution.task.uid,
      'input',
      'source.bin',
    )), true);
    assert.equal(
      connectionEndpoints.some((endpoint) => endpoint.host === 'race-new.example.invalid'),
      false,
    );

    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(remoteRoot, { recursive: true, force: true });
  }
});
