const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { createV2Repositories } = require('../src/repositories/v2');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function edge(index, sourceNodeUid, sourcePort, targetNodeUid, targetPort) {
  return {
    uid: uid(8100 + index),
    sourceNodeUid,
    sourcePort,
    targetNodeUid,
    targetPort,
  };
}

function createSchedulerFixture(t, executeNode) {
  const {
    createWorkflowRunService,
    createWorkflowScheduler,
    createWorkflowService,
  } = require('../src/workflows');
  assert.equal(typeof createWorkflowScheduler, 'function');
  const database = createMigratedV2Database(t);
  const dramaUid = uid(8000);
  insertDrama(database, dramaUid);
  const repositories = createV2Repositories(database);
  const text = 'scheduler fixture';
  repositories.sources.createDocumentWithBlocks({
    document: {
      uid: uid(8001),
      dramaUid,
      sourceType: 'txt',
      originalName: 'scheduler.txt',
      encoding: 'utf-8',
      contentSha256: sha256(text),
      fullText: text,
    },
    blocks: [{
      uid: uid(8002),
      ordinal: 0,
      headingPath: [],
      charStart: 0,
      charEnd: text.length,
      text,
      textSha256: sha256(text),
    }],
  });
  repositories.sources.createSelection({
    uid: uid(8003),
    documentUid: uid(8001),
    startBlockUid: uid(8002),
    endBlockUid: uid(8002),
    startOffset: 0,
    endOffset: text.length,
    selectedTextSha256: sha256(text),
  });
  const workflowService = createWorkflowService({
    repositories,
    createUid: () => uid(8004),
  });
  const workflow = workflowService.createWorkflow({ dramaId: 1, name: 'Scheduler fixture' });
  const nodes = [
    { uid: uid(8010), nodeType: 'source.selection', domainRef: { type: 'source_selection', uid: uid(8003) } },
    { uid: uid(8011), nodeType: 'story.facts' },
    { uid: uid(8012), nodeType: 'episode.adaptation' },
    { uid: uid(8013), nodeType: 'script.structured' },
    { uid: uid(8014), nodeType: 'asset.character' },
  ].map((node, index) => ({
    ...node,
    position: { x: index * 200, y: 0 },
    config: {},
    status: 'ready',
  }));
  workflowService.replaceGraph(workflow.definition.uid, {
    expectedRevision: 0,
    nodes,
    edges: [
      edge(1, uid(8010), 'selection', uid(8011), 'selection'),
      edge(2, uid(8011), 'facts', uid(8012), 'facts'),
      edge(3, uid(8012), 'beats', uid(8013), 'beats'),
      edge(4, uid(8011), 'facts', uid(8014), 'facts'),
    ],
  });
  let nextUid = 8200;
  const runService = createWorkflowRunService({
    repositories,
    createUid: () => uid(nextUid++),
  });
  const scheduler = createWorkflowScheduler({ runService, executeNode });
  return { database, repositories, runService, scheduler, workflow };
}

test('backend scheduler executes full and scoped runs without a frontend node loop', async (t) => {
  const calls = [];
  const fixture = createSchedulerFixture(t, async (context) => {
    calls.push(context.node.uid);
    return { resultRef: `result:v1:${context.node.uid}` };
  });
  const full = await fixture.scheduler.start({
    workflowUid: fixture.workflow.definition.uid,
    scope: { mode: 'full' },
    maxRetries: 0,
  }).completion;
  assert.equal(full.run.status, 'succeeded');
  assert.deepEqual(full.nodes.map((node) => node.status), Array(5).fill('succeeded'));
  assert.deepEqual(calls, full.run.graphSnapshot.topologicalOrder);
  assert.equal(full.nodes.every((node) => /^[0-9a-f]{64}$/.test(node.cacheKey)), true);

  calls.length = 0;
  const downstream = await fixture.scheduler.start({
    workflowUid: fixture.workflow.definition.uid,
    scope: { mode: 'downstream', nodeUid: uid(8012) },
    maxRetries: 0,
  }).completion;
  assert.equal(downstream.run.status, 'succeeded');
  assert.deepEqual(calls, [uid(8012), uid(8013)]);
  assert.deepEqual(
    downstream.nodes.filter((node) => node.status === 'skipped').map((node) => node.nodeUid),
    [uid(8010), uid(8011), uid(8014)],
  );
});

test('scheduler retries retryable failures and isolates exhausted branches', async (t) => {
  const {
    createNodeExecutionError,
  } = require('../src/workflows');
  let adaptationAttempts = 0;
  let exhaust = false;
  const fixture = createSchedulerFixture(t, async ({ node }) => {
    if (node.uid === uid(8012)) {
      adaptationAttempts += 1;
      if (adaptationAttempts === 1 || exhaust) {
        throw createNodeExecutionError('ERR_SYNTHETIC_RETRY', { retryable: true });
      }
    }
    return { resultRef: `result:v1:${node.uid}` };
  });
  const recovered = await fixture.scheduler.start({
    workflowUid: fixture.workflow.definition.uid,
    scope: { mode: 'full' },
    maxRetries: 1,
  }).completion;
  assert.equal(recovered.run.status, 'succeeded');
  assert.equal(recovered.nodes.find((node) => node.nodeUid === uid(8012)).retryCount, 1);

  exhaust = true;
  const failed = await fixture.scheduler.start({
    workflowUid: fixture.workflow.definition.uid,
    scope: { mode: 'full' },
    maxRetries: 0,
  }).completion;
  assert.equal(failed.run.status, 'failed');
  assert.equal(failed.nodes.find((node) => node.nodeUid === uid(8012)).status, 'failed');
  assert.equal(failed.nodes.find((node) => node.nodeUid === uid(8013)).status, 'blocked');
  assert.equal(failed.nodes.find((node) => node.nodeUid === uid(8014)).status, 'succeeded');

  exhaust = false;
  const retried = await fixture.scheduler.retryNode({
    nodeRunUid: failed.nodes.find((node) => node.nodeUid === uid(8012)).uid,
    maxRetries: 0,
  }).completion;
  assert.equal(retried.run.status, 'succeeded');
  assert.equal(retried.run.retryCount, 1);
  assert.equal(retried.nodes.find((node) => node.nodeUid === uid(8013)).status, 'succeeded');
});

test('scheduler cancellation aborts active work and persists a terminal aggregate', async (t) => {
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const fixture = createSchedulerFixture(t, ({ signal }) => new Promise((resolve) => {
    started();
    signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true });
  }));
  const handle = fixture.scheduler.start({
    workflowUid: fixture.workflow.definition.uid,
    scope: { mode: 'full' },
    maxRetries: 0,
  });
  await began;
  const cancelled = fixture.scheduler.cancelRun(handle.runUid);
  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(cancelled.nodes.every((node) => ['cancelled', 'skipped'].includes(node.status)), true);
  assert.deepEqual(await handle.completion, cancelled);
});

test('cancellation settles even when an executor ignores abort and ignores late outcomes', async (t) => {
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const neverSettles = createSchedulerFixture(t, () => {
    started();
    return new Promise(() => {});
  });
  const neverHandle = neverSettles.scheduler.start({
    workflowUid: neverSettles.workflow.definition.uid,
    scope: { mode: 'full' },
    maxRetries: 0,
  });
  await began;
  const neverCancelled = neverSettles.scheduler.cancelRun(neverHandle.runUid);
  const neverCompletion = await Promise.race([
    neverHandle.completion,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('cancelled execution did not settle')),
      100,
    )),
  ]);
  assert.deepEqual(neverCompletion, neverCancelled);

  let releaseLate;
  const lateStarted = new Promise((resolve) => { started = resolve; });
  const lateResolve = createSchedulerFixture(t, () => {
    started();
    return new Promise((resolve) => { releaseLate = resolve; });
  });
  const lateHandle = lateResolve.scheduler.start({
    workflowUid: lateResolve.workflow.definition.uid,
    scope: { mode: 'full' },
    maxRetries: 0,
  });
  await lateStarted;
  const lateCancelled = lateResolve.scheduler.cancelRun(lateHandle.runUid);
  assert.deepEqual(await lateHandle.completion, lateCancelled);
  releaseLate({ shouldNotPersist: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lateResolve.runService.getRun(lateHandle.runUid), lateCancelled);

  let rejectLate;
  const rejectionStarted = new Promise((resolve) => { started = resolve; });
  const lateRejection = createSchedulerFixture(t, () => {
    started();
    return new Promise((_, reject) => { rejectLate = reject; });
  });
  const unhandled = [];
  const recordUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', recordUnhandled);
  t.after(() => process.off('unhandledRejection', recordUnhandled));
  const rejectionHandle = lateRejection.scheduler.start({
    workflowUid: lateRejection.workflow.definition.uid,
    scope: { mode: 'full' },
    maxRetries: 0,
  });
  await rejectionStarted;
  const rejectionCancelled = lateRejection.scheduler.cancelRun(rejectionHandle.runUid);
  assert.deepEqual(await rejectionHandle.completion, rejectionCancelled);
  rejectLate(new Error('synthetic late provider rejection'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lateRejection.runService.getRun(rejectionHandle.runUid), rejectionCancelled);
  assert.deepEqual(unhandled, []);
});

test('retry and cancel controls roll back the complete aggregate when persistence fails', async (t) => {
  const { createNodeExecutionError } = require('../src/workflows');
  const retryFixture = createSchedulerFixture(t, async ({ node }) => {
    if (node.uid === uid(8012)) {
      throw createNodeExecutionError('ERR_SYNTHETIC_RETRY', { retryable: false });
    }
    return { resultRef: `result:v1:${node.uid}` };
  });
  const failed = await retryFixture.scheduler.start({
    workflowUid: retryFixture.workflow.definition.uid,
    scope: { mode: 'full' },
    maxRetries: 0,
  }).completion;
  const failedNode = failed.nodes.find((node) => node.nodeUid === uid(8012));
  retryFixture.database.exec(`
    CREATE TRIGGER synthetic_retry_failure
    BEFORE UPDATE OF status ON node_runs
    WHEN OLD.status = 'blocked' AND NEW.status = 'queued'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic retry failure');
    END;
  `);
  assert.throws(
    () => retryFixture.scheduler.retryNode({ nodeRunUid: failedNode.uid, maxRetries: 0 }),
  );
  assert.deepEqual(retryFixture.runService.getRun(failed.run.uid), failed);

  const cancelFixture = createSchedulerFixture(t, async () => ({ ok: true }));
  const queued = cancelFixture.runService.createRun({
    workflowUid: cancelFixture.workflow.definition.uid,
    triggerType: 'manual',
  });
  cancelFixture.database.exec(`
    CREATE TRIGGER synthetic_cancel_failure
    BEFORE UPDATE OF status ON node_runs
    WHEN NEW.node_uid = '${uid(8012)}' AND NEW.status = 'cancelled'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic cancel failure');
    END;
  `);
  assert.throws(() => cancelFixture.scheduler.cancelRun(queued.run.uid));
  assert.deepEqual(cancelFixture.runService.getRun(queued.run.uid), queued);
});

test('an active run rejects retry before mutating any persisted state', async (t) => {
  const { createNodeExecutionError } = require('../src/workflows');
  let releaseIndependent;
  let independentStarted;
  const began = new Promise((resolve) => { independentStarted = resolve; });
  const independent = new Promise((resolve) => { releaseIndependent = resolve; });
  const fixture = createSchedulerFixture(t, async ({ node }) => {
    if (node.uid === uid(8012)) {
      throw createNodeExecutionError('ERR_SYNTHETIC_RETRY', { retryable: false });
    }
    if (node.uid === uid(8014)) {
      independentStarted();
      return independent;
    }
    return { resultRef: `result:v1:${node.uid}` };
  });
  const handle = fixture.scheduler.start({
    workflowUid: fixture.workflow.definition.uid,
    scope: { mode: 'full' },
    maxRetries: 0,
  });
  await began;
  const before = fixture.runService.getRun(handle.runUid);
  const failedNode = before.nodes.find((node) => node.nodeUid === uid(8012));
  assert.equal(failedNode.status, 'failed');
  assert.throws(
    () => fixture.scheduler.retryNode({ nodeRunUid: failedNode.uid, maxRetries: 0 }),
    (error) => error.code === 'WORKFLOW_CONFLICT',
  );
  assert.deepEqual(fixture.runService.getRun(handle.runUid), before);
  releaseIndependent({ resultRef: `result:v1:${uid(8014)}` });
  assert.equal((await handle.completion).run.status, 'failed');
});
