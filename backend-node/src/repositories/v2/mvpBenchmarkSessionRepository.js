'use strict';

const { types: { isProxy } } = require('node:util');

const { sha256Canonical } = require('../../h3/contract');
const {
  createMvpBenchmarkSessionPlan,
  isMvpBenchmarkSessionError,
  parseMvpBenchmarkSessionPlan,
  parseMvpBenchmarkSessionRequest,
  serializeMvpBenchmarkSessionJson,
} = require('../../benchmark/mvpBenchmarkSession');
const { validateWorkflowExecutionPlan } = require('../../workflows/executionPlan');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { executeWrite } = require('./repositorySupport');

const ENTITY = 'MVP benchmark session';
const REMOTE_TASK_PREFIX = 'remote-task:v1:';
const JSON_PARSE = JSON.parse;
const STRING_STARTS_WITH = String.prototype.startsWith;
const DEFINE_PROPERTY = Object.defineProperty;
const MAP_CONSTRUCTOR = Map;
const MAP_GET = Map.prototype.get;
const MAP_HAS = Map.prototype.has;
const MAP_SET = Map.prototype.set;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const WORKFLOW_PREPARATION_KEYS = Object.freeze([
  'uid', 'dramaUid', 'workflowRunUid', 'createdAtEpochMs',
]);

function append(target, value) {
  Reflect.apply(DEFINE_PROPERTY, Object, [target, String(target.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  }]);
}

function invalidData() {
  throw new V2RepositoryDataError(ENTITY, 'persisted record');
}

function sorted(values) {
  const output = [];
  for (let index = 0; index < values.length; index += 1) append(output, values[index]);
  for (let index = 1; index < output.length; index += 1) {
    const current = output[index];
    let position = index;
    while (position > 0 && output[position - 1] > current) {
      output[position] = output[position - 1];
      position -= 1;
    }
    output[position] = current;
  }
  return output;
}

function sameStrings(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function workflowPreparationSeed(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) {
    throw new TypeError('MVP benchmark workflow preparation request is invalid');
  }
  let descriptors;
  let prototype;
  try {
    descriptors = Reflect.apply(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
    prototype = Reflect.apply(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
  } catch {
    throw new TypeError('MVP benchmark workflow preparation request is invalid');
  }
  const keys = Reflect.apply(REFLECT_OWN_KEYS, Reflect, [descriptors]);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== WORKFLOW_PREPARATION_KEYS.length) {
    throw new TypeError('MVP benchmark workflow preparation request is invalid');
  }
  const output = Object.create(null);
  for (let index = 0; index < WORKFLOW_PREPARATION_KEYS.length; index += 1) {
    const key = WORKFLOW_PREPARATION_KEYS[index];
    if (!Reflect.apply(OBJECT_HAS_OWN, Object, [descriptors, key])) {
      throw new TypeError('MVP benchmark workflow preparation request is invalid');
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true
      || !Reflect.apply(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) {
      throw new TypeError('MVP benchmark workflow preparation request is invalid');
    }
    output[key] = descriptor.value;
  }
  return output;
}

function createMvpBenchmarkSessionRepository(database, dependencies) {
  const {
    assets, audioModeIntents, h3GenerationIntents, remote, runs, workflows,
  } = dependencies ?? {};
  if (!assets || typeof assets.get !== 'function'
    || !audioModeIntents || typeof audioModeIntents.getExecutionSource !== 'function'
    || !h3GenerationIntents || typeof h3GenerationIntents.getExecutionSource !== 'function'
    || !remote || typeof remote.getFormalTask !== 'function'
    || !runs || typeof runs.getWorkflowWithNodes !== 'function' || typeof runs.getNode !== 'function'
    || !workflows || typeof workflows.getDefinition !== 'function') {
    throw new TypeError('MVP benchmark session repository dependencies are invalid');
  }

  const statements = Object.freeze({
    get: database.prepare('SELECT * FROM mvp_benchmark_sessions WHERE uid=?'),
    getByWorkflow: database.prepare(
      'SELECT * FROM mvp_benchmark_sessions WHERE workflow_run_uid=?',
    ),
    insert: database.prepare(`
      INSERT INTO mvp_benchmark_sessions
        (uid,drama_uid,workflow_run_uid,request_json,plan_json,plan_sha256,created_at_epoch_ms)
      VALUES
        (@uid,@dramaUid,@workflowRunUid,@requestJson,@planJson,@planSha256,@createdAtEpochMs)
    `),
    graph: database.prepare(`
      SELECT run.workflow_uid, run.graph_hash, run.graph_revision, run.graph_snapshot_json,
             run.status AS workflow_run_status,
             definition.drama_uid
      FROM workflow_runs AS run
      JOIN workflow_definitions AS definition ON definition.uid=run.workflow_uid
      WHERE run.uid=?
    `),
    h3: database.prepare(`
      SELECT intent.uid AS intent_uid, intent.asset_uid, intent.manifest_uid,
             intent.generation_spec_sha256, intent.plan_evidence_sha256,
             task.workflow_run_uid, task.idempotency_key,
             task.workflow_manifest_uid, task.stage AS task_stage,
             task.status AS task_status, task.prompt_id,
             task.output_asset_version_uid, node.uid AS node_run_uid,
             node.node_uid, node.status AS node_status
      FROM h3_generation_intents AS intent
      JOIN remote_tasks AS task ON task.uid=intent.task_uid
      JOIN node_runs AS node ON node.uid=substr(task.idempotency_key, 16)
      WHERE task.uid=?
    `),
    audio: database.prepare(`
      SELECT intent.workflow_run_uid, intent.node_run_uid, intent.plan_sha256,
             node.node_uid, node.status AS node_status
      FROM audio_mode_intents AS intent
      JOIN node_runs AS node ON node.uid=intent.node_run_uid
      WHERE intent.uid=?
    `),
    h3Count: database.prepare(`
      SELECT count(*) FROM h3_generation_intents AS intent
      JOIN remote_tasks AS task ON task.uid=intent.task_uid
      WHERE task.workflow_run_uid=?
    `).pluck(),
    audioCount: database.prepare(
      'SELECT count(*) FROM audio_mode_intents WHERE workflow_run_uid=?',
    ).pluck(),
    h3TaskUidsByWorkflow: database.prepare(`
      SELECT task.uid
      FROM h3_generation_intents AS intent
      JOIN remote_tasks AS task ON task.uid=intent.task_uid
      WHERE task.workflow_run_uid=?
      ORDER BY task.uid
    `).pluck(),
    audioIntentUidsByWorkflow: database.prepare(`
      SELECT uid
      FROM audio_mode_intents
      WHERE workflow_run_uid=?
      ORDER BY uid
    `).pluck(),
  });

  function planNodes(plan, nodeType) {
    const output = [];
    for (let order = 0; order < plan.topologicalOrder.length; order += 1) {
      const nodeUid = plan.topologicalOrder[order];
      let matched = null;
      for (let index = 0; index < plan.snapshot.nodes.length; index += 1) {
        const candidate = plan.snapshot.nodes[index];
        if (candidate.uid === nodeUid) {
          if (matched !== null) invalidData();
          matched = candidate;
        }
      }
      if (matched?.enabled === true && matched.nodeType === nodeType) append(output, matched);
    }
    return output;
  }

  function nodeRun(aggregate, uid) {
    let matched = null;
    for (let index = 0; index < aggregate.nodes.length; index += 1) {
      if (aggregate.nodes[index].uid !== uid) continue;
      if (matched !== null) throw new V2RepositoryConflictError(ENTITY, 'prepared');
      matched = aggregate.nodes[index];
    }
    return matched;
  }

  function graphNode(graph, uid) {
    let matched = null;
    for (let index = 0; index < graph.snapshot.nodes.length; index += 1) {
      if (graph.snapshot.nodes[index].uid !== uid) continue;
      if (matched !== null) return null;
      matched = graph.snapshot.nodes[index];
    }
    return matched;
  }

  function buildPlan(request) {
    let aggregate;
    let definition;
    let graph;
    try {
      aggregate = runs.getWorkflowWithNodes(request.workflowRunUid);
      definition = workflows.getDefinition(aggregate.run.workflowUid);
      graph = validateWorkflowExecutionPlan(aggregate.run.graphSnapshot);
    } catch {
      throw new V2RepositoryConflictError(ENTITY, 'prepared');
    }
    if (aggregate.run.status !== 'queued' || definition.dramaUid !== request.dramaUid
      || graph.workflowUid !== definition.uid || graph.workflowUid !== aggregate.run.workflowUid
      || graph.graphHash !== aggregate.run.graphHash
      || graph.graphRevision !== aggregate.run.graphRevision) {
      throw new V2RepositoryConflictError(ENTITY, 'prepared');
    }
    const videoNodes = planNodes(graph, 'shot.video');
    const audioNodes = planNodes(graph, 'audio.tts');
    if (videoNodes.length < 4 || videoNodes.length > 6 || audioNodes.length < 1
      || request.h3TaskUids.length !== videoNodes.length
      || request.audioIntentUids.length !== audioNodes.length) {
      throw new V2RepositoryConflictError(ENTITY, 'prepared');
    }

    const h3ByNode = new MAP_CONSTRUCTOR();
    for (let index = 0; index < request.h3TaskUids.length; index += 1) {
      const taskUid = request.h3TaskUids[index];
      let intent;
      let task;
      let node;
      let asset;
      try {
        intent = h3GenerationIntents.getExecutionSource(taskUid);
        task = remote.getFormalTask(taskUid);
        if (typeof task.idempotencyKey !== 'string'
          || !Reflect.apply(STRING_STARTS_WITH, task.idempotencyKey, [REMOTE_TASK_PREFIX])) {
          throw new TypeError();
        }
        const nodeRunUid = task.idempotencyKey.slice(REMOTE_TASK_PREFIX.length);
        node = runs.getNode(nodeRunUid);
        asset = assets.get(intent.assetUid);
      } catch {
        throw new V2RepositoryConflictError(ENTITY, 'prepared');
      }
      const planNode = graphNode(graph, node.nodeUid);
      if (task.workflowRunUid !== request.workflowRunUid
        || task.stage !== 'prepared' || task.status !== 'queued'
        || task.promptId !== null || task.outputAssetVersionUid !== null
        || node.workflowRunUid !== request.workflowRunUid || node.status !== 'queued'
        || !planNode || planNode.nodeType !== 'shot.video' || planNode.enabled !== true
        || planNode.domainRef?.type !== 'asset' || planNode.domainRef.uid !== intent.assetUid
        || asset.ownerType !== 'drama' || asset.ownerUid !== request.dramaUid
        || intent.promptSemantic.dramaUid !== request.dramaUid
        || intent.manifestUid !== task.workflowManifestUid
        || Reflect.apply(MAP_HAS, h3ByNode, [node.nodeUid])) {
        throw new V2RepositoryConflictError(ENTITY, 'prepared');
      }
      Reflect.apply(MAP_SET, h3ByNode, [node.nodeUid, Object.freeze({
        taskUid,
        intentUid: intent.uid,
        nodeRunUid: node.uid,
        nodeUid: node.nodeUid,
        assetUid: intent.assetUid,
        manifestUid: intent.manifestUid,
        generationSpecSha256: sha256Canonical(intent.generationSpec),
        planEvidenceSha256: intent.planEvidenceSha256,
      })]);
    }

    const audioByNode = new MAP_CONSTRUCTOR();
    for (let index = 0; index < request.audioIntentUids.length; index += 1) {
      const intentUid = request.audioIntentUids[index];
      let intent;
      let node;
      try {
        intent = audioModeIntents.getExecutionSource(intentUid);
        node = nodeRun(aggregate, intent.nodeRunUid);
      } catch {
        throw new V2RepositoryConflictError(ENTITY, 'prepared');
      }
      const planNode = graphNode(graph, node?.nodeUid);
      if (intent.dramaUid !== request.dramaUid
        || intent.workflowRunUid !== request.workflowRunUid
        || !node || node.status !== 'queued'
        || !planNode || planNode.nodeType !== 'audio.tts' || planNode.enabled !== true
        || planNode.domainRef?.type !== 'narrative_result'
        || planNode.domainRef.uid !== intent.shotResultUid
        || Reflect.apply(MAP_HAS, audioByNode, [node.nodeUid])) {
        throw new V2RepositoryConflictError(ENTITY, 'prepared');
      }
      Reflect.apply(MAP_SET, audioByNode, [node.nodeUid, Object.freeze({
        intentUid,
        nodeRunUid: node.uid,
        nodeUid: node.nodeUid,
        planSha256: intent.plan.planSha256,
      })]);
    }

    const h3Tasks = [];
    for (let index = 0; index < videoNodes.length; index += 1) {
      const item = Reflect.apply(MAP_GET, h3ByNode, [videoNodes[index].uid]);
      if (!item) throw new V2RepositoryConflictError(ENTITY, 'prepared');
      append(h3Tasks, item);
    }
    const audioIntents = [];
    for (let index = 0; index < audioNodes.length; index += 1) {
      const item = Reflect.apply(MAP_GET, audioByNode, [audioNodes[index].uid]);
      if (!item) throw new V2RepositoryConflictError(ENTITY, 'prepared');
      append(audioIntents, item);
    }
    return createMvpBenchmarkSessionPlan({
      schemaVersion: 'mvp-benchmark-session-plan.v1',
      uid: request.uid,
      dramaUid: request.dramaUid,
      workflowRunUid: request.workflowRunUid,
      workflowUid: graph.workflowUid,
      graphHash: graph.graphHash,
      graphRevision: graph.graphRevision,
      h3Tasks,
      audioIntents,
      createdAtEpochMs: request.createdAtEpochMs,
    });
  }

  function assertPersistedSources(plan) {
    const graphRow = statements.graph.get(plan.workflowRunUid);
    let graph;
    try { graph = validateWorkflowExecutionPlan(Reflect.apply(JSON_PARSE, JSON, [graphRow?.graph_snapshot_json])); } catch {
      return invalidData();
    }
    if (!graphRow || graphRow.workflow_run_status !== 'queued'
      || graphRow.drama_uid !== plan.dramaUid
      || graphRow.workflow_uid !== plan.workflowUid
      || graphRow.graph_hash !== plan.graphHash || graphRow.graph_revision !== plan.graphRevision
      || graph.graphHash !== plan.graphHash || graph.graphRevision !== plan.graphRevision
      || graph.workflowUid !== plan.workflowUid
      || statements.h3Count.get(plan.workflowRunUid) !== plan.h3Tasks.length
      || statements.audioCount.get(plan.workflowRunUid) !== plan.audioIntents.length) invalidData();

    const videoNodes = planNodes(graph, 'shot.video');
    const audioNodes = planNodes(graph, 'audio.tts');
    if (videoNodes.length !== plan.h3Tasks.length || audioNodes.length !== plan.audioIntents.length) {
      invalidData();
    }
    for (let index = 0; index < plan.h3Tasks.length; index += 1) {
      const item = plan.h3Tasks[index];
      const row = statements.h3.get(item.taskUid);
      let intent;
      try { intent = h3GenerationIntents.getExecutionSource(item.taskUid); } catch { return invalidData(); }
      if (!row || row.intent_uid !== item.intentUid || row.asset_uid !== item.assetUid
        || row.manifest_uid !== item.manifestUid
        || row.generation_spec_sha256 !== item.generationSpecSha256
        || row.plan_evidence_sha256 !== item.planEvidenceSha256
        || row.workflow_run_uid !== plan.workflowRunUid
        || row.workflow_manifest_uid !== item.manifestUid
        || row.task_stage !== 'prepared' || row.task_status !== 'queued'
        || row.prompt_id !== null || row.output_asset_version_uid !== null
        || row.node_run_uid !== item.nodeRunUid || row.node_uid !== item.nodeUid
        || row.node_status !== 'queued'
        || videoNodes[index].uid !== item.nodeUid
        || videoNodes[index].domainRef?.uid !== item.assetUid
        || intent.uid !== item.intentUid || intent.assetUid !== item.assetUid
        || intent.manifestUid !== item.manifestUid
        || intent.planEvidenceSha256 !== item.planEvidenceSha256
        || sha256Canonical(intent.generationSpec) !== item.generationSpecSha256) invalidData();
    }
    for (let index = 0; index < plan.audioIntents.length; index += 1) {
      const item = plan.audioIntents[index];
      const row = statements.audio.get(item.intentUid);
      let intent;
      try { intent = audioModeIntents.getExecutionSource(item.intentUid); } catch { return invalidData(); }
      if (!row || row.workflow_run_uid !== plan.workflowRunUid
        || row.node_run_uid !== item.nodeRunUid || row.node_uid !== item.nodeUid
        || row.plan_sha256 !== item.planSha256 || row.node_status !== 'queued'
        || audioNodes[index].uid !== item.nodeUid
        || intent.uid !== item.intentUid || intent.workflowRunUid !== plan.workflowRunUid
        || intent.nodeRunUid !== item.nodeRunUid || intent.plan.planSha256 !== item.planSha256) {
        invalidData();
      }
    }
    return plan;
  }

  function mapRow(row) {
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    try {
      const requestValue = Reflect.apply(JSON_PARSE, JSON, [row.request_json]);
      const planValue = Reflect.apply(JSON_PARSE, JSON, [row.plan_json]);
      const request = parseMvpBenchmarkSessionRequest(requestValue, 'MVP_BENCHMARK_SESSION_DATA_INVALID');
      const plan = parseMvpBenchmarkSessionPlan(planValue);
      const taskUids = [];
      const intentUids = [];
      for (let index = 0; index < plan.h3Tasks.length; index += 1) {
        taskUids[index] = plan.h3Tasks[index].taskUid;
      }
      for (let index = 0; index < plan.audioIntents.length; index += 1) {
        intentUids[index] = plan.audioIntents[index].intentUid;
      }
      const planTaskUids = sorted(taskUids);
      const planIntentUids = sorted(intentUids);
      if (serializeMvpBenchmarkSessionJson(request) !== row.request_json
        || serializeMvpBenchmarkSessionJson(plan) !== row.plan_json
        || row.uid !== plan.uid || row.uid !== request.uid
        || row.drama_uid !== plan.dramaUid || row.drama_uid !== request.dramaUid
        || row.workflow_run_uid !== plan.workflowRunUid
        || row.workflow_run_uid !== request.workflowRunUid
        || row.plan_sha256 !== plan.planSha256
        || row.created_at_epoch_ms !== plan.createdAtEpochMs
        || row.created_at_epoch_ms !== request.createdAtEpochMs
        || !sameStrings(planTaskUids, request.h3TaskUids)
        || !sameStrings(planIntentUids, request.audioIntentUids)) invalidData();
      return assertPersistedSources(plan);
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return invalidData();
    }
  }

  function get(uid) {
    return mapRow(statements.get.get(uid));
  }

  function prepareRequest(request) {
    const plan = buildPlan(request);
    const existing = statements.get.get(request.uid) ?? statements.getByWorkflow.get(request.workflowRunUid);
    if (existing) {
      const mapped = mapRow(existing);
      if (mapped.uid !== plan.uid || mapped.planSha256 !== plan.planSha256) {
        throw new V2RepositoryConflictError(ENTITY, 'prepared');
      }
      return mapped;
    }
    executeWrite(ENTITY, 'prepared', () => statements.insert.run({
      uid: request.uid,
      dramaUid: request.dramaUid,
      workflowRunUid: request.workflowRunUid,
      requestJson: serializeMvpBenchmarkSessionJson(request),
      planJson: serializeMvpBenchmarkSessionJson(plan),
      planSha256: plan.planSha256,
      createdAtEpochMs: request.createdAtEpochMs,
    }));
    return get(request.uid);
  }

  const prepareTransaction = database.transaction((request) => prepareRequest(request));

  function prepare(value) {
    let request;
    try { request = parseMvpBenchmarkSessionRequest(value); } catch (error) {
      if (isMvpBenchmarkSessionError(error)) throw error;
      throw new TypeError('MVP benchmark session request is invalid');
    }
    return prepareTransaction.immediate(request);
  }

  const prepareFromWorkflowTransaction = database.transaction((seed) => {
    const h3TaskUids = statements.h3TaskUidsByWorkflow.all(seed.workflowRunUid);
    const audioIntentUids = statements.audioIntentUidsByWorkflow.all(seed.workflowRunUid);
    if (h3TaskUids.length < 4 || h3TaskUids.length > 6
      || audioIntentUids.length < 1 || audioIntentUids.length > 32) {
      throw new V2RepositoryConflictError(ENTITY, 'prepared');
    }
    let request;
    try {
      request = parseMvpBenchmarkSessionRequest({
        schemaVersion: 'mvp-benchmark-session-request.v1',
        uid: seed.uid,
        dramaUid: seed.dramaUid,
        workflowRunUid: seed.workflowRunUid,
        h3TaskUids,
        audioIntentUids,
        createdAtEpochMs: seed.createdAtEpochMs,
      });
    } catch (error) {
      if (isMvpBenchmarkSessionError(error)) throw error;
      throw new TypeError('MVP benchmark workflow preparation request is invalid');
    }
    const existing = statements.getByWorkflow.get(request.workflowRunUid);
    if (existing) {
      const mapped = mapRow(existing);
      if (mapped.dramaUid !== request.dramaUid
        || mapped.workflowRunUid !== request.workflowRunUid) {
        throw new V2RepositoryConflictError(ENTITY, 'prepared');
      }
      return mapped;
    }
    return prepareRequest(request);
  });

  function prepareFromWorkflow(value) {
    const seed = workflowPreparationSeed(value);
    return prepareFromWorkflowTransaction.immediate(seed);
  }

  return Object.freeze({ get, prepare, prepareFromWorkflow });
}

module.exports = Object.freeze({ createMvpBenchmarkSessionRepository });
