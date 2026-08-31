'use strict';

const { createPromptSemanticVersionRecord } = require('../../assets/generationHistory');
const { sha256Canonical } = require('../../h3/contract');
const { createH3ExecutionBinding } = require('../../h3/executionBinding');
const {
  createH3ExecutionIntent,
  validateH3ExecutionIntent,
} = require('../../h3/executionIntent');
const { createH3TextToVideoWorkflowBundle } = require('../../h3/workflowBundle');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
} = require('./errors');
const { executeWrite, requiredRow } = require('./repositorySupport');

function invalidData() {
  throw new V2RepositoryDataError('H3 generation intent', 'persisted record');
}

function promptInput(record) {
  return {
    uid: record.uid,
    semantic: record.semantic,
    createdAtEpochMs: record.createdAtEpochMs,
  };
}

function createH3GenerationIntentRepository(database, {
  assets,
  comfyManifests,
  generationHistory,
  remote,
  requireApprovedShot,
} = {}) {
  if (!assets || typeof assets.get !== 'function' || typeof assets.getVersion !== 'function'
    || !comfyManifests || typeof comfyManifests.get !== 'function'
    || !generationHistory || typeof generationHistory.getPrompt !== 'function'
    || !remote || typeof remote.getConnection !== 'function'
    || typeof remote.getFormalTask !== 'function'
    || typeof requireApprovedShot !== 'function') {
    throw new TypeError('H3 generation intent repository dependencies are invalid');
  }
  let statements;

  function prepared() {
    if (statements) return statements;
    statements = Object.freeze({
      getByTask: database.prepare('SELECT * FROM h3_generation_intents WHERE task_uid = ?'),
      getPlan: database.prepare(`
        SELECT run.graph_snapshot_json, node.node_uid
        FROM remote_tasks AS task
        JOIN node_runs AS node ON node.uid=substr(task.idempotency_key, 16)
          AND node.workflow_run_uid=task.workflow_run_uid
        JOIN workflow_runs AS run ON run.uid=task.workflow_run_uid
        WHERE task.uid=? AND task.contract_version='remote-task.v1'
      `),
      insertIntent: database.prepare(`
        INSERT INTO h3_generation_intents
          (uid, task_uid, generation_run_uid, history_uid, asset_uid, prompt_semantic_uid,
           manifest_uid, parent_version_uid, generation_spec_json, generation_spec_sha256,
           filename_prefix, task_prompt_sha256, plan_evidence_sha256, created_at_epoch_ms)
        VALUES
          (@uid, @taskUid, @generationRunUid, @historyUid, @assetUid, @promptSemanticUid,
           @manifestUid, @parentVersionUid, @generationSpecJson, @generationSpecSha256,
           @filenamePrefix, @taskPromptSha256, @planEvidenceSha256, @createdAtEpochMs)
      `),
      insertPrompt: database.prepare(`
        INSERT INTO prompt_semantic_versions
          (uid, drama_uid, shot_result_uid, shot_result_hash, shot_envelope_hash,
           shot_approval_ref, semantic_sha256, semantic_json, created_at_epoch_ms)
        VALUES
          (@uid, @dramaUid, @shotResultUid, @shotResultHash, @shotEnvelopeHash,
           @shotApprovalRef, @semanticSha256, @semanticJson, @createdAtEpochMs)
      `),
    });
    return statements;
  }

  function assertApproval(prompt) {
    let approved;
    try { approved = requireApprovedShot(prompt.shotResultUid); } catch {
      throw new V2RepositoryConflictError('H3 generation intent', 'approved');
    }
    if (approved.approval.resultHash !== prompt.shotResultHash
      || approved.approval.envelopeHash !== prompt.shotEnvelopeHash
      || approved.approval.reviewRef !== prompt.shotApprovalRef) {
      throw new V2RepositoryConflictError('H3 generation intent', 'approved');
    }
  }

  function assertReferences(intent, { executionSource = false, preparing = false } = {}) {
    const sql = prepared();
    let task;
    let manifest;
    let asset;
    let connection;
    let parent;
    try {
      task = remote.getFormalTask(intent.taskUid);
      manifest = comfyManifests.get(intent.manifestUid);
      asset = assets.get(intent.assetUid);
      connection = remote.getConnection(task.connectionUid);
      parent = intent.parentVersionUid === null
        ? null : assets.getVersion(intent.parentVersionUid);
    } catch {
      return invalidData();
    }
    const planRow = sql.getPlan.get(intent.taskUid);
    const expectedManifest = createH3TextToVideoWorkflowBundle().manifest;
    if (!planRow
      || task.workflowRunUid === null
      || task.workflowManifestUid !== intent.manifestUid
      || sha256Canonical(manifest) !== sha256Canonical(expectedManifest)
      || asset.ownerType !== 'drama'
      || asset.ownerUid !== intent.promptSemantic.dramaUid
      || asset.assetType !== 'video'
      || asset.status === 'deleted'
      || (intent.parentVersionUid !== null && (
        !parent || parent.assetUid !== asset.uid || parent.status !== 'ready'
      ))) invalidData();
    let binding;
    try {
      const graphSnapshot = JSON.parse(planRow.graph_snapshot_json);
      if (JSON.stringify(graphSnapshot) !== planRow.graph_snapshot_json) invalidData();
      binding = createH3ExecutionBinding({
        generationSpec: intent.generationSpec,
        filenamePrefix: intent.filenamePrefix,
        task,
        graphSnapshot,
        nodeUid: planRow.node_uid,
        connection,
        asset,
        manifestUid: intent.manifestUid,
      });
    } catch {
      if (preparing) throw new V2RepositoryConflictError('H3 generation intent', 'prepared');
      return invalidData();
    }
    if (binding.taskPromptSha256 !== intent.taskPromptSha256
      || binding.planEvidenceSha256 !== intent.planEvidenceSha256) invalidData();
    if (executionSource && asset.currentVersionUid !== intent.parentVersionUid) invalidData();
    if (preparing && (task.stage !== 'prepared' || task.status !== 'queued'
      || task.promptId !== null || task.outputAssetVersionUid !== null
      || asset.currentVersionUid !== intent.parentVersionUid)) {
      throw new V2RepositoryConflictError('H3 generation intent', 'prepared');
    }
    assertApproval(intent.promptSemantic);
    return intent;
  }

  function map(row, options) {
    let prompt;
    let generationSpec;
    try {
      prompt = generationHistory.getPrompt(row.prompt_semantic_uid);
      generationSpec = JSON.parse(row.generation_spec_json);
      if (JSON.stringify(generationSpec) !== row.generation_spec_json
        || sha256Canonical(generationSpec) !== row.generation_spec_sha256) invalidData();
      return assertReferences(validateH3ExecutionIntent({
        schemaVersion: 'h3-local-execution-intent.v1',
        uid: row.uid,
        taskUid: row.task_uid,
        generationRunUid: row.generation_run_uid,
        historyUid: row.history_uid,
        assetUid: row.asset_uid,
        promptSemantic: prompt,
        generationSpec,
        manifestUid: row.manifest_uid,
        parentVersionUid: row.parent_version_uid,
        filenamePrefix: row.filename_prefix,
        taskPromptSha256: row.task_prompt_sha256,
        planEvidenceSha256: row.plan_evidence_sha256,
        createdAtEpochMs: row.created_at_epoch_ms,
      }), options);
    } catch (error) {
      if (error instanceof V2RepositoryConflictError) throw error;
      if (error instanceof V2RepositoryDataError) throw error;
      return invalidData();
    }
  }

  const insertTransaction = database.transaction((value) => {
    const intent = createH3ExecutionIntent(value);
    assertReferences(intent, { preparing: true });
    const prompt = createPromptSemanticVersionRecord(promptInput(intent.promptSemantic));
    const existingPrompt = database.prepare(
      'SELECT semantic_sha256, created_at_epoch_ms FROM prompt_semantic_versions WHERE uid = ?',
    ).get(prompt.uid);
    if (existingPrompt) {
      if (existingPrompt.semantic_sha256 !== prompt.semanticSha256
        || existingPrompt.created_at_epoch_ms !== prompt.createdAtEpochMs) {
        throw new V2RepositoryConflictError('prompt semantic version', 'matched');
      }
    } else {
      prepared().insertPrompt.run({ ...prompt, semanticJson: JSON.stringify(prompt.semantic) });
    }
    prepared().insertIntent.run({
      ...intent,
      promptSemanticUid: prompt.uid,
      generationSpecJson: JSON.stringify(intent.generationSpec),
      generationSpecSha256: sha256Canonical(intent.generationSpec),
    });
    return intent.taskUid;
  });

  function getByTask(taskUid) {
    return map(requiredRow(
      prepared().getByTask.get(taskUid),
      'H3 generation intent',
      taskUid,
    ));
  }

  return Object.freeze({
    getByTask,
    getExecutionSource(taskUid) {
      return map(requiredRow(
        prepared().getByTask.get(taskUid),
        'H3 generation intent',
        taskUid,
      ), { executionSource: true });
    },

    prepare(value) {
      let taskUid;
      executeWrite('H3 generation intent', 'created', () => {
        taskUid = insertTransaction(value);
        return { changes: 1 };
      });
      return getByTask(taskUid);
    },
  });
}

module.exports = Object.freeze({ createH3GenerationIntentRepository });
