const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');
const { createV2Repositories } = require('../src/repositories/v2');

function uidSequence(start) {
  let current = start;
  return () => uid(current++);
}

function graphFixture(workflowUid) {
  const sourceUid = uid(4101);
  const factsUid = uid(4102);
  return {
    expectedRevision: 0,
    nodes: [
      {
        uid: sourceUid,
        nodeType: 'source.selection',
        position: { x: 20, y: 40 },
        config: { contextBeforeBlocks: 1 },
        status: 'disabled',
      },
      {
        uid: factsUid,
        nodeType: 'story.facts',
        position: { x: 320.5, y: 40 },
        config: {},
        status: 'disabled',
      },
    ],
    edges: [
      {
        uid: uid(4201),
        sourceNodeUid: sourceUid,
        sourcePort: 'selection',
        targetNodeUid: factsUid,
        targetPort: 'selection',
      },
    ],
    workflowUid,
  };
}

test('migration v6 adds a registry binding and monotonic graph revision', (t) => {
  const database = createMigratedV2Database(t);
  const columns = database.prepare('PRAGMA table_info(workflow_definitions)').all();
  assert.ok(columns.some((column) => column.name === 'registry_version'));
  assert.ok(columns.some((column) => column.name === 'graph_revision'));
  assert.equal(database.prepare('SELECT max(version) FROM schema_migrations').pluck().get(), 16);

  insertDrama(database, uid(4000));
  database.prepare(`
    INSERT INTO workflow_definitions (uid, drama_uid, name)
    VALUES (?, ?, 'Revision guard')
  `).run(uid(4001), uid(4000));
  assert.deepEqual(database.prepare(`
    SELECT registry_version, graph_revision FROM workflow_definitions WHERE uid = ?
  `).get(uid(4001)), { registry_version: '4.0.0', graph_revision: 0 });
  assert.throws(
    () => database.prepare('UPDATE workflow_definitions SET graph_revision = 2 WHERE uid = ?').run(uid(4001)),
    /graph revision must advance by one/i,
  );
});

test('creates, lists, reads, and atomically replaces a workflow graph', (t) => {
  const { createWorkflowService } = require('../src/workflows');
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(4000));
  const repositories = createV2Repositories(database);
  const service = createWorkflowService({ repositories, createUid: uidSequence(4001) });

  const created = service.createWorkflow({ dramaId: 1, name: '  主工作流  ', description: 'v2 canvas' });
  assert.equal(created.definition.uid, uid(4001));
  assert.equal(created.definition.name, '主工作流');
  assert.equal(created.definition.registryVersion, '4.0.0');
  assert.equal(created.definition.graphRevision, 0);
  assert.deepEqual(created.nodes, []);
  assert.deepEqual(created.edges, []);
  assert.deepEqual(service.listWorkflows(1).map((item) => item.uid), [uid(4001)]);

  const replacement = graphFixture(created.definition.uid);
  const saved = service.replaceGraph(created.definition.uid, replacement);
  assert.equal(saved.definition.graphRevision, 1);
  assert.deepEqual(saved.nodes.map((node) => node.uid), [uid(4101), uid(4102)]);
  assert.deepEqual(saved.edges.map((edge) => edge.uid), [uid(4201)]);
  assert.ok(Object.isFrozen(saved));
  assert.ok(Object.isFrozen(saved.nodes[0].config));
  assert.deepEqual(service.getWorkflow(created.definition.uid), saved);

  const second = service.replaceGraph(created.definition.uid, {
    expectedRevision: 1,
    nodes: [replacement.nodes[0]],
    edges: [],
  });
  assert.equal(second.definition.graphRevision, 2);
  assert.deepEqual(second.nodes.map((node) => node.uid), [uid(4101)]);
  assert.deepEqual(second.edges, []);
});

test('rejects stale replacement atomically without changing the saved graph', (t) => {
  const { createWorkflowService, isWorkflowError } = require('../src/workflows');
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(4000));
  const service = createWorkflowService({
    repositories: createV2Repositories(database),
    createUid: uidSequence(4001),
  });
  const created = service.createWorkflow({ dramaId: 1, name: 'Conflict graph' });
  const saved = service.replaceGraph(created.definition.uid, graphFixture(created.definition.uid));

  assert.throws(
    () => service.replaceGraph(created.definition.uid, {
      expectedRevision: 0,
      nodes: [{ ...graphFixture(created.definition.uid).nodes[0], uid: uid(4199) }],
      edges: [],
    }),
    (error) => {
      assert.equal(isWorkflowError(error), true);
      assert.equal(error.code, 'WORKFLOW_CONFLICT');
      return true;
    },
  );
  assert.deepEqual(service.getWorkflow(created.definition.uid), saved);
});

test('fails closed on hostile graph input before repository writes', (t) => {
  const { createWorkflowService, isWorkflowError } = require('../src/workflows');
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(4000));
  const service = createWorkflowService({
    repositories: createV2Repositories(database),
    createUid: uidSequence(4001),
  });
  const created = service.createWorkflow({ dramaId: 1, name: 'Input boundary' });
  let getterCalls = 0;
  const node = graphFixture(created.definition.uid).nodes[0];
  Object.defineProperty(node, 'config', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return {};
    },
  });

  for (const graph of [
    { expectedRevision: 0, nodes: [node], edges: [] },
    { expectedRevision: 0, nodes: [{ ...graphFixture(created.definition.uid).nodes[0], nodeType: 'unknown.node' }], edges: [] },
    { expectedRevision: 0, nodes: [{ ...graphFixture(created.definition.uid).nodes[0], position: { x: Infinity, y: 0 } }], edges: [] },
    { expectedRevision: 0, nodes: graphFixture(created.definition.uid).nodes, edges: [{ ...graphFixture(created.definition.uid).edges[0], targetNodeUid: uid(4999) }] },
  ]) {
    assert.throws(() => service.replaceGraph(created.definition.uid, graph), (error) => {
      assert.equal(isWorkflowError(error), true);
      assert.match(error.code, /^WORKFLOW_(INPUT_INVALID|GRAPH_INVALID)$/);
      return true;
    });
  }
  assert.equal(getterCalls, 0);
  assert.equal(service.getWorkflow(created.definition.uid).definition.graphRevision, 0);
  assert.deepEqual(service.getWorkflow(created.definition.uid).nodes, []);
});
