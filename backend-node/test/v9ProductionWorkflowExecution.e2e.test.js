'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createV2Repositories } = require('../src/repositories/v2');
const {
  createMaterializedNodeExecutor,
  createWorkflowRunService,
  createWorkflowService,
  isNodeExecutionError,
} = require('../src/workflows');
const { isValidBoundDomainReference } = require('../src/workflows/domainReferences');
const {
  SUPPORTED_MATERIALIZED_NODE_TYPES,
} = require('../src/workflows/materializedNodeExecutor');
const { insertDrama, uid } = require('./helpers/v2RepositoryDatabase');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function testConfig(tempRoot) {
  const configDir = path.join(tempRoot, 'configs');
  const databasePath = path.join(tempRoot, 'data', 'workflow.sqlite').replace(/\\/gu, '/');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/gu, '/');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), [
    'app:',
    '  name: LocalMiniDrama-Production-Workflow',
    '  version: 0.0.0-test',
    'server:',
    '  port: 0',
    '  host: 127.0.0.1',
    '  insecure_tls: false',
    'database:',
    '  type: sqlite',
    `  path: "${databasePath}"`,
    'storage:',
    `  local_path: "${storagePath}"`,
    '',
  ].join('\n'), 'utf8');
}

function seedSelection(repositories, dramaUid) {
  const text = 'production materialized workflow evidence';
  const documentUid = uid(9951);
  const blockUid = uid(9952);
  const selectionUid = uid(9953);
  repositories.sources.createDocumentWithBlocks({
    document: {
      uid: documentUid,
      dramaUid,
      sourceType: 'txt',
      originalName: 'production-workflow.txt',
      encoding: 'utf-8',
      contentSha256: sha256(text),
      fullText: text,
    },
    blocks: [{
      uid: blockUid,
      ordinal: 0,
      headingPath: [],
      charStart: 0,
      charEnd: text.length,
      text,
      textSha256: sha256(text),
    }],
  });
  repositories.sources.createSelection({
    uid: selectionUid,
    documentUid,
    startBlockUid: blockUid,
    endBlockUid: blockUid,
    startOffset: 0,
    endOffset: text.length,
    selectedTextSha256: sha256(text),
  });
  return selectionUid;
}

function mediaVersion({ uid: versionUid, assetUid, status = 'ready', mimeType = 'video/mp4' }) {
  return {
    uid: versionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri: `asset://drama/production-workflow/${versionUid}`,
    relativePath: `projects/production-workflow/${versionUid}.mp4`,
    sha256: sha256(`media-${versionUid}`),
    mimeType,
    width: 608,
    height: 352,
    durationMs: 1625,
    parentUid: null,
    status,
    createdAt: '2026-08-31T00:00:00.000Z',
  };
}

test('materialized media references require a ready current AssetVersion', () => {
  const dramaUid = uid(9940);
  const assetUid = uid(9941);
  const versionUid = uid(9942);
  const node = {
    nodeType: 'shot.video',
    domainRefType: 'asset',
    domainRefUid: assetUid,
  };
  const check = (asset, getVersion) => isValidBoundDomainReference(node, {
    assets: { get: () => asset, getVersion },
  }, dramaUid);
  const baseAsset = {
    uid: assetUid,
    ownerType: 'drama',
    ownerUid: dramaUid,
    assetType: 'video',
    status: 'ready',
    currentVersionUid: versionUid,
  };
  const readyVersion = mediaVersion({ uid: versionUid, assetUid });

  let versionReads = 0;
  assert.equal(check({ ...baseAsset, status: 'draft', currentVersionUid: null }, () => {
    versionReads += 1;
    return readyVersion;
  }), false);
  assert.equal(check({ ...baseAsset, currentVersionUid: null }, () => {
    versionReads += 1;
    return readyVersion;
  }), false);
  assert.equal(versionReads, 0);
  assert.equal(check(baseAsset, () => mediaVersion({
    uid: versionUid,
    assetUid,
    status: 'pending',
  })), false);
  assert.equal(check(baseAsset, () => mediaVersion({
    uid: versionUid,
    assetUid: uid(9943),
  })), false);
  assert.equal(check(baseAsset, () => mediaVersion({
    uid: versionUid,
    assetUid,
    mimeType: 'image/png',
  })), false);
  assert.equal(check(baseAsset, () => readyVersion), true);
});

test('materialized execution fails closed when ready media drifts before node execution', (t) => {
  const { createMigratedV2Database } = require('./helpers/v2RepositoryDatabase');
  const database = createMigratedV2Database(t);
  const dramaUid = uid(9930);
  const assetUid = uid(9931);
  const versionUid = uid(9932);
  const nodeUid = uid(9933);
  insertDrama(database, dramaUid);
  const repositories = createV2Repositories(database);
  repositories.assets.create({
    uid: assetUid,
    ownerType: 'drama',
    ownerUid: dramaUid,
    assetType: 'video',
    status: 'draft',
  });
  const { createdAt, ...persistedVersion } = mediaVersion({
    uid: versionUid,
    assetUid,
  });
  assert.equal(createdAt, '2026-08-31T00:00:00.000Z');
  repositories.assets.addVersion(persistedVersion, { makeCurrent: true });
  const workflowService = createWorkflowService({ repositories });
  const graph = workflowService.createWorkflow({ dramaId: 1, name: 'Media drift fixture' });
  workflowService.replaceGraph(graph.definition.uid, {
    expectedRevision: 0,
    nodes: [{
      uid: nodeUid,
      nodeType: 'shot.video',
      position: { x: 0, y: 0 },
      config: {},
      domainRef: { type: 'asset', uid: assetUid },
      status: 'ready',
    }],
    edges: [],
  });
  const runService = createWorkflowRunService({ repositories });
  const created = runService.createRun({
    workflowUid: graph.definition.uid,
    triggerType: 'full',
  });
  runService.transitionWorkflow({
    runUid: created.run.uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  const runningNode = runService.transitionNode({
    nodeRunUid: created.nodes[0].uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
    inputSnapshot: {},
  });
  database.prepare(`
    UPDATE assets SET status = 'draft', current_version_uid = NULL WHERE uid = ?
  `).run(assetUid);

  const executeNode = createMaterializedNodeExecutor({ repositories, runService });
  assert.throws(() => executeNode({
    runUid: created.run.uid,
    nodeRunUid: runningNode.uid,
    node: created.run.graphSnapshot.snapshot.nodes[0],
    inputSnapshot: runningNode.inputSnapshot,
    signal: null,
  }), (error) => (
    isNodeExecutionError(error) && error.code === 'ERR_NODE_EXECUTION_DATA_INVALID'
  ));
});

async function waitForRun(request, runUid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(`/workflow-runs/${runUid}`);
    assert.equal(response.status, 200);
    if (['succeeded', 'failed', 'cancelled'].includes(response.body.data.run.status)) {
      return response.body.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`workflow run ${runUid} did not settle`);
}

test('actual createApp executes only current persisted evidence nodes and fails closed otherwise', async () => {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'production-workflow-e2e-'));
  testConfig(tempRoot);
  let server = null;
  let closeDatabase = () => {};
  try {
    process.chdir(tempRoot);
    const { createApp } = require('../src/app');
    const { closeDb } = require('../src/db');
    closeDatabase = closeDb;
    const created = createApp();
    await created.startupRecoveryPromise;
    const database = created.db;
    const repositories = createV2Repositories(database);
    const dramaUid = uid(9950);
    insertDrama(database, dramaUid);
    const selectionUid = seedSelection(repositories, dramaUid);
    const videoAssetUid = uid(9954);
    repositories.assets.create({
      uid: videoAssetUid,
      ownerType: 'drama',
      ownerUid: dramaUid,
      assetType: 'video',
      status: 'draft',
    });
    const videoVersionUid = uid(9955);
    const { createdAt, ...persistedVideoVersion } = mediaVersion({
      uid: videoVersionUid,
      assetUid: videoAssetUid,
    });
    assert.equal(createdAt, '2026-08-31T00:00:00.000Z');
    repositories.assets.addVersion(persistedVideoVersion, { makeCurrent: true });

    const draftAssetUid = uid(9956);
    repositories.assets.create({
      uid: draftAssetUid,
      ownerType: 'drama',
      ownerUid: dramaUid,
      assetType: 'video',
      status: 'draft',
    });

    server = await new Promise((resolve, reject) => {
      const instance = created.app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    const address = server.address();
    const request = async (pathname, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/v2${pathname}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      });
      return { status: response.status, body: await response.json() };
    };

    assert.deepEqual(
      created.runtime.workflows.supportedNodeTypes,
      SUPPORTED_MATERIALIZED_NODE_TYPES,
    );
    assert.equal(Object.isFrozen(created.runtime.workflows.supportedNodeTypes), true);

    const createdWorkflow = await request('/dramas/1/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'Persisted source selection' }),
    });
    assert.equal(createdWorkflow.status, 201);
    const workflowUid = createdWorkflow.body.data.definition.uid;
    const sourceNodeUid = uid(9960);
    const saved = await request(`/workflows/${workflowUid}/graph`, {
      method: 'PUT',
      body: JSON.stringify({
        expected_revision: 0,
        nodes: [{
          uid: sourceNodeUid,
          node_type: 'source.selection',
          position: { x: 0, y: 0 },
          config: {},
          domain_ref: { type: 'source_selection', uid: selectionUid },
          status: 'ready',
        }],
        edges: [],
      }),
    });
    assert.equal(saved.status, 200);

    const started = await request(`/workflows/${workflowUid}/runs`, {
      method: 'POST',
      body: JSON.stringify({ scope: { mode: 'full' }, max_retries: 0 }),
    });
    assert.equal(started.status, 202);
    const succeeded = await waitForRun(request, started.body.data.run_uid);
    assert.equal(succeeded.run.status, 'succeeded');
    assert.deepEqual(succeeded.nodes[0].output, {
      selection: { type: 'source_selection', uid: selectionUid },
    });

    const invalidMediaWorkflow = await request('/dramas/1/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'Invalid draft media evidence' }),
    });
    assert.equal(invalidMediaWorkflow.status, 201);
    const invalidMediaWorkflowUid = invalidMediaWorkflow.body.data.definition.uid;
    const invalidMediaNodeUid = uid(9964);
    const invalidMediaGraph = await request(`/workflows/${invalidMediaWorkflowUid}/graph`, {
      method: 'PUT',
      body: JSON.stringify({
        expected_revision: 0,
        nodes: [{
          uid: invalidMediaNodeUid,
          node_type: 'shot.video',
          position: { x: 0, y: 0 },
          config: {},
          domain_ref: { type: 'asset', uid: draftAssetUid },
          status: 'ready',
        }],
        edges: [],
      }),
    });
    assert.equal(invalidMediaGraph.status, 400);
    assert.equal(invalidMediaGraph.body.error.code, 'WORKFLOW_GRAPH_INVALID');

    const unsupportedWorkflow = await request('/dramas/1/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'Unsupported export execution' }),
    });
    assert.equal(unsupportedWorkflow.status, 201);
    const unsupportedWorkflowUid = unsupportedWorkflow.body.data.definition.uid;
    const videoNodeUid = uid(9961);
    const exportNodeUid = uid(9962);
    const unsupportedGraph = await request(`/workflows/${unsupportedWorkflowUid}/graph`, {
      method: 'PUT',
      body: JSON.stringify({
        expected_revision: 0,
        nodes: [{
          uid: videoNodeUid,
          node_type: 'shot.video',
          position: { x: 0, y: 0 },
          config: {},
          domain_ref: { type: 'asset', uid: videoAssetUid },
          status: 'ready',
        }, {
          uid: exportNodeUid,
          node_type: 'export.final',
          position: { x: 240, y: 0 },
          config: {},
          status: 'ready',
        }],
        edges: [{
          uid: uid(9963),
          source_node_uid: videoNodeUid,
          source_port: 'video',
          target_node_uid: exportNodeUid,
          target_port: 'videos',
        }],
      }),
    });
    assert.equal(unsupportedGraph.status, 200);
    const assetCountBefore = database.prepare('SELECT COUNT(*) FROM assets').pluck().get();
    const versionCountBefore = database.prepare('SELECT COUNT(*) FROM asset_versions').pluck().get();
    const unsupportedStart = await request(`/workflows/${unsupportedWorkflowUid}/runs`, {
      method: 'POST',
      body: JSON.stringify({ scope: { mode: 'full' }, max_retries: 0 }),
    });
    assert.equal(unsupportedStart.status, 202);
    const failed = await waitForRun(request, unsupportedStart.body.data.run_uid);
    assert.equal(failed.run.status, 'failed');
    assert.equal(failed.nodes.find((node) => node.nodeUid === videoNodeUid).status, 'succeeded');
    const unsupportedNode = failed.nodes.find((node) => node.nodeUid === exportNodeUid);
    assert.equal(unsupportedNode.status, 'failed');
    assert.equal(unsupportedNode.errorCode, 'ERR_NODE_EXECUTION_UNAVAILABLE');
    assert.equal(database.prepare('SELECT COUNT(*) FROM assets').pluck().get(), assetCountBefore);
    assert.equal(
      database.prepare('SELECT COUNT(*) FROM asset_versions').pluck().get(),
      versionCountBefore,
    );

    let proxyReads = 0;
    const hostileRoot = new Proxy({}, {
      get() {
        proxyReads += 1;
        throw new Error('synthetic-executor-sentinel');
      },
      getOwnPropertyDescriptor() {
        proxyReads += 1;
        throw new Error('synthetic-executor-sentinel');
      },
      ownKeys() {
        proxyReads += 1;
        throw new Error('synthetic-executor-sentinel');
      },
    });
    assert.throws(
      () => created.runtime.workflows.executeNode(hostileRoot),
      (error) => isNodeExecutionError(error) && error.code === 'ERR_NODE_EXECUTION_DATA_INVALID',
    );
    assert.equal(proxyReads, 0);

    let accessorReads = 0;
    const hostileNested = {
      runUid: uid(9970),
      nodeRunUid: uid(9971),
      inputSnapshot: {},
      signal: null,
    };
    Object.defineProperty(hostileNested, 'node', {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error('synthetic-executor-sentinel');
      },
    });
    assert.throws(
      () => created.runtime.workflows.executeNode(hostileNested),
      (error) => isNodeExecutionError(error) && error.code === 'ERR_NODE_EXECUTION_DATA_INVALID',
    );
    assert.equal(accessorReads, 0);

    assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
