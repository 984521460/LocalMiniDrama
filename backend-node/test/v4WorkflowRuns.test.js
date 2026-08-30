const assert = require('node:assert/strict');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const { createV2Repositories } = require('../src/repositories/v2');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');
const executionPlanSchema = require('../../schemas/v4/workflow-execution-plan.schema.json');
const workflowRunSchema = require('../../schemas/v4/workflow-run.schema.json');

function validateWorkflowRunSchema(value) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(executionPlanSchema);
  return ajv.compile(workflowRunSchema)(value);
}

function uidSequence(values) {
  const queue = [...values];
  return () => {
    if (queue.length === 0) throw new Error('fixture uid sequence exhausted');
    return queue.shift();
  };
}

function createWorkflowFixture(t, createRunUid) {
  const {
    createWorkflowRunService,
    createWorkflowService,
  } = require('../src/workflows');
  assert.equal(typeof createWorkflowRunService, 'function');
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(7000));
  const repositories = createV2Repositories(database);
  const workflowService = createWorkflowService({
    repositories,
    createUid: () => uid(7001),
  });
  const workflow = workflowService.createWorkflow({ dramaId: 1, name: 'Runtime fixture' });
  workflowService.replaceGraph(workflow.definition.uid, {
    expectedRevision: 0,
    nodes: [
      {
        uid: uid(7010),
        nodeType: 'source.selection',
        position: { x: 0, y: 0 },
        config: { contextBeforeBlocks: 1 },
        status: 'disabled',
      },
      {
        uid: uid(7011),
        nodeType: 'story.facts',
        position: { x: 200, y: 0 },
        config: {},
        status: 'disabled',
      },
    ],
    edges: [{
      uid: uid(7020),
      sourceNodeUid: uid(7010),
      sourcePort: 'selection',
      targetNodeUid: uid(7011),
      targetPort: 'selection',
    }],
  });
  const runService = createWorkflowRunService({ repositories, createUid: createRunUid });
  return { database, repositories, runService, workflow, workflowService };
}

test('creates an atomic workflow run bound to an immutable canonical graph snapshot', (t) => {
  const { database, runService, workflow, workflowService } = createWorkflowFixture(t, uidSequence([
    uid(7100), uid(7101), uid(7102),
  ]));
  const created = runService.createRun({
    workflowUid: workflow.definition.uid,
    triggerType: 'full',
  });

  assert.equal(created.run.uid, uid(7100));
  assert.equal(created.run.workflowUid, workflow.definition.uid);
  assert.equal(created.run.graphRevision, 1);
  assert.equal(created.run.graphHash, created.run.graphSnapshot.graphHash);
  assert.equal(created.run.graphSnapshot.workflowUid, workflow.definition.uid);
  assert.equal(created.run.status, 'queued');
  assert.deepEqual(created.nodes.map((node) => [node.uid, node.nodeUid, node.ordinal, node.status]), [
    [uid(7101), uid(7010), 0, 'queued'],
    [uid(7102), uid(7011), 1, 'queued'],
  ]);
  assert.equal(validateWorkflowRunSchema(created), true);
  const invalidSchemaState = structuredClone(created);
  invalidSchemaState.nodes[0].status = 'succeeded';
  assert.equal(validateWorkflowRunSchema(invalidSchemaState), false);
  const excessiveRetry = structuredClone(created);
  excessiveRetry.nodes[0].retryCount = 101;
  assert.equal(validateWorkflowRunSchema(excessiveRetry), false);
  assert.ok(Object.isFrozen(created));
  assert.ok(Object.isFrozen(created.run.graphSnapshot.snapshot.nodes[0].config));
  assert.deepEqual(runService.getRun(created.run.uid), created);
  assert.deepEqual(runService.listRuns(workflow.definition.uid).map((item) => item.uid), [created.run.uid]);

  assert.throws(
    () => database.prepare('UPDATE workflow_runs SET graph_hash = ? WHERE uid = ?')
      .run('f'.repeat(64), created.run.uid),
    /snapshot.*immutable/i,
  );
  assert.throws(
    () => database.prepare('DELETE FROM workflow_runs WHERE uid = ?').run(created.run.uid),
    /cannot be deleted/i,
  );
  assert.throws(
    () => database.prepare("UPDATE node_runs SET input_snapshot_json = '{\"unexpected\":true}' WHERE uid = ?")
      .run(created.nodes[0].uid),
    /state fields are inconsistent/i,
  );
  assert.throws(
    () => database.prepare('UPDATE node_runs SET cache_key = ? WHERE uid = ?')
      .run('a'.repeat(64), created.nodes[0].uid),
    /state fields are inconsistent/i,
  );
  assert.throws(
    () => database.prepare('UPDATE workflow_runs SET retry_count = 101 WHERE uid = ?')
      .run(created.run.uid),
    /state fields are inconsistent/i,
  );
  assert.throws(
    () => database.prepare('UPDATE node_runs SET retry_count = 101 WHERE uid = ?')
      .run(created.nodes[0].uid),
    /(?:CHECK constraint failed|status transition is invalid)/i,
  );

  workflowService.replaceGraph(workflow.definition.uid, {
    expectedRevision: 1,
    nodes: [],
    edges: [],
  });
  assert.equal(runService.getRun(created.run.uid).run.graphHash, created.run.graphHash);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});

test('P9-01 atomically closes interrupted workflow runs and is restart-idempotent', (t) => {
  const { runService, workflow } = createWorkflowFixture(t, uidSequence([
    uid(7190), uid(7191), uid(7192), uid(7193), uid(7194), uid(7195),
  ]));
  const created = runService.createRun({
    workflowUid: workflow.definition.uid,
    triggerType: 'full',
  });
  runService.transitionWorkflow({
    runUid: created.run.uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  runService.transitionNode({
    nodeRunUid: created.nodes[0].uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
    inputSnapshot: {},
  });
  const queued = runService.createRun({
    workflowUid: workflow.definition.uid,
    triggerType: 'manual',
  });

  assert.deepEqual(runService.recoverInterruptedRuns(), { recoveredCount: 1 });
  const recovered = runService.getRun(created.run.uid);
  assert.equal(recovered.run.status, 'failed');
  assert.equal(recovered.run.errorCode, 'ERR_WORKFLOW_RECOVERY_ORPHANED');
  assert.deepEqual(recovered.nodes.map((node) => [node.status, node.errorCode]), [
    ['failed', 'ERR_WORKFLOW_RECOVERY_ORPHANED'],
    ['blocked', 'ERR_WORKFLOW_RECOVERY_ORPHANED'],
  ]);
  assert.deepEqual(runService.recoverInterruptedRuns(), { recoveredCount: 0 });
  assert.equal(runService.getRun(queued.run.uid).run.status, 'queued');
});

test('P9-01 seals a fully persisted workflow success instead of orphaning it', (t) => {
  const { runService, workflow } = createWorkflowFixture(t, uidSequence([
    uid(7180), uid(7181), uid(7182),
  ]));
  const created = runService.createRun({
    workflowUid: workflow.definition.uid,
    triggerType: 'full',
  });
  runService.transitionWorkflow({
    runUid: created.run.uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  for (const node of created.nodes) {
    runService.transitionNode({
      nodeRunUid: node.uid,
      expectedStatus: 'queued',
      nextStatus: 'running',
      inputSnapshot: {},
    });
    runService.transitionNode({
      nodeRunUid: node.uid,
      expectedStatus: 'running',
      nextStatus: 'succeeded',
      output: {},
    });
  }

  assert.deepEqual(runService.recoverInterruptedRuns(), { recoveredCount: 1 });
  const recovered = runService.getRun(created.run.uid);
  assert.equal(recovered.run.status, 'succeeded');
  assert.equal(recovered.run.errorCode, null);
  assert.deepEqual(recovered.nodes.map((node) => node.status), ['succeeded', 'succeeded']);
});

test('P9-01 workflow recovery rolls back every node when terminal sealing fails', (t) => {
  const { database, runService, workflow } = createWorkflowFixture(t, uidSequence([
    uid(7170), uid(7171), uid(7172),
  ]));
  const created = runService.createRun({
    workflowUid: workflow.definition.uid,
    triggerType: 'full',
  });
  runService.transitionWorkflow({
    runUid: created.run.uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  runService.transitionNode({
    nodeRunUid: created.nodes[0].uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
    inputSnapshot: {},
  });
  database.exec(`
    CREATE TRIGGER synthetic_recovery_seal_failure
    BEFORE UPDATE OF status ON workflow_runs
    WHEN NEW.error_code='ERR_WORKFLOW_RECOVERY_ORPHANED'
    BEGIN
      SELECT RAISE(ABORT,'synthetic recovery seal failure');
    END
  `);

  assert.throws(() => runService.recoverInterruptedRuns(), {
    code: 'WORKFLOW_CONFLICT',
  });
  assert.equal(runService.getRun(created.run.uid).run.status, 'running');
  assert.deepEqual(runService.getRun(created.run.uid).nodes.map((node) => node.status), [
    'running', 'queued',
  ]);
});

test('workflow and node run state machines enforce legal transitions and terminal consistency', (t) => {
  const { runService, workflow } = createWorkflowFixture(t, uidSequence([
    uid(7200), uid(7201), uid(7202),
  ]));
  const created = runService.createRun({ workflowUid: workflow.definition.uid, triggerType: 'manual' });
  assert.throws(() => runService.transitionNode({
    nodeRunUid: created.nodes[0].uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
    inputSnapshot: {},
  }), (error) => error.code === 'WORKFLOW_RUN_TRANSITION_INVALID');
  assert.equal(runService.getRun(created.run.uid).nodes[0].status, 'queued');
  const running = runService.transitionWorkflow({
    runUid: created.run.uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  assert.equal(running.status, 'running');
  assert.match(running.startedAt, /^\d{4}-\d{2}-\d{2}T/u);

  assert.throws(() => runService.transitionWorkflow({
    runUid: created.run.uid,
    expectedStatus: 'running',
    nextStatus: 'succeeded',
  }), (error) => error.code === 'WORKFLOW_RUN_TRANSITION_INVALID');

  for (const node of created.nodes) {
    const nodeRunning = runService.transitionNode({
      nodeRunUid: node.uid,
      expectedStatus: 'queued',
      nextStatus: 'running',
      inputSnapshot: { graphHash: created.run.graphHash },
      cacheKey: 'a'.repeat(64),
    });
    assert.equal(nodeRunning.status, 'running');
    assert.equal(nodeRunning.inputSnapshot.graphHash, created.run.graphHash);
    assert.deepEqual(Object.keys(nodeRunning.inputSnapshot), ['graphHash']);
    const succeeded = runService.transitionNode({
      nodeRunUid: node.uid,
      expectedStatus: 'running',
      nextStatus: 'succeeded',
      output: { artifactUid: uid(7290 + node.ordinal) },
    });
    assert.equal(succeeded.status, 'succeeded');
    assert.equal(succeeded.output.artifactUid, uid(7290 + node.ordinal));
    assert.deepEqual(Object.keys(succeeded.output), ['artifactUid']);
  }

  const succeeded = runService.transitionWorkflow({
    runUid: created.run.uid,
    expectedStatus: 'running',
    nextStatus: 'succeeded',
  });
  assert.equal(succeeded.status, 'succeeded');
  assert.match(succeeded.completedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.throws(() => runService.transitionWorkflow({
    runUid: created.run.uid,
    expectedStatus: 'succeeded',
    nextStatus: 'running',
  }), (error) => error.code === 'WORKFLOW_RUN_TRANSITION_INVALID');
});

test('run payloads accept only canonical opaque credential references and reject persisted drift', (t) => {
  const { runService, workflow } = createWorkflowFixture(t, uidSequence([
    uid(7250), uid(7251), uid(7252),
  ]));
  const created = runService.createRun({ workflowUid: workflow.definition.uid, triggerType: 'manual' });
  runService.transitionWorkflow({
    runUid: created.run.uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  const sentinel = 'plain-secret-value';
  assert.throws(() => runService.transitionNode({
    nodeRunUid: created.nodes[0].uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
    inputSnapshot: { credentialRef: sentinel },
  }), (error) => {
    assert.equal(error.code, 'WORKFLOW_INPUT_INVALID');
    assert.doesNotMatch(JSON.stringify(error), new RegExp(sentinel));
    return true;
  });

  const canonicalRef = `credential:v1:${uid(7259)}`;
  const running = runService.transitionNode({
    nodeRunUid: created.nodes[0].uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
    inputSnapshot: { credential_ref: canonicalRef },
  });
  assert.equal(running.inputSnapshot.credential_ref, canonicalRef);
  assert.throws(() => runService.transitionNode({
    nodeRunUid: created.nodes[0].uid,
    expectedStatus: 'running',
    nextStatus: 'succeeded',
    output: { credentialRef: sentinel },
  }), (error) => error.code === 'WORKFLOW_INPUT_INVALID');

  const drifted = structuredClone(runService.getRun(created.run.uid));
  drifted.nodes[0].inputSnapshot = { credentialRef: sentinel };
  const {
    createWorkflowRunService,
    isWorkflowError,
  } = require('../src/workflows');
  const driftedService = createWorkflowRunService({
    repositories: {
      withTransaction(callback) { return callback(this); },
      runs: {
        getNode: () => drifted.nodes[0],
        getWorkflowWithNodes: () => drifted,
        listWorkflowRuns: () => [drifted.run],
      },
      workflows: {},
    },
  });
  for (const operation of [
    () => driftedService.getRun(created.run.uid),
    () => driftedService.listRuns(workflow.definition.uid),
  ]) {
    assert.throws(operation, (error) => {
      assert.equal(isWorkflowError(error), true);
      assert.equal(error.code, 'WORKFLOW_DATA_INVALID');
      assert.doesNotMatch(JSON.stringify(error), new RegExp(sentinel));
      return true;
    });
  }
});

test('run creation rolls back every row when a generated node-run identity conflicts', (t) => {
  const { database, runService, workflow } = createWorkflowFixture(t, uidSequence([
    uid(7300), uid(7301), uid(7301),
  ]));
  assert.throws(() => runService.createRun({
    workflowUid: workflow.definition.uid,
    triggerType: 'full',
  }), (error) => error.code === 'WORKFLOW_CONFLICT');
  assert.equal(database.prepare('SELECT count(*) FROM workflow_runs').pluck().get(), 0);
  assert.equal(database.prepare('SELECT count(*) FROM node_runs').pluck().get(), 0);
});

test('run queries fail closed on malformed identities and persisted snapshot drift', (t) => {
  const {
    createWorkflowRunService,
    isWorkflowError,
  } = require('../src/workflows');
  const { runService, workflow } = createWorkflowFixture(t, uidSequence([
    uid(7400), uid(7401), uid(7402),
  ]));
  const created = runService.createRun({ workflowUid: workflow.definition.uid, triggerType: 'full' });
  assert.throws(() => runService.getRun('bad-run-id'), (error) => (
    isWorkflowError(error) && error.code === 'WORKFLOW_INPUT_INVALID'
  ));

  const driftedRepositories = {
    withTransaction(callback) { return callback(this); },
    runs: {
      getWorkflowWithNodes: () => ({
        ...created,
        run: { ...created.run, graphHash: 'f'.repeat(64) },
      }),
    },
    workflows: {},
  };
  const drifted = createWorkflowRunService({
    repositories: driftedRepositories,
    createUid: () => uid(7499),
  });
  assert.throws(() => drifted.getRun(created.run.uid), (error) => {
    assert.equal(isWorkflowError(error), true);
    assert.equal(error.code, 'WORKFLOW_DATA_INVALID');
    assert.doesNotMatch(JSON.stringify(error), /ffffffff/);
    return true;
  });
});
