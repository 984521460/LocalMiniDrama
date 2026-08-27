const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const http = require('node:http');
const test = require('node:test');

const express = require('express');

const { createV2Repositories } = require('../src/repositories/v2');
const workflowRoutes = require('../src/routes/v2/workflows');
const { createNodeExecutionError } = require('../src/workflows');
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

  const text = 'local workflow end-to-end fixture';
  const documentUid = uid(9801);
  const blockUid = uid(9802);
  const selectionUid = uid(9803);
  repositories.sources.createDocumentWithBlocks({
    document: {
      uid: documentUid,
      dramaUid,
      sourceType: 'txt',
      originalName: 'workflow-e2e.txt',
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

  const assetUid = uid(9810);
  const versionUid = uid(9811);
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
    logicalUri: 'asset://character/workflow-e2e-v1',
    relativePath: 'characters/workflow-e2e-v1.png',
    sha256: sha256('synthetic-image'),
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    durationMs: null,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  return { selectionUid };
}

async function withLocalServer(t, database, executeNode) {
  const events = [];
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v2', workflowRoutes(
    database,
    { error: (...args) => events.push(args) },
    { executeNode },
  ));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return {
    events,
    request: async (pathname, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v2${pathname}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

async function waitForRun(request, runUid, statuses, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(`/workflow-runs/${runUid}`);
    assert.equal(response.status, 200);
    if (statuses.includes(response.body.data.run.status)) return response.body.data;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`workflow run ${runUid} did not reach ${statuses.join('/')}`);
}

function graphBody(selectionUid, targetPort = 'selection') {
  return {
    expected_revision: 0,
    nodes: [
      {
        uid: uid(9820),
        node_type: 'source.selection',
        position: { x: 0, y: 0 },
        config: {},
        domain_ref: { type: 'source_selection', uid: selectionUid },
        status: 'ready',
      },
      {
        uid: uid(9821),
        node_type: 'story.facts',
        position: { x: 240, y: 0 },
        config: {},
        status: 'ready',
      },
    ],
    edges: [{
      uid: uid(9822),
      source_node_uid: uid(9820),
      source_port: 'selection',
      target_node_uid: uid(9821),
      target_port: targetPort,
    }],
  };
}

test('local workflow E2E covers save, reopen, execute, retry, cancel, and domain isolation', async (t) => {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(9800);
  insertDrama(database, dramaUid);
  const repositories = createV2Repositories(database);
  const { selectionUid } = seedDomainEntities(database, repositories, dramaUid);
  const domainBefore = domainSnapshot(database);

  let executionMode = 'success';
  let hangStartedResolve;
  let hangStarted = Promise.resolve();
  const executeNode = ({ node }) => {
    if (executionMode === 'failure' && node.uid === uid(9820)) {
      throw createNodeExecutionError('ERR_SYNTHETIC_LOCAL_FAILURE', { retryable: false });
    }
    if (executionMode === 'hang' && node.uid === uid(9820)) {
      hangStartedResolve();
      return new Promise(() => {});
    }
    return Promise.resolve({ resultRef: `result:v1:${node.uid}` });
  };
  const { events, request } = await withLocalServer(t, database, executeNode);

  const created = await request('/dramas/1/workflows', {
    method: 'POST',
    body: JSON.stringify({ name: 'Local E2E workflow' }),
  });
  assert.equal(created.status, 201);
  const workflowUid = created.body.data.definition.uid;
  assert.equal(created.body.data.definition.graphRevision, 0);

  const invalidConnection = await request(`/workflows/${workflowUid}/graph`, {
    method: 'PUT',
    body: JSON.stringify(graphBody(selectionUid, 'unknown-input')),
  });
  assert.equal(invalidConnection.status, 400);
  assert.equal(invalidConnection.body.error.code, 'WORKFLOW_GRAPH_INVALID');
  assert.equal((await request(`/workflows/${workflowUid}`)).body.data.definition.graphRevision, 0);

  const saved = await request(`/workflows/${workflowUid}/graph`, {
    method: 'PUT',
    body: JSON.stringify(graphBody(selectionUid)),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.definition.graphRevision, 1);
  assert.equal(saved.body.data.edges.length, 1);

  const reopened = await request(`/workflows/${workflowUid}`);
  assert.equal(reopened.status, 200);
  assert.deepEqual(reopened.body.data, saved.body.data);

  const succeededStart = await request(`/workflows/${workflowUid}/runs`, {
    method: 'POST',
    body: JSON.stringify({ scope: { mode: 'full' }, max_retries: 0 }),
  });
  assert.equal(succeededStart.status, 202);
  const succeeded = await waitForRun(request, succeededStart.body.data.run_uid, ['succeeded']);
  assert.deepEqual(succeeded.nodes.map((node) => node.status), ['succeeded', 'succeeded']);

  executionMode = 'failure';
  const failedStart = await request(`/workflows/${workflowUid}/runs`, {
    method: 'POST',
    body: JSON.stringify({ scope: { mode: 'full' }, max_retries: 0 }),
  });
  assert.equal(failedStart.status, 202);
  const failed = await waitForRun(request, failedStart.body.data.run_uid, ['failed']);
  const failedNode = failed.nodes.find((node) => node.status === 'failed');
  assert.equal(failedNode.nodeUid, uid(9820));
  assert.equal(failed.nodes.find((node) => node.nodeUid === uid(9821)).status, 'blocked');

  executionMode = 'success';
  const retry = await request(`/node-runs/${failedNode.uid}/retry`, {
    method: 'POST',
    body: JSON.stringify({ max_retries: 0 }),
  });
  assert.equal(retry.status, 202);
  assert.equal(retry.body.data.run_uid, failed.run.uid);
  const recovered = await waitForRun(request, failed.run.uid, ['succeeded']);
  assert.equal(recovered.run.retryCount, 1);
  assert.deepEqual(recovered.nodes.map((node) => node.status), ['succeeded', 'succeeded']);

  executionMode = 'hang';
  hangStarted = new Promise((resolve) => { hangStartedResolve = resolve; });
  const cancelStart = await request(`/workflows/${workflowUid}/runs`, {
    method: 'POST',
    body: JSON.stringify({ scope: { mode: 'full' }, max_retries: 0 }),
  });
  assert.equal(cancelStart.status, 202);
  await Promise.race([
    hangStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('local executor did not start')), 1000)),
  ]);
  const cancelled = await request(`/workflow-runs/${cancelStart.body.data.run_uid}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.run.status, 'cancelled');
  const cancelledStatus = await waitForRun(request, cancelStart.body.data.run_uid, ['cancelled']);
  assert.equal(cancelledStatus.nodes.every((node) => node.status === 'cancelled'), true);

  assert.deepEqual(domainSnapshot(database), domainBefore);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
  assert.deepEqual(events, []);
});
