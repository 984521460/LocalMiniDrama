const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const express = require('express');

const workflowRoutes = require('../src/routes/v2/workflows');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

async function withServer(t, database, runtime) {
  const events = [];
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v2', workflowRoutes(
    database,
    { error: (...args) => events.push(args) },
    runtime,
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

test('workflow v2 routes expose create, list, get, and atomic graph replacement', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(4500));
  const { request } = await withServer(t, database);

  const created = await request('/dramas/1/workflows', {
    method: 'POST',
    body: JSON.stringify({ name: 'API graph' }),
  });
  assert.equal(created.status, 201);
  const workflowUid = created.body.data.definition.uid;
  assert.equal(created.body.data.definition.graphRevision, 0);

  const listed = await request('/dramas/1/workflows');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data.map((item) => item.uid), [workflowUid]);

  const saved = await request(`/workflows/${workflowUid}/graph`, {
    method: 'PUT',
    body: JSON.stringify({
      expected_revision: 0,
      nodes: [{
        uid: uid(4501),
        node_type: 'source.selection',
        position: { x: 0, y: 0 },
        config: {},
        status: 'disabled',
      }],
      edges: [],
    }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.definition.graphRevision, 1);

  const plan = await request(`/workflows/${workflowUid}/plan`);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.data.graphRevision, 1);
  assert.match(plan.body.data.graphHash, /^[0-9a-f]{64}$/);

  const createdRun = await request(`/workflows/${workflowUid}/runs`, {
    method: 'POST',
    body: JSON.stringify({ trigger_type: 'manual' }),
  });
  assert.equal(createdRun.status, 201);
  assert.equal(createdRun.body.data.run.workflowUid, workflowUid);
  assert.equal(createdRun.body.data.run.graphHash, plan.body.data.graphHash);
  assert.equal(createdRun.body.data.nodes.length, 1);

  const listedRuns = await request(`/workflows/${workflowUid}/runs`);
  assert.equal(listedRuns.status, 200);
  assert.deepEqual(listedRuns.body.data.map((run) => run.uid), [createdRun.body.data.run.uid]);

  const fetchedRun = await request(`/workflow-runs/${createdRun.body.data.run.uid}`);
  assert.equal(fetchedRun.status, 200);
  assert.equal(fetchedRun.body.data.nodes[0].nodeUid, uid(4501));

  const fetched = await request(`/workflows/${workflowUid}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.data.nodes[0].nodeType, 'source.selection');
});

test('workflow v2 routes publish the immutable registry used by the canvas', async (t) => {
  const database = createMigratedV2Database(t);
  const { request } = await withServer(t, database);

  const registry = await request('/workflow-registry');
  assert.equal(registry.status, 200);
  assert.equal(registry.body.data.schemaVersion, '4.0');
  assert.equal(registry.body.data.registryVersion, '4.0.0');
  assert.equal(registry.body.data.nodes.length, 16);
  assert.deepEqual(registry.body.data.nodes[0], {
    type: 'source.selection',
    title: '原文选区',
    inputs: [{
      id: 'document',
      valueType: 'SourceDocument',
      cardinality: 'one',
      required: true,
    }],
    outputs: [{
      id: 'selection',
      valueType: 'SourceSelection',
      cardinality: 'one',
      required: true,
    }],
  });
});

test('workflow routes return fixed errors without logging rejected values', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(4500));
  const { events, request } = await withServer(t, database);
  const sentinel = 'synthetic-private-workflow-value';

  const invalid = await request('/dramas/1/workflows', {
    method: 'POST',
    body: JSON.stringify({ name: sentinel, unexpected: true }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'WORKFLOW_INPUT_INVALID');
  assert.doesNotMatch(JSON.stringify(invalid.body), new RegExp(sentinel));
  assert.doesNotMatch(JSON.stringify(events), new RegExp(sentinel));

  const missing = await request(`/workflows/${uid(4599)}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'WORKFLOW_NOT_FOUND');
});

test('workflow run routes fail closed without echoing persisted credential-shaped drift', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(4600));
  const { events, request } = await withServer(t, database);
  const created = await request('/dramas/1/workflows', {
    method: 'POST',
    body: JSON.stringify({ name: 'Drift fixture' }),
  });
  const workflowUid = created.body.data.definition.uid;
  await request(`/workflows/${workflowUid}/graph`, {
    method: 'PUT',
    body: JSON.stringify({
      expected_revision: 0,
      nodes: [{
        uid: uid(4601),
        node_type: 'source.selection',
        position: { x: 0, y: 0 },
        config: {},
        status: 'disabled',
      }],
      edges: [],
    }),
  });
  const runResponse = await request(`/workflows/${workflowUid}/runs`, {
    method: 'POST',
    body: JSON.stringify({ trigger_type: 'manual' }),
  });
  const run = runResponse.body.data;
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE workflow_runs SET status = 'running', started_at = ?, updated_at = ? WHERE uid = ?
  `).run(now, now, run.run.uid);
  const sentinel = 'plain-secret-value';
  database.prepare(`
    UPDATE node_runs
    SET status = 'running', input_snapshot_json = ?, started_at = ?, updated_at = ?
    WHERE uid = ?
  `).run(JSON.stringify({ credentialRef: sentinel }), now, now, run.nodes[0].uid);

  const response = await request(`/workflow-runs/${run.run.uid}`);
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'WORKFLOW_DATA_INVALID');
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(sentinel));
  assert.doesNotMatch(JSON.stringify(events), new RegExp(sentinel));
});

test('workflow execution routes delegate one scope to the backend scheduler and expose retry and cancel', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(4700));
  const calls = [];
  const scheduler = {
    start(input) {
      calls.push(['start', input]);
      return { runUid: uid(4790), completion: Promise.resolve({ status: 'succeeded' }) };
    },
    retryNode(input) {
      calls.push(['retry', input]);
      return { runUid: uid(4790), completion: Promise.resolve({ status: 'succeeded' }) };
    },
    cancelRun(runUid) {
      calls.push(['cancel', runUid]);
      return { run: { uid: runUid, status: 'cancelled' }, nodes: [] };
    },
  };
  const { request } = await withServer(t, database, { scheduler });

  const started = await request(`/workflows/${uid(4701)}/runs`, {
    method: 'POST',
    body: JSON.stringify({
      scope: { mode: 'selection', node_uids: [uid(4710), uid(4711)] },
      max_retries: 2,
    }),
  });
  assert.equal(started.status, 202);
  assert.deepEqual(started.body.data, { run_uid: uid(4790) });
  assert.deepEqual(calls[0], ['start', {
    workflowUid: uid(4701),
    scope: { mode: 'selection', nodeUids: [uid(4710), uid(4711)] },
    maxRetries: 2,
  }]);

  const retried = await request(`/node-runs/${uid(4791)}/retry`, {
    method: 'POST',
    body: JSON.stringify({ max_retries: 1 }),
  });
  assert.equal(retried.status, 202);
  assert.deepEqual(calls[1], ['retry', { nodeRunUid: uid(4791), maxRetries: 1 }]);

  const cancelled = await request(`/workflow-runs/${uid(4790)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.run.status, 'cancelled');
  assert.deepEqual(calls[2], ['cancel', uid(4790)]);
});

test('workflow execution routes reject unavailable or malformed scheduling without creating a run', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(4800));
  const { request } = await withServer(t, database);

  const unavailable = await request(`/workflows/${uid(4801)}/runs`, {
    method: 'POST',
    body: JSON.stringify({ scope: { mode: 'full' } }),
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, 'WORKFLOW_EXECUTION_UNAVAILABLE');
  assert.equal(database.prepare('SELECT count(*) FROM workflow_runs').pluck().get(), 0);

  const malformed = await request(`/workflows/${uid(4801)}/runs`, {
    method: 'POST',
    body: JSON.stringify({
      trigger_type: 'full',
      scope: { mode: 'node', node_uid: uid(4810) },
    }),
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'WORKFLOW_INPUT_INVALID');
  assert.equal(database.prepare('SELECT count(*) FROM workflow_runs').pluck().get(), 0);
});
