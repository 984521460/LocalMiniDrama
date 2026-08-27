const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const { createV2Repositories } = require('../src/repositories/v2');
const { createWorkflowRunService, createWorkflowService } = require('../src/workflows');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function domainSnapshot(database) {
  const rows = (table, orderBy) => database.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
  return structuredClone({
    characters: rows('characters', 'id'),
    storyboards: rows('storyboards', 'id'),
    sourceDocuments: rows('source_documents', 'uid'),
    sourceBlocks: rows('source_blocks', 'uid'),
    sourceSelections: rows('source_selections', 'uid'),
    assets: rows('assets', 'uid'),
    assetVersions: rows('asset_versions', 'uid'),
  });
}

function seedDomainEntities(database, repositories, dramaUid) {
  database.prepare("INSERT INTO episodes (id, drama_id, title) VALUES (1, 1, 'Episode')").run();
  database.prepare("INSERT INTO scenes (id, drama_id, episode_id, location) VALUES (1, 1, 1, 'Room')").run();
  database.prepare("INSERT INTO characters (id, drama_id, name) VALUES (1, 1, 'Character')").run();
  database.prepare("INSERT INTO storyboards (id, episode_id, scene_id, title) VALUES (1, 1, 1, 'Shot')").run();
  const characterUid = database.prepare('SELECT uid FROM characters WHERE id = 1').pluck().get();

  const documentUid = uid(9101);
  const blockUid = uid(9102);
  const selectionUid = uid(9103);
  repositories.sources.createDocumentWithBlocks({
    document: {
      uid: documentUid,
      dramaUid,
      sourceType: 'txt',
      originalName: 'domain-isolation.txt',
      encoding: 'utf-8',
      contentSha256: sha256('source'),
      fullText: 'source',
    },
    blocks: [{
      uid: blockUid,
      ordinal: 0,
      headingPath: [],
      charStart: 0,
      charEnd: 6,
      text: 'source',
      textSha256: sha256('source'),
    }],
  });
  repositories.sources.createSelection({
    uid: selectionUid,
    documentUid,
    startBlockUid: blockUid,
    endBlockUid: blockUid,
    startOffset: 0,
    endOffset: 6,
    selectedTextSha256: sha256('source'),
  });

  const assetUid = uid(9110);
  const versionUid = uid(9111);
  repositories.assets.create({
    uid: assetUid,
    ownerType: 'character',
    ownerUid: characterUid,
    assetType: 'reference_image',
    status: 'draft',
  });
  repositories.assets.addVersion({
    uid: versionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri: 'asset://character/reference-image-v1',
    relativePath: 'characters/reference-image-v1.png',
    sha256: sha256('image'),
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    durationMs: null,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  return { selectionUid, versionUid };
}

test('canvas and run foreign keys cannot own or cascade into domain entities', (t) => {
  const database = createMigratedV2Database(t);
  assert.deepEqual(
    database.pragma('foreign_key_list(canvas_nodes)').map((foreignKey) => foreignKey.table),
    ['workflow_definitions'],
  );
  assert.deepEqual(
    database.pragma('foreign_key_list(node_runs)').map((foreignKey) => foreignKey.table),
    ['workflow_runs'],
  );
});

test('moving and deleting canvas nodes preserves domain entities and frozen run history', (t) => {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(9100);
  insertDrama(database, dramaUid);
  const repositories = createV2Repositories(database);
  const { selectionUid, versionUid } = seedDomainEntities(database, repositories, dramaUid);

  const assetWorkflowUid = uid(9120);
  const assetNode = {
    uid: uid(9121),
    nodeType: 'asset.character',
    position: { x: 10, y: 20 },
    config: {},
    domainRefType: 'asset_version',
    domainRefUid: versionUid,
    status: 'disabled',
  };
  repositories.workflows.createGraph({
    definition: {
      uid: assetWorkflowUid,
      dramaUid,
      name: 'Asset view',
      version: 1,
      status: 'draft',
      description: null,
    },
    nodes: [assetNode],
    edges: [],
  });

  const workflowService = createWorkflowService({
    repositories,
    createUid: () => uid(9130),
  });
  const runService = createWorkflowRunService({ repositories, createUid: (() => {
    const values = [uid(9140), uid(9141)];
    return () => values.shift();
  })() });
  const workflow = workflowService.createWorkflow({ dramaId: 1, name: 'Source view' });
  const sourceNode = {
    uid: uid(9131),
    nodeType: 'source.selection',
    position: { x: 0, y: 0 },
    config: {},
    domainRef: { type: 'source_selection', uid: selectionUid },
  };
  workflowService.replaceGraph(workflow.definition.uid, {
    expectedRevision: 0,
    nodes: [sourceNode],
    edges: [],
  });
  const run = runService.createRun({
    workflowUid: workflow.definition.uid,
    triggerType: 'manual',
  });
  const before = domainSnapshot(database);

  repositories.workflows.replaceGraph({
    workflowUid: assetWorkflowUid,
    expectedRevision: 0,
    nodes: [{ ...assetNode, position: { x: 300, y: 400 } }],
    edges: [],
  });
  repositories.workflows.replaceGraph({
    workflowUid: assetWorkflowUid,
    expectedRevision: 1,
    nodes: [],
    edges: [],
  });
  workflowService.replaceGraph(workflow.definition.uid, {
    expectedRevision: 1,
    nodes: [{ ...sourceNode, position: { x: 500, y: 600 } }],
    edges: [],
  });
  workflowService.replaceGraph(workflow.definition.uid, {
    expectedRevision: 2,
    nodes: [],
    edges: [],
  });

  assert.deepEqual(domainSnapshot(database), before);
  assert.deepEqual(runService.getRun(run.run.uid), run);
  assert.equal(database.prepare('SELECT count(*) FROM canvas_nodes').pluck().get(), 0);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});
