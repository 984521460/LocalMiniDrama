'use strict';

const { randomUUID } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { createPromptSemanticVersionRecord } = require('../assets/generationHistory');
const {
  createPromptSemanticVersioningService,
} = require('../narrative/promptSemanticVersioning');
const {
  V2RepositoryNotFoundError,
} = require('../repositories/v2/errors');
const { resolveRemoteExecutionBinding } = require('../remote/remoteExecutionBinding');
const { createWorkflowRunService } = require('../workflows');
const { exactKeys, sha256Canonical, snapshot, uid } = require('./contract');
const { fail, isH3ContractError } = require('./errors');
const { validateH3GenerationSpec } = require('./generationSpec');
const { createH3ExecutionBinding } = require('./executionBinding');
const { compileH3ShotPrompt } = require('./promptCompiler');
const { createH3TextToVideoWorkflowBundle } = require('./workflowBundle');
const { assertH3WorkflowVerified } = require('./workflowSupport');

const INPUT_CODE = 'H3_GENERATION_INPUT_INVALID';
const CONFLICT_CODE = 'H3_HISTORY_CONFLICT';

function configuration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('H3 execution intent service configuration is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(['repositories', 'createUid', 'nowEpochMs']);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))
    || !Object.hasOwn(descriptors, 'repositories')) {
    throw new TypeError('H3 execution intent service configuration is invalid');
  }
  const repositories = descriptors.repositories?.value;
  const createUid = descriptors.createUid?.value ?? randomUUID;
  const nowEpochMs = descriptors.nowEpochMs?.value ?? Date.now;
  if (!repositories || typeof repositories !== 'object' || isProxy(repositories)
    || !repositories.assets || !repositories.h3GenerationIntents
    || !repositories.remote || !repositories.runs || !repositories.workflows
    || typeof repositories.withTransaction !== 'function'
    || typeof createUid !== 'function' || isProxy(createUid)
    || typeof nowEpochMs !== 'function' || isProxy(nowEpochMs)) {
    throw new TypeError('H3 execution intent service configuration is invalid');
  }
  return Object.freeze({ repositories, createUid, nowEpochMs });
}

function requestRecord(value) {
  const input = snapshot(value, INPUT_CODE, {
    maxArrayLength: 512,
    maxDepth: 40,
    maxEntries: 60_000,
    maxStringBytes: 512 * 1024,
    maxTotalBytes: 8 * 1024 * 1024,
  });
  exactKeys(input, [
    'taskUid', 'promptInput', 'continuitySnapshotUids', 'generationSpec', 'filenamePrefix',
  ], INPUT_CODE);
  uid(input.taskUid, INPUT_CODE);
  if (!Array.isArray(input.continuitySnapshotUids)) fail(INPUT_CODE);
  return input;
}

function taskNodeContext(repositories, runService, task) {
  if (task.workflowRunUid === null || !task.idempotencyKey.startsWith('remote-task:v1:')) {
    fail(CONFLICT_CODE);
  }
  const nodeRunUid = task.idempotencyKey.slice('remote-task:v1:'.length);
  const aggregate = runService.getRun(task.workflowRunUid);
  const node = runService.getNode(nodeRunUid);
  const planNode = aggregate.run.graphSnapshot.snapshot.nodes.find(
    (candidate) => candidate.uid === node.nodeUid,
  );
  if (!planNode?.domainRef || planNode.domainRef.type !== 'asset') fail(CONFLICT_CODE);
  const asset = repositories.assets.get(planNode.domainRef.uid);
  const connection = repositories.remote.getConnection(task.connectionUid);
  if (node.workflowRunUid !== task.workflowRunUid
    || !resolveRemoteExecutionBinding({ planNode, task, connection, asset })) fail(CONFLICT_CODE);
  return Object.freeze({
    asset,
    connection,
    graphSnapshot: aggregate.run.graphSnapshot,
    nodeUid: node.nodeUid,
    planNode,
  });
}

function samePreparedRequest(intent, task, asset, promptSemantic, generationSpec, binding) {
  return intent.taskUid === task.uid
    && intent.assetUid === asset.uid
    && intent.manifestUid === task.workflowManifestUid
    && intent.promptSemantic.semanticSha256 === promptSemantic.semanticSha256
    && intent.promptSemantic.shotResultUid === promptSemantic.shotResultUid
    && intent.promptSemantic.shotApprovalRef === promptSemantic.shotApprovalRef
    && intent.filenamePrefix === binding.filenamePrefix
    && intent.taskPromptSha256 === binding.taskPromptSha256
    && intent.planEvidenceSha256 === binding.planEvidenceSha256
    && sha256Canonical(intent.generationSpec) === sha256Canonical(generationSpec);
}

function createH3ExecutionIntentService(options) {
  const configured = configuration(options);
  const { repositories } = configured;
  const semanticService = createPromptSemanticVersioningService({ repositories });
  const runService = createWorkflowRunService({ repositories });
  const manifestUid = createH3TextToVideoWorkflowBundle().manifest.uid;

  return Object.freeze({
    prepare(value) {
      const request = requestRecord(value);
      let generationSpec;
      try {
        generationSpec = validateH3GenerationSpec(request.generationSpec);
        assertH3WorkflowVerified(generationSpec);
      } catch (error) {
        if (isH3ContractError(error)) throw error;
        return fail(INPUT_CODE);
      }

      try {
        const semanticResult = semanticService.complete({
          promptInput: request.promptInput,
          continuitySnapshotUids: request.continuitySnapshotUids,
        });
        const matches = semanticResult.output.semanticShots.filter(
          (shot) => shot.shotId === generationSpec.prompt.shotId,
        );
        if (matches.length !== 1) fail(CONFLICT_CODE);
        const compiledPrompt = compileH3ShotPrompt({
          dramaUid: semanticResult.dramaUid,
          semanticShot: matches[0],
        });
        if (sha256Canonical(compiledPrompt) !== sha256Canonical(generationSpec.prompt)) {
          fail(CONFLICT_CODE);
        }

        const task = repositories.remote.getFormalTask(request.taskUid);
        if (task.workflowManifestUid !== manifestUid) fail(CONFLICT_CODE);
        const context = taskNodeContext(repositories, runService, task);
        if (context.asset.ownerUid !== generationSpec.prompt.dramaUid) fail(CONFLICT_CODE);
        const binding = createH3ExecutionBinding({
          generationSpec,
          filenamePrefix: request.filenamePrefix,
          task,
          graphSnapshot: context.graphSnapshot,
          nodeUid: context.nodeUid,
          connection: context.connection,
          asset: context.asset,
          manifestUid,
        });

        const createdAtEpochMs = configured.nowEpochMs();
        const promptSemantic = createPromptSemanticVersionRecord({
          uid: configured.createUid(),
          semantic: semanticResult,
          createdAtEpochMs,
        }, CONFLICT_CODE);
        try {
          const existing = repositories.h3GenerationIntents.getByTask(task.uid);
          if (!samePreparedRequest(
            existing, task, context.asset, promptSemantic, generationSpec, binding,
          )) {
            fail(CONFLICT_CODE);
          }
          return existing;
        } catch (error) {
          if (!(error instanceof V2RepositoryNotFoundError)) throw error;
        }
        if (task.stage !== 'prepared' || task.status !== 'queued'
          || task.promptId !== null || task.outputAssetVersionUid !== null) fail(CONFLICT_CODE);
        return repositories.h3GenerationIntents.prepare({
          uid: configured.createUid(),
          taskUid: task.uid,
          generationRunUid: configured.createUid(),
          historyUid: configured.createUid(),
          assetUid: context.asset.uid,
          promptSemantic,
          generationSpec,
          manifestUid,
          parentVersionUid: context.asset.currentVersionUid,
          ...binding,
          createdAtEpochMs,
        });
      } catch (error) {
        if (isH3ContractError(error)) throw error;
        return fail(CONFLICT_CODE);
      }
    },
  });
}

module.exports = Object.freeze({ createH3ExecutionIntentService });
