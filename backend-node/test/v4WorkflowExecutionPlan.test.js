const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const { createV2Repositories } = require('../src/repositories/v2');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

function graph(expectedRevision, { changed = false, reverse = false } = {}) {
  const source = {
    uid: uid(6011),
    nodeType: 'source.selection',
    position: { y: 10, x: 20 },
    config: changed
      ? { contextAfterBlocks: 2, contextBeforeBlocks: 1 }
      : { contextBeforeBlocks: 1, contextAfterBlocks: 1 },
    status: 'disabled',
  };
  const facts = {
    uid: uid(6012),
    nodeType: 'story.facts',
    position: { x: 220, y: 10 },
    config: {},
    status: 'disabled',
  };
  const nodes = reverse ? [facts, source] : [source, facts];
  return {
    expectedRevision,
    nodes,
    edges: [{
      uid: uid(6021),
      sourceNodeUid: source.uid,
      sourcePort: 'selection',
      targetNodeUid: facts.uid,
      targetPort: 'selection',
    }],
  };
}

test('creates an immutable canonical graph snapshot and deterministic execution plan', (t) => {
  const { createWorkflowService } = require('../src/workflows');
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(6000));
  const service = createWorkflowService({
    repositories: createV2Repositories(database),
    createUid: () => uid(6010),
  });
  const workflow = service.createWorkflow({ dramaId: 1, name: 'Execution plan' });
  service.replaceGraph(workflow.definition.uid, graph(0));

  const first = service.createExecutionPlan(workflow.definition.uid);
  assert.equal(first.schemaVersion, '4.0');
  assert.equal(first.registryVersion, '4.0.0');
  assert.equal(first.graphRevision, 1);
  assert.match(first.graphHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.topologicalOrder, [uid(6011), uid(6012)]);
  assert.deepEqual(first.snapshot.nodes.map((node) => node.uid), [uid(6011), uid(6012)]);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.snapshot));
  assert.ok(Object.isFrozen(first.snapshot.nodes[0].config.nested));
  const schema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'schemas', 'v4', 'workflow-execution-plan.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(first), true, JSON.stringify(validate.errors));

  service.replaceGraph(workflow.definition.uid, graph(1, { reverse: true }));
  const reordered = service.createExecutionPlan(workflow.definition.uid);
  assert.equal(reordered.graphRevision, 2);
  assert.equal(reordered.graphHash, first.graphHash);
  assert.deepEqual(reordered.snapshot, first.snapshot);

  service.replaceGraph(workflow.definition.uid, graph(2, { changed: true }));
  const changed = service.createExecutionPlan(workflow.definition.uid);
  assert.notEqual(changed.graphHash, first.graphHash);
});

test('execution planning revalidates persisted graph data and returns a fixed failure', (t) => {
  const { createWorkflowService, isWorkflowError } = require('../src/workflows');
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(6000));
  const service = createWorkflowService({
    repositories: createV2Repositories(database),
    createUid: () => uid(6010),
  });
  const workflow = service.createWorkflow({ dramaId: 1, name: 'Persisted validation' });
  service.replaceGraph(workflow.definition.uid, graph(0));
  database.prepare('UPDATE canvas_nodes SET node_type = ? WHERE uid = ?')
    .run('synthetic.invalid.node', uid(6011));

  assert.throws(() => service.createExecutionPlan(workflow.definition.uid), (error) => {
    assert.equal(isWorkflowError(error), true);
    assert.equal(error.code, 'WORKFLOW_DATA_INVALID');
    assert.doesNotMatch(JSON.stringify(error), /synthetic\.invalid\.node/);
    return true;
  });
});

test('node configs reject raw secrets before persistence and during plan reconstruction', (t) => {
  const { createWorkflowService, isWorkflowError } = require('../src/workflows');
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(6000));
  const service = createWorkflowService({
    repositories: createV2Repositories(database),
    createUid: () => uid(6010),
  });
  const workflow = service.createWorkflow({ dramaId: 1, name: 'Secret boundary' });
  service.replaceGraph(workflow.definition.uid, graph(0));

  for (const config of [
    { apiKey: 'fixture-raw-secret-value' },
    { contextBeforeBlocks: 1, authorization: { bearer: 'fixture-raw-secret-value' } },
  ]) {
    const invalidGraph = graph(1);
    invalidGraph.nodes[0].config = config;
    assert.throws(() => service.replaceGraph(workflow.definition.uid, invalidGraph), (error) => {
      assert.equal(isWorkflowError(error), true);
      assert.equal(error.code, 'WORKFLOW_GRAPH_INVALID');
      assert.doesNotMatch(JSON.stringify(error), /fixture-raw-secret-value/);
      return true;
    });
  }
  assert.equal(service.getWorkflow(workflow.definition.uid).definition.graphRevision, 1);

  database.prepare('UPDATE canvas_nodes SET config_json = ? WHERE uid = ?')
    .run(JSON.stringify({ apiKey: 'fixture-persisted-secret-value' }), uid(6011));
  assert.throws(() => service.createExecutionPlan(workflow.definition.uid), (error) => {
    assert.equal(isWorkflowError(error), true);
    assert.equal(error.code, 'WORKFLOW_DATA_INVALID');
    assert.doesNotMatch(JSON.stringify(error), /fixture-persisted-secret-value/);
    return true;
  });
});

test('execution identity contains only stable enabled state and canonical identifiers', () => {
  const {
    WorkflowPlanDataError,
    createWorkflowExecutionPlan,
  } = require('../src/workflows/executionPlan');
  const dramaUid = uid(6100);
  const selectionUid = uid(6101);
  const documentUid = uid(6102);
  const repositories = {
    sources: {
      getSelection: () => ({ documentUid }),
      getDocument: () => ({ dramaUid }),
    },
  };
  const base = {
    definition: {
      uid: uid(6103),
      dramaUid,
      registryVersion: '4.0.0',
      graphRevision: 1,
    },
    nodes: [{
      uid: uid(6104),
      nodeType: 'source.selection',
      position: { x: 0, y: 0 },
      config: {},
      domainRefType: 'source_selection',
      domainRefUid: selectionUid,
      status: 'draft',
    }],
    edges: [],
  };

  const enabledPlans = ['draft', 'ready', 'running', 'succeeded', 'failed', 'stale']
    .map((status) => createWorkflowExecutionPlan({
      ...base,
      nodes: [{ ...base.nodes[0], status }],
    }, repositories));
  assert.deepEqual(new Set(enabledPlans.map((plan) => plan.graphHash)).size, 1);
  assert.equal(enabledPlans[0].snapshot.nodes[0].enabled, true);
  assert.equal(Object.hasOwn(enabledPlans[0].snapshot.nodes[0], 'status'), false);
  const disabled = createWorkflowExecutionPlan({
    ...base,
    nodes: [{ ...base.nodes[0], status: 'disabled' }],
  }, repositories);
  assert.equal(disabled.snapshot.nodes[0].enabled, false);
  assert.notEqual(disabled.graphHash, enabledPlans[0].graphHash);

  for (const mutate of [
    (candidate) => { candidate.definition.uid = 'bad-workflow'; },
    (candidate) => { candidate.definition.dramaUid = 'bad-drama'; },
    (candidate) => { candidate.nodes[0].uid = 'bad-node'; },
    (candidate) => { candidate.nodes[0].domainRefUid = 'bad-domain-ref'; },
  ]) {
    const candidate = structuredClone(base);
    mutate(candidate);
    assert.throws(
      () => createWorkflowExecutionPlan(candidate, repositories),
      (error) => error instanceof WorkflowPlanDataError,
    );
  }
});

test('execution planning never invokes hostile accessors or leaks their errors', () => {
  const {
    WorkflowPlanDataError,
    createWorkflowExecutionPlan,
  } = require('../src/workflows/executionPlan');
  let getterCalls = 0;
  const graphWithAccessor = {};
  Object.defineProperty(graphWithAccessor, 'definition', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('fixture-hostile-accessor-detail');
    },
  });
  assert.throws(() => createWorkflowExecutionPlan(graphWithAccessor, {}), (error) => {
    assert.equal(error instanceof WorkflowPlanDataError, true);
    assert.doesNotMatch(String(error), /fixture-hostile-accessor-detail/);
    return true;
  });
  assert.equal(getterCalls, 0);

  let proxyCalls = 0;
  const graphProxy = new Proxy({}, {
    get() {
      proxyCalls += 1;
      throw new Error('fixture-hostile-proxy-detail');
    },
  });
  assert.throws(
    () => createWorkflowExecutionPlan(graphProxy, {}),
    (error) => error instanceof WorkflowPlanDataError,
  );
  assert.equal(proxyCalls, 0);
});

test('runtime and schema share exact per-node configuration contracts', () => {
  const { normalizeWorkflowNodeConfig } = require('../src/workflows/nodeConfig');
  const schema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'schemas', 'v4', 'workflow-execution-plan.schema.json'),
    'utf8',
  ));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const validateNode = ajv.getSchema(`${schema.$id}#/$defs/node`);
  assert.equal(typeof validateNode, 'function');
  const credentialRef = `credential:v1:${uid(6200)}`;
  const connectionEvidenceSha256 = 'b'.repeat(64);
  const examples = {
    'source.selection': { contextAfterBlocks: 2, contextBeforeBlocks: 1 },
    'story.facts': { profileUid: uid(6201), temperature: 0.5 },
    'episode.adaptation': { profileUid: uid(6202), targetSeconds: 60, temperature: 0.4 },
    'script.structured': { profileUid: uid(6203), temperature: 0.3 },
    'asset.character': { profileUid: uid(6204) },
    'asset.character_candidates': {
      candidateCount: 4,
      credentialRef,
      height: 1024,
      manifestUid: uid(6205),
      profileUid: uid(6206),
      seed: 42,
      width: 1024,
    },
    'asset.character_pack': { profileUid: uid(6207) },
    'asset.scene': { candidateCount: 4, height: 1024, width: 1024 },
    'asset.prop': { candidateCount: 4, seed: 7 },
    'shot.plan': { maxShots: 6, profileUid: uid(6208), targetSeconds: 60, temperature: 0.2 },
    'shot.image': {
      connectionEvidenceSha256, connectionUid: uid(6212), credentialRef, height: 1080,
      manifestUid: uid(6209), seed: 9, width: 1920,
    },
    'shot.video': {
      connectionEvidenceSha256, connectionUid: uid(6213), credentialRef, durationMs: 15000,
      fps: 24, height: 1080, width: 1920,
    },
    'audio.tts': { credentialRef, profileUid: uid(6210), speed: 1 },
    'subtitle.align': { profileUid: uid(6211) },
    'bgm.track': { credentialRef, targetSeconds: 60 },
    'export.final': { format: 'mp4', fps: 24, height: 1080, width: 1920 },
  };

  let ordinal = 6300;
  for (const [nodeType, config] of Object.entries(examples)) {
    const normalized = normalizeWorkflowNodeConfig(nodeType, config);
    assert.ok(Object.isFrozen(normalized));
    const valid = validateNode({
      uid: uid(ordinal),
      nodeType,
      position: { x: 0, y: 0 },
      config: normalized,
      domainRef: null,
      enabled: true,
    });
    assert.equal(valid, true, `${nodeType}: ${JSON.stringify(validateNode.errors)}`);
    ordinal += 1;
  }

  for (const invalid of [
    ['shot.image', { apiKey: 'fixture-secret' }],
    ['shot.image', { credentialRef: 'fixture-secret' }],
    ['shot.video', { connectionEvidenceSha256: 'A'.repeat(64) }],
    ['source.selection', { width: 1920 }],
    ['export.final', { format: 'provider-specific' }],
  ]) {
    assert.throws(() => normalizeWorkflowNodeConfig(invalid[0], invalid[1]), {
      code: 'WORKFLOW_NODE_CONFIG_INVALID',
    });
  }
});
