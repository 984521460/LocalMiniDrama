'use strict';

const {
  createMediaExportRunPublicRecord,
  publicOutputFromReceipt,
} = require('../../media/mediaExportRun');
const {
  parseMediaExportExecutionPlanRecord,
} = require('../../media/mediaExportExecutionPlan');
const { parseMediaExportReceiptRecord } = require('../../media/mediaExportReceipt');
const { exactObject } = require('../../audio/audioContract');
const { validateWorkflowExecutionPlan } = require('../../workflows/executionPlan');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { executeWrite, optimisticResult } = require('./repositorySupport');

const ENTITY = 'media export run';
const NODE_OUTPUT_KEYS = Object.freeze(['schemaVersion', 'executionPlan']);
const PUBLIC_ERROR_CODES = new Set(['MEDIA_EXPORT_FAILED', 'MEDIA_EXPORT_CLEANUP_FAILED']);

function canonicalJson(value, field, maximumBytes) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new V2RepositoryDataError(ENTITY, field);
  }
  try {
    const parsed = JSON.parse(value);
    if (JSON.stringify(parsed) !== value) throw new Error('not canonical');
    return parsed;
  } catch {
    throw new V2RepositoryDataError(ENTITY, field);
  }
}

function planFromNodeRow(row) {
  try {
    const output = exactObject(
      canonicalJson(row.node_output_json, 'node output', 16 * 1024 * 1024),
      NODE_OUTPUT_KEYS,
      'MEDIA_EXPORT_DATA_INVALID',
    );
    if (output.schemaVersion !== 'media-export-node-output.v1') throw new Error('schema');
    const plan = parseMediaExportExecutionPlanRecord(output.executionPlan);
    const graph = validateWorkflowExecutionPlan(
      canonicalJson(row.graph_snapshot_json, 'graph snapshot', 16 * 1024 * 1024),
    );
    const nodes = graph.snapshot.nodes;
    const matches = Array.isArray(nodes)
      ? nodes.filter((node) => node && node.uid === row.node_uid
        && node.nodeType === 'export.final' && node.enabled === true)
      : [];
    if (row.node_status !== 'succeeded' || row.workflow_status !== 'succeeded'
      || matches.length !== 1 || graph.workflowUid !== row.run_workflow_uid
      || graph.graphHash !== row.run_graph_hash
      || graph.graphRevision !== row.run_graph_revision
      || plan.workflowRunUid !== row.workflow_run_uid
      || plan.dramaUid !== row.drama_uid) throw new Error('binding');
    return plan;
  } catch (error) {
    if (error instanceof V2RepositoryDataError) throw error;
    throw new V2RepositoryDataError(ENTITY, 'source node');
  }
}

function assertReceiptMatchesPlan(receipt, plan) {
  if (receipt.uid !== plan.uid || receipt.dramaUid !== plan.dramaUid
    || receipt.workflowRunUid !== plan.workflowRunUid
    || receipt.productionTimelineSnapshotUid !== plan.productionTimelineSnapshotUid
    || receipt.productionTimelineSnapshotSha256 !== plan.productionTimelineSnapshotSha256
    || receipt.normalizationPlanUid !== plan.normalizationPlanUid
    || receipt.normalizationPlanSha256 !== plan.normalizationPlanSha256
    || receipt.executionPlanSha256 !== plan.executionPlanSha256
    || receipt.profileSha256 !== plan.profile.profileSha256
    || receipt.output.relativePath !== plan.outputRelativePath
    || Math.abs(receipt.output.durationMs - plan.durationMs) > 50) {
    throw new V2RepositoryDataError(ENTITY, 'receipt');
  }
}

function createMediaExportRunRepository(database) {
  const sourceNode = database.prepare(`
    SELECT node.uid AS source_node_run_uid, node.node_uid, node.status AS node_status,
      node.output_json AS node_output_json, workflow_run.uid AS workflow_run_uid,
      workflow_run.status AS workflow_status, workflow_run.graph_snapshot_json,
      workflow_run.workflow_uid AS run_workflow_uid,
      workflow_run.graph_hash AS run_graph_hash,
      workflow_run.graph_revision AS run_graph_revision,
      workflow.drama_uid
    FROM node_runs AS node
    JOIN workflow_runs AS workflow_run ON workflow_run.uid=node.workflow_run_uid
    JOIN workflow_definitions AS workflow ON workflow.uid=workflow_run.workflow_uid
    WHERE node.uid=?
  `);
  const getRow = database.prepare(`
    SELECT export_run.*, seal.source_node_run_uid, seal.execution_plan_json,
      seal.execution_plan_sha256, seal.output_asset_uid,
      seal.output_asset_version_uid AS sealed_output_asset_version_uid,
      seal.receipt_json, seal.created_at_epoch_ms, seal.completed_at_epoch_ms,
      asset.owner_type AS output_owner_type, asset.owner_uid AS output_owner_uid,
      asset.asset_type AS output_asset_type, asset.current_version_uid,
      asset.status AS output_asset_status, asset.created_at AS output_asset_created_at,
      asset.updated_at AS output_asset_updated_at, version.asset_uid AS version_asset_uid,
      version.storage_provider, version.logical_uri, version.relative_path,
      version.sha256 AS version_sha256, version.mime_type, version.width, version.height,
      version.duration_ms, version.parent_uid, version.status AS version_status,
      version.created_at AS version_created_at
    FROM export_runs AS export_run
    JOIN media_export_run_seals AS seal ON seal.uid=export_run.uid
    LEFT JOIN assets AS asset ON asset.uid=seal.output_asset_uid
    LEFT JOIN asset_versions AS version ON version.uid=seal.output_asset_version_uid
    WHERE export_run.uid=?
  `);
  const getBySourceRow = database.prepare(`
    SELECT uid AS export_run_uid FROM media_export_run_seals WHERE source_node_run_uid=?
  `);
  const listRows = database.prepare(`
    SELECT seal.uid AS export_run_uid FROM media_export_run_seals AS seal
    JOIN export_runs AS export_run ON export_run.uid=seal.uid
    WHERE export_run.drama_uid=? ORDER BY export_run.created_at DESC,export_run.uid DESC
    LIMIT 100
  `);
  const insertRun = database.prepare(`
    INSERT INTO export_runs (
      uid,drama_uid,workflow_run_uid,timeline_snapshot_json,encoding_json,
      audio_json,subtitle_json,output_asset_version_uid,validation_json,status
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  const insertSeal = database.prepare(`
    INSERT INTO media_export_run_seals (
      uid,source_node_run_uid,execution_plan_json,execution_plan_sha256,
      created_at_epoch_ms
    ) VALUES (?,?,?,?,?)
  `);
  const startRun = database.prepare(`
    UPDATE export_runs SET status='running',started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE uid=? AND status='queued'
  `);
  const completeSeal = database.prepare(`
    UPDATE media_export_run_seals SET output_asset_uid=?,output_asset_version_uid=?,
      receipt_json=?,completed_at_epoch_ms=?
    WHERE uid=? AND completed_at_epoch_ms IS NULL
  `);
  const completeRun = database.prepare(`
    UPDATE export_runs SET status='succeeded',output_asset_version_uid=?,validation_json=?,
      completed_at=?,updated_at=?
    WHERE uid=? AND status='running'
  `);
  const failSeal = database.prepare(`
    UPDATE media_export_run_seals SET completed_at_epoch_ms=?
    WHERE uid=? AND completed_at_epoch_ms IS NULL
  `);
  const failRun = database.prepare(`
    UPDATE export_runs SET status='failed',error_code=?,error_detail_ref=NULL,
      completed_at=?,updated_at=?
    WHERE uid=? AND status='running'
  `);
  const insertAsset = database.prepare(`
    INSERT INTO assets (uid,owner_type,owner_uid,asset_type,status,created_at,updated_at)
    VALUES (?,'drama',?,'final_video','draft',?,?)
  `);
  const insertVersion = database.prepare(`
    INSERT INTO asset_versions (
      uid,asset_uid,storage_provider,logical_uri,relative_path,sha256,mime_type,
      width,height,duration_ms,parent_uid,status,created_at
    ) VALUES (?,?,'local',?,?,?,?,?,?,?,?, 'ready',?)
  `);
  const activateAsset = database.prepare(`
    UPDATE assets SET current_version_uid=?,status='ready',
      updated_at=? WHERE uid=? AND status='draft'
  `);

  function map(uid) {
    const row = getRow.get(uid);
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    try {
      const planValue = canonicalJson(row.execution_plan_json, 'execution plan', 16 * 1024 * 1024);
      const plan = parseMediaExportExecutionPlanRecord(planValue);
      const source = sourceNode.get(row.source_node_run_uid);
      const currentSourcePlan = source ? planFromNodeRow(source) : null;
      if (plan.uid !== row.uid || plan.dramaUid !== row.drama_uid
        || plan.workflowRunUid !== row.workflow_run_uid
        || plan.executionPlanSha256 !== row.execution_plan_sha256
        || currentSourcePlan === null
        || currentSourcePlan.executionPlanSha256 !== plan.executionPlanSha256) {
        throw new V2RepositoryDataError(ENTITY, 'execution plan');
      }
      const terminal = row.status === 'succeeded' || row.status === 'failed';
      const sealCompletedAt = row.completed_at_epoch_ms === null
        ? null : new Date(row.completed_at_epoch_ms).toISOString();
      if ((terminal && sealCompletedAt !== row.completed_at)
        || (!terminal && row.completed_at_epoch_ms !== null)) {
        throw new V2RepositoryDataError(ENTITY, 'completion time');
      }
      let receipt = null;
      let output = null;
      if (row.receipt_json !== null) {
        receipt = parseMediaExportReceiptRecord(
          canonicalJson(row.receipt_json, 'receipt', 1024 * 1024),
        );
        assertReceiptMatchesPlan(receipt, plan);
        const completedAt = new Date(receipt.completedAtEpochMs).toISOString();
        if (row.completed_at_epoch_ms !== receipt.completedAtEpochMs
          || row.output_asset_version_uid !== row.sealed_output_asset_version_uid
          || row.output_owner_type !== 'drama' || row.output_owner_uid !== plan.dramaUid
          || row.output_asset_type !== 'final_video' || row.output_asset_status !== 'ready'
          || row.current_version_uid !== row.sealed_output_asset_version_uid
          || row.version_asset_uid !== row.output_asset_uid || row.storage_provider !== 'local'
          || row.logical_uri !== `asset://dramas/${plan.dramaUid}/final/${row.output_asset_uid}/${row.sealed_output_asset_version_uid}`
          || row.relative_path !== receipt.output.relativePath
          || row.version_sha256 !== receipt.output.sha256 || row.mime_type !== 'video/mp4'
          || row.width !== receipt.output.video.width || row.height !== receipt.output.video.height
          || row.duration_ms !== receipt.output.durationMs || row.parent_uid !== null
          || row.version_status !== 'ready' || row.output_asset_created_at !== completedAt
          || row.output_asset_updated_at !== completedAt
          || row.version_created_at !== completedAt) {
          throw new V2RepositoryDataError(ENTITY, 'output');
        }
        output = publicOutputFromReceipt(receipt);
      }
      return createMediaExportRunPublicRecord({
        schemaVersion: 'media-export-run.v1',
        uid: row.uid,
        dramaUid: row.drama_uid,
        workflowRunUid: row.workflow_run_uid,
        sourceNodeRunUid: row.source_node_run_uid,
        executionPlanSha256: row.execution_plan_sha256,
        status: row.status,
        outputAssetUid: row.output_asset_uid,
        outputAssetVersionUid: row.sealed_output_asset_version_uid,
        output,
        errorCode: row.error_code === null ? null : row.error_code.replace(/^ERR_/u, ''),
        createdAt: row.created_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      });
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      throw new V2RepositoryDataError(ENTITY, 'record');
    }
  }

  const prepareTransaction = database.transaction((nodeRunUid, createdAtEpochMs, expectedDramaUid) => {
    const node = sourceNode.get(nodeRunUid);
    if (!node) throw new V2RepositoryNotFoundError('export node run');
    const plan = planFromNodeRow(node);
    if (expectedDramaUid !== null && plan.dramaUid !== expectedDramaUid) {
      throw new V2RepositoryConflictError(ENTITY, 'prepared');
    }
    const existing = getBySourceRow.get(nodeRunUid);
    if (existing) return map(existing.export_run_uid);
    insertRun.run(
      plan.uid,
      plan.dramaUid,
      plan.workflowRunUid,
      JSON.stringify({ uid: plan.productionTimelineSnapshotUid, sha256: plan.productionTimelineSnapshotSha256 }),
      JSON.stringify(plan.profile),
      JSON.stringify({ mode: plan.mode, uid: plan.audioMixPlan.uid, sha256: plan.audioMixPlan.mixSha256 }),
      JSON.stringify({ trackSha256: plan.subtitleTrackSha256, documentSha256: plan.subtitleDocument.documentSha256 }),
      null,
      '{}',
      'queued',
    );
    insertSeal.run(plan.uid, nodeRunUid, JSON.stringify(plan), plan.executionPlanSha256, createdAtEpochMs);
    return map(plan.uid);
  });

  const completeTransaction = database.transaction((input) => {
    const receipt = parseMediaExportReceiptRecord(input.receipt);
    const row = getRow.get(input.uid);
    if (!row || row.status !== 'running') throw new V2RepositoryConflictError(ENTITY, 'completed');
    const plan = parseMediaExportExecutionPlanRecord(
      canonicalJson(row.execution_plan_json, 'execution plan', 16 * 1024 * 1024),
    );
    assertReceiptMatchesPlan(receipt, plan);
    const completedAt = new Date(receipt.completedAtEpochMs).toISOString();
    insertAsset.run(input.assetUid, plan.dramaUid, completedAt, completedAt);
    insertVersion.run(
      input.assetVersionUid,
      input.assetUid,
      `asset://dramas/${plan.dramaUid}/final/${input.assetUid}/${input.assetVersionUid}`,
      receipt.output.relativePath,
      receipt.output.sha256,
      'video/mp4',
      receipt.output.video.width,
      receipt.output.video.height,
      receipt.output.durationMs,
      null,
      completedAt,
    );
    activateAsset.run(input.assetVersionUid, completedAt, input.assetUid);
    const receiptJson = JSON.stringify(receipt);
    completeSeal.run(
      input.assetUid, input.assetVersionUid, receiptJson, receipt.completedAtEpochMs, input.uid,
    );
    completeRun.run(
      input.assetVersionUid, receiptJson, completedAt, completedAt, input.uid,
    );
    return map(input.uid);
  });

  const failTransaction = database.transaction((uid, errorCode, completedAtEpochMs) => {
    const completedAt = new Date(completedAtEpochMs).toISOString();
    const first = failSeal.run(completedAtEpochMs, uid);
    if (first.changes !== 1) throw new V2RepositoryConflictError(ENTITY, 'failed');
    const second = failRun.run(errorCode, completedAt, completedAt, uid);
    if (second.changes !== 1) throw new V2RepositoryConflictError(ENTITY, 'failed');
    return map(uid);
  });

  const startTransaction = database.transaction((uid) => {
    const result = startRun.run(uid);
    optimisticResult({
      changes: result.changes,
      exists: () => Boolean(getRow.get(uid)),
      entity: ENTITY,
      uid,
      operation: 'started',
    });
    return map(uid);
  });

  return Object.freeze({
    complete(input) {
      return executeWrite(ENTITY, 'completed', () => completeTransaction(input));
    },
    fail(uid, errorCode, completedAtEpochMs) {
      if (!PUBLIC_ERROR_CODES.has(errorCode)) {
        throw new V2RepositoryDataError(ENTITY, 'error code');
      }
      return executeWrite(
        ENTITY,
        'failed',
        () => failTransaction(uid, `ERR_${errorCode}`, completedAtEpochMs),
      );
    },
    get: map,
    getExecutionPlan(uid) {
      map(uid);
      const row = getRow.get(uid);
      if (!row) throw new V2RepositoryNotFoundError(ENTITY);
      try {
        return parseMediaExportExecutionPlanRecord(
          canonicalJson(row.execution_plan_json, 'execution plan', 16 * 1024 * 1024),
        );
      } catch {
        throw new V2RepositoryDataError(ENTITY, 'execution plan');
      }
    },
    getBySourceNodeRun(nodeRunUid) {
      const row = getBySourceRow.get(nodeRunUid);
      return row ? map(row.export_run_uid) : null;
    },
    listByDrama(dramaUid) {
      return Object.freeze(listRows.all(dramaUid).map((row) => map(row.export_run_uid)));
    },
    prepareFromNode(nodeRunUid, createdAtEpochMs, expectedDramaUid = null) {
      try {
        return prepareTransaction(nodeRunUid, createdAtEpochMs, expectedDramaUid);
      } catch (error) {
        if (error instanceof V2RepositoryNotFoundError || error instanceof V2RepositoryDataError) throw error;
        if (typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) {
          throw new V2RepositoryConflictError(ENTITY, 'prepared');
        }
        throw error;
      }
    },
    start(uid) {
      return executeWrite(ENTITY, 'started', () => startTransaction(uid));
    },
  });
}

module.exports = Object.freeze({ createMediaExportRunRepository });
