'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { types: { isProxy } } = require('node:util');

const { compileComfyWorkflow } = require('../integrations/comfyui/workflowCompiler');
const { convertComfyApiWorkflow } = require('../integrations/comfyui/workflowConverter');
const { loadComfyWorkflowJson } = require('../integrations/comfyui/workflowLoader');
const { createWorkflowRunService } = require('../workflows');
const {
  createRemoteTaskError,
  hashRemoteTaskPrompt,
  isRemoteTaskError,
} = require('./remoteTask');
const { remoteExecutionRequest } = require('./remoteExecutionRequest');
const { remoteConnectionEvidenceSha256 } = require('./connectionProfile');
const { createComfyWorkflowManifest } = require('./workflowManifest');
const { resolveRemoteExecutionBinding } = require('./remoteExecutionBinding');
const { isRemoteOutputVerifier } = require('./outputVerifier');
const { isH3GenerationHistoryService } = require('../h3/generationHistoryService');

const OUTPUT_TYPES = Object.freeze({
  '.jpeg': Object.freeze({ mediaKind: 'image', mimeType: 'image/jpeg' }),
  '.jpg': Object.freeze({ mediaKind: 'image', mimeType: 'image/jpeg' }),
  '.mp4': Object.freeze({ mediaKind: 'video', mimeType: 'video/mp4' }),
  '.png': Object.freeze({ mediaKind: 'image', mimeType: 'image/png' }),
  '.webp': Object.freeze({ mediaKind: 'image', mimeType: 'image/webp' }),
});
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function fail(code = 'REMOTE_TASK_UNEXPECTED') {
  throw createRemoteTaskError(code);
}

function configuration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Remote execution coordinator configuration is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const required = [
    'repositories', 'taskService', 'sessionService', 'transfer', 'remoteClient', 'outputVerifier',
    'h3HistoryService', 'localRoot',
  ];
  const optional = ['createUid', 'timeoutMs'];
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))
    || required.some((key) => !Object.hasOwn(descriptors, key))) {
    throw new TypeError('Remote execution coordinator configuration is invalid');
  }
  const input = Object.create(null);
  for (const key of [...required, ...optional]) {
    if (!Object.hasOwn(descriptors, key)) continue;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Remote execution coordinator configuration is invalid');
    }
    input[key] = descriptor.value;
  }
  const methodSets = [
    [input.taskService, [
      'beginUpload', 'complete', 'fail', 'get', 'markDownloading',
      'markExecuting', 'markVerifying', 'submit',
    ]],
    [input.sessionService, ['openSession']],
    [input.transfer, ['downloadFile', 'inspectRemoteFile', 'uploadFile']],
    [input.remoteClient, ['waitForPrompt']],
  ];
  for (const [target, methods] of methodSets) {
    if (!target || typeof target !== 'object' || isProxy(target)
      || methods.some((name) => typeof Object.getOwnPropertyDescriptor(target, name)?.value !== 'function')) {
      throw new TypeError('Remote execution coordinator configuration is invalid');
    }
  }
  const repositories = input.repositories;
  if (!repositories || typeof repositories !== 'object' || isProxy(repositories)
    || !repositories.assets || !repositories.comfyManifests || !repositories.h3GenerationIntents
    || !repositories.remote
    || !repositories.workflows || !repositories.runs
    || typeof repositories.withTransaction !== 'function') {
    throw new TypeError('Remote execution coordinator configuration is invalid');
  }
  const createUid = input.createUid ?? crypto.randomUUID;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof input.localRoot !== 'string' || !path.isAbsolute(input.localRoot)
    || typeof createUid !== 'function' || isProxy(createUid)
    || !isRemoteOutputVerifier(input.outputVerifier)
    || !isH3GenerationHistoryService(input.h3HistoryService)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86_400_000) {
    throw new TypeError('Remote execution coordinator configuration is invalid');
  }
  const localRoot = path.resolve(input.localRoot);
  return Object.freeze({ ...input, createUid, localRoot, timeoutMs });
}

function executionIdentity(request) {
  const hash = crypto.createHash('sha256');
  hash.update(request.workflowBytes);
  hash.update(JSON.stringify({
    expectedStateVersion: request.expectedStateVersion,
    values: request.values,
    uploads: request.uploads,
    output: request.output,
  }));
  return hash.digest('hex');
}

function compileRequest(task, manifest, request) {
  let loaded;
  let compiled;
  try {
    createComfyWorkflowManifest(manifest, request.workflowBytes);
    loaded = loadComfyWorkflowJson(request.workflowBytes);
    compiled = compileComfyWorkflow({
      convertedWorkflow: convertComfyApiWorkflow(loaded.workflow),
      inputBindings: manifest.inputs,
      outputBindings: manifest.outputs,
      values: request.values,
    });
  } catch {
    fail('REMOTE_TASK_INPUT_INVALID');
  }
  if (loaded.sha256 !== manifest.workflowSha256
    || hashRemoteTaskPrompt(compiled.prompt) !== task.promptSha256
    || !Object.hasOwn(compiled.outputNodeIds, request.output.logicalName)) {
    fail('REMOTE_TASK_INPUT_INVALID');
  }
  return compiled;
}

function openedSession(value, connectionUid, expectedEvidenceSha256) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const connection = descriptors.connection?.value;
  const session = descriptors.session?.value;
  if (!connection || !session || typeof connection !== 'object' || typeof session !== 'object'
    || isProxy(connection) || isProxy(session)
    || Object.getOwnPropertyDescriptor(connection, 'uid')?.value !== connectionUid
    || remoteConnectionEvidenceSha256(connection) !== expectedEvidenceSha256
    || typeof Object.getOwnPropertyDescriptor(connection, 'remoteWorkDir')?.value !== 'string'
    || typeof Object.getOwnPropertyDescriptor(session, 'close')?.value !== 'function') fail();
  return Object.freeze({ connection, session });
}

function outputDescriptor(state, compiled, logicalName, connection, taskUid) {
  if (!state || state.state !== 'succeeded' || !Array.isArray(state.outputs)) fail();
  const nodeId = compiled.outputNodeIds[logicalName];
  const matches = state.outputs.filter((entry) => entry.nodeId === nodeId);
  if (matches.length !== 1) fail();
  const selected = matches[0];
  const extension = path.posix.extname(selected.fileName).toLowerCase();
  const type = OUTPUT_TYPES[extension];
  const expectedSubfolder = `${connection.remoteWorkDir}/jobs/${taskUid}/output`;
  if (!type || type.mediaKind !== selected.mediaKind || selected.subfolder !== expectedSubfolder) fail();
  return Object.freeze({
    fileName: selected.fileName,
    mediaKind: type.mediaKind,
    mimeType: type.mimeType,
    remoteRelativePath: `output/${selected.fileName}`,
  });
}

function nodeContext(repositories, runService, task, assetUid) {
  if (task.workflowRunUid === null || !task.idempotencyKey.startsWith('remote-task:v1:')) {
    fail('REMOTE_TASK_INPUT_INVALID');
  }
  if (task.remoteRelativeDir !== `jobs/${task.uid}`) fail('REMOTE_TASK_INPUT_INVALID');
  const nodeRunUid = task.idempotencyKey.slice('remote-task:v1:'.length);
  let aggregate;
  let node;
  let graph;
  let asset;
  let connection;
  try {
    aggregate = runService.getRun(task.workflowRunUid);
    node = runService.getNode(nodeRunUid);
    graph = repositories.workflows.getGraph(aggregate.run.workflowUid);
    asset = repositories.assets.get(assetUid);
    connection = repositories.remote.getConnection(task.connectionUid);
  } catch {
    fail('REMOTE_TASK_INPUT_INVALID');
  }
  const planNode = aggregate.run.graphSnapshot.snapshot.nodes.find(
    (candidate) => candidate.uid === node.nodeUid,
  );
  const binding = resolveRemoteExecutionBinding({ planNode, task, connection, asset });
  if (node.workflowRunUid !== task.workflowRunUid || !binding
    || asset.ownerType !== 'drama' || asset.ownerUid !== graph.definition.dramaUid
    || asset.status === 'deleted'
    || !['queued', 'running'].includes(aggregate.run.status)
    || !['queued', 'running'].includes(node.status)) fail('REMOTE_TASK_CONFLICT');
  return Object.freeze({
    aggregate, asset, binding, connection, dramaUid: graph.definition.dramaUid, node, planNode,
  });
}

async function closeSession(opened) {
  try { await opened.session.close(); } catch { fail(); }
}

function createRemoteExecutionCoordinator(options) {
  const configured = configuration(options);
  const runService = createWorkflowRunService({ repositories: configured.repositories });
  const active = new Map();

  async function withSession(connectionUid, connectionEvidenceSha256, operation) {
    let opened;
    try {
      opened = openedSession(
        await configured.sessionService.openSession(connectionUid, connectionEvidenceSha256),
        connectionUid,
        connectionEvidenceSha256,
      );
      return await operation(opened);
    } catch (error) {
      if (isRemoteTaskError(error)) throw error;
      fail();
    } finally {
      if (opened) await closeSession(opened);
    }
    return undefined;
  }

  function startNode(context, taskUid) {
    let aggregate = context.aggregate;
    if (aggregate.run.status === 'queued') {
      runService.transitionWorkflow({
        runUid: aggregate.run.uid,
        expectedStatus: 'queued',
        nextStatus: 'running',
      });
      aggregate = runService.getRun(aggregate.run.uid);
    }
    let node = aggregate.nodes.find((candidate) => candidate.uid === context.node.uid);
    if (node.status === 'queued') {
      node = runService.transitionNode({
        nodeRunUid: node.uid,
        expectedStatus: 'queued',
        nextStatus: 'running',
        inputSnapshot: { remoteTaskUid: taskUid },
      });
    }
    return node;
  }

  function failNode(taskUid, phase, errorCode, retryable, context) {
    let task;
    try {
      configured.repositories.withTransaction(() => {
        task = configured.taskService.get(taskUid);
        if (!['completed', 'failed', 'cancelled'].includes(task.stage)) {
          task = configured.taskService.fail(taskUid, {
            expectedStateVersion: task.stateVersion,
            phase,
            errorCode,
            retryable,
          });
        }
        if (task.stage !== 'completed') {
          const current = runService.getNode(context.node.uid);
          if (current.status === 'running') {
            runService.transitionNode({
              nodeRunUid: current.uid,
              expectedStatus: 'running',
              nextStatus: 'failed',
              errorCode,
            });
          }
          const aggregate = runService.getRun(context.aggregate.run.uid);
          if (aggregate.run.status === 'running') {
            runService.transitionWorkflow({
              runUid: aggregate.run.uid,
              expectedStatus: 'running',
              nextStatus: 'failed',
              errorCode: 'ERR_WORKFLOW_NODE_FAILED',
            });
          }
        }
      });
    } catch { fail(); }
    return task;
  }

  async function executeOperation(taskUid, request) {
    let task = configured.taskService.get(taskUid);
    if (task.stage !== 'prepared' || task.stateVersion !== request.expectedStateVersion) {
      fail('REMOTE_TASK_CONFLICT');
    }
    let manifest;
    try { manifest = configured.repositories.comfyManifests.get(task.workflowManifestUid); } catch {
      fail('REMOTE_TASK_INPUT_INVALID');
    }
    const compiled = compileRequest(task, manifest, request);
    const context = nodeContext(
      configured.repositories,
      runService,
      task,
      request.output.assetUid,
    );
    let h3Expectation;
    try {
      h3Expectation = configured.outputVerifier.preflight({
        planNode: context.planNode,
        manifest,
        values: request.values,
      });
    } catch {
      fail('REMOTE_TASK_INPUT_INVALID');
    }
    let h3Intent = null;
    if (h3Expectation !== null) {
      try {
        h3Intent = configured.repositories.h3GenerationIntents.getByTask(task.uid);
      } catch {
        fail('REMOTE_TASK_INPUT_INVALID');
      }
      const spec = h3Intent.generationSpec;
      if (h3Intent.taskUid !== task.uid
        || h3Intent.assetUid !== context.asset.uid
        || h3Intent.manifestUid !== manifest.uid
        || spec.width !== request.values.width
        || spec.height !== request.values.height
        || spec.frames !== request.values.frames
        || spec.seed !== request.values.seed
        || spec.prompt.text !== request.values.prompt
        || h3Intent.filenamePrefix !== request.values.filenamePrefix
        || h3Intent.taskPromptSha256 !== task.promptSha256) fail('REMOTE_TASK_INPUT_INVALID');
    }
    configured.repositories.withTransaction(() => {
      startNode(context, task.uid);
      task = configured.taskService.beginUpload(task.uid, {
        expectedStateVersion: task.stateVersion,
      });
    });

    try {
      if (request.uploads.length > 0) {
        await withSession(task.connectionUid, task.connectionEvidenceSha256, async (opened) => {
          for (const upload of request.uploads) {
            await configured.transfer.uploadFile({
              session: opened.session,
              localRelativePath: upload.localRelativePath,
              remoteWorkDir: opened.connection.remoteWorkDir,
              taskUid: task.uid,
              relativePath: upload.remoteRelativePath,
              expectedSha256: upload.sha256,
            });
          }
        });
      }
    } catch {
      failNode(task.uid, 'upload', 'ERR_REMOTE_UPLOAD_FAILED', true, context);
      fail();
    }

    try {
      task = await configured.taskService.submit(task.uid, {
        expectedStateVersion: task.stateVersion,
        prompt: compiled.prompt,
      });
    } catch (error) {
      failNode(task.uid, error.code === 'REMOTE_TASK_DEPENDENCY_NOT_READY'
        ? 'dependency' : 'submission', error.code === 'REMOTE_TASK_DEPENDENCY_NOT_READY'
        ? 'ERR_REMOTE_DEPENDENCY_FAILED' : 'ERR_REMOTE_SUBMISSION_INDETERMINATE', false, context);
      throw error;
    }

    try {
      task = configured.taskService.markExecuting(task.uid, {
        expectedStateVersion: task.stateVersion,
      });
    } catch {
      failNode(task.uid, 'execution', 'ERR_REMOTE_EXECUTION_FAILED', true, context);
      fail();
    }
    let output;
    try {
      const state = await configured.remoteClient.waitForPrompt(
        task.connectionUid,
        task.connectionEvidenceSha256,
        task.promptId,
        { timeoutMs: configured.timeoutMs, pollIntervalMs: 1000 },
      );
      output = outputDescriptor(
        state,
        compiled,
        request.output.logicalName,
        context.connection,
        task.uid,
      );
      if (context.binding.mediaKind !== output.mediaKind) fail('REMOTE_TASK_INPUT_INVALID');
    } catch {
      failNode(task.uid, 'execution', 'ERR_REMOTE_EXECUTION_FAILED', true, context);
      fail();
    }

    try {
      task = configured.taskService.markDownloading(task.uid, {
        expectedStateVersion: task.stateVersion,
      });
    } catch {
      failNode(task.uid, 'download', 'ERR_REMOTE_DOWNLOAD_FAILED', true, context);
      fail();
    }
    let versionUid;
    try { versionUid = configured.createUid(); } catch { fail(); }
    if (typeof versionUid !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(versionUid)) fail();
    const extension = path.posix.extname(output.fileName).toLowerCase();
    const localRelativePath = `projects/${context.dramaUid}/assets/${versionUid}${extension}`;
    let measured;
    try {
      measured = await withSession(task.connectionUid, task.connectionEvidenceSha256, async (opened) => {
        const remote = await configured.transfer.inspectRemoteFile({
          session: opened.session,
          remoteWorkDir: opened.connection.remoteWorkDir,
          taskUid: task.uid,
          relativePath: output.remoteRelativePath,
        });
        await configured.transfer.downloadFile({
          session: opened.session,
          localRelativePath,
          remoteWorkDir: opened.connection.remoteWorkDir,
          taskUid: task.uid,
          relativePath: output.remoteRelativePath,
          expectedSha256: remote.sha256,
        });
        return remote;
      });
    } catch {
      failNode(task.uid, 'download', 'ERR_REMOTE_DOWNLOAD_FAILED', true, context);
      fail();
    }

    let verifiedOutput;
    try {
      verifiedOutput = await configured.outputVerifier.verify({
        planNode: context.planNode,
        manifest,
        localRelativePath,
        remoteSha256: measured.sha256,
        remoteBytes: measured.bytes,
        mimeType: output.mimeType,
      });
    } catch {
      try {
        const target = path.resolve(configured.localRoot, ...localRelativePath.split('/'));
        if (target.startsWith(`${configured.localRoot}${path.sep}`)) await fs.promises.unlink(target);
      } catch { /* fixed cleanup */ }
      failNode(task.uid, 'verification', 'ERR_REMOTE_VERIFICATION_FAILED', false, context);
      fail();
    }

    let version;
    let node;
    let generationHistory = null;
    try {
      configured.repositories.withTransaction((scoped) => {
        version = configured.repositories.assets.addVersion({
          uid: versionUid,
          assetUid: context.asset.uid,
          storageProvider: 'local',
          logicalUri: `asset://dramas/${context.dramaUid}/generated/${versionUid}`,
          relativePath: localRelativePath,
          sha256: measured.sha256,
          mimeType: output.mimeType,
          width: verifiedOutput.width,
          height: verifiedOutput.height,
          durationMs: verifiedOutput.durationMs,
          parentUid: h3Intent === null
            ? context.asset.currentVersionUid
            : h3Intent.parentVersionUid,
          status: 'ready',
        }, { makeCurrent: false });
        task = configured.taskService.markVerifying(task.uid, {
          expectedStateVersion: task.stateVersion,
        });
        if (h3Intent !== null) {
          generationHistory = configured.h3HistoryService.recordPrepared(
            scoped,
            {
              intent: h3Intent,
              remotePromptId: task.promptId,
              outputVersionUid: version.uid,
              measured: verifiedOutput.measured,
            },
          );
        }
        task = configured.taskService.complete(task.uid, {
          expectedStateVersion: task.stateVersion,
          outputAssetVersionUid: version.uid,
        });
        const currentNode = runService.getNode(context.node.uid);
        node = runService.transitionNode({
          nodeRunUid: currentNode.uid,
          expectedStatus: 'running',
          nextStatus: 'succeeded',
          output: { assetVersionUid: version.uid, remoteTaskUid: task.uid },
        });
        const aggregate = runService.getRun(context.aggregate.run.uid);
        if (aggregate.run.status === 'running'
          && aggregate.nodes.every((candidate) => ['succeeded', 'skipped'].includes(candidate.status))) {
          runService.transitionWorkflow({
            runUid: aggregate.run.uid,
            expectedStatus: 'running',
            nextStatus: 'succeeded',
          });
        }
      });
    } catch {
      try {
        const target = path.resolve(configured.localRoot, ...localRelativePath.split('/'));
        if (target.startsWith(`${configured.localRoot}${path.sep}`)) await fs.promises.unlink(target);
      } catch { /* fixed cleanup */ }
      failNode(task.uid, 'verification', 'ERR_REMOTE_VERIFICATION_FAILED', false, context);
      fail();
    }
    return Object.freeze({ task, assetVersion: version, node, generationHistory });
  }

  function execute(taskUid, value) {
    const request = remoteExecutionRequest(value);
    const identity = executionIdentity(request);
    const current = active.get(taskUid);
    if (current) {
      if (current.identity !== identity) fail('REMOTE_TASK_CONFLICT');
      return current.promise;
    }
    const promise = executeOperation(taskUid, request).finally(() => {
      if (active.get(taskUid)?.promise === promise) active.delete(taskUid);
    });
    active.set(taskUid, Object.freeze({ identity, promise }));
    return promise;
  }

  return Object.freeze({ execute });
}

module.exports = Object.freeze({ createRemoteExecutionCoordinator });
