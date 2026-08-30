const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const { V2MigrationError, runV2Migrations } = require('../src/db/v2');
const assetService = require('../src/services/assetService');
const { createWorkflowPlanFixture } = require('./helpers/v2RepositoryDatabase');

const BASE_TABLES = Object.freeze([
  'source_documents',
  'source_blocks',
  'source_selections',
  'assets',
  'asset_versions',
  'workflow_definitions',
  'canvas_nodes',
  'canvas_edges',
  'workflow_manifests',
  'generation_runs',
  'workflow_runs',
  'node_runs',
  'export_runs',
  'remote_connections',
  'remote_tasks',
]);
const STATUS_TABLES = Object.freeze([
  'assets',
  'asset_versions',
  'workflow_definitions',
  'canvas_nodes',
  'workflow_manifests',
  'generation_runs',
  'workflow_runs',
  'node_runs',
  'export_runs',
  'remote_connections',
  'remote_tasks',
]);
const V2_MIGRATIONS_DIR = path.resolve(__dirname, '../migrations/v2');
const FIRST_MIGRATION_PATH = path.join(V2_MIGRATIONS_DIR, '0001_add_core_uids.sql');
const SECOND_MIGRATION_PATH = path.join(V2_MIGRATIONS_DIR, '0002_create_v2_base_tables.sql');
const THIRD_MIGRATION_PATH = path.join(V2_MIGRATIONS_DIR, '0003_source_evidence_integrity.sql');
const LEGACY_SCHEMA_SQL = fs.readFileSync(path.resolve(__dirname, '../migrations/01_init.sql'), 'utf8');
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function uid(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-v2-base-tables-'));
  const databases = new Set();
  t.after(() => {
    for (const database of databases) {
      if (!database.open) continue;
      if (database.inTransaction) database.exec('ROLLBACK');
      database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, databases };
}

function openDatabase(workspace, filename = 'project.sqlite') {
  const database = new Database(path.join(workspace.root, filename));
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 0');
  workspace.databases.add(database);
  return database;
}

function migrateEmptyLegacyDatabase(database) {
  database.exec(LEGACY_SCHEMA_SQL);
  database.prepare(`
    INSERT INTO assets (name, type, url, created_at, updated_at)
    VALUES ('legacy poster', 'image', 'legacy://poster', '2026-01-01', '2026-01-01')
  `).run();
  const result = runV2Migrations(database, { migrationsDir: V2_MIGRATIONS_DIR });
  assert.deepEqual(result.appliedVersions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(result.currentVersion, 14);
}

function assertBaseTableContract(database) {
  const existing = new Set(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map((row) => row.name));

  for (const table of BASE_TABLES) {
    assert.equal(existing.has(table), true, `${table} must exist`);
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    const uidColumn = columns.find((column) => column.name === 'uid');
    assert.equal(uidColumn?.pk, 1, `${table}.uid must be the primary key`);
    assert.equal(uidColumn?.notnull, 1, `${table}.uid must be NOT NULL`);
    assert.equal(
      columns.some((column) => /(password|secret|api_key|access_key|private_key|absolute_path)/i.test(column.name)),
      false,
      `${table} must not define secret-value or absolute-path columns`,
    );
  }
}

function insertSourceDocument(database, document) {
  const hasBlockCount = database.prepare('PRAGMA table_info(source_documents)').all()
    .some((column) => column.name === 'block_count');
  database.prepare(`
    INSERT INTO source_documents
      (uid, drama_uid, source_type, original_name, encoding, content_sha256, full_text${hasBlockCount ? ', block_count' : ''})
    VALUES
      (@uid, @dramaUid, @sourceType, @originalName, @encoding, @contentSha256, @fullText${hasBlockCount ? ', @blockCount' : ''})
  `).run(document);
}

function insertValidGraph(database) {
  const ids = Object.freeze({
    drama: uid(1),
    document: uid(2),
    blockStart: uid(3),
    blockEnd: uid(4),
    selection: uid(5),
    asset: uid(6),
    assetVersionOne: uid(7),
    assetVersionTwo: uid(8),
    workflow: uid(9),
    nodeSource: uid(10),
    nodeAsset: uid(11),
    edge: uid(12),
    manifest: uid(13),
    generationRun: uid(14),
    workflowRun: uid(15),
    nodeRun: uid(16),
    remoteConnection: uid(17),
    remoteTask: uid(18),
    exportRun: uid(19),
  });

  database.prepare("INSERT INTO dramas (title, uid) VALUES ('v2 project', ?)").run(ids.drama);
  insertSourceDocument(database, {
    uid: ids.document,
    dramaUid: ids.drama,
    sourceType: 'markdown',
    originalName: 'story.md',
    encoding: 'utf-8',
    contentSha256: SHA_A,
    fullText: '# Chapter\nText',
    blockCount: 2,
  });
  database.prepare(`
    INSERT INTO source_blocks
      (uid, document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256)
    VALUES (?, ?, 0, '["Chapter"]', 0, 9, 'Chapter', ?)
  `).run(ids.blockStart, ids.document, SHA_A);
  database.prepare(`
    INSERT INTO source_blocks
      (uid, document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256)
    VALUES (?, ?, 1, '["Chapter"]', 10, 14, 'Text', ?)
  `).run(ids.blockEnd, ids.document, SHA_B);
  database.prepare(`
    INSERT INTO source_selections
      (uid, document_uid, start_block_uid, end_block_uid, start_offset, end_offset, selected_text_sha256)
    VALUES (?, ?, ?, ?, 0, 4, ?)
  `).run(ids.selection, ids.document, ids.blockStart, ids.blockEnd, SHA_B);

  database.prepare(`
    INSERT INTO assets (uid, owner_type, owner_uid, asset_type, status)
    VALUES (?, 'drama', ?, 'image', 'draft')
  `).run(ids.asset, ids.drama);
  database.prepare(`
    INSERT INTO asset_versions
      (uid, asset_uid, storage_provider, logical_uri, relative_path, sha256, mime_type, width, height, status)
    VALUES (?, ?, 'local', 'asset://dramas/v2/poster/v1', 'projects/v2/assets/poster-v1.png', ?, 'image/png', 1024, 1024, 'ready')
  `).run(ids.assetVersionOne, ids.asset, SHA_A);
  database.prepare(`
    INSERT INTO asset_versions
      (uid, asset_uid, storage_provider, logical_uri, relative_path, sha256, mime_type, width, height, parent_uid, status)
    VALUES (?, ?, 'local', 'asset://dramas/v2/poster/v2', 'projects/v2/assets/poster-v2.png', ?, 'image/png', 1024, 1024, ?, 'ready')
  `).run(ids.assetVersionTwo, ids.asset, SHA_B, ids.assetVersionOne);
  database.prepare('UPDATE assets SET current_version_uid = ?, status = ? WHERE uid = ?')
    .run(ids.assetVersionTwo, 'ready', ids.asset);

  database.prepare(`
    INSERT INTO workflow_definitions (uid, drama_uid, name, version, status)
    VALUES (?, ?, 'MVP graph', 1, 'draft')
  `).run(ids.workflow, ids.drama);
  database.prepare(`
    INSERT INTO canvas_nodes
      (uid, workflow_uid, node_type, position_json, config_json, domain_ref_type, domain_ref_uid, status)
    VALUES (?, ?, 'source.selection', '{"x":0,"y":0}', '{}', 'source_selection', ?, 'ready')
  `).run(ids.nodeSource, ids.workflow, ids.selection);
  database.prepare(`
    INSERT INTO canvas_nodes
      (uid, workflow_uid, node_type, position_json, config_json, domain_ref_type, domain_ref_uid, status)
    VALUES (?, ?, 'asset.character', '{"x":320,"y":0}', '{}', 'asset', ?, 'draft')
  `).run(ids.nodeAsset, ids.workflow, ids.asset);
  database.prepare(`
    INSERT INTO canvas_edges
      (uid, workflow_uid, source_node_uid, source_port, target_node_uid, target_port)
    VALUES (?, ?, ?, 'selection', ?, 'facts')
  `).run(ids.edge, ids.workflow, ids.nodeSource, ids.nodeAsset);
  database.prepare(`
    INSERT INTO workflow_manifests
      (uid, manifest_id, version, engine, workflow_file, workflow_sha256, model_family,
       requirements_json, inputs_json, outputs_json, validation_json, status)
    VALUES (?, 'minimax-h3-t2v', '1.0.0', 'comfyui', 'workflows/h3-t2v-api.json', ?, 'minimax-h3',
      '[]', '{}', '{}', '{"valid":true}', 'validated')
  `).run(ids.manifest, SHA_A);

  database.prepare(`
    INSERT INTO generation_runs
      (uid, owner_type, owner_uid, provider, model, seed, parameters_json, input_json,
       output_asset_version_uid, status)
    VALUES (?, 'asset', ?, 'comfyui', 'minimax-h3', 42, '{"steps":4}', '{}', ?, 'succeeded')
  `).run(ids.generationRun, ids.asset, ids.assetVersionTwo);
  const hasRunSnapshotBinding = database.prepare('PRAGMA table_info(workflow_runs)').all()
    .some((column) => column.name === 'graph_hash');
  if (hasRunSnapshotBinding) {
    const workflowPlan = createWorkflowPlanFixture(ids.workflow, [ids.nodeAsset]);
    database.prepare(`
      INSERT INTO workflow_runs
        (uid, workflow_uid, graph_snapshot_json, graph_hash, graph_revision, trigger_type, status)
      VALUES (?, ?, ?, ?, ?, 'full', 'queued')
    `).run(
      ids.workflowRun,
      ids.workflow,
      JSON.stringify(workflowPlan),
      workflowPlan.graphHash,
      workflowPlan.graphRevision,
    );
    database.prepare(`
      INSERT INTO node_runs
        (uid, workflow_run_uid, node_uid, ordinal, input_snapshot_json, status)
      VALUES (?, ?, ?, 0, '{}', 'queued')
    `).run(ids.nodeRun, ids.workflowRun, ids.nodeAsset);
  } else {
    database.prepare(`
      INSERT INTO workflow_runs
        (uid, workflow_uid, graph_snapshot_json, trigger_type, status)
      VALUES (?, ?, '{"nodes":2,"edges":1}', 'full', 'running')
    `).run(ids.workflowRun, ids.workflow);
    database.prepare(`
      INSERT INTO node_runs
        (uid, workflow_run_uid, node_uid, input_snapshot_json, output_json, status)
      VALUES (?, ?, ?, '{}', '{"assetVersionUid":"${ids.assetVersionTwo}"}', 'succeeded')
    `).run(ids.nodeRun, ids.workflowRun, ids.nodeAsset);
  }

  database.prepare(`
    INSERT INTO remote_connections
      (uid, name, host, port, username, host_fingerprint, credential_ref, status)
    VALUES (?, 'Synthetic remote', 'gpu.example.invalid', 65022, 'fixture-user', ?, ?, 'ready')
  `).run(ids.remoteConnection, `SHA256:${'A'.repeat(43)}`, `credential:v1:${uid(20)}`);
  database.prepare(`
    INSERT INTO remote_tasks
      (uid, connection_uid, workflow_run_uid, provider, prompt_id, remote_relative_dir,
       stage, status, output_asset_version_uid)
    VALUES (?, ?, ?, 'comfyui', 'prompt-1', 'jobs/task-1', 'completed', 'succeeded', ?)
  `).run(ids.remoteTask, ids.remoteConnection, ids.workflowRun, ids.assetVersionTwo);
  database.prepare(`
    INSERT INTO export_runs
      (uid, drama_uid, workflow_run_uid, timeline_snapshot_json, encoding_json, audio_json,
       subtitle_json, output_asset_version_uid, validation_json, status)
    VALUES (?, ?, ?, '{}', '{"codec":"h264"}', '{}', '{}', ?, '{"playable":true}', 'succeeded')
  `).run(ids.exportRun, ids.drama, ids.workflowRun, ids.assetVersionTwo);

  return ids;
}

function insertOtherExecutionContext(database) {
  const ids = Object.freeze({
    drama: uid(1400),
    workflow: uid(1401),
    workflowRun: uid(1402),
    remoteConnection: uid(1403),
    node: uid(1405),
  });
  database.prepare("INSERT INTO dramas (title, uid) VALUES ('other v2 project', ?)").run(ids.drama);
  database.prepare(`
    INSERT INTO workflow_definitions (uid, drama_uid, name, version, status)
    VALUES (?, ?, 'Other execution graph', 1, 'active')
  `).run(ids.workflow, ids.drama);
  database.prepare(`
    INSERT INTO canvas_nodes (uid, workflow_uid, node_type, position_json, config_json, status)
    VALUES (?, ?, 'source.selection', '{}', '{}', 'ready')
  `).run(ids.node, ids.workflow);
  const workflowPlan = createWorkflowPlanFixture(ids.workflow, [ids.node]);
  database.prepare(`
    INSERT INTO workflow_runs
      (uid, workflow_uid, graph_snapshot_json, graph_hash, graph_revision, trigger_type, status)
    VALUES (?, ?, ?, ?, ?, 'manual', 'queued')
  `).run(
    ids.workflowRun,
    ids.workflow,
    JSON.stringify(workflowPlan),
    workflowPlan.graphHash,
    workflowPlan.graphRevision,
  );
  database.prepare(`
    INSERT INTO remote_connections
      (uid, name, host, port, username, credential_ref, status)
    VALUES (?, 'Other connection', '127.0.0.1', 22, 'runner', ?, 'ready')
  `).run(ids.remoteConnection, `credential:v1:${uid(1404)}`);
  return ids;
}

test('creates the fifteen Source, Asset, Workflow, Run, and Remote base tables', (t) => {
  const workspace = createWorkspace(t);
  const database = openDatabase(workspace);
  migrateEmptyLegacyDatabase(database);
  assertBaseTableContract(database);
  assert.equal(assetService.getById(database, 1).name, 'legacy poster');
  assert.equal(database.prepare('SELECT count(*) AS count FROM legacy_assets').get().count, 1);
  const createdLegacyAsset = assetService.create(database, null, { name: 'compatibility asset', type: 'image' });
  assert.equal(createdLegacyAsset.id, 2);
  assert.equal(assetService.update(database, null, createdLegacyAsset.id, { name: 'renamed asset' }).name, 'renamed asset');
  assert.equal(assetService.list(database, {}).total, 2);
  assert.equal(assetService.deleteById(database, null, createdLegacyAsset.id), true);
  assert.equal(assetService.getById(database, createdLegacyAsset.id), null);

  const ids = insertValidGraph(database);
  assert.deepEqual(database.prepare(`
    SELECT wr.uid AS workflow_run_uid, nr.uid AS node_run_uid, av.uid AS output_version_uid
    FROM workflow_runs wr
    JOIN node_runs nr ON nr.workflow_run_uid = wr.uid
    JOIN remote_tasks rt ON rt.workflow_run_uid = wr.uid
    JOIN asset_versions av ON av.uid = rt.output_asset_version_uid
    WHERE wr.uid = ?
  `).get(ids.workflowRun), {
    workflow_run_uid: ids.workflowRun,
    node_run_uid: ids.nodeRun,
    output_version_uid: ids.assetVersionTwo,
  });

  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
  assert.deepEqual(runV2Migrations(database, { migrationsDir: V2_MIGRATIONS_DIR }).appliedVersions, []);

  database.close();
  const reopened = openDatabase(workspace);
  assertBaseTableContract(reopened);
  assert.equal(assetService.getById(reopened, 1).name, 'legacy poster');
  assert.equal(reopened.prepare('SELECT current_version_uid FROM assets WHERE uid = ?')
    .get(ids.asset).current_version_uid, ids.assetVersionTwo);
});

test('upgrades an existing version-two database with append-only source evidence guards', (t) => {
  const workspace = createWorkspace(t);
  const migrationsDir = path.join(workspace.root, 'migrations');
  fs.mkdirSync(migrationsDir);
  fs.copyFileSync(FIRST_MIGRATION_PATH, path.join(migrationsDir, path.basename(FIRST_MIGRATION_PATH)));
  fs.copyFileSync(SECOND_MIGRATION_PATH, path.join(migrationsDir, path.basename(SECOND_MIGRATION_PATH)));
  const database = openDatabase(workspace, 'upgrade.sqlite');
  database.exec(LEGACY_SCHEMA_SQL);

  const versionTwo = runV2Migrations(database, { migrationsDir });
  assert.deepEqual(versionTwo.appliedVersions, [1, 2]);
  assert.equal(versionTwo.currentVersion, 2);
  const ids = insertValidGraph(database);
  database.prepare('UPDATE source_documents SET content_sha256 = ? WHERE uid = ?')
    .run(SHA_B, ids.document);

  fs.copyFileSync(THIRD_MIGRATION_PATH, path.join(migrationsDir, path.basename(THIRD_MIGRATION_PATH)));
  const upgraded = runV2Migrations(database, { migrationsDir });
  assert.deepEqual(upgraded.appliedVersions, [3]);
  assert.equal(upgraded.currentVersion, 3);
  assert.throws(
    () => database.prepare('UPDATE source_documents SET content_sha256 = ? WHERE uid = ?')
      .run(SHA_A, ids.document),
    /source document identity and evidence are immutable/i,
  );
  assert.equal(database.prepare('SELECT block_count FROM source_documents WHERE uid = ?')
    .get(ids.document).block_count, 2);
});

test('migration seven fails atomically instead of accepting unverifiable provisional run history', (t) => {
  const workspace = createWorkspace(t);
  const migrationsDir = path.join(workspace.root, 'through-version-six');
  fs.mkdirSync(migrationsDir);
  for (const filename of fs.readdirSync(V2_MIGRATIONS_DIR).filter((name) => /^000[1-6]_.*\.sql$/u.test(name))) {
    fs.copyFileSync(path.join(V2_MIGRATIONS_DIR, filename), path.join(migrationsDir, filename));
  }
  const database = openDatabase(workspace, 'legacy-runs.sqlite');
  database.exec(LEGACY_SCHEMA_SQL);
  assert.equal(runV2Migrations(database, { migrationsDir }).currentVersion, 6);
  insertValidGraph(database);

  assert.throws(
    () => runV2Migrations(database, { migrationsDir: V2_MIGRATIONS_DIR }),
    (error) => error instanceof V2MigrationError && error.code === 'MIGRATION_EXECUTION_FAILED',
  );
  assert.equal(database.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 6);
  assert.equal(database.prepare('PRAGMA table_info(workflow_runs)').all()
    .some((column) => column.name === 'graph_hash'), false);
  assert.equal(database.prepare(`
    SELECT count(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name = 'v2_migration_0007_empty_run_guard'
  `).get().count, 0);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
});

test('refuses to seal a version-two source document that has no evidence blocks', (t) => {
  const workspace = createWorkspace(t);
  const migrationsDir = path.join(workspace.root, 'migrations-orphan');
  fs.mkdirSync(migrationsDir);
  fs.copyFileSync(FIRST_MIGRATION_PATH, path.join(migrationsDir, path.basename(FIRST_MIGRATION_PATH)));
  fs.copyFileSync(SECOND_MIGRATION_PATH, path.join(migrationsDir, path.basename(SECOND_MIGRATION_PATH)));
  const database = openDatabase(workspace, 'orphan-upgrade.sqlite');
  database.exec(LEGACY_SCHEMA_SQL);
  runV2Migrations(database, { migrationsDir });
  const dramaUid = uid(28);
  database.prepare("INSERT INTO dramas (title, uid) VALUES ('orphan source', ?)").run(dramaUid);
  insertSourceDocument(database, {
    uid: uid(29),
    dramaUid,
    sourceType: 'txt',
    originalName: 'orphan.txt',
    encoding: 'utf-8',
    contentSha256: SHA_A,
    fullText: 'orphan',
    blockCount: 1,
  });
  fs.copyFileSync(THIRD_MIGRATION_PATH, path.join(migrationsDir, path.basename(THIRD_MIGRATION_PATH)));

  assert.throws(
    () => runV2Migrations(database, { migrationsDir }),
    (error) => error instanceof V2MigrationError && error.code === 'MIGRATION_EXECUTION_FAILED',
  );
  assert.equal(database.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 2);
  assert.equal(database.prepare('PRAGMA table_info(source_documents)').all()
    .some((column) => column.name === 'block_count'), false);
});

test('enforces UUID, JSON, status, relationship, uniqueness, and relative-path boundaries', (t) => {
  const workspace = createWorkspace(t);
  const database = openDatabase(workspace, 'constraints.sqlite');
  migrateEmptyLegacyDatabase(database);
  const ids = insertValidGraph(database);
  const constraintDocument = uid(29);
  insertSourceDocument(database, {
    uid: constraintDocument,
    dramaUid: ids.drama,
    sourceType: 'txt',
    originalName: 'constraint.txt',
    encoding: 'utf-8',
    contentSha256: SHA_A,
    fullText: 'x',
    blockCount: 1,
  });

  assert.throws(
    () => database.prepare(`
      INSERT INTO source_documents
        (uid, drama_uid, source_type, original_name, encoding, content_sha256, full_text, block_count)
      VALUES ('not-a-uuid', ?, 'txt', 'bad.txt', 'utf-8', ?, '', 1)
    `).run(ids.drama, SHA_A),
    /CHECK constraint failed/i,
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO source_blocks
        (uid, document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256)
      VALUES (?, ?, 0, '{}', 0, 1, 'x', ?)
    `).run(uid(30), constraintDocument, SHA_A),
    /CHECK constraint failed/i,
  );
  database.prepare(`
    INSERT INTO source_blocks
      (uid, document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256)
    VALUES (?, ?, 0, '[]', 0, 1, 'x', ?)
  `).run(uid(32), constraintDocument, SHA_A);
  assert.throws(
    () => database.prepare(`
      INSERT INTO source_blocks
        (uid, document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256)
      VALUES (?, ?, 2, '[]', 20, 21, 'x', ?)
    `).run(uid(31), uid(999), SHA_A),
    /FOREIGN KEY constraint failed/i,
  );

  for (const table of STATUS_TABLES) {
    assert.throws(
      () => database.prepare(`UPDATE ${table} SET status = 'unknown-state' WHERE uid = (SELECT min(uid) FROM ${table})`).run(),
      /CHECK constraint failed|status transition is invalid|state fields are inconsistent/i,
      `${table}.status must use its declared state set`,
    );
  }

  for (const table of BASE_TABLES) {
    for (const invalidUid of [`${uid(900)}\0tail`, Buffer.from(uid(901))]) {
      assert.throws(
        () => database.prepare(`UPDATE ${table} SET uid = ? WHERE uid = (SELECT min(uid) FROM ${table})`).run(invalidUid),
        /CHECK constraint failed|(?:run|task) (?:ownership|identity|snapshot and identity) (?:is|are) immutable|remote connection identity is immutable|source (?:document|block|selection).*immutable/i,
        `${table}.uid must reject NUL-suffixed text and BLOB values`,
      );
    }
  }

  assert.throws(
    () => database.prepare(`UPDATE canvas_nodes SET config_json = '[]' WHERE uid = ?`).run(ids.nodeSource),
    /CHECK constraint failed/i,
  );
  assert.throws(
    () => database.prepare(`UPDATE workflow_manifests SET requirements_json = '{}' WHERE uid = ?`).run(ids.manifest),
    /CHECK constraint failed/i,
  );
  assert.throws(
    () => database.prepare(`UPDATE generation_runs SET parameters_json = '[]' WHERE uid = ?`).run(ids.generationRun),
    /CHECK constraint failed/i,
  );
  assert.throws(
    () => database.prepare(`UPDATE workflow_runs SET graph_snapshot_json = '[]' WHERE uid = ?`).run(ids.workflowRun),
    /CHECK constraint failed|snapshot and identity are immutable/i,
  );
  assert.throws(
    () => database.prepare(`UPDATE node_runs SET input_snapshot_json = '[]' WHERE uid = ?`).run(ids.nodeRun),
    /CHECK constraint failed|state fields are inconsistent/i,
  );
  assert.throws(
    () => database.prepare(`UPDATE export_runs SET timeline_snapshot_json = '[]' WHERE uid = ?`).run(ids.exportRun),
    /CHECK constraint failed/i,
  );

  const otherDocument = uid(40);
  const otherBlock = uid(41);
  insertSourceDocument(database, {
    uid: otherDocument,
    dramaUid: ids.drama,
    sourceType: 'txt',
    originalName: 'other.txt',
    encoding: 'utf-8',
    contentSha256: SHA_A,
    fullText: 'other',
    blockCount: 1,
  });
  database.prepare(`
    INSERT INTO source_blocks
      (uid, document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256)
    VALUES (?, ?, 0, '[]', 0, 5, 'other', ?)
  `).run(otherBlock, otherDocument, SHA_A);
  assert.throws(
    () => database.prepare(`
      INSERT INTO source_selections
        (uid, document_uid, start_block_uid, end_block_uid, start_offset, end_offset, selected_text_sha256)
      VALUES (?, ?, ?, ?, 0, 1, ?)
    `).run(uid(42), ids.document, ids.blockStart, otherBlock, SHA_A),
    /selection blocks must belong to the selected document/i,
  );
  assert.throws(
    () => database.prepare('UPDATE source_blocks SET document_uid = ? WHERE uid = ?')
      .run(otherDocument, ids.blockStart),
    /source block identity and content are immutable/i,
  );

  const otherAsset = uid(50);
  const otherVersion = uid(51);
  database.prepare(`
    INSERT INTO assets (uid, owner_type, owner_uid, asset_type, status)
    VALUES (?, 'drama', ?, 'image', 'draft')
  `).run(otherAsset, ids.drama);
  database.prepare(`
    INSERT INTO asset_versions
      (uid, asset_uid, storage_provider, logical_uri, relative_path, status)
    VALUES (?, ?, 'local', 'asset://dramas/v2/other', 'projects/v2/assets/other.png', 'ready')
  `).run(otherVersion, otherAsset);
  assert.throws(
    () => database.prepare('UPDATE assets SET current_version_uid = ? WHERE uid = ?')
      .run(otherVersion, ids.asset),
    /current asset version must belong to the asset/i,
  );
  assert.throws(
    () => database.prepare('UPDATE asset_versions SET parent_uid = ? WHERE uid = ?')
      .run(otherVersion, ids.assetVersionTwo),
    /parent asset version must belong to the same asset/i,
  );
  assert.throws(
    () => database.prepare('UPDATE asset_versions SET asset_uid = ? WHERE uid = ?')
      .run(otherAsset, ids.assetVersionTwo),
    /asset version ownership is immutable/i,
  );

  const otherWorkflow = uid(60);
  const otherNode = uid(61);
  database.prepare(`
    INSERT INTO workflow_definitions (uid, drama_uid, name, version, status)
    VALUES (?, ?, 'Other graph', 1, 'draft')
  `).run(otherWorkflow, ids.drama);
  database.prepare(`
    INSERT INTO canvas_nodes (uid, workflow_uid, node_type, position_json, config_json, status)
    VALUES (?, ?, 'source.selection', '{}', '{}', 'draft')
  `).run(otherNode, otherWorkflow);
  assert.throws(
    () => database.prepare(`
      INSERT INTO canvas_edges
        (uid, workflow_uid, source_node_uid, source_port, target_node_uid, target_port)
      VALUES (?, ?, ?, 'out', ?, 'in')
    `).run(uid(62), ids.workflow, ids.nodeSource, otherNode),
    /edge nodes must belong to the edge workflow/i,
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO node_runs (uid, workflow_run_uid, node_uid, ordinal, input_snapshot_json, status)
      VALUES (?, ?, ?, 1, '{}', 'queued')
    `).run(uid(63), ids.workflowRun, otherNode),
    /node run (?:must reference a node from its workflow|initial state and snapshot binding are invalid)/i,
  );
  assert.throws(
    () => database.prepare('UPDATE canvas_nodes SET workflow_uid = ? WHERE uid = ?')
      .run(otherWorkflow, ids.nodeSource),
    /canvas node workflow ownership is immutable/i,
  );
  assert.throws(
    () => database.prepare('UPDATE workflow_runs SET workflow_uid = ? WHERE uid = ?')
      .run(otherWorkflow, ids.workflowRun),
    /workflow run (?:ownership is|snapshot and identity are) immutable/i,
  );

  assert.throws(
    () => database.prepare(`
      INSERT INTO asset_versions
        (uid, asset_uid, storage_provider, logical_uri, relative_path, status)
      VALUES (?, ?, 'local', 'asset://bad/absolute', 'C:\\temp\\asset.png', 'pending')
    `).run(uid(70), ids.asset),
    /CHECK constraint failed/i,
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO workflow_manifests
        (uid, manifest_id, version, engine, workflow_file, workflow_sha256,
         requirements_json, inputs_json, outputs_json, validation_json, status)
      VALUES (?, 'absolute', '1.0.0', 'comfyui', '/tmp/workflow.json', ?, '[]', '{}', '{}', '{}', 'draft')
    `).run(uid(71), SHA_A),
    /CHECK constraint failed/i,
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO remote_tasks
        (uid, connection_uid, provider, remote_relative_dir, stage, status)
      VALUES (?, ?, 'comfyui', 'C:\\jobs\\task', 'prepared', 'queued')
    `).run(uid(72), ids.remoteConnection),
    /CHECK constraint failed/i,
  );

  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});

test('rolls back a failed base-table migration and succeeds after the schema collision is removed', (t) => {
  const workspace = createWorkspace(t);
  const database = openDatabase(workspace, 'recoverable.sqlite');
  const firstOnlyDir = path.join(workspace.root, 'first-migration');
  fs.mkdirSync(firstOnlyDir);
  fs.copyFileSync(FIRST_MIGRATION_PATH, path.join(firstOnlyDir, path.basename(FIRST_MIGRATION_PATH)));

  database.exec(LEGACY_SCHEMA_SQL);
  assert.deepEqual(runV2Migrations(database, { migrationsDir: firstOnlyDir }).appliedVersions, [1]);
  database.exec('CREATE TABLE source_documents (uid TEXT PRIMARY KEY)');

  assert.throws(
    () => runV2Migrations(database, { migrationsDir: V2_MIGRATIONS_DIR }),
    (error) => error instanceof V2MigrationError && error.code === 'MIGRATION_EXECUTION_FAILED',
  );
  assert.deepEqual(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(), [{ version: 1 }]);
  for (const table of BASE_TABLES.filter((table) => !['source_documents', 'assets'].includes(table))) {
    assert.equal(database.prepare(`
      SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table).count, 0, `${table} must roll back`);
  }
  const rolledBackAssetColumns = database.prepare('PRAGMA table_info(assets)').all();
  assert.equal(rolledBackAssetColumns.some((column) => column.name === 'id'), true);
  assert.equal(rolledBackAssetColumns.some((column) => column.name === 'uid'), false);
  assert.equal(database.prepare(`
    SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'legacy_assets'
  `).get().count, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_documents').get().count, 0);

  database.exec('DROP TABLE source_documents');
  const recovered = runV2Migrations(database, { migrationsDir: V2_MIGRATIONS_DIR });
  assert.deepEqual(recovered.appliedVersions, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(recovered.currentVersion, 14);
  assertBaseTableContract(database);
  assert.equal(database.prepare('SELECT count(*) AS count FROM legacy_assets').get().count, 0);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
});

test('rejects traversal, ambiguous segments, and NUL in every relative path field', (t) => {
  const workspace = createWorkspace(t);
  const database = openDatabase(workspace, 'relative-paths.sqlite');
  migrateEmptyLegacyDatabase(database);
  const ids = insertValidGraph(database);
  const invalidPaths = [
    '../outside.bin',
    'safe/../../outside.bin',
    'safe\\..\\outside.bin',
    './inside.bin',
    'safe/./inside.bin',
    'safe//inside.bin',
    'safe/inside/',
    `safe\0outside.bin`,
  ];

  invalidPaths.forEach((invalidPath, index) => {
    assert.throws(
      () => database.prepare(`
        INSERT INTO asset_versions
          (uid, asset_uid, storage_provider, logical_uri, relative_path, status)
        VALUES (?, ?, 'local', ?, ?, 'pending')
      `).run(uid(1000 + index), ids.asset, `asset://invalid/${index}`, invalidPath),
      /CHECK constraint failed/i,
      `asset version path must reject ${JSON.stringify(invalidPath)}`,
    );
    assert.throws(
      () => database.prepare(`
        INSERT INTO workflow_manifests
          (uid, manifest_id, version, engine, workflow_file, workflow_sha256,
           requirements_json, inputs_json, outputs_json, validation_json, status)
        VALUES (?, ?, '1.0.0', 'comfyui', ?, ?, '[]', '{}', '{}', '{}', 'draft')
      `).run(uid(1100 + index), `invalid-path-${index}`, invalidPath, SHA_A),
      /CHECK constraint failed/i,
      `workflow file must reject ${JSON.stringify(invalidPath)}`,
    );
    assert.throws(
      () => database.prepare(`
        INSERT INTO remote_tasks
          (uid, connection_uid, provider, remote_relative_dir, stage, status)
        VALUES (?, ?, 'comfyui', ?, 'prepared', 'queued')
      `).run(uid(1200 + index), ids.remoteConnection, invalidPath),
      /CHECK constraint failed/i,
      `remote task path must reject ${JSON.stringify(invalidPath)}`,
    );
  });
});

test('accepts only versioned opaque credential references', (t) => {
  const workspace = createWorkspace(t);
  const database = openDatabase(workspace, 'credential-references.sqlite');
  migrateEmptyLegacyDatabase(database);
  const ids = insertValidGraph(database);
  const invalidReferences = [
    'plain-text-password',
    'vault://featurize/test',
    'credential:v1:not-a-uuid',
    `credential:v1:${uid(100)}\nsecret`,
    `credential:v1:${uid(100)}\0tail`,
    Buffer.from(`credential:v1:${uid(100)}`),
  ];

  for (const invalidReference of invalidReferences) {
    assert.throws(
      () => database.prepare('UPDATE remote_connections SET credential_ref = ? WHERE uid = ?')
        .run(invalidReference, ids.remoteConnection),
      /CHECK constraint failed/i,
    );
  }
  assert.equal(database.prepare('SELECT credential_ref FROM remote_connections WHERE uid = ?')
    .get(ids.remoteConnection).credential_ref, `credential:v1:${uid(20)}`);
});

test('prevents cyclic asset version ancestry', (t) => {
  const workspace = createWorkspace(t);
  const database = openDatabase(workspace, 'asset-version-cycle.sqlite');
  migrateEmptyLegacyDatabase(database);
  const ids = insertValidGraph(database);

  assert.throws(
    () => database.prepare('UPDATE asset_versions SET parent_uid = ? WHERE uid = ?')
      .run(ids.assetVersionTwo, ids.assetVersionOne),
    /asset version ancestry must be acyclic/i,
  );
  assert.equal(database.prepare('SELECT parent_uid FROM asset_versions WHERE uid = ?')
    .get(ids.assetVersionOne).parent_uid, null);
});

test('keeps node run ownership immutable after creation', (t) => {
  const workspace = createWorkspace(t);
  const database = openDatabase(workspace, 'node-run-ownership.sqlite');
  migrateEmptyLegacyDatabase(database);
  const ids = insertValidGraph(database);
  const otherWorkflow = uid(1300);
  const otherNode = uid(1301);
  const otherRun = uid(1302);
  database.prepare(`
    INSERT INTO workflow_definitions (uid, drama_uid, name, version, status)
    VALUES (?, ?, 'Immutable other graph', 1, 'active')
  `).run(otherWorkflow, ids.drama);
  database.prepare(`
    INSERT INTO canvas_nodes (uid, workflow_uid, node_type, position_json, config_json, status)
    VALUES (?, ?, 'source.selection', '{}', '{}', 'ready')
  `).run(otherNode, otherWorkflow);
  const otherPlan = createWorkflowPlanFixture(otherWorkflow, [otherNode]);
  database.prepare(`
    INSERT INTO workflow_runs
      (uid, workflow_uid, graph_snapshot_json, graph_hash, graph_revision, trigger_type, status)
    VALUES (?, ?, ?, ?, ?, 'manual', 'queued')
  `).run(otherRun, otherWorkflow, JSON.stringify(otherPlan), otherPlan.graphHash, otherPlan.graphRevision);

  assert.throws(
    () => database.prepare(`
      UPDATE node_runs SET workflow_run_uid = ?, node_uid = ? WHERE uid = ?
    `).run(otherRun, otherNode, ids.nodeRun),
    /node run (?:ownership|identity) is immutable/i,
  );
  assert.deepEqual(database.prepare(`
    SELECT workflow_run_uid, node_uid FROM node_runs WHERE uid = ?
  `).get(ids.nodeRun), {
    workflow_run_uid: ids.workflowRun,
    node_uid: ids.nodeAsset,
  });
});

test('stores only machine error codes and versioned opaque error detail references', (t) => {
  const workspace = createWorkspace(t);
  const database = openDatabase(workspace, 'error-references.sqlite');
  migrateEmptyLegacyDatabase(database);
  const ids = insertValidGraph(database);
  const runRows = [
    ['generation_runs', ids.generationRun],
    ['remote_tasks', ids.remoteTask],
    ['export_runs', ids.exportRun],
  ];
  const invalidReferences = [
    'Bearer raw-secret-token',
    '{"provider":"raw response"}',
    'error-detail:v1:not-a-uuid',
    `error-detail:v1:${uid(1500)}\nsecret`,
    `error-detail:v1:${uid(1500)}\0tail`,
    Buffer.from(`error-detail:v1:${uid(1500)}`),
  ];
  const invalidCodes = [
    'Bearer raw-secret-token',
    'provider error message',
    'err_lowercase',
    'ERR_',
    `ERR_BAD\nTOKEN`,
    `ERR_GOOD\0SECRET`,
    `ERR_${'A'.repeat(61)}`,
    Buffer.from('ERR_PROVIDER_FAILURE'),
  ];

  runRows.forEach(([table, rowUid], index) => {
    const validReference = `error-detail:v1:${uid(1510 + index)}`;
    database.prepare(`UPDATE ${table} SET error_code = 'ERR_PROVIDER_FAILURE', error_detail_ref = ? WHERE uid = ?`)
      .run(validReference, rowUid);
    for (const invalidReference of invalidReferences) {
      assert.throws(
        () => database.prepare(`UPDATE ${table} SET error_detail_ref = ? WHERE uid = ?`)
          .run(invalidReference, rowUid),
        /CHECK constraint failed/i,
        `${table}.error_detail_ref must reject raw error detail`,
      );
    }
    for (const invalidCode of invalidCodes) {
      assert.throws(
        () => database.prepare(`UPDATE ${table} SET error_code = ? WHERE uid = ?`)
          .run(invalidCode, rowUid),
        /CHECK constraint failed/i,
        `${table}.error_code must reject non-machine codes`,
      );
    }
    assert.deepEqual(database.prepare(`SELECT error_code, error_detail_ref FROM ${table} WHERE uid = ?`)
      .get(rowUid), {
      error_code: 'ERR_PROVIDER_FAILURE',
      error_detail_ref: validReference,
    });
  });

  const statefulRuns = [
    ['workflow_runs', ids.workflowRun, 'failed'],
    ['node_runs', ids.nodeRun, 'blocked'],
  ];
  statefulRuns.forEach(([table, rowUid, failedStatus], tableIndex) => {
    for (const invalidReference of invalidReferences) {
      assert.throws(
        () => database.prepare(`
          UPDATE ${table}
          SET status = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              error_code = 'ERR_PROVIDER_FAILURE', error_detail_ref = ?
          WHERE uid = ?
        `).run(failedStatus, invalidReference, rowUid),
        /CHECK constraint failed/i,
      );
    }
    for (const invalidCode of invalidCodes) {
      assert.throws(
        () => database.prepare(`
          UPDATE ${table}
          SET status = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              error_code = ?, error_detail_ref = ?
          WHERE uid = ?
        `).run(failedStatus, invalidCode, `error-detail:v1:${uid(1550 + tableIndex)}`, rowUid),
        /CHECK constraint failed/i,
      );
    }
    const validReference = `error-detail:v1:${uid(1560 + tableIndex)}`;
    database.prepare(`
      UPDATE ${table}
      SET status = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          error_code = 'ERR_PROVIDER_FAILURE', error_detail_ref = ?
      WHERE uid = ?
    `).run(failedStatus, validReference, rowUid);
    assert.deepEqual(database.prepare(`SELECT error_code, error_detail_ref FROM ${table} WHERE uid = ?`)
      .get(rowUid), {
      error_code: 'ERR_PROVIDER_FAILURE',
      error_detail_ref: validReference,
    });
  });
});

test('keeps adjacent execution ownership immutable and enforces export drama consistency', (t) => {
  const workspace = createWorkspace(t);
  const database = openDatabase(workspace, 'execution-ownership.sqlite');
  migrateEmptyLegacyDatabase(database);
  const ids = insertValidGraph(database);
  const other = insertOtherExecutionContext(database);
  const replacementPlan = createWorkflowPlanFixture(other.workflow, [other.node]);

  assert.throws(
    () => database.prepare('UPDATE generation_runs SET owner_type = ?, owner_uid = ? WHERE uid = ?')
      .run('drama', other.drama, ids.generationRun),
    /generation run ownership is immutable/i,
  );
  assert.throws(
    () => database.prepare(`
      UPDATE remote_tasks SET connection_uid = ?, workflow_run_uid = ? WHERE uid = ?
    `).run(other.remoteConnection, other.workflowRun, ids.remoteTask),
    /remote task ownership is immutable/i,
  );
  assert.throws(
    () => database.prepare(`
      UPDATE export_runs SET drama_uid = ?, workflow_run_uid = ? WHERE uid = ?
    `).run(other.drama, other.workflowRun, ids.exportRun),
    /export run ownership is immutable/i,
  );
  assert.throws(
    () => database.prepare('UPDATE workflow_definitions SET drama_uid = ? WHERE uid = ?')
      .run(ids.drama, other.workflow),
    /workflow drama ownership is immutable/i,
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO export_runs
        (uid, drama_uid, workflow_run_uid, timeline_snapshot_json, status)
      VALUES (?, ?, ?, '{}', 'queued')
    `).run(uid(1450), ids.drama, other.workflowRun),
    /export run drama must match its workflow run/i,
  );
  assert.throws(
    () => database.prepare(`
      INSERT OR REPLACE INTO generation_runs
        (uid, owner_type, owner_uid, provider, model, status)
      VALUES (?, 'drama', ?, 'comfyui', 'replacement', 'queued')
    `).run(ids.generationRun, other.drama),
    /generation run identity cannot be replaced/i,
  );
  assert.throws(
    () => database.prepare(`
      INSERT OR REPLACE INTO workflow_runs
        (uid, workflow_uid, graph_snapshot_json, graph_hash, graph_revision, trigger_type, status)
      VALUES (?, ?, ?, ?, ?, 'manual', 'queued')
    `).run(
      ids.workflowRun,
      other.workflow,
      JSON.stringify(replacementPlan),
      replacementPlan.graphHash,
      replacementPlan.graphRevision,
    ),
    /workflow run identity cannot be replaced/i,
  );
  assert.throws(
    () => database.prepare(`
      INSERT OR REPLACE INTO node_runs
        (uid, workflow_run_uid, node_uid, ordinal, input_snapshot_json, status)
      VALUES (?, ?, ?, 0, '{}', 'queued')
    `).run(ids.nodeRun, other.workflowRun, other.node),
    /node run identity cannot be replaced/i,
  );
  assert.throws(
    () => database.prepare(`
      INSERT OR REPLACE INTO remote_tasks
        (uid, connection_uid, workflow_run_uid, provider, remote_relative_dir, stage, status)
      VALUES (?, ?, ?, 'comfyui', 'jobs/replaced', 'prepared', 'queued')
    `).run(ids.remoteTask, other.remoteConnection, other.workflowRun),
    /remote task identity cannot be replaced/i,
  );
  assert.throws(
    () => database.prepare(`
      INSERT OR REPLACE INTO export_runs
        (uid, drama_uid, workflow_run_uid, timeline_snapshot_json, status)
      VALUES (?, ?, ?, '{}', 'queued')
    `).run(ids.exportRun, other.drama, other.workflowRun),
    /export run identity cannot be replaced/i,
  );
  assert.throws(
    () => database.prepare('UPDATE generation_runs SET uid = ? WHERE uid = ?')
      .run(uid(1499), ids.generationRun),
    /generation run ownership is immutable/i,
  );
});

test('rejects remote prompt identity collisions for every UPDATE conflict policy', (t) => {
  const workspace = createWorkspace(t);
  const database = openDatabase(workspace, 'remote-prompt-collision.sqlite');
  migrateEmptyLegacyDatabase(database);
  const ids = insertValidGraph(database);

  ['IGNORE', 'FAIL', 'REPLACE'].forEach((policy, index) => {
    const taskUid = uid(1500 + index);
    database.prepare(`
      INSERT INTO remote_tasks
        (uid, connection_uid, workflow_run_uid, provider, remote_relative_dir, stage, status)
      VALUES (?, ?, ?, 'comfyui', ?, 'submitted', 'running')
    `).run(taskUid, ids.remoteConnection, ids.workflowRun, `jobs/pending-${index}`);

    assert.throws(
      () => database.prepare(`
        UPDATE OR ${policy} remote_tasks SET prompt_id = 'prompt-1' WHERE uid = ?
      `).run(taskUid),
      /remote task prompt identity conflicts with existing task/i,
      `UPDATE OR ${policy} must not replace or ignore a conflicting remote prompt identity`,
    );
    assert.equal(database.prepare('SELECT prompt_id FROM remote_tasks WHERE uid = ?').get(taskUid).prompt_id, null);
    assert.equal(database.prepare("SELECT uid FROM remote_tasks WHERE prompt_id = 'prompt-1'").get().uid, ids.remoteTask);
  });

  assert.equal(database.prepare('SELECT count(*) AS count FROM remote_tasks').get().count, 4);
});

test('allows one remote prompt assignment and keeps it immutable afterward', (t) => {
  const workspace = createWorkspace(t);
  const database = openDatabase(workspace, 'remote-prompt-immutable.sqlite');
  migrateEmptyLegacyDatabase(database);
  const ids = insertValidGraph(database);
  const pendingTaskUid = uid(1510);
  database.prepare(`
    INSERT INTO remote_tasks
      (uid, connection_uid, workflow_run_uid, provider, remote_relative_dir, stage, status)
    VALUES (?, ?, ?, 'comfyui', 'jobs/pending-once', 'submitted', 'running')
  `).run(pendingTaskUid, ids.remoteConnection, ids.workflowRun);

  const assigned = database.prepare(`
    UPDATE remote_tasks SET prompt_id = 'prompt-once' WHERE uid = ?
  `).run(pendingTaskUid);
  assert.equal(assigned.changes, 1);

  ['', ' OR IGNORE', ' OR FAIL', ' OR REPLACE'].forEach((policy) => {
    assert.throws(
      () => database.prepare(`
        UPDATE${policy} remote_tasks SET prompt_id = 'prompt-changed' WHERE uid = ?
      `).run(pendingTaskUid),
      /remote task prompt identity is immutable/i,
    );
  });
  assert.throws(
    () => database.prepare('UPDATE remote_tasks SET prompt_id = NULL WHERE uid = ?').run(pendingTaskUid),
    /remote task prompt identity is immutable/i,
  );
  assert.equal(database.prepare('SELECT prompt_id FROM remote_tasks WHERE uid = ?').get(pendingTaskUid).prompt_id, 'prompt-once');
});

test('fails closed when a candidate parent chain is already cyclic', (t) => {
  const workspace = createWorkspace(t);
  const database = openDatabase(workspace, 'preexisting-version-cycle.sqlite');
  migrateEmptyLegacyDatabase(database);
  const ids = insertValidGraph(database);
  const detachedVersion = uid(1600);
  database.prepare(`
    INSERT INTO asset_versions
      (uid, asset_uid, storage_provider, logical_uri, relative_path, status)
    VALUES (?, ?, 'local', 'asset://dramas/v2/poster/detached', 'projects/v2/assets/detached.png', 'ready')
  `).run(detachedVersion, ids.asset);

  const updateTrigger = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND name = 'v2_asset_versions_acyclic_parent_update'
  `).get().sql;
  database.exec('DROP TRIGGER v2_asset_versions_acyclic_parent_update');
  database.prepare('UPDATE asset_versions SET parent_uid = ? WHERE uid = ?')
    .run(ids.assetVersionTwo, ids.assetVersionOne);
  database.exec(updateTrigger);

  assert.throws(
    () => database.prepare(`
      INSERT INTO asset_versions
        (uid, asset_uid, storage_provider, logical_uri, relative_path, parent_uid, status)
      VALUES (?, ?, 'local', 'asset://dramas/v2/poster/cycle-child',
        'projects/v2/assets/cycle-child.png', ?, 'ready')
    `).run(uid(1601), ids.asset, ids.assetVersionOne),
    /asset version ancestry must be acyclic/i,
  );
  assert.throws(
    () => database.prepare('UPDATE asset_versions SET parent_uid = ? WHERE uid = ?')
      .run(ids.assetVersionOne, detachedVersion),
    /asset version ancestry must be acyclic/i,
  );
});
