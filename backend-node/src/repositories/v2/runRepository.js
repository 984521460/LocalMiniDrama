const { executeWrite, optimisticResult, requiredRow } = require('./repositorySupport');
const { freezeSnapshot, mapRow, mapRows, serializeJson } = require('./rowMapping');
const { createGenerationPayloadSnapshot } = require('../../assets/generationHistory');
const { V2RepositoryDataError } = require('./errors');

const GENERATION_MAP = Object.freeze({
  entity: 'generation run',
  jsonFields: Object.freeze({ parameters_json: 'parameters', input_json: 'input' }),
  jsonKinds: Object.freeze({ parameters_json: 'object', input_json: 'object' }),
});
const WORKFLOW_RUN_MAP = Object.freeze({
  entity: 'workflow run',
  jsonFields: Object.freeze({ graph_snapshot_json: 'graphSnapshot' }),
  jsonKinds: Object.freeze({ graph_snapshot_json: 'object' }),
});
const NODE_RUN_MAP = Object.freeze({
  entity: 'node run',
  jsonFields: Object.freeze({ input_snapshot_json: 'inputSnapshot', output_json: 'output' }),
  jsonKinds: Object.freeze({ input_snapshot_json: 'object', output_json: 'object?' }),
});
const EXPORT_MAP = Object.freeze({
  entity: 'export run',
  jsonFields: Object.freeze({
    timeline_snapshot_json: 'timelineSnapshot',
    encoding_json: 'encoding',
    audio_json: 'audio',
    subtitle_json: 'subtitle',
    validation_json: 'validation',
  }),
  jsonKinds: Object.freeze({
    timeline_snapshot_json: 'object',
    encoding_json: 'object',
    audio_json: 'object',
    subtitle_json: 'object',
    validation_json: 'object',
  }),
});

function createRunRepository(database) {
  const insertGeneration = database.prepare(`
    INSERT INTO generation_runs
      (uid, owner_type, owner_uid, provider, model, seed, parameters_json, input_json,
       prompt_version_uid, status)
    VALUES
      (@uid, @ownerType, @ownerUid, @provider, @model, @seed, @parametersJson, @inputJson,
       @promptVersionUid, @status)
  `);
  const insertWorkflowRun = database.prepare(`
    INSERT INTO workflow_runs
      (uid, workflow_uid, graph_snapshot_json, graph_hash, graph_revision, trigger_type, status)
    VALUES
      (@uid, @workflowUid, @graphSnapshotJson, @graphHash, @graphRevision, @triggerType, @status)
  `);
  const insertNodeRun = database.prepare(`
    INSERT INTO node_runs
      (uid, workflow_run_uid, node_uid, ordinal, input_snapshot_json, output_json, cache_key, status)
    VALUES
      (@uid, @workflowRunUid, @nodeUid, @ordinal, @inputSnapshotJson, @outputJson, @cacheKey, @status)
  `);
  const insertExport = database.prepare(`
    INSERT INTO export_runs
      (uid, drama_uid, workflow_run_uid, timeline_snapshot_json, encoding_json, audio_json,
       subtitle_json, output_asset_version_uid, validation_json, status)
    VALUES
      (@uid, @dramaUid, @workflowRunUid, @timelineSnapshotJson, @encodingJson, @audioJson,
       @subtitleJson, @outputAssetVersionUid, @validationJson, @status)
  `);
  const getGenerationRow = database.prepare('SELECT * FROM generation_runs WHERE uid = ?');
  const getWorkflowRunRow = database.prepare('SELECT * FROM workflow_runs WHERE uid = ?');
  const getNodeRunRow = database.prepare('SELECT * FROM node_runs WHERE uid = ?');
  const getExportRow = database.prepare('SELECT * FROM export_runs WHERE uid = ?');
  const listNodeRunRows = database.prepare(`
    SELECT * FROM node_runs WHERE workflow_run_uid = ? ORDER BY ordinal
  `);
  const listWorkflowRunRows = database.prepare(`
    SELECT * FROM workflow_runs WHERE workflow_uid = ? ORDER BY created_at DESC, uid DESC LIMIT 100
  `);
  const listRecoverableWorkflowRunRows = database.prepare(`
    SELECT uid FROM workflow_runs WHERE status = 'running' ORDER BY created_at, uid
  `);
  const updateGenerationStatus = database.prepare(`
    UPDATE generation_runs
    SET status = @nextStatus,
        output_asset_version_uid = CASE WHEN @nextStatus = 'succeeded'
          THEN @outputAssetVersionUid ELSE NULL END,
        error_code = CASE WHEN @nextStatus = 'failed' THEN @errorCode ELSE NULL END,
        error_detail_ref = CASE WHEN @nextStatus = 'failed' THEN @errorDetailRef ELSE NULL END,
        started_at = CASE WHEN @nextStatus = 'running' AND started_at IS NULL
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE started_at END,
        completed_at = CASE WHEN @nextStatus IN ('succeeded', 'failed', 'cancelled')
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE completed_at END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND status = @expectedStatus
  `);
  const updateWorkflowStatus = database.prepare(`
    UPDATE workflow_runs
    SET status = @nextStatus,
        retry_count = CASE
          WHEN @expectedStatus = 'failed' AND @nextStatus = 'running' THEN retry_count + 1
          ELSE retry_count END,
        started_at = CASE WHEN @nextStatus = 'running' AND started_at IS NULL
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE started_at END,
        completed_at = CASE WHEN @nextStatus IN ('succeeded', 'failed', 'cancelled')
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,
        error_code = CASE WHEN @nextStatus = 'failed' THEN @errorCode ELSE NULL END,
        error_detail_ref = CASE WHEN @nextStatus = 'failed' THEN @errorDetailRef ELSE NULL END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND status = @expectedStatus
  `);
  const updateNodeStatus = database.prepare(`
    UPDATE node_runs
    SET status = @nextStatus,
        input_snapshot_json = CASE
          WHEN @expectedStatus = 'queued' AND @nextStatus = 'running' THEN @inputSnapshotJson
          WHEN @expectedStatus IN ('failed', 'blocked') AND @nextStatus = 'queued' THEN '{}'
          ELSE input_snapshot_json END,
        output_json = CASE WHEN @nextStatus = 'succeeded' THEN @outputJson ELSE NULL END,
        cache_key = CASE
          WHEN @expectedStatus = 'queued' AND @nextStatus = 'running' THEN @cacheKey
          WHEN @expectedStatus IN ('failed', 'blocked') AND @nextStatus = 'queued' THEN NULL
          ELSE cache_key END,
        started_at = CASE WHEN @nextStatus = 'running' AND started_at IS NULL
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHEN @nextStatus = 'queued' THEN NULL ELSE started_at END,
        completed_at = CASE WHEN @nextStatus IN ('succeeded', 'failed', 'cancelled', 'blocked', 'skipped')
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,
        retry_count = CASE WHEN @expectedStatus IN ('failed', 'blocked') AND @nextStatus = 'queued'
          THEN retry_count + 1 ELSE retry_count END,
        error_code = CASE WHEN @nextStatus IN ('failed', 'blocked') THEN @errorCode ELSE NULL END,
        error_detail_ref = CASE WHEN @nextStatus IN ('failed', 'blocked') THEN @errorDetailRef ELSE NULL END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND status = @expectedStatus
  `);
  const updateExportStatus = database.prepare(`
    UPDATE export_runs
    SET status = @nextStatus,
        started_at = CASE WHEN @nextStatus = 'running' AND started_at IS NULL
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE started_at END,
        completed_at = CASE WHEN @nextStatus IN ('succeeded', 'failed', 'cancelled')
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE completed_at END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND status = @expectedStatus
  `);

  const createWorkflowTransaction = database.transaction(({ run, nodes }) => {
    insertWorkflowRun.run({
      ...run,
      graphSnapshotJson: serializeJson(run.graphSnapshot, {}),
    });
    for (const node of nodes) {
      insertNodeRun.run({
        ...node,
        workflowRunUid: run.uid,
        inputSnapshotJson: serializeJson(node.inputSnapshot, {}),
        outputJson: node.output === null || node.output === undefined ? null : serializeJson(node.output, {}),
        cacheKey: node.cacheKey ?? null,
      });
    }
  });

  function getGeneration(uid) {
    const run = mapRow(requiredRow(getGenerationRow.get(uid), 'generation run', uid), GENERATION_MAP);
    try {
      createGenerationPayloadSnapshot({
        parameters: run.parameters,
        input: run.input,
      }, 'GENERATION_HISTORY_DATA_INVALID');
      return run;
    } catch {
      throw new V2RepositoryDataError('generation run', 'payload');
    }
  }

  function getWorkflow(uid) {
    return mapRow(requiredRow(getWorkflowRunRow.get(uid), 'workflow run', uid), WORKFLOW_RUN_MAP);
  }

  function getNode(uid) {
    return mapRow(requiredRow(getNodeRunRow.get(uid), 'node run', uid), NODE_RUN_MAP);
  }

  function getExport(uid) {
    return mapRow(requiredRow(getExportRow.get(uid), 'export run', uid), EXPORT_MAP);
  }

  function transition({ uid, expectedStatus, nextStatus }, descriptor) {
    const result = executeWrite(descriptor.entity, 'transitioned', () => descriptor.statement.run({
      uid,
      expectedStatus,
      nextStatus,
    }));
    optimisticResult({
      changes: result.changes,
      exists: () => Boolean(descriptor.getRow.get(uid)),
      entity: descriptor.entity,
      uid,
      operation: 'transitioned',
    });
    return descriptor.get(uid);
  }

  const transitionDescriptors = Object.freeze({
    generation: Object.freeze({ entity: 'generation run', statement: updateGenerationStatus, getRow: getGenerationRow, get: getGeneration }),
    workflow: Object.freeze({ entity: 'workflow run', statement: updateWorkflowStatus, getRow: getWorkflowRunRow, get: getWorkflow }),
    node: Object.freeze({ entity: 'node run', statement: updateNodeStatus, getRow: getNodeRunRow, get: getNode }),
    export: Object.freeze({ entity: 'export run', statement: updateExportStatus, getRow: getExportRow, get: getExport }),
  });

  return Object.freeze({
    createExport(run) {
      const persisted = {
        ...run,
        workflowRunUid: run.workflowRunUid ?? null,
        timelineSnapshotJson: serializeJson(run.timelineSnapshot, {}),
        encodingJson: serializeJson(run.encoding, {}),
        audioJson: serializeJson(run.audio, {}),
        subtitleJson: serializeJson(run.subtitle, {}),
        outputAssetVersionUid: run.outputAssetVersionUid ?? null,
        validationJson: serializeJson(run.validation, {}),
      };
      executeWrite('export run', 'created', () => insertExport.run(persisted));
      return getExport(run.uid);
    },

    createGeneration(run) {
      const payload = createGenerationPayloadSnapshot({
        parameters: run.parameters,
        input: run.input,
      });
      const persisted = {
        ...run,
        seed: run.seed ?? null,
        parametersJson: serializeJson(payload.parameters, {}),
        inputJson: serializeJson(payload.input, {}),
        promptVersionUid: run.promptVersionUid ?? null,
      };
      executeWrite('generation run', 'created', () => insertGeneration.run(persisted));
      return getGeneration(run.uid);
    },

    createWorkflowWithNodes({ run, nodes = [] }) {
      const persisted = {
        ...run,
        graphHash: run.graphHash,
        graphRevision: run.graphRevision,
      };
      executeWrite('workflow run', 'created', () => createWorkflowTransaction({ run: persisted, nodes }));
      return freezeSnapshot({ run: getWorkflow(run.uid), nodes: mapRows(listNodeRunRows.all(run.uid), NODE_RUN_MAP) });
    },

    getExport,
    getGeneration,
    getNode,
    getWorkflow,

    getWorkflowWithNodes(uid) {
      return freezeSnapshot({ run: getWorkflow(uid), nodes: mapRows(listNodeRunRows.all(uid), NODE_RUN_MAP) });
    },

    listWorkflowRuns(workflowUid) {
      return mapRows(listWorkflowRunRows.all(workflowUid), WORKFLOW_RUN_MAP);
    },

    listRecoverableWorkflowRunUids() {
      return Object.freeze(listRecoverableWorkflowRunRows.all().map((row) => row.uid));
    },

    transitionExportStatus(input) {
      return transition(input, transitionDescriptors.export);
    },

    transitionGenerationStatus(input) {
      const result = executeWrite('generation run', 'transitioned', () => updateGenerationStatus.run({
        uid: input.uid,
        expectedStatus: input.expectedStatus,
        nextStatus: input.nextStatus,
        outputAssetVersionUid: input.outputAssetVersionUid ?? null,
        errorCode: input.errorCode ?? null,
        errorDetailRef: input.errorDetailRef ?? null,
      }));
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getGenerationRow.get(input.uid)),
        entity: 'generation run',
        uid: input.uid,
        operation: 'transitioned',
      });
      return getGeneration(input.uid);
    },

    transitionNodeStatus(input) {
      const result = executeWrite('node run', 'transitioned', () => updateNodeStatus.run({
        uid: input.uid,
        expectedStatus: input.expectedStatus,
        nextStatus: input.nextStatus,
        inputSnapshotJson: serializeJson(input.inputSnapshot, {}),
        outputJson: input.output === undefined || input.output === null
          ? null
          : serializeJson(input.output, {}),
        cacheKey: input.cacheKey ?? null,
        errorCode: input.errorCode ?? null,
        errorDetailRef: input.errorDetailRef ?? null,
      }));
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getNodeRunRow.get(input.uid)),
        entity: 'node run',
        uid: input.uid,
        operation: 'transitioned',
      });
      return getNode(input.uid);
    },

    transitionWorkflowStatus(input) {
      const result = executeWrite('workflow run', 'transitioned', () => updateWorkflowStatus.run({
        uid: input.uid,
        expectedStatus: input.expectedStatus,
        nextStatus: input.nextStatus,
        errorCode: input.errorCode ?? null,
        errorDetailRef: input.errorDetailRef ?? null,
      }));
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getWorkflowRunRow.get(input.uid)),
        entity: 'workflow run',
        uid: input.uid,
        operation: 'transitioned',
      });
      return getWorkflow(input.uid);
    },
  });
}

module.exports = { createRunRepository };
