'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv2020 = require('ajv/dist/2020');

const { createMediaExportReceipt } = require('../src/media/mediaExportReceipt');
const { createProjectManifest } = require('../src/adapters/v2/zip/manifest');
const { parseMediaExportExecutionPlanRecord } = require('../src/media/mediaExportExecutionPlan');
const {
  createMediaExportRunPublicRecord,
  createMediaExportRunRequest,
} = require('../src/media/mediaExportRun');
const { createMediaExportService } = require('../src/media/mediaExportService');
const { createV2Repositories } = require('../src/repositories/v2');
const {
  createWorkflowExecutionPlan,
  validateWorkflowExecutionPlan,
} = require('../src/workflows/executionPlan');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');
const { createLocalMediaExportFixture } = require('./helpers/v8LocalMediaFixture');
const { uid: v8Uid } = require('./helpers/v8AudioFixture');

const DRAMA_UID = v8Uid(1);
const WORKFLOW_UID = uid(20);
const WORKFLOW_RUN_UID = v8Uid(21);
const SOURCE_NODE_UID = uid(90008);
const SOURCE_NODE_RUN_UID = uid(90009);
const NODE_UID = uid(90010);
const NODE_RUN_UID = uid(90011);
const SOURCE_ASSET_UID = uid(90012);

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function graphHash(snapshot) {
  return createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');
}

function seedSucceededExportNode(database, executionPlan) {
  insertDrama(database, DRAMA_UID, 'Media export run drama');
  database.prepare(`
    INSERT INTO workflow_definitions (uid,drama_uid,name,registry_version,graph_revision)
    VALUES (?,?,'Media export workflow','4.0.0',0)
  `).run(WORKFLOW_UID, DRAMA_UID);
  const repositories = createV2Repositories(database);
  repositories.assets.create({
    uid: SOURCE_ASSET_UID,
    ownerType: 'drama',
    ownerUid: DRAMA_UID,
    assetType: 'video',
    status: 'draft',
  });
  database.prepare(`
    INSERT INTO canvas_nodes (
      uid,workflow_uid,node_type,position_json,config_json,
      domain_ref_type,domain_ref_uid,status
    ) VALUES (?,?,'shot.video','{"x":0,"y":0}',
      '{"durationMs":1500,"fps":24,"height":1080,"width":1920}',
      'asset',?,'ready')
  `).run(SOURCE_NODE_UID, WORKFLOW_UID, SOURCE_ASSET_UID);
  database.prepare(`
    INSERT INTO canvas_nodes (
      uid,workflow_uid,node_type,position_json,config_json,status
    ) VALUES (?,?,'export.final','{"x":300,"y":0}',
      '{"format":"mp4","fps":24,"height":1080,"width":1920}','ready')
  `).run(NODE_UID, WORKFLOW_UID);
  database.prepare(`
    INSERT INTO canvas_edges (
      uid,workflow_uid,source_node_uid,source_port,target_node_uid,target_port
    ) VALUES (?,?,?,'video',?,'videos')
  `).run(uid(90015), WORKFLOW_UID, SOURCE_NODE_UID, NODE_UID);
  const graphSnapshot = createWorkflowExecutionPlan({
    definition: {
      uid: WORKFLOW_UID,
      dramaUid: DRAMA_UID,
      graphRevision: 0,
      registryVersion: '4.0.0',
    },
    nodes: [
      {
        uid: SOURCE_NODE_UID,
        nodeType: 'shot.video',
        position: { x: 0, y: 0 },
        config: {
          durationMs: 1500,
          fps: 24,
          height: 1080,
          width: 1920,
        },
        domainRefType: 'asset',
        domainRefUid: SOURCE_ASSET_UID,
        status: 'ready',
      },
      {
        uid: NODE_UID,
        nodeType: 'export.final',
        position: { x: 300, y: 0 },
        config: { format: 'mp4', fps: 24, height: 1080, width: 1920 },
        domainRefType: null,
        domainRefUid: null,
        status: 'ready',
      },
    ],
    edges: [{
      uid: uid(90015),
      sourceNodeUid: SOURCE_NODE_UID,
      sourcePort: 'video',
      targetNodeUid: NODE_UID,
      targetPort: 'videos',
    }],
  }, repositories);
  repositories.runs.createWorkflowWithNodes({
    run: {
      uid: WORKFLOW_RUN_UID,
      workflowUid: WORKFLOW_UID,
      graphSnapshot,
      graphHash: graphSnapshot.graphHash,
      graphRevision: 0,
      triggerType: 'manual',
      status: 'queued',
    },
    nodes: [
      {
        uid: SOURCE_NODE_RUN_UID,
        nodeUid: SOURCE_NODE_UID,
        ordinal: 0,
        inputSnapshot: {},
        output: null,
        cacheKey: null,
        status: 'queued',
      },
      {
        uid: NODE_RUN_UID,
        nodeUid: NODE_UID,
        ordinal: 1,
        inputSnapshot: {},
        output: null,
        cacheKey: null,
        status: 'queued',
      },
    ],
  });
  repositories.runs.transitionWorkflowStatus({
    uid: WORKFLOW_RUN_UID, expectedStatus: 'queued', nextStatus: 'running',
  });
  repositories.runs.transitionNodeStatus({
    uid: SOURCE_NODE_RUN_UID,
    expectedStatus: 'queued',
    nextStatus: 'running',
    inputSnapshot: {},
  });
  repositories.runs.transitionNodeStatus({
    uid: SOURCE_NODE_RUN_UID,
    expectedStatus: 'running',
    nextStatus: 'succeeded',
    output: {},
  });
  repositories.runs.transitionNodeStatus({
    uid: NODE_RUN_UID, expectedStatus: 'queued', nextStatus: 'running', inputSnapshot: {},
  });
  repositories.runs.transitionNodeStatus({
    uid: NODE_RUN_UID,
    expectedStatus: 'running',
    nextStatus: 'succeeded',
    output: { schemaVersion: 'media-export-node-output.v1', executionPlan },
  });
  repositories.runs.transitionWorkflowStatus({
    uid: WORKFLOW_RUN_UID, expectedStatus: 'running', nextStatus: 'succeeded',
  });
  return repositories;
}

function receiptFor(executionPlan, completedAtEpochMs) {
  return createMediaExportReceipt({
    schemaVersion: '8.0',
    executionPlan,
    completedAtEpochMs,
    output: {
      relativePath: executionPlan.outputRelativePath,
      sha256: 'b'.repeat(64),
      bytes: 2048,
      durationMs: executionPlan.durationMs,
      formatNames: ['mov', 'mp4'],
      video: {
        codecName: 'h264', width: 1920, height: 1080, pixelFormat: 'yuv420p',
        averageFrameRate: { numerator: 24, denominator: 1 },
        timeBase: { numerator: 1, denominator: 90000 },
        sampleAspectRatio: '1:1', displayAspectRatio: '16:9', frameCount: 36,
      },
      audio: {
        codecName: 'aac', sampleRateHz: 48000, channels: 2,
        channelLayout: 'stereo', sampleFormat: 'fltp',
      },
      decoded: true,
      fastStart: true,
    },
  });
}

test('P8-10 request accepts only an opaque succeeded export node reference', () => {
  const nodeRunUid = uid(90001);
  assert.deepEqual(createMediaExportRunRequest({ nodeRunUid }), { nodeRunUid });
  for (const value of [
    {},
    { nodeRunUid, executionPlan: {} },
    { nodeRunUid: '../node' },
    new Proxy({ nodeRunUid }, { ownKeys() { throw new Error('trap'); } }),
  ]) assert.throws(
    () => createMediaExportRunRequest(value),
    (error) => error.code === 'MEDIA_EXPORT_RUN_INPUT_INVALID',
  );
});

test('P8-10 public record is path-safe and exposes only sealed result evidence', () => {
  const run = {
    schemaVersion: 'media-export-run.v1',
    uid: uid(90002),
    dramaUid: uid(90003),
    workflowRunUid: uid(90004),
    sourceNodeRunUid: uid(90005),
    executionPlanSha256: 'a'.repeat(64),
    status: 'succeeded',
    outputAssetUid: uid(90006),
    outputAssetVersionUid: uid(90007),
    output: {
      relativePath: `projects/${uid(90003)}/exports/${uid(90002)}.mp4`,
      sha256: 'b'.repeat(64),
      bytes: 1024,
      durationMs: 1500,
      width: 1920,
      height: 1080,
      frameRate: '24/1',
      videoCodec: 'h264',
      audioCodec: 'aac',
    },
    errorCode: null,
    createdAt: '2026-08-30T02:00:00.000Z',
    startedAt: '2026-08-30T02:00:01.000Z',
    completedAt: '2026-08-30T02:00:02.000Z',
  };
  const publicRecord = createMediaExportRunPublicRecord(run);
  const schema = JSON.parse(fs.readFileSync(path.resolve(
    __dirname, '../../schemas/v8/media-export-run.schema.json',
  ), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(publicRecord), true, JSON.stringify(validate.errors));
  const maximumOutput = {
    ...publicRecord,
    output: { ...publicRecord.output, bytes: 68_719_476_736, durationMs: 3_600_100 },
  };
  assert.equal(validate(maximumOutput), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...maximumOutput,
    output: { ...maximumOutput.output, bytes: 68_719_476_737 },
  }), false);
  assert.equal(validate({
    ...maximumOutput,
    output: { ...maximumOutput.output, durationMs: 3_600_101 },
  }), false);
  assert.equal(publicRecord.status, 'succeeded');
  assert.equal(publicRecord.output.relativePath, run.output.relativePath);
  assert.doesNotMatch(JSON.stringify(publicRecord), /[A-Z]:\\|workspace|credential|secret/i);
  assert.throws(
    () => createMediaExportRunPublicRecord({
      ...run,
      output: { ...run.output, relativePath: 'C:\\private\\final.mp4' },
    }),
    (error) => error.code === 'MEDIA_EXPORT_RUN_DATA_INVALID',
  );
  assert.throws(
    () => createMediaExportRunPublicRecord({
      ...run,
      status: 'failed', outputAssetUid: null, outputAssetVersionUid: null,
      output: null, errorCode: 'MEDIA_EXPORT_UNKNOWN',
    }),
    (error) => error.code === 'MEDIA_EXPORT_RUN_DATA_INVALID',
  );
});

test('P8-10 service dependency boundary is explicit and modular', () => {
  assert.throws(() => createMediaExportService({}), /Media export service dependencies are invalid/);
});

test('P8-10 rejects incomplete frozen graphs before and after a run is prepared', async (t) => {
  const local = await createLocalMediaExportFixture(t, 90013);
  const database = createMigratedV2Database(t);
  const repositories = seedSucceededExportNode(database, local.fixture.executionPlan);
  const stored = database.prepare(`
    SELECT graph_snapshot_json,graph_hash,graph_revision
    FROM workflow_runs WHERE uid=?
  `).get(WORKFLOW_RUN_UID);
  const graph = JSON.parse(stored.graph_snapshot_json);
  const invalidSnapshot = {
    ...graph.snapshot,
    nodes: graph.snapshot.nodes.filter((node) => node.uid === NODE_UID),
    edges: [],
  };
  const invalidGraph = {
    ...graph,
    graphHash: graphHash(invalidSnapshot),
    snapshot: invalidSnapshot,
    topologicalOrder: [NODE_UID],
  };
  assert.throws(() => validateWorkflowExecutionPlan(invalidGraph));
  assert.equal(database.prepare(
    'SELECT media_export_source_graph_valid(?,?,?,?,?)',
  ).pluck().get(
    JSON.stringify(invalidGraph),
    WORKFLOW_UID,
    invalidGraph.graphHash,
    invalidGraph.graphRevision,
    NODE_UID,
  ), 0);

  database.exec('DROP TRIGGER v2_workflow_runs_snapshot_immutable');
  const updateGraph = database.prepare(`
    UPDATE workflow_runs SET graph_snapshot_json=?,graph_hash=?,graph_revision=? WHERE uid=?
  `);
  updateGraph.run(
    JSON.stringify(invalidGraph), invalidGraph.graphHash, invalidGraph.graphRevision, WORKFLOW_RUN_UID,
  );
  assert.throws(
    () => repositories.mediaExportRuns.prepareFromNode(
      NODE_RUN_UID, local.fixture.executionPlan.createdAtEpochMs, DRAMA_UID,
    ),
    (error) => error.code === 'V2_REPOSITORY_DATA_INVALID',
  );
  assert.equal(database.prepare('SELECT count(*) FROM media_export_run_seals').pluck().get(), 0);

  updateGraph.run(stored.graph_snapshot_json, stored.graph_hash, stored.graph_revision, WORKFLOW_RUN_UID);
  const prepared = repositories.mediaExportRuns.prepareFromNode(
    NODE_RUN_UID, local.fixture.executionPlan.createdAtEpochMs, DRAMA_UID,
  );
  assert.equal(prepared.status, 'queued');
  updateGraph.run(
    JSON.stringify(invalidGraph), invalidGraph.graphHash, invalidGraph.graphRevision, WORKFLOW_RUN_UID,
  );
  for (const read of [
    () => repositories.mediaExportRuns.get(prepared.uid),
    () => repositories.mediaExportRuns.getExecutionPlan(prepared.uid),
    () => repositories.mediaExportRuns.getBySourceNodeRun(NODE_RUN_UID),
    () => repositories.mediaExportRuns.listByDrama(DRAMA_UID),
  ]) assert.throws(read, (error) => error.code === 'V2_REPOSITORY_DATA_INVALID');
});

test('P8-10 seals a succeeded export.final result and fails closed on output drift', async (t) => {
  const local = await createLocalMediaExportFixture(t, 90020);
  const database = createMigratedV2Database(t);
  const repositories = seedSucceededExportNode(database, local.fixture.executionPlan);
  const source = database.prepare(`
    SELECT node.status AS node_status,node.output_json,workflow_run.status AS workflow_status,
      workflow_run.graph_snapshot_json,workflow_run.uid AS workflow_run_uid,workflow.drama_uid
    FROM node_runs AS node
    JOIN workflow_runs AS workflow_run ON workflow_run.uid=node.workflow_run_uid
    JOIN workflow_definitions AS workflow ON workflow.uid=workflow_run.workflow_uid
    WHERE node.uid=?
  `).get(NODE_RUN_UID);
  assert.equal(source.node_status, 'succeeded');
  assert.equal(source.workflow_status, 'succeeded');
  assert.equal(source.workflow_run_uid, local.fixture.executionPlan.workflowRunUid);
  assert.equal(source.drama_uid, local.fixture.executionPlan.dramaUid);
  const sourceOutput = JSON.parse(source.output_json);
  assert.deepEqual(
    parseMediaExportExecutionPlanRecord(sourceOutput.executionPlan),
    local.fixture.executionPlan,
  );
  assert.equal(JSON.parse(source.graph_snapshot_json).snapshot.nodes.some(
    (node) => node.uid === NODE_UID && node.nodeType === 'export.final' && node.enabled === true,
  ), true);
  const completedAtEpochMs = local.fixture.executionPlan.createdAtEpochMs + 100;
  const receipt = receiptFor(local.fixture.executionPlan, completedAtEpochMs);
  let uidValue = 90030;
  const service = createMediaExportService({
    repository: repositories.mediaExportRuns,
    exporter: { async export() { return receipt; } },
    createUid: () => uid(uidValue++),
    nowEpochMs: () => completedAtEpochMs,
    async removeOutput() { throw new Error('must not clean a committed output'); },
  });

  const result = await service.start({ nodeRunUid: NODE_RUN_UID });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.uid, local.fixture.executionPlan.uid);
  assert.equal(result.output.sha256, receipt.output.sha256);
  assert.equal(result.outputAssetUid, uid(90030));
  assert.equal(result.outputAssetVersionUid, uid(90031));
  assert.deepEqual(service.listByDrama(DRAMA_UID), [result]);
  assert.deepEqual(await service.start({ nodeRunUid: NODE_RUN_UID }), result);
  assert.equal(database.prepare('SELECT count(*) FROM assets WHERE asset_type=?').pluck().get('final_video'), 1);

  assert.throws(() => database.prepare(
    'UPDATE OR REPLACE media_export_run_seals SET source_node_run_uid=? WHERE uid=?',
  ).run(uid(90100), result.uid), /invalid|forbidden/u);
  assert.throws(
    () => database.prepare('DELETE FROM media_export_run_seals WHERE uid=?').run(result.uid),
    /append-only/u,
  );
  assert.throws(() => database.prepare(
    "UPDATE asset_versions SET relative_path='projects/drift.mp4' WHERE uid=?",
  ).run(result.outputAssetVersionUid), /frozen/u);
  database.pragma('recursive_triggers = OFF');
  assert.throws(() => database.prepare(`
    INSERT OR REPLACE INTO export_runs SELECT * FROM export_runs WHERE uid=?
  `).run(result.uid), /replacement/u);
  assert.throws(() => database.prepare(`
    INSERT OR REPLACE INTO assets SELECT * FROM assets WHERE uid=?
  `).run(result.outputAssetUid), /replacement/u);
  assert.throws(() => database.prepare(`
    INSERT OR REPLACE INTO asset_versions SELECT * FROM asset_versions WHERE uid=?
  `).run(result.outputAssetVersionUid), /replacement/u);
  database.pragma('recursive_triggers = ON');

  const snapshot = repositories.projectArchives.exportSnapshot(1);
  const manifest = createProjectManifest({
    legacyProjectVersion: '1.0.0',
    exportedAt: '2026-08-30T02:10:00.000Z',
    project: snapshot.project,
    records: snapshot.records,
  });
  assert.equal(manifest.records.mediaExportRunSeals.length, 1);
  const reboundRecords = JSON.parse(JSON.stringify(snapshot.records));
  reboundRecords.mediaExportRunSeals[0].source_node_run_uid = SOURCE_NODE_RUN_UID;
  const reboundSourceNode = reboundRecords.nodeRuns.find((row) => row.uid === SOURCE_NODE_RUN_UID);
  reboundSourceNode.output_json = JSON.stringify({
    schemaVersion: 'media-export-node-output.v1',
    executionPlan: local.fixture.executionPlan,
  });
  assert.throws(() => createProjectManifest({
    legacyProjectVersion: '1.0.0',
    exportedAt: '2026-08-30T02:10:00.000Z',
    project: snapshot.project,
    records: reboundRecords,
  }));
  const restoredDatabase = createMigratedV2Database(t);
  insertDrama(restoredDatabase, uid(90101), 'Restored media export drama');
  const restoredRepositories = createV2Repositories(restoredDatabase);
  restoredRepositories.projectArchives.importSnapshot(1, manifest);
  assert.deepEqual(restoredRepositories.mediaExportRuns.get(result.uid), result);

  restoredDatabase.exec('DROP TRIGGER v2_media_export_run_seals_validate_update');
  restoredDatabase.prepare(`
    UPDATE media_export_run_seals
    SET completed_at_epoch_ms=completed_at_epoch_ms+1000 WHERE uid=?
  `).run(result.uid);
  assert.throws(
    () => restoredRepositories.mediaExportRuns.get(result.uid),
    (error) => error.code === 'V2_REPOSITORY_DATA_INVALID',
  );
  assert.throws(
    () => restoredRepositories.mediaExportRuns.listByDrama(DRAMA_UID),
    (error) => error.code === 'V2_REPOSITORY_DATA_INVALID',
  );
  const driftedSuccessSnapshot = restoredRepositories.projectArchives.exportSnapshot(1);
  assert.throws(() => createProjectManifest({
    legacyProjectVersion: '1.0.0',
    exportedAt: '2026-08-30T02:10:00.000Z',
    project: driftedSuccessSnapshot.project,
    records: driftedSuccessSnapshot.records,
  }));

  database.exec('DROP TRIGGER v2_media_export_asset_versions_frozen');
  database.prepare('UPDATE asset_versions SET created_at=? WHERE uid=?')
    .run('2026-08-30T02:11:00.000Z', result.outputAssetVersionUid);
  assert.throws(
    () => service.get(result.uid),
    (error) => error.code === 'V2_REPOSITORY_DATA_INVALID',
  );
});

test('P8-10 records failed export without creating an output AssetVersion', async (t) => {
  const local = await createLocalMediaExportFixture(t, 90040);
  const database = createMigratedV2Database(t);
  const repositories = seedSucceededExportNode(database, local.fixture.executionPlan);
  const completedAtEpochMs = local.fixture.executionPlan.createdAtEpochMs + 100;
  const service = createMediaExportService({
    repository: repositories.mediaExportRuns,
    exporter: { async export() { throw new Error('synthetic ffmpeg failure'); } },
    createUid: () => uid(90041),
    nowEpochMs: () => completedAtEpochMs,
    async removeOutput() { throw new Error('no receipt means no cleanup'); },
  });

  const result = await service.start({ nodeRunUid: NODE_RUN_UID });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'MEDIA_EXPORT_FAILED');
  assert.equal(database.prepare('SELECT count(*) FROM assets WHERE asset_type=?').pluck().get('final_video'), 0);
  assert.equal(database.prepare('SELECT count(*) FROM asset_versions WHERE mime_type=?').pluck().get('video/mp4'), 0);

  const snapshot = repositories.projectArchives.exportSnapshot(1);
  const manifest = createProjectManifest({
    legacyProjectVersion: '1.0.0',
    exportedAt: '2026-08-30T02:20:00.000Z',
    project: snapshot.project,
    records: snapshot.records,
  });
  const restoredDatabase = createMigratedV2Database(t);
  insertDrama(restoredDatabase, uid(90102), 'Restored failed media export drama');
  const restoredRepositories = createV2Repositories(restoredDatabase);
  restoredRepositories.projectArchives.importSnapshot(1, manifest);
  assert.deepEqual(restoredRepositories.mediaExportRuns.get(result.uid), result);

  database.exec('DROP TRIGGER v2_media_export_run_seals_validate_update');
  database.prepare(`
    UPDATE media_export_run_seals
    SET completed_at_epoch_ms=completed_at_epoch_ms+1000 WHERE uid=?
  `).run(result.uid);
  assert.throws(
    () => service.get(result.uid),
    (error) => error.code === 'V2_REPOSITORY_DATA_INVALID',
  );
  assert.throws(
    () => service.listByDrama(DRAMA_UID),
    (error) => error.code === 'V2_REPOSITORY_DATA_INVALID',
  );
  const driftedFailureSnapshot = repositories.projectArchives.exportSnapshot(1);
  assert.throws(() => createProjectManifest({
    legacyProjectVersion: '1.0.0',
    exportedAt: '2026-08-30T02:20:00.000Z',
    project: driftedFailureSnapshot.project,
    records: driftedFailureSnapshot.records,
  }));
});

test('P8-10 removes an installed output when DB completion cannot commit', async (t) => {
  const local = await createLocalMediaExportFixture(t, 90050);
  const database = createMigratedV2Database(t);
  const repositories = seedSucceededExportNode(database, local.fixture.executionPlan);
  const receipt = receiptFor(
    local.fixture.executionPlan,
    local.fixture.executionPlan.createdAtEpochMs + 100,
  );
  let removed = null;
  const actual = repositories.mediaExportRuns;
  const repository = Object.freeze({
    complete() { throw new Error('synthetic commit failure'); },
    fail: actual.fail,
    get: actual.get,
    getBySourceNodeRun: actual.getBySourceNodeRun,
    getExecutionPlan: actual.getExecutionPlan,
    listByDrama: actual.listByDrama,
    prepareFromNode: actual.prepareFromNode,
    start: actual.start,
  });
  const service = createMediaExportService({
    repository,
    exporter: { async export() { return receipt; } },
    createUid: () => uid(90051),
    nowEpochMs: () => receipt.completedAtEpochMs,
    async removeOutput(relativePath, sha256) { removed = { relativePath, sha256 }; },
  });

  const result = await service.start({ nodeRunUid: NODE_RUN_UID });
  assert.equal(result.status, 'failed');
  assert.deepEqual(removed, {
    relativePath: receipt.output.relativePath,
    sha256: receipt.output.sha256,
  });
  assert.equal(database.prepare('SELECT count(*) FROM assets WHERE asset_type=?').pluck().get('final_video'), 0);
});

test('P8-10 rolls back completion when final persisted evidence validation fails', async (t) => {
  const local = await createLocalMediaExportFixture(t, 90060);
  const database = createMigratedV2Database(t);
  const repositories = seedSucceededExportNode(database, local.fixture.executionPlan);
  const receipt = receiptFor(
    local.fixture.executionPlan,
    local.fixture.executionPlan.createdAtEpochMs + 100,
  );
  database.exec(`
    CREATE TRIGGER synthetic_media_export_version_drift
    AFTER INSERT ON asset_versions
    WHEN NEW.mime_type='video/mp4'
    BEGIN
      UPDATE asset_versions
      SET created_at='2026-08-30T23:59:59.999Z'
      WHERE uid=NEW.uid;
    END;
  `);
  let removed = null;
  let nextUid = 90061;
  const service = createMediaExportService({
    repository: repositories.mediaExportRuns,
    exporter: { async export() { return receipt; } },
    createUid: () => uid(nextUid++),
    nowEpochMs: () => receipt.completedAtEpochMs,
    async removeOutput(relativePath, sha256) { removed = { relativePath, sha256 }; },
  });

  const result = await service.start({ nodeRunUid: NODE_RUN_UID });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'MEDIA_EXPORT_FAILED');
  assert.deepEqual(removed, {
    relativePath: receipt.output.relativePath,
    sha256: receipt.output.sha256,
  });
  assert.equal(database.prepare('SELECT count(*) FROM assets WHERE asset_type=?').pluck().get('final_video'), 0);
  assert.equal(database.prepare('SELECT count(*) FROM asset_versions WHERE mime_type=?').pluck().get('video/mp4'), 0);
});
