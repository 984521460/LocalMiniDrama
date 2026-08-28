'use strict';

const { validateWorkflowExecutionPlan } = require('../workflows/executionPlan');
const { hashRemoteTaskPrompt } = require('../remote/remoteTask');
const { resolveRemoteExecutionBinding } = require('../remote/remoteExecutionBinding');
const { sha256Canonical } = require('./contract');
const { fail } = require('./errors');
const { validateH3GenerationSpec } = require('./generationSpec');
const { validateH3OutputExpectation } = require('./outputExpectation');
const { compileH3GenerationWorkflow } = require('./workflowBundle');

const CODE = 'H3_HISTORY_CONFLICT';

function compiledTaskPromptSha256(generationSpec, filenamePrefix) {
  try {
    return hashRemoteTaskPrompt(compileH3GenerationWorkflow({
      generationSpec: validateH3GenerationSpec(generationSpec),
      filenamePrefix,
    }).prompt);
  } catch {
    return fail(CODE);
  }
}

function planEvidenceSha256({
  graphSnapshot,
  nodeUid,
  task,
  connection,
  asset,
  generationSpec,
  manifestUid,
}) {
  let plan;
  let spec;
  try {
    plan = validateWorkflowExecutionPlan(graphSnapshot);
    spec = validateH3GenerationSpec(generationSpec);
  } catch {
    return fail(CODE);
  }
  const matches = plan.snapshot.nodes.filter((candidate) => candidate.uid === nodeUid);
  if (matches.length !== 1) fail(CODE);
  const planNode = matches[0];
  const config = planNode.config;
  let output;
  try {
    output = validateH3OutputExpectation({
      width: config?.width,
      height: config?.height,
      durationMs: config?.durationMs,
      fps: config?.fps,
    });
  } catch {
    return fail(CODE);
  }
  if (!resolveRemoteExecutionBinding({ planNode, task, connection, asset })
    || task.workflowRunUid === null
    || task.workflowManifestUid !== manifestUid
    || planNode.nodeType !== 'shot.video'
    || config.profileUid !== spec.profileUid
    || config.manifestUid !== manifestUid
    || config.width !== spec.width
    || config.height !== spec.height
    || config.seed !== spec.seed
    || config.fps !== spec.fps
    || output.frames !== spec.frames) fail(CODE);
  return sha256Canonical({
    schemaVersion: 'h3-execution-plan-evidence.v1',
    workflowRunUid: task.workflowRunUid,
    workflowUid: plan.workflowUid,
    graphRevision: plan.graphRevision,
    graphHash: plan.graphHash,
    nodeUid,
    planNode,
    taskUid: task.uid,
    connectionEvidenceSha256: task.connectionEvidenceSha256,
    assetUid: asset.uid,
    manifestUid,
    generationSpecSha256: sha256Canonical(spec),
  });
}

function createH3ExecutionBinding(input) {
  const taskPromptSha256 = compiledTaskPromptSha256(
    input.generationSpec,
    input.filenamePrefix,
  );
  if (taskPromptSha256 !== input.task?.promptSha256) fail(CODE);
  return Object.freeze({
    filenamePrefix: input.filenamePrefix,
    taskPromptSha256,
    planEvidenceSha256: planEvidenceSha256(input),
  });
}

module.exports = Object.freeze({
  compiledTaskPromptSha256,
  createH3ExecutionBinding,
  planEvidenceSha256,
});
