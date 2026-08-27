const { executeWrite, optimisticResult, requiredRow } = require('./repositorySupport');
const { freezeSnapshot, mapRow, mapRows, serializeJson } = require('./rowMapping');

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
      (uid, workflow_uid, graph_snapshot_json, trigger_type, status)
    VALUES
      (@uid, @workflowUid, @graphSnapshotJson, @triggerType, @status)
  `);
  const insertNodeRun = database.prepare(`
    INSERT INTO node_runs
      (uid, workflow_run_uid, node_uid, input_snapshot_json, output_json, cache_key, status)
    VALUES
      (@uid, @workflowRunUid, @nodeUid, @inputSnapshotJson, @outputJson, @cacheKey, @status)
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
    SELECT * FROM node_runs WHERE workflow_run_uid = ? ORDER BY created_at, uid
  `);
  const updateGenerationStatus = database.prepare(`
    UPDATE generation_runs
    SET status = @nextStatus,
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
        started_at = CASE WHEN @nextStatus = 'running' AND started_at IS NULL
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE started_at END,
        completed_at = CASE WHEN @nextStatus IN ('succeeded', 'failed', 'cancelled')
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE completed_at END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND status = @expectedStatus
  `);
  const updateNodeStatus = database.prepare(`
    UPDATE node_runs
    SET status = @nextStatus,
        started_at = CASE WHEN @nextStatus = 'running' AND started_at IS NULL
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE started_at END,
        completed_at = CASE WHEN @nextStatus IN ('succeeded', 'failed', 'cancelled', 'skipped')
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE completed_at END,
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
    return mapRow(requiredRow(getGenerationRow.get(uid), 'generation run', uid), GENERATION_MAP);
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
      const persisted = {
        ...run,
        seed: run.seed ?? null,
        parametersJson: serializeJson(run.parameters, {}),
        inputJson: serializeJson(run.input, {}),
        promptVersionUid: run.promptVersionUid ?? null,
      };
      executeWrite('generation run', 'created', () => insertGeneration.run(persisted));
      return getGeneration(run.uid);
    },

    createWorkflowWithNodes({ run, nodes = [] }) {
      executeWrite('workflow run', 'created', () => createWorkflowTransaction({ run, nodes }));
      return freezeSnapshot({ run: getWorkflow(run.uid), nodes: mapRows(listNodeRunRows.all(run.uid), NODE_RUN_MAP) });
    },

    getExport,
    getGeneration,
    getNode,
    getWorkflow,

    getWorkflowWithNodes(uid) {
      return freezeSnapshot({ run: getWorkflow(uid), nodes: mapRows(listNodeRunRows.all(uid), NODE_RUN_MAP) });
    },

    transitionExportStatus(input) {
      return transition(input, transitionDescriptors.export);
    },

    transitionGenerationStatus(input) {
      return transition(input, transitionDescriptors.generation);
    },

    transitionNodeStatus(input) {
      return transition(input, transitionDescriptors.node);
    },

    transitionWorkflowStatus(input) {
      return transition(input, transitionDescriptors.workflow);
    },
  });
}

module.exports = { createRunRepository };
