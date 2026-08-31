'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { compileComfyWorkflow } = require('../../src/integrations/comfyui/workflowCompiler');
const { convertComfyApiWorkflow } = require('../../src/integrations/comfyui/workflowConverter');
const { createComfyUiClient } = require('../../src/integrations/comfyui/client');
const { createH3GenerationHistoryService } = require('../../src/h3/generationHistoryService');
const { createH3LocalVideoInspector } = require('../../src/h3/localVideoInspector');
const { createV2Repositories } = require('../../src/repositories/v2');
const { remoteConnectionEvidenceSha256 } = require('../../src/remote/connectionProfile');
const { createRemoteExecutionCoordinator } = require('../../src/remote/remoteExecutionCoordinator');
const { createRemoteOutputVerifier } = require('../../src/remote/outputVerifier');
const { createSftpTransfer } = require('../../src/remote/sftpTransfer');
const { hashRemoteTaskPrompt } = require('../../src/remote/remoteTask');
const { createRemoteTaskService } = require('../../src/remote/remoteTaskService');
const { createComfyWorkflowManifest } = require('../../src/remote/workflowManifest');
const { createWorkflowRunService, createWorkflowService } = require('../../src/workflows');
const { createMigratedV2Database, insertDrama, uid } = require('./v2RepositoryDatabase');

const CONNECTION_UID = uid(9931);
const MANIFEST_UID = uid(9932);
const TASK_UID = uid(9933);
const NODE_RUN_UID = uid(9934);
const DRAMA_UID = uid(9936);
const WORKFLOW_UID = uid(9937);
const NODE_UID = uid(9938);
const ASSET_UID = uid(9939);
const VERSION_UID = uid(9940);
const SOURCE_VERSION_UID = uid(9942);
const PROMPT = Object.freeze({ 1: Object.freeze({ class_type: 'PromptNode' }) });
const PROVIDER_DETAIL = 'synthetic CUDA out of memory provider detail';
const WORKFLOW = Object.freeze({
  10: Object.freeze({
    class_type: 'PromptNode',
    inputs: Object.freeze({ text: 'old prompt' }),
    _meta: Object.freeze({ title: 'APP_GENERATION_INPUTS' }),
  }),
  20: Object.freeze({
    class_type: 'SaveVideo',
    inputs: Object.freeze({ video: Object.freeze(['10', 0]) }),
    _meta: Object.freeze({ title: 'APP_OUTPUT_VIDEO' }),
  }),
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function partialFiles(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith('.part')) found.push(absolute);
    }
  };
  visit(root);
  return found;
}

class FaultingLocalSftp {
  constructor(root, fault) {
    this.root = root;
    this.fault = fault;
    this.ended = false;
  }

  local(remotePath) {
    return path.join(this.root, ...remotePath.split('/'));
  }

  lstat(remotePath, callback) {
    fs.lstat(this.local(remotePath), callback);
  }

  mkdir(remotePath, callback) {
    fs.mkdir(this.local(remotePath), callback);
  }

  realpath(remotePath, callback) {
    fs.realpath(this.local(remotePath), (error, resolved) => {
      if (error) callback(error);
      else callback(null, `/sandbox/${path.relative(this.root, resolved).replace(/\\/gu, '/')}`);
    });
  }

  fastPut(localPath, remotePath, callback) {
    if (this.fault !== 'upload_network') {
      fs.copyFile(localPath, this.local(remotePath), callback);
      return;
    }
    const source = fs.readFileSync(localPath);
    fs.writeFile(this.local(remotePath), source.subarray(0, Math.min(4, source.length)), (error) => {
      if (error) callback(error);
      else callback(Object.assign(new Error('synthetic interrupted upload'), { code: 'ECONNRESET' }));
    });
  }

  fastGet(remotePath, localPath, callback) {
    if (this.fault !== 'download_disk_full') {
      fs.copyFile(this.local(remotePath), localPath, callback);
      return;
    }
    const source = fs.readFileSync(this.local(remotePath));
    fs.writeFile(localPath, source.subarray(0, Math.min(4, source.length)), (error) => {
      if (error) callback(error);
      else callback(Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' }));
    });
  }

  createReadStream(remotePath) {
    return fs.createReadStream(this.local(remotePath));
  }

  rename(from, to, callback) {
    fs.rename(this.local(from), this.local(to), callback);
  }

  unlink(remotePath, callback) {
    fs.unlink(this.local(remotePath), callback);
  }

  end() {
    this.ended = true;
  }
}

function createTransferFailureFixture(t, fault) {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-p9-fault-local-'));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-p9-fault-remote-'));
  t.after(() => {
    fs.rmSync(localRoot, { force: true, recursive: true });
    fs.rmSync(remoteRoot, { force: true, recursive: true });
  });
  const sftp = new FaultingLocalSftp(remoteRoot, fault);
  return Object.freeze({
    localRoot,
    partialFiles,
    remoteRoot,
    sftp,
    taskUid: TASK_UID,
    transfer: createSftpTransfer({ localRoot }),
    session: Object.freeze({ async sftp() { return sftp; } }),
  });
}

function manifestFixture(workflowBytes) {
  return createComfyWorkflowManifest({
    schemaVersion: 'comfy-workflow-manifest.v1',
    uid: MANIFEST_UID,
    manifestId: 'p9-remote-failure-fixture',
    version: '1.0.0',
    engine: 'comfyui',
    workflowFile: 'fixtures/p9-remote-failure.json',
    workflowSha256: sha256(workflowBytes),
    modelFamily: 'p9-synthetic',
    requirements: [
      { kind: 'node', nodeType: 'PromptNode' },
      { kind: 'node', nodeType: 'SaveVideo' },
    ],
    inputs: {
      prompt: {
        marker: 'APP_GENERATION_INPUTS',
        inputName: 'text',
        valueType: 'string',
        required: true,
      },
    },
    outputs: { video: { marker: 'APP_OUTPUT_VIDEO' } },
    validation: {
      schemaVersion: 'comfy-workflow-manifest.v1',
      workflowFormat: 'api',
      markersValidated: true,
    },
    status: 'validated',
  }, workflowBytes);
}

async function createCoordinatorTransferFailureFixture(t, fault) {
  const transferFixture = createTransferFailureFixture(t, fault);
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'P9 remote failure drama');
  const repositories = createV2Repositories(database);
  const credentialRef = `credential:v1:${uid(9941)}`;
  const connection = repositories.remote.createConnection({
    uid: CONNECTION_UID,
    name: 'P9 failure worker',
    host: 'failure-worker.example.invalid',
    port: 22,
    username: 'fixture',
    hostFingerprint: `SHA256:${'A'.repeat(43)}`,
    credentialRef,
    status: 'ready',
    authMethod: 'password',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
  });
  const connectionEvidenceSha256 = remoteConnectionEvidenceSha256(connection);
  const workflowBytes = Buffer.from(JSON.stringify(WORKFLOW), 'utf8');
  const manifest = manifestFixture(workflowBytes);
  repositories.comfyManifests.create(manifest);
  repositories.assets.create({
    uid: ASSET_UID,
    ownerType: 'drama',
    ownerUid: DRAMA_UID,
    assetType: 'video',
    status: 'draft',
  });
  repositories.assets.addVersion({
    uid: SOURCE_VERSION_UID,
    assetUid: ASSET_UID,
    storageProvider: 'local',
    logicalUri: `asset://drama/p9-remote-failure/${SOURCE_VERSION_UID}`,
    relativePath: `projects/p9-remote-failure/${SOURCE_VERSION_UID}.mp4`,
    sha256: sha256('p9-remote-failure-source-video'),
    mimeType: 'video/mp4',
    width: 608,
    height: 352,
    durationMs: 1625,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  const workflowService = createWorkflowService({
    repositories,
    createUid: () => WORKFLOW_UID,
  });
  const workflow = workflowService.createWorkflow({
    dramaId: 1,
    name: 'P9 coordinator failure workflow',
    description: null,
  });
  workflowService.replaceGraph(workflow.definition.uid, {
    expectedRevision: 0,
    nodes: [{
      uid: NODE_UID,
      nodeType: 'shot.video',
      position: { x: 0, y: 0 },
      config: {
        connectionEvidenceSha256,
        connectionUid: CONNECTION_UID,
        credentialRef,
        manifestUid: MANIFEST_UID,
      },
      domainRef: { type: 'asset', uid: ASSET_UID },
      status: 'ready',
    }],
    edges: [],
  });
  const runService = createWorkflowRunService({ repositories });
  const run = runService.createRun({
    workflowUid: workflow.definition.uid,
    triggerType: 'manual',
  });
  const values = Object.freeze({ prompt: 'Synthetic coordinator failure shot.' });
  const compiled = compileComfyWorkflow({
    convertedWorkflow: convertComfyApiWorkflow(WORKFLOW),
    inputBindings: manifest.inputs,
    outputBindings: manifest.outputs,
    values,
  });
  let submitCalls = 0;
  const client = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:8188',
    requestTimeoutMs: 100,
    async fetchImpl(url, options = {}) {
      const parsed = new URL(url);
      if (parsed.pathname === '/prompt' && options.method === 'POST') {
        submitCalls += 1;
        return jsonResponse({ prompt_id: 'coordinator-fault-prompt', node_errors: {} });
      }
      throw new Error('synthetic unexpected coordinator Comfy request');
    },
  });
  const taskService = createRemoteTaskService({
    repository: repositories.remote,
    manifestRepository: repositories.comfyManifests,
    client,
    dependencyChecker: { async requireReady() { return Object.freeze({ ready: true }); } },
    createUid: () => TASK_UID,
    now: () => '2026-08-30T09:45:00.000Z',
    timeoutMs: 100,
  });
  const request = Object.freeze({
    connectionUid: CONNECTION_UID,
    connectionEvidenceSha256,
    workflowRunUid: run.run.uid,
    workflowManifestUid: MANIFEST_UID,
    idempotencyKey: `remote-task:v1:${run.nodes[0].uid}`,
    promptSha256: hashRemoteTaskPrompt(compiled.prompt),
    remoteRelativeDir: `jobs/${TASK_UID}`,
    maxRetries: 2,
  });
  const task = (await taskService.prepare(request)).task;
  const session = Object.freeze({
    async sftp() { return transferFixture.sftp; },
    async close() {},
  });
  const inspector = createH3LocalVideoInspector({
    localRoot: transferFixture.localRoot,
    ffprobePath: 'synthetic-ffprobe',
    ffmpegPath: 'synthetic-ffmpeg',
    timeoutMs: 1000,
    async runProcess() { return Object.freeze({ exitCode: 0, stdout: '', stderr: '' }); },
  });
  const coordinator = createRemoteExecutionCoordinator({
    repositories,
    taskService,
    sessionService: {
      async openSession() { return Object.freeze({ connection, session }); },
    },
    transfer: transferFixture.transfer,
    remoteClient: {
      async waitForPrompt() {
        return Object.freeze({
          state: 'succeeded',
          outputs: Object.freeze([Object.freeze({
            nodeId: compiled.outputNodeIds.video,
            fileName: 'result.mp4',
            subfolder: `ai-drama-studio/jobs/${TASK_UID}/output`,
            mediaKind: 'video',
          })]),
        });
      },
    },
    outputVerifier: createRemoteOutputVerifier({ h3Inspector: inspector }),
    h3HistoryService: createH3GenerationHistoryService({ repositories }),
    localRoot: transferFixture.localRoot,
    createUid: () => VERSION_UID,
    timeoutMs: 1000,
    heartbeatIntervalMs: 50,
  });
  return Object.freeze({
    ...transferFixture,
    assetUid: ASSET_UID,
    coordinator,
    database,
    executeRequest: Object.freeze({
      expectedStateVersion: task.stateVersion,
      workflowBase64: workflowBytes.toString('base64'),
      values,
      uploads: fault === 'upload_network' ? Object.freeze([Object.freeze({
        localRelativePath: 'input/source.bin',
        remoteRelativePath: 'input/source.bin',
        sha256: sha256(Buffer.from('synthetic upload payload')),
      })]) : Object.freeze([]),
      output: Object.freeze({ logicalName: 'video', assetUid: ASSET_UID }),
    }),
    localOutputRelativePath: `projects/${DRAMA_UID}/assets/${VERSION_UID}.mp4`,
    repositories,
    sourceVersionUid: SOURCE_VERSION_UID,
    runService,
    runUid: run.run.uid,
    nodeRunUid: run.nodes[0].uid,
    submitCalls() { return submitCalls; },
    taskService,
  });
}

function createRemoteFailureFixture(t) {
  const database = createMigratedV2Database(t);
  database.prepare(`
    INSERT INTO remote_connections
      (uid, name, host, port, username, credential_ref, status)
    VALUES (?, 'Failure worker', 'failure-worker.example.invalid', 22, 'fixture', ?, 'ready')
  `).run(CONNECTION_UID, `credential:v1:${uid(9935)}`);
  database.prepare(`
    INSERT INTO workflow_manifests
      (uid, manifest_id, version, engine, workflow_file, workflow_sha256,
       model_family, requirements_json, inputs_json, outputs_json, validation_json, status)
    VALUES (?, 'failure-fixture', '1.0.0', 'comfyui', 'fixtures/failure-workflow.json', ?,
            'fixture', ?, ?, ?, ?, 'validated')
  `).run(
    MANIFEST_UID,
    'a'.repeat(64),
    '[{"kind":"node","nodeType":"PromptNode"}]',
    '{"prompt":{"marker":"APP_INPUT","inputName":"text","valueType":"string","required":true}}',
    '{"video":{"marker":"APP_OUTPUT"}}',
    '{"schemaVersion":"comfy-workflow-manifest.v1","workflowFormat":"api","markersValidated":true}',
  );
  let mode = 'healthy';
  let submitCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/prompt' && options.method === 'POST') {
      submitCalls += 1;
      return jsonResponse({ prompt_id: 'fault-prompt', node_errors: {} });
    }
    if (parsed.pathname === '/history/fault-prompt') {
      if (mode === 'restart') throw new Error('synthetic Comfy restart transport detail');
      if (mode === 'oom') {
        return jsonResponse({
          'fault-prompt': {
            status: {
              completed: true,
              status_str: 'error',
              messages: [["execution_error", { exception_message: PROVIDER_DETAIL }]],
            },
            outputs: {},
          },
        });
      }
      return jsonResponse({
        'fault-prompt': {
          status: { completed: false, status_str: 'running' },
          outputs: {},
        },
      });
    }
    if (parsed.pathname === '/queue') {
      return jsonResponse({ queue_running: [], queue_pending: [] });
    }
    throw new Error('synthetic unexpected Comfy request');
  };
  const repositories = createV2Repositories(database);
  const service = createRemoteTaskService({
    repository: repositories.remote,
    manifestRepository: { get: () => Object.freeze({ uid: MANIFEST_UID }) },
    client: createComfyUiClient({
      baseUrl: 'http://127.0.0.1:8188',
      fetchImpl,
      requestTimeoutMs: 100,
    }),
    dependencyChecker: { async requireReady() { return Object.freeze({ ready: true }); } },
    createUid: () => TASK_UID,
    now: () => '2026-08-30T09:45:00.000Z',
    timeoutMs: 100,
  });
  const request = Object.freeze({
    connectionUid: CONNECTION_UID,
    connectionEvidenceSha256: 'e'.repeat(64),
    workflowRunUid: null,
    workflowManifestUid: MANIFEST_UID,
    idempotencyKey: `remote-task:v1:${NODE_RUN_UID}`,
    promptSha256: hashRemoteTaskPrompt(PROMPT),
    remoteRelativeDir: `jobs/${TASK_UID}`,
    maxRetries: 2,
  });
  return Object.freeze({
    database,
    prompt: PROMPT,
    providerDetail: PROVIDER_DETAIL,
    repositories,
    request,
    service,
    setMode(value) { mode = value; },
    submitCalls() { return submitCalls; },
  });
}

module.exports = Object.freeze({
  createCoordinatorTransferFailureFixture,
  createRemoteFailureFixture,
  createTransferFailureFixture,
  partialFiles,
  sha256,
});
