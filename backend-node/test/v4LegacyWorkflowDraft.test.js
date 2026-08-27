const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const express = require('express');
const { validateWorkflowGraph } = require('@local-mini-drama/workflow-engine');

const { createLegacyWorkflowDraft } = require('../src/adapters/v2/legacyWorkflowDraft');
const workflowRoutes = require('../src/routes/v2/workflows');
const { isCanonicalUuid } = require('../src/workflows/identifiers');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

async function withServer(t, database) {
  const events = [];
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v2', workflowRoutes(database, { error: (...args) => events.push(args) }));
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

function legacySnapshot(database) {
  const createdByAdapter = new Set(['workflow_definitions', 'canvas_nodes', 'canvas_edges']);
  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).pluck().all().filter((table) => table !== 'schema_migrations' && !createdByAdapter.has(table));
  return Object.fromEntries(tables.map((table) => [
    table,
    database.prepare(`SELECT * FROM "${table}"`).all().map(JSON.stringify).sort(),
  ]));
}

function seedLegacyCanvas(database) {
  insertDrama(database, uid(5600), 'Legacy canvas drama');
  database.prepare('UPDATE dramas SET metadata = ? WHERE id = 1').run(JSON.stringify({
    canvas_layout: { nodes: { 'char:1': { x: 12, y: 34 } }, viewport: { x: 0, y: 0, zoom: 1 } },
    workflow_groups: [{ id: 'legacy-group', title: '旧工作流', storyboard_ids: [1] }],
  }));
  database.prepare("INSERT INTO characters (drama_id, name) VALUES (1, '测试角色')").run();
  database.prepare("INSERT INTO episodes (drama_id, episode_number, title) VALUES (1, 1, '第一集')").run();
  database.prepare("INSERT INTO storyboards (episode_id, storyboard_number, title) VALUES (1, 1, '镜头一')").run();
  database.prepare("INSERT INTO scenes (drama_id, episode_id, location) VALUES (1, 1, '测试场景')").run();
  database.prepare("INSERT INTO props (drama_id, name) VALUES (1, '测试道具')").run();
}

test('builds one deterministic disabled v2 draft without embedding legacy records', () => {
  const first = createLegacyWorkflowDraft({ dramaUid: uid(5600) });
  const second = createLegacyWorkflowDraft({ dramaUid: uid(5600) });
  assert.deepEqual(first, second);
  assert.equal(first.definition.name, 'v1 兼容草稿');
  assert.equal(first.definition.status, 'draft');
  assert.equal(first.nodes.length, 5);
  assert.equal(first.edges.length, 4);
  assert.ok(first.nodes.every((node) => node.status === 'disabled'));
  assert.ok(first.nodes.every((node) => node.domainRefType === null && node.domainRefUid === null));
  assert.ok(first.nodes.every((node) => Object.keys(node.config).length === 0));
  assert.ok([
    first.definition.uid,
    ...first.nodes.map((node) => node.uid),
    ...first.edges.map((edge) => edge.uid),
  ].every(isCanonicalUuid));
  assert.deepEqual(validateWorkflowGraph({
    nodes: first.nodes.map((node) => ({
      uid: node.uid,
      nodeType: node.nodeType,
      disabled: true,
      bound: false,
    })),
    edges: first.edges,
  }), {
    nodeCount: 5,
    edgeCount: 4,
    topologicalOrder: first.nodes.map((node) => node.uid),
  });
  assert.doesNotMatch(JSON.stringify(first), /canvas_layout|workflow_groups|测试角色|镜头一/u);
});

test('legacy draft route is idempotent and never changes v1 business data', async (t) => {
  const database = createMigratedV2Database(t);
  seedLegacyCanvas(database);
  const before = legacySnapshot(database);
  const { request } = await withServer(t, database);

  const first = await request('/dramas/1/workflows/legacy-draft', {
    method: 'POST', body: JSON.stringify({}),
  });
  const second = await request('/dramas/1/workflows/legacy-draft', {
    method: 'POST', body: JSON.stringify({}),
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.data, first.body.data);
  assert.equal(first.body.data.nodes.length, 5);
  assert.equal(database.prepare('SELECT count(*) FROM workflow_definitions').pluck().get(), 1);
  assert.deepEqual(legacySnapshot(database), before);
  assert.equal(database.prepare('PRAGMA integrity_check').pluck().get(), 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('legacy draft route preserves an existing v2 workflow and rejects unexpected input safely', async (t) => {
  const database = createMigratedV2Database(t);
  seedLegacyCanvas(database);
  const { events, request } = await withServer(t, database);
  const created = await request('/dramas/1/workflows', {
    method: 'POST', body: JSON.stringify({ name: '已有 v2 工作流' }),
  });

  const ensured = await request('/dramas/1/workflows/legacy-draft', {
    method: 'POST', body: JSON.stringify({}),
  });
  assert.equal(ensured.status, 200);
  assert.equal(ensured.body.data.definition.uid, created.body.data.definition.uid);
  assert.equal(database.prepare('SELECT count(*) FROM workflow_definitions').pluck().get(), 1);

  const sentinel = 'synthetic-private-legacy-adapter-value';
  const invalid = await request('/dramas/1/workflows/legacy-draft', {
    method: 'POST', body: JSON.stringify({ unexpected: sentinel }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'WORKFLOW_INPUT_INVALID');
  assert.doesNotMatch(JSON.stringify(invalid.body), new RegExp(sentinel));
  assert.doesNotMatch(JSON.stringify(events), new RegExp(sentinel));
});
