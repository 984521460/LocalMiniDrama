const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const AdmZip = require('adm-zip');
const Ajv = require('ajv/dist/2020');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { createV2Repositories } = require('../src/repositories/v2');
const { createWorkflowExecutionPlan } = require('../src/workflows/executionPlan');
const { validateRunAggregate } = require('../src/workflows/runState');
const createDramaRoutes = require('../src/routes/drama');
const projectZipService = require('../src/services/projectZipService');
const { createProjectImportMediaStaging } = require('../src/services/projectImportMediaStaging');

const manifestSchema = require('../../schemas/v2/project-archive-manifest.schema.json');
const fixtureProject = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'minimal-project', 'project.json'),
  'utf8',
);

const UUIDS = Object.freeze({
  document: '10000000-0000-4000-8000-000000000001',
  block: '10000000-0000-4000-8000-000000000002',
  selection: '10000000-0000-4000-8000-000000000003',
  blockB: '10000000-0000-4000-8000-000000000004',
  workflow: '20000000-0000-4000-8000-000000000001',
  nodeA: '20000000-0000-4000-8000-000000000002',
  nodeB: '20000000-0000-4000-8000-000000000003',
  edge: '20000000-0000-4000-8000-000000000004',
  asset: '30000000-0000-4000-8000-000000000001',
  version: '30000000-0000-4000-8000-000000000002',
  generation: '40000000-0000-4000-8000-000000000001',
  workflowRun: '40000000-0000-4000-8000-000000000002',
  nodeRun: '40000000-0000-4000-8000-000000000003',
  exportRun: '40000000-0000-4000-8000-000000000004',
  nodeRunB: '40000000-0000-4000-8000-000000000005',
});

function createLog() {
  const entries = [];
  return {
    entries,
    info(message, detail) { entries.push(JSON.stringify({ level: 'info', message, detail })); },
    error(message, detail) { entries.push(JSON.stringify({ level: 'error', message, detail })); },
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function createV1Zip(projectJson = fixtureProject) {
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(projectJson, 'utf8'));
  return zip.toBuffer();
}

function replaceZipEntryName(zipBuffer, from, to) {
  const source = Buffer.from(from, 'utf8');
  const target = Buffer.from(to, 'utf8');
  assert.equal(source.length, target.length);
  const output = Buffer.from(zipBuffer);
  let offset = 0;
  let replacements = 0;
  while ((offset = output.indexOf(source, offset)) !== -1) {
    target.copy(output, offset);
    offset += target.length;
    replacements++;
  }
  assert.equal(replacements >= 2, true, 'local and central ZIP names must both be replaced');
  return output;
}

function createDatabase(t) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrationsAndEnsure(database);
  t.after(() => database.close());
  return database;
}

function createStorage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-v2-zip-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

function createResponseCapture() {
  const capture = { body: null, statusCode: null };
  const response = {
    status(statusCode) {
      capture.statusCode = statusCode;
      return this;
    },
    json(body) {
      capture.body = body;
      return this;
    },
  };
  return { capture, response };
}

function addProjectScopedV2Data(database, dramaUid) {
  const repositories = createV2Repositories(database);
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const sourceText = 'helloworld';

  repositories.sources.createDocumentWithBlocks({
    document: {
      uid: UUIDS.document,
      dramaUid,
      sourceType: 'markdown',
      originalName: 'story.md',
      encoding: 'utf-8',
      contentSha256: sha256(sourceText),
      fullText: sourceText,
    },
    blocks: [
      {
        uid: UUIDS.block,
        ordinal: 0,
        headingPath: [],
        charStart: 0,
        charEnd: 5,
        text: 'hello',
        textSha256: sha256('hello'),
      },
      {
        uid: UUIDS.blockB,
        ordinal: 1,
        headingPath: [],
        charStart: 5,
        charEnd: 10,
        text: 'world',
        textSha256: sha256('world'),
      },
    ],
  });
  repositories.sources.createSelection({
    uid: UUIDS.selection,
    documentUid: UUIDS.document,
    startBlockUid: UUIDS.block,
    endBlockUid: UUIDS.block,
    startOffset: 0,
    endOffset: 5,
    selectedTextSha256: sha256('hello'),
  });

  repositories.workflows.createGraph({
    definition: {
      uid: UUIDS.workflow,
      dramaUid,
      name: '主流程',
      version: 1,
      status: 'active',
      description: 'ZIP v2 round-trip',
    },
    nodes: [
      {
        uid: UUIDS.nodeA,
        nodeType: 'source.selection',
        position: { x: 10, y: 20 },
        config: { contextBeforeBlocks: 0 },
        domainRefType: null,
        domainRefUid: null,
        status: 'disabled',
      },
      {
        uid: UUIDS.nodeB,
        nodeType: 'story.facts',
        position: { x: 210, y: 20 },
        config: {},
        domainRefType: null,
        domainRefUid: null,
        status: 'disabled',
      },
    ],
    edges: [{
      uid: UUIDS.edge,
      sourceNodeUid: UUIDS.nodeA,
      sourcePort: 'selection',
      targetNodeUid: UUIDS.nodeB,
      targetPort: 'selection',
    }],
  });

  repositories.assets.create({
    uid: UUIDS.asset,
    ownerType: 'drama',
    ownerUid: dramaUid,
    assetType: 'image',
    status: 'draft',
  });
  repositories.assets.addVersion({
    uid: UUIDS.version,
    assetUid: UUIDS.asset,
    storageProvider: 'local',
    logicalUri: 'asset://local/project/preview.png',
    relativePath: 'projects/archive/preview.png',
    sha256: hashB,
    mimeType: 'image/png',
    width: 1280,
    height: 720,
    durationMs: null,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });

  repositories.runs.createGeneration({
    uid: UUIDS.generation,
    ownerType: 'drama',
    ownerUid: dramaUid,
    provider: 'fixture',
    model: 'fixture-v1',
    seed: 7,
    parameters: { width: 1280, height: 720 },
    input: { prompt: 'two people meet' },
    promptVersionUid: null,
    status: 'queued',
  });
  const workflowPlan = createWorkflowExecutionPlan(
    repositories.workflows.getGraph(UUIDS.workflow),
    repositories,
  );
  repositories.runs.createWorkflowWithNodes({
    run: {
      uid: UUIDS.workflowRun,
      workflowUid: UUIDS.workflow,
      graphSnapshot: workflowPlan,
      graphHash: workflowPlan.graphHash,
      graphRevision: workflowPlan.graphRevision,
      triggerType: 'manual',
      status: 'queued',
    },
    nodes: [
      {
        uid: UUIDS.nodeRun,
        nodeUid: UUIDS.nodeA,
        ordinal: 0,
        inputSnapshot: {},
        output: null,
        cacheKey: null,
        status: 'queued',
      },
      {
        uid: UUIDS.nodeRunB,
        nodeUid: UUIDS.nodeB,
        ordinal: 1,
        inputSnapshot: {},
        output: null,
        cacheKey: null,
        status: 'queued',
      },
    ],
  });
  repositories.runs.createExport({
    uid: UUIDS.exportRun,
    dramaUid,
    workflowRunUid: UUIDS.workflowRun,
    timelineSnapshot: { shots: [] },
    encoding: { codec: 'h264' },
    audio: {},
    subtitle: {},
    outputAssetVersionUid: UUIDS.version,
    validation: { playable: true },
    status: 'queued',
  });
}

function archiveHistoryUid(index) {
  return `41000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function runHistoryMatrix(manifest) {
  const workflowTemplate = manifest.records.workflowRuns[0];
  const nodeTemplates = manifest.records.nodeRuns;
  const timestamp = workflowTemplate.created_at;
  const definitions = [
    {
      workflow: { status: 'queued', started_at: null, completed_at: null, error_code: null },
      nodes: [
        { status: 'queued' },
        { status: 'queued' },
      ],
    },
    {
      workflow: { status: 'running', started_at: timestamp, completed_at: null, error_code: null },
      nodes: [
        { status: 'running', started_at: timestamp, input: { stage: 'running' }, cache_key: 'c'.repeat(64) },
        { status: 'cancelled', completed_at: timestamp },
      ],
    },
    {
      workflow: { status: 'succeeded', started_at: timestamp, completed_at: timestamp, error_code: null },
      nodes: [
        { status: 'succeeded', started_at: timestamp, completed_at: timestamp, input: { stage: 'done' }, output: { assetUid: UUIDS.asset } },
        { status: 'skipped', completed_at: timestamp },
      ],
    },
    {
      workflow: { status: 'failed', started_at: timestamp, completed_at: timestamp, error_code: 'ERR_FIXTURE' },
      nodes: [
        { status: 'failed', started_at: timestamp, completed_at: timestamp, input: { stage: 'failed' }, error_code: 'ERR_FIXTURE' },
        { status: 'blocked', completed_at: timestamp, error_code: 'ERR_DEPENDENCY' },
      ],
    },
    {
      workflow: { status: 'cancelled', started_at: null, completed_at: timestamp, error_code: null },
      nodes: [
        { status: 'cancelled', completed_at: timestamp },
        { status: 'queued' },
      ],
    },
  ];
  const workflowRuns = [];
  const nodeRuns = [];
  definitions.forEach((definition, runIndex) => {
    const workflowRunUid = archiveHistoryUid(100 + runIndex);
    workflowRuns.push({
      ...workflowTemplate,
      uid: workflowRunUid,
      retry_count: runIndex === 3 ? 1 : 0,
      error_detail_ref: null,
      updated_at: timestamp,
      ...definition.workflow,
    });
    definition.nodes.forEach((state, nodeIndex) => {
      const input = state.input || {};
      nodeRuns.push({
        ...nodeTemplates[nodeIndex],
        uid: archiveHistoryUid(200 + (runIndex * 2) + nodeIndex),
        workflow_run_uid: workflowRunUid,
        input_snapshot_json: JSON.stringify(input),
        output_json: state.output ? JSON.stringify(state.output) : null,
        cache_key: state.cache_key || null,
        retry_count: runIndex === 3 && nodeIndex === 0 ? 1 : 0,
        error_code: state.error_code || null,
        error_detail_ref: null,
        started_at: state.started_at || null,
        completed_at: state.completed_at || null,
        updated_at: timestamp,
        status: state.status,
      });
    });
  });
  return { workflowRuns, nodeRuns };
}

function archiveRunAggregate(workflowRun, nodeRuns) {
  return {
    run: {
      uid: workflowRun.uid,
      workflowUid: workflowRun.workflow_uid,
      graphSnapshot: JSON.parse(workflowRun.graph_snapshot_json),
      graphHash: workflowRun.graph_hash,
      graphRevision: workflowRun.graph_revision,
      triggerType: workflowRun.trigger_type,
      status: workflowRun.status,
      retryCount: workflowRun.retry_count,
      errorCode: workflowRun.error_code,
      errorDetailRef: workflowRun.error_detail_ref,
      createdAt: workflowRun.created_at,
      startedAt: workflowRun.started_at,
      completedAt: workflowRun.completed_at,
      updatedAt: workflowRun.updated_at,
    },
    nodes: nodeRuns.map((nodeRun) => ({
      uid: nodeRun.uid,
      workflowRunUid: nodeRun.workflow_run_uid,
      nodeUid: nodeRun.node_uid,
      ordinal: nodeRun.ordinal,
      inputSnapshot: JSON.parse(nodeRun.input_snapshot_json),
      output: nodeRun.output_json === null ? null : JSON.parse(nodeRun.output_json),
      cacheKey: nodeRun.cache_key,
      status: nodeRun.status,
      retryCount: nodeRun.retry_count,
      errorCode: nodeRun.error_code,
      errorDetailRef: nodeRun.error_detail_ref,
      createdAt: nodeRun.created_at,
      startedAt: nodeRun.started_at,
      completedAt: nodeRun.completed_at,
      updatedAt: nodeRun.updated_at,
    })),
  };
}

function readV2Manifest(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const entry = zip.getEntry('v2/manifest.json');
  assert.ok(entry, 'v2 archive must contain v2/manifest.json');
  return JSON.parse(entry.getData().toString('utf8'));
}

function replaceJsonEntry(zipBuffer, name, value) {
  const zip = new AdmZip(zipBuffer);
  zip.deleteFile(name);
  zip.addFile(name, Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
  return zip.toBuffer();
}

function listStorageFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push(path.relative(root, absolute).replace(/\\/g, '/'));
    }
  };
  visit(root);
  return files.sort();
}

test('startup migration keeps v1 ZIP import compatible and installs the v2 ledger', (t) => {
  const database = createDatabase(t);
  const storage = createStorage(t);
  const result = projectZipService.importDrama(database, { storage: { local_path: storage } }, createLog(), createV1Zip());

  assert.equal(result.title, 'Phase 0 最小迁移样例');
  assert.equal(database.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 32);
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_documents').get().count, 0);
});

test('v2 project ZIP preserves portable project data through export and clean-database import', (t) => {
  const source = createDatabase(t);
  const sourceStorage = createStorage(t);
  const log = createLog();
  const importedV1 = projectZipService.importDrama(source, { storage: { local_path: sourceStorage } }, log, createV1Zip());
  const sourceDrama = source.prepare('SELECT id, uid FROM dramas WHERE id = ?').get(importedV1.drama_id);
  addProjectScopedV2Data(source, sourceDrama.uid);

  const exported = projectZipService.exportDramaV20(source, { storage: { local_path: sourceStorage } }, log, sourceDrama.id);
  const firstManifest = readV2Manifest(exported.buffer);
  const validate = new Ajv({ allErrors: true, strict: true }).compile(manifestSchema);
  assert.equal(validate(firstManifest), true, JSON.stringify(validate.errors));
  assert.equal(firstManifest.schemaVersion, '2.0.0');
  assert.equal(firstManifest.records.remoteConnections, undefined);
  assert.equal(firstManifest.records.remoteTasks, undefined);
  assert.equal(exported.buffer.includes(Buffer.from(sourceStorage, 'utf8')), false);

  const destination = createDatabase(t);
  const destinationStorage = createStorage(t);
  const importedV2 = projectZipService.importDrama(
    destination,
    { storage: { local_path: destinationStorage } },
    log,
    exported.buffer,
  );
  const reexported = projectZipService.exportDramaV20(
    destination,
    { storage: { local_path: destinationStorage } },
    log,
    importedV2.drama_id,
  );
  const secondManifest = readV2Manifest(reexported.buffer);

  assert.deepEqual(secondManifest.project, firstManifest.project);
  assert.deepEqual(secondManifest.records, firstManifest.records);
  for (const table of [
    'source_documents', 'source_blocks', 'source_selections', 'assets', 'asset_versions',
    'workflow_definitions', 'canvas_nodes', 'canvas_edges', 'generation_runs',
    'workflow_runs', 'node_runs', 'export_runs',
  ]) {
    assert.equal(destination.prepare(`SELECT count(*) AS count FROM ${table}`).get().count > 0, true, table);
  }
});

test('v2 project ZIP replays every legal workflow and node run state without weakening initial inserts', (t) => {
  const source = createDatabase(t);
  const sourceStorage = createStorage(t);
  const log = createLog();
  const imported = projectZipService.importDrama(
    source,
    { storage: { local_path: sourceStorage } },
    log,
    createV1Zip(),
  );
  const drama = source.prepare('SELECT id, uid FROM dramas WHERE id = ?').get(imported.drama_id);
  addProjectScopedV2Data(source, drama.uid);
  const exported = projectZipService.exportDramaV20(
    source,
    { storage: { local_path: sourceStorage } },
    log,
    drama.id,
  );
  const manifest = readV2Manifest(exported.buffer);
  const history = runHistoryMatrix(manifest);
  for (const workflowRun of history.workflowRuns) {
    const nodeRuns = history.nodeRuns
      .filter((nodeRun) => nodeRun.workflow_run_uid === workflowRun.uid)
      .sort((left, right) => left.ordinal - right.ordinal);
    assert.doesNotThrow(
      () => validateRunAggregate(archiveRunAggregate(workflowRun, nodeRuns)),
      `archive run aggregate must be valid for status ${workflowRun.status}`,
    );
  }
  manifest.records.workflowRuns = history.workflowRuns;
  manifest.records.nodeRuns = history.nodeRuns;
  manifest.records.exportRuns = [];
  const archive = replaceJsonEntry(exported.buffer, 'v2/manifest.json', manifest);

  const destination = createDatabase(t);
  const destinationStorage = createStorage(t);
  const restored = projectZipService.importDrama(
    destination,
    { storage: { local_path: destinationStorage } },
    log,
    archive,
  );
  const restoredManifest = readV2Manifest(projectZipService.exportDramaV20(
    destination,
    { storage: { local_path: destinationStorage } },
    log,
    restored.drama_id,
  ).buffer);
  assert.deepEqual(restoredManifest.records.workflowRuns, history.workflowRuns);
  assert.deepEqual(restoredManifest.records.nodeRuns, history.nodeRuns);
  assert.deepEqual(
    [...new Set(restoredManifest.records.workflowRuns.map((row) => row.status))].sort(),
    ['cancelled', 'failed', 'queued', 'running', 'succeeded'],
  );
  assert.deepEqual(
    [...new Set(restoredManifest.records.nodeRuns.map((row) => row.status))].sort(),
    ['blocked', 'cancelled', 'failed', 'queued', 'running', 'skipped', 'succeeded'],
  );

  const template = history.workflowRuns[0];
  assert.throws(() => destination.prepare(`
    INSERT INTO workflow_runs
      (uid, workflow_uid, graph_snapshot_json, graph_hash, graph_revision, trigger_type,
       status, retry_count, error_code, error_detail_ref, created_at, started_at,
       completed_at, updated_at)
    VALUES
      (?, @workflow_uid, @graph_snapshot_json, @graph_hash, @graph_revision, @trigger_type,
       'succeeded', 0, NULL, NULL, @created_at, @created_at, @created_at, @updated_at)
  `).run(archiveHistoryUid(900), template), /initial state/i);

  destination.prepare(`
    INSERT INTO workflow_runs
      (uid, workflow_uid, graph_snapshot_json, graph_hash, graph_revision, trigger_type,
       status, retry_count, error_code, error_detail_ref, created_at, started_at,
       completed_at, updated_at)
    VALUES
      (?, @workflow_uid, @graph_snapshot_json, @graph_hash, @graph_revision, @trigger_type,
       'queued', 0, NULL, NULL, @created_at, NULL, NULL, @updated_at)
  `).run(archiveHistoryUid(901), template);
  assert.throws(() => destination.prepare(`
    INSERT INTO node_runs
      (uid, workflow_run_uid, node_uid, ordinal, input_snapshot_json, output_json,
       cache_key, status, retry_count, error_code, error_detail_ref, created_at,
       started_at, completed_at, updated_at)
    VALUES
      (?, ?, ?, 0, '{}', NULL, NULL, 'skipped', 0, NULL, NULL, ?, NULL, ?, ?)
  `).run(
    archiveHistoryUid(902),
    archiveHistoryUid(901),
    UUIDS.nodeA,
    template.created_at,
    template.created_at,
    template.updated_at,
  ), /initial state/i);

  const tampered = structuredClone(manifest);
  const succeeded = tampered.records.nodeRuns.find((row) => row.status === 'succeeded');
  succeeded.output_json = null;
  const rejected = createDatabase(t);
  const rejectedStorage = path.join(createStorage(t), 'must-not-exist');
  assert.throws(
    () => projectZipService.importDrama(
      rejected,
      { storage: { local_path: rejectedStorage } },
      log,
      replaceJsonEntry(exported.buffer, 'v2/manifest.json', tampered),
    ),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
  assert.equal(rejected.prepare('SELECT count(*) FROM dramas').pluck().get(), 0);
  assert.equal(rejected.prepare('SELECT count(*) FROM workflow_runs').pluck().get(), 0);
  assert.equal(fs.existsSync(rejectedStorage), false);
});

test('v2 import rejects incomplete or drifted source evidence before any database write', (t) => {
  const source = createDatabase(t);
  const sourceStorage = createStorage(t);
  const log = createLog();
  const imported = projectZipService.importDrama(source, { storage: { local_path: sourceStorage } }, log, createV1Zip());
  const drama = source.prepare('SELECT id, uid FROM dramas WHERE id = ?').get(imported.drama_id);
  addProjectScopedV2Data(source, drama.uid);
  const exported = projectZipService.exportDramaV20(source, { storage: { local_path: sourceStorage } }, log, drama.id);
  const originalManifest = readV2Manifest(exported.buffer);

  const mutations = [
    (manifest) => { manifest.records.sourceBlocks.pop(); },
    (manifest) => { manifest.records.sourceBlocks[0].text_sha256 = '0'.repeat(64); },
    (manifest) => { manifest.records.sourceBlocks[1].char_start = 6; },
    (manifest) => { manifest.records.sourceSelections[0].selected_text_sha256 = '0'.repeat(64); },
    (manifest) => {
      manifest.records.sourceBlocks.push({
        ...manifest.records.sourceBlocks[1],
        uid: '10000000-0000-4000-8000-000000000005',
        ordinal: 2,
        char_start: 10,
        char_end: 10,
        text: '',
        text_sha256: sha256(''),
      });
    },
  ];

  for (const mutate of mutations) {
    const manifest = structuredClone(originalManifest);
    mutate(manifest);
    const destination = createDatabase(t);
    const destinationStorage = path.join(createStorage(t), 'not-created');
    assert.equal(fs.existsSync(destinationStorage), false);
    const archive = replaceJsonEntry(exported.buffer, 'v2/manifest.json', manifest);
    assert.throws(
      () => projectZipService.importDrama(
        destination,
        { storage: { local_path: destinationStorage } },
        log,
        archive,
      ),
      (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
    );
    assert.equal(destination.prepare('SELECT count(*) AS count FROM dramas').get().count, 0);
    assert.equal(destination.prepare('SELECT count(*) AS count FROM source_documents').get().count, 0);
    assert.equal(fs.existsSync(destinationStorage), false);
  }
});

test('v2 export rejects persisted source block count drift instead of laundering it', (t) => {
  const database = createDatabase(t);
  const storage = createStorage(t);
  const log = createLog();
  const imported = projectZipService.importDrama(
    database,
    { storage: { local_path: storage } },
    log,
    createV1Zip(),
  );
  const drama = database.prepare('SELECT id, uid FROM dramas WHERE id = ?').get(imported.drama_id);
  addProjectScopedV2Data(database, drama.uid);
  database.exec('DROP TRIGGER v2_source_documents_immutable_evidence');
  database.prepare('UPDATE source_documents SET block_count = block_count + 1 WHERE uid = ?')
    .run(UUIDS.document);

  assert.throws(
    () => projectZipService.exportDramaV20(database, { storage: { local_path: storage } }, log, drama.id),
    (error) => error.code === 'PROJECT_ARCHIVE_INVALID'
      && !error.message.includes(UUIDS.document),
  );
});

test('safe ZIP reader rejects traversal and oversized expansion before database writes', (t) => {
  const database = createDatabase(t);
  const storage = createStorage(t);
  const traversal = new AdmZip();
  traversal.addFile('project.json', Buffer.from(fixtureProject));
  traversal.addFile('safe/path.txt', Buffer.from('escape'));
  const traversalBuffer = replaceZipEntryName(traversal.toBuffer(), 'safe/path.txt', '../escape.txt');
  assert.throws(
    () => projectZipService.importDrama(database, { storage: { local_path: storage } }, createLog(), traversalBuffer),
    (error) => error.code === 'PROJECT_ARCHIVE_UNSAFE_PATH',
  );

  const bomb = new AdmZip();
  bomb.addFile('project.json', Buffer.from(fixtureProject));
  bomb.addFile('media/oversized.bin', Buffer.alloc((16 * 1024 * 1024) + 1));
  assert.throws(
    () => projectZipService.importDrama(database, { storage: { local_path: storage } }, createLog(), bomb.toBuffer()),
    (error) => error.code === 'PROJECT_ARCHIVE_LIMIT_EXCEEDED',
  );
  assert.equal(database.prepare('SELECT count(*) AS count FROM dramas').get().count, 0);
});

test('v2 import rejects UID conflicts atomically and archive errors do not disclose values', (t) => {
  const source = createDatabase(t);
  const storage = createStorage(t);
  const log = createLog();
  const imported = projectZipService.importDrama(source, { storage: { local_path: storage } }, log, createV1Zip());
  const drama = source.prepare('SELECT id, uid FROM dramas WHERE id = ?').get(imported.drama_id);
  addProjectScopedV2Data(source, drama.uid);
  const exported = projectZipService.exportDramaV20(source, { storage: { local_path: storage } }, log, drama.id);

  const destination = createDatabase(t);
  const destinationStorage = createStorage(t);
  projectZipService.importDrama(destination, { storage: { local_path: destinationStorage } }, log, exported.buffer);
  const before = destination.prepare('SELECT count(*) AS count FROM dramas').get().count;
  assert.throws(
    () => projectZipService.importDrama(destination, { storage: { local_path: destinationStorage } }, log, exported.buffer),
    (error) => error.code === 'PROJECT_ARCHIVE_UID_CONFLICT'
      && !error.message.includes(drama.uid),
  );
  assert.equal(destination.prepare('SELECT count(*) AS count FROM dramas').get().count, before);
});

test('v2 export fails closed when project JSON fields contain credential-shaped data', (t) => {
  const database = createDatabase(t);
  const storage = createStorage(t);
  const log = createLog();
  const imported = projectZipService.importDrama(database, { storage: { local_path: storage } }, log, createV1Zip());
  const drama = database.prepare('SELECT id, uid FROM dramas WHERE id = ?').get(imported.drama_id);
  addProjectScopedV2Data(database, drama.uid);
  const marker = 'zip-test-secret-value';
  database.prepare('UPDATE canvas_nodes SET config_json = ? WHERE uid = ?')
    .run(JSON.stringify({ apiKey: marker }), UUIDS.nodeA);

  assert.throws(
    () => projectZipService.exportDramaV20(database, { storage: { local_path: storage } }, log, drama.id),
    (error) => error.code === 'PROJECT_ARCHIVE_SECRET_DETECTED'
      && !error.message.includes(marker),
  );
  assert.equal(log.entries.join('\n').includes(marker), false);

  database.prepare('UPDATE canvas_nodes SET config_json = ? WHERE uid = ?')
    .run(JSON.stringify({ quality: 'preview' }), UUIDS.nodeA);
  database.prepare('UPDATE dramas SET metadata = ? WHERE id = ?')
    .run(JSON.stringify({ api_token: marker }), drama.id);
  assert.throws(
    () => projectZipService.exportDramaV20(database, { storage: { local_path: storage } }, log, drama.id),
    (error) => error.code === 'PROJECT_ARCHIVE_SECRET_DETECTED'
      && !error.message.includes(marker),
  );
  assert.equal(log.entries.join('\n').includes(marker), false);
});

test('manifest schema and runtime both reject incomplete, extra, and unclosed records', (t) => {
  const database = createDatabase(t);
  const storage = createStorage(t);
  const log = createLog();
  const imported = projectZipService.importDrama(database, { storage: { local_path: storage } }, log, createV1Zip());
  const drama = database.prepare('SELECT id, uid FROM dramas WHERE id = ?').get(imported.drama_id);
  addProjectScopedV2Data(database, drama.uid);
  const exported = projectZipService.exportDramaV20(database, { storage: { local_path: storage } }, log, drama.id);
  const validate = new Ajv({ allErrors: true, strict: true }).compile(manifestSchema);

  const extra = structuredClone(readV2Manifest(exported.buffer));
  extra.records.sourceDocuments[0].unexpected = true;
  assert.equal(validate(extra), false);
  assert.throws(
    () => projectZipService.importDrama(createDatabase(t), { storage: { local_path: createStorage(t) } }, log, replaceJsonEntry(exported.buffer, 'v2/manifest.json', extra)),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );

  const missing = structuredClone(readV2Manifest(exported.buffer));
  delete missing.records.sourceDocuments[0].created_at;
  assert.equal(validate(missing), false);

  const unclosed = structuredClone(readV2Manifest(exported.buffer));
  unclosed.records.sourceBlocks[0].document_uid = '90000000-0000-4000-8000-000000000001';
  assert.throws(
    () => projectZipService.importDrama(createDatabase(t), { storage: { local_path: createStorage(t) } }, log, replaceJsonEntry(exported.buffer, 'v2/manifest.json', unclosed)),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );

  const driftedRun = structuredClone(readV2Manifest(exported.buffer));
  driftedRun.records.workflowRuns[0].graph_hash = 'f'.repeat(64);
  assert.throws(
    () => projectZipService.importDrama(createDatabase(t), { storage: { local_path: createStorage(t) } }, log, replaceJsonEntry(exported.buffer, 'v2/manifest.json', driftedRun)),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );

  const incompleteRun = structuredClone(readV2Manifest(exported.buffer));
  incompleteRun.records.nodeRuns.pop();
  assert.throws(
    () => projectZipService.importDrama(createDatabase(t), { storage: { local_path: createStorage(t) } }, log, replaceJsonEntry(exported.buffer, 'v2/manifest.json', incompleteRun)),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
});

test('typed ownership prevents cross-project export when different entity types reuse a UID', (t) => {
  const database = createDatabase(t);
  const storage = createStorage(t);
  const log = createLog();
  const first = projectZipService.importDrama(database, { storage: { local_path: storage } }, log, createV1Zip());
  const second = projectZipService.importDrama(database, { storage: { local_path: storage } }, log, createV1Zip());
  const firstDrama = database.prepare('SELECT id, uid FROM dramas WHERE id = ?').get(first.drama_id);
  const secondDrama = database.prepare('SELECT id, uid FROM dramas WHERE id = ?').get(second.drama_id);
  const firstCharacter = database.prepare('SELECT id FROM characters WHERE drama_id = ? ORDER BY id LIMIT 1').get(first.drama_id);
  assert.ok(firstCharacter);
  database.prepare('UPDATE characters SET uid = ? WHERE id = ?').run(secondDrama.uid, firstCharacter.id);
  createV2Repositories(database).assets.create({
    uid: '90000000-0000-4000-8000-000000000002',
    ownerType: 'drama',
    ownerUid: secondDrama.uid,
    assetType: 'image',
    status: 'draft',
  });

  const manifest = readV2Manifest(projectZipService.exportDramaV20(
    database,
    { storage: { local_path: storage } },
    log,
    firstDrama.id,
  ).buffer);
  assert.deepEqual(manifest.records.assets, []);
});

test('v2 import checks global-only UID tables inside the import boundary and leaves no media on failure', (t) => {
  const source = createDatabase(t);
  const sourceStorage = createStorage(t);
  const log = createLog();
  const imported = projectZipService.importDrama(source, { storage: { local_path: sourceStorage } }, log, createV1Zip());
  const drama = source.prepare('SELECT id, uid FROM dramas WHERE id = ?').get(imported.drama_id);
  addProjectScopedV2Data(source, drama.uid);
  const exported = projectZipService.exportDramaV20(source, { storage: { local_path: sourceStorage } }, log, drama.id);
  const manifest = readV2Manifest(exported.buffer);

  const conflictDb = createDatabase(t);
  createV2Repositories(conflictDb).remote.createConnection({
    uid: manifest.records.sourceDocuments[0].uid,
    name: 'synthetic',
    host: '127.0.0.1',
    port: 22,
    username: 'fixture',
    hostFingerprint: `SHA256:${'A'.repeat(43)}`,
    credentialRef: 'credential:v1:90000000-0000-4000-8000-000000000003',
    status: 'ready',
    authMethod: 'password',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
  });
  assert.throws(
    () => projectZipService.importDrama(conflictDb, { storage: { local_path: createStorage(t) } }, log, exported.buffer),
    (error) => error.code === 'PROJECT_ARCHIVE_UID_CONFLICT',
  );

  const leakingZip = new AdmZip(exported.buffer);
  const legacy = JSON.parse(leakingZip.getEntry('project.json').getData().toString('utf8'));
  legacy.characters[0].image_file = 'media/leak.png';
  leakingZip.deleteFile('project.json');
  leakingZip.addFile('project.json', Buffer.from(JSON.stringify(legacy), 'utf8'));
  leakingZip.addFile('media/leak.png', Buffer.from('synthetic-media'));
  const broken = structuredClone(manifest);
  broken.records.sourceDocuments[0].drama_uid = '90000000-0000-4000-8000-000000000004';
  leakingZip.deleteFile('v2/manifest.json');
  leakingZip.addFile('v2/manifest.json', Buffer.from(JSON.stringify(broken), 'utf8'));
  const failedDb = createDatabase(t);
  const failedStorage = createStorage(t);
  assert.throws(
    () => projectZipService.importDrama(failedDb, { storage: { local_path: failedStorage } }, log, leakingZip.toBuffer()),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
  assert.deepEqual(listStorageFiles(failedStorage), []);
  assert.equal(failedDb.prepare('SELECT count(*) AS count FROM dramas').get().count, 0);

  const stagedZip = new AdmZip(createV1Zip());
  const stagedProject = JSON.parse(stagedZip.getEntry('project.json').getData().toString('utf8'));
  stagedProject.characters[0].image_file = 'media/staged.png';
  stagedZip.deleteFile('project.json');
  stagedZip.addFile('project.json', Buffer.from(JSON.stringify(stagedProject), 'utf8'));
  stagedZip.addFile('media/staged.png', Buffer.from('staged-media'));
  const rollbackDb = createDatabase(t);
  rollbackDb.exec(`
    CREATE TEMP TRIGGER fail_imported_character
    BEFORE INSERT ON characters
    BEGIN
      SELECT RAISE(ABORT, 'synthetic import failure');
    END
  `);
  const rollbackStorage = createStorage(t);
  assert.throws(
    () => projectZipService.importDrama(rollbackDb, { storage: { local_path: rollbackStorage } }, log, stagedZip.toBuffer()),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID'
      && !error.message.includes('synthetic import failure'),
  );
  assert.deepEqual(listStorageFiles(rollbackStorage), []);
  assert.equal(rollbackDb.prepare('SELECT count(*) AS count FROM dramas').get().count, 0);
});

test('nested JSON strings cannot carry credential keys or machine-local paths', (t) => {
  const database = createDatabase(t);
  const storage = createStorage(t);
  const log = createLog();
  const imported = projectZipService.importDrama(database, { storage: { local_path: storage } }, log, createV1Zip());
  const drama = database.prepare('SELECT id, uid FROM dramas WHERE id = ?').get(imported.drama_id);
  addProjectScopedV2Data(database, drama.uid);
  const marker = 'nested-secret-marker';
  database.prepare('UPDATE canvas_nodes SET config_json = ? WHERE uid = ?')
    .run(JSON.stringify({ nested: JSON.stringify({ apiKey: marker }) }), UUIDS.nodeA);
  assert.throws(
    () => projectZipService.exportDramaV20(database, { storage: { local_path: storage } }, log, drama.id),
    (error) => error.code === 'PROJECT_ARCHIVE_SECRET_DETECTED' && !error.message.includes(marker),
  );

  database.prepare('UPDATE canvas_nodes SET config_json = ? WHERE uid = ?')
    .run(JSON.stringify({ nested: JSON.stringify({ cacheDir: 'C:\\Users\\fixture\\cache' }) }), UUIDS.nodeA);
  assert.throws(
    () => projectZipService.exportDramaV20(database, { storage: { local_path: storage } }, log, drama.id),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
});

test('structured workflow config preserves API routes while named filesystem fields stay portable', (t) => {
  const source = createDatabase(t);
  const storage = createStorage(t);
  const log = createLog();
  const imported = projectZipService.importDrama(source, { storage: { local_path: storage } }, log, createV1Zip());
  const drama = source.prepare('SELECT id, uid FROM dramas WHERE id = ?').get(imported.drama_id);
  addProjectScopedV2Data(source, drama.uid);
  const portableConfig = {
    route: '/v1/images',
    endpointPath: '/v1/tasks',
    routes: ['/v1/images', 'https://api.example.test/v1/images'],
    endpointPaths: ['/v1/images'],
    routePaths: ['/v1/tasks'],
    apiPaths: ['/v1/assets'],
    encodedRoute: '/v1/image%20name',
    transformOrigin: 'center center',
  };
  source.prepare('UPDATE canvas_nodes SET config_json = ? WHERE uid = ?')
    .run(JSON.stringify(portableConfig), UUIDS.nodeA);

  const exported = projectZipService.exportDramaV20(source, { storage: { local_path: storage } }, log, drama.id);
  const destination = createDatabase(t);
  projectZipService.importDrama(
    destination,
    { storage: { local_path: createStorage(t) } },
    log,
    exported.buffer,
  );
  assert.deepEqual(
    JSON.parse(destination.prepare('SELECT config_json FROM canvas_nodes WHERE uid = ?').pluck().get(UUIDS.nodeA)),
    portableConfig,
  );

  const nestedRouteConfig = { route: JSON.stringify(['/v1/images', '/v1/tasks']) };
  source.prepare('UPDATE canvas_nodes SET config_json = ? WHERE uid = ?')
    .run(JSON.stringify(nestedRouteConfig), UUIDS.nodeA);
  const nestedExport = projectZipService.exportDramaV20(source, { storage: { local_path: storage } }, log, drama.id);
  const nestedDestination = createDatabase(t);
  projectZipService.importDrama(
    nestedDestination,
    { storage: { local_path: createStorage(t) } },
    log,
    nestedExport.buffer,
  );
  assert.deepEqual(
    JSON.parse(nestedDestination.prepare('SELECT config_json FROM canvas_nodes WHERE uid = ?').pluck().get(UUIDS.nodeA)),
    nestedRouteConfig,
  );

  const unsafeConfigs = [
    { cacheDir: '/root/private-cache' },
    { route: 'file:///C:/Users/fixture/private' },
    { cacheDir: { value: 'C:\\Users\\fixture\\cache' } },
    { route: { value: 'file:///C:/Users/fixture/private' } },
    { routes: ['file:///C:/Users/fixture/private'] },
    { outputFile: 'C:\\Users\\fixture\\out.png' },
    { fileName: '/root/out.png' },
    { route: String.raw`https:\\api.example.test\v1\images` },
    { route: 'https://api.example.test/v1/../private' },
    { route: 'https://api.example.test/v1/./images' },
    { base_url: String.raw`https:\\api.example.test\v1` },
    { route: '/v1/image name' },
    { route: '/v1/images?q=a b' },
    { route: '/v1/images#a b' },
    { route: 'https://api.example.test/v1/image name' },
    { route: '/v1/image\u00a0name' },
    { route: '/v1/image\u2003name' },
  ];
  for (const config of unsafeConfigs) {
    source.prepare('UPDATE canvas_nodes SET config_json = ? WHERE uid = ?')
      .run(JSON.stringify(config), UUIDS.nodeA);
    assert.throws(
      () => projectZipService.exportDramaV20(source, { storage: { local_path: storage } }, log, drama.id),
      (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
    );
  }
});

test('Windows media staging imports a normal file and rejects junction promotion escapes', (t) => {
  const database = createDatabase(t);
  const storage = createStorage(t);
  const project = JSON.parse(fixtureProject);
  project.characters[0].image_file = 'media/character.png';
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(JSON.stringify(project), 'utf8'));
  zip.addFile('media/character.png', Buffer.from('portable-media-content'));
  const imported = projectZipService.importDrama(database, { storage: { local_path: storage } }, createLog(), zip.toBuffer());
  const localPath = database.prepare('SELECT local_path FROM characters WHERE drama_id = ? ORDER BY id LIMIT 1').pluck().get(imported.drama_id);
  assert.equal(typeof localPath, 'string');
  assert.equal(fs.readFileSync(path.join(storage, ...localPath.split('/')), 'utf8'), 'portable-media-content');

  const escapeStorage = createStorage(t);
  const outside = createStorage(t);
  const staging = createProjectImportMediaStaging(escapeStorage);
  const relative = staging.write({
    projectDir: 'projects/0001_fixture',
    category: 'characters',
    zipPath: 'media/escape.png',
    prefix: 'fixture',
    buffer: Buffer.from('escape-canary'),
  });
  const category = path.join(escapeStorage, 'projects', '0001_fixture', 'characters');
  fs.mkdirSync(path.dirname(category), { recursive: true });
  fs.symlinkSync(outside, category, 'junction');
  assert.throws(() => staging.promote(), (error) => error.code === 'PROJECT_IMPORT_MEDIA_FAILED');
  assert.deepEqual(listStorageFiles(outside), []);
  assert.equal(fs.existsSync(path.join(outside, path.basename(relative))), false);
});

test('portable fields and legacy local-path columns reject arbitrary absolute paths', (t) => {
  const source = createDatabase(t);
  const storage = createStorage(t);
  const log = createLog();
  const imported = projectZipService.importDrama(source, { storage: { local_path: storage } }, log, createV1Zip());
  const drama = source.prepare('SELECT id, uid FROM dramas WHERE id = ?').get(imported.drama_id);
  addProjectScopedV2Data(source, drama.uid);
  const exported = projectZipService.exportDramaV20(source, { storage: { local_path: storage } }, log, drama.id);
  const manifest = readV2Manifest(exported.buffer);
  manifest.records.sourceDocuments[0].original_name = 'C:\\Users\\fixture\\private\\script.txt';
  assert.throws(
    () => projectZipService.importDrama(createDatabase(t), { storage: { local_path: createStorage(t) } }, log, replaceJsonEntry(exported.buffer, 'v2/manifest.json', manifest)),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );

  const legacy = JSON.parse(fixtureProject);
  legacy.episodes[0].storyboards[0].last_frame_local_path = '\\\\server\\share\\outside.png';
  assert.throws(
    () => projectZipService.importDrama(createDatabase(t), { storage: { local_path: createStorage(t) } }, log, createV1Zip(JSON.stringify(legacy))),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
});

test('example imports use the same safe ZIP service and fixed route error boundary', (t) => {
  const examples = createStorage(t);
  const storage = createStorage(t);
  const database = createDatabase(t);
  const log = createLog();
  const previous = process.env.EXAMPLE_DRAMA_PATH;
  process.env.EXAMPLE_DRAMA_PATH = examples;
  t.after(() => {
    if (previous === undefined) delete process.env.EXAMPLE_DRAMA_PATH;
    else process.env.EXAMPLE_DRAMA_PATH = previous;
  });

  fs.writeFileSync(path.join(examples, 'safe..demo.zip'), createV1Zip());
  const routes = createDramaRoutes(database, { storage: { local_path: storage } }, log);
  const good = createResponseCapture();
  routes.importExample({ body: { filename: 'safe..demo.zip' } }, good.response);
  assert.equal(good.capture.statusCode, 201);
  assert.equal(good.capture.body.success, true);

  const wrongType = createResponseCapture();
  assert.doesNotThrow(() => routes.importExample({ body: { filename: 42 } }, wrongType.response));
  assert.equal(wrongType.capture.statusCode, 400);

  const unsafeProject = JSON.parse(fixtureProject);
  unsafeProject.episodes[0].storyboards[0].last_frame_image_url = 'file:///C:/Users/fixture/private.png';
  fs.writeFileSync(path.join(examples, 'unsafe.zip'), createV1Zip(JSON.stringify(unsafeProject)));
  const unsafe = createResponseCapture();
  routes.importExample({ body: { filename: 'unsafe.zip' } }, unsafe.response);
  assert.equal(unsafe.capture.statusCode, 400);
  assert.equal(unsafe.capture.body.error.message, 'Project archive manifest is invalid or unsupported');
  assert.equal(log.entries.join('\n').includes('C:/Users/fixture/private.png'), false);
});

test('portable media fields reject cross-platform absolute paths while remote URLs remain valid', (t) => {
  const invalidCases = [
    ['last_frame_local_path', '/root/private.png'],
    ['last_frame_local_path', '/srv/media/private.png'],
    ['last_frame_local_path', '//server/share/private.png'],
    ['last_frame_local_path', '\\Device\\HarddiskVolume3\\Users\\fixture\\private.png'],
    ['last_frame_local_path', '\\??\\C:\\Users\\fixture\\private.png'],
    ['last_frame_image_url', 'file:///C:/Users/fixture/private.png'],
    ['last_frame_image_url', String.raw`https:\\media.example.test\frames\private.png`],
    ['last_frame_image_url', 'https://media.example.test/frames/../private.png'],
    ['image_url', 'C:\\Users\\fixture\\private.png'],
    ['video_url', '\\\\server\\share\\private.mp4'],
  ];
  for (const [key, value] of invalidCases) {
    const legacy = JSON.parse(fixtureProject);
    legacy.episodes[0].storyboards[0][key] = value;
    assert.throws(
      () => projectZipService.importDrama(
        createDatabase(t),
        { storage: { local_path: createStorage(t) } },
        createLog(),
        createV1Zip(JSON.stringify(legacy)),
      ),
      (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
      `${key} accepted ${value}`,
    );
  }

  const remote = JSON.parse(fixtureProject);
  remote.episodes[0].storyboards[0].last_frame_image_url = 'https://media.example.test/frame.png';
  remote.episodes[0].script_content = '正文可以原样提及 /root/private.png，而不被当作本机字段。';
  const database = createDatabase(t);
  const result = projectZipService.importDrama(
    database,
    { storage: { local_path: createStorage(t) } },
    createLog(),
    createV1Zip(JSON.stringify(remote)),
  );
  assert.equal(
    database.prepare(`
      SELECT s.last_frame_image_url
      FROM storyboards s
      JOIN episodes e ON e.id = s.episode_id
      WHERE e.drama_id = ?
      ORDER BY s.id
      LIMIT 1
    `).pluck().get(result.drama_id),
    'https://media.example.test/frame.png',
  );
});

test('media imports preserve legal project titles containing consecutive dots', (t) => {
  const project = JSON.parse(fixtureProject);
  project.drama.title = '第一章..续';
  project.characters[0].image_file = 'media/character.png';
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(JSON.stringify(project), 'utf8'));
  zip.addFile('media/character.png', Buffer.from('portable-media-content'));
  const database = createDatabase(t);
  const storage = createStorage(t);
  const result = projectZipService.importDrama(database, { storage: { local_path: storage } }, createLog(), zip.toBuffer());
  const localPath = database.prepare('SELECT local_path FROM characters WHERE drama_id = ?').pluck().get(result.drama_id);
  assert.equal(fs.readFileSync(path.join(storage, ...localPath.split('/')), 'utf8'), 'portable-media-content');
});
