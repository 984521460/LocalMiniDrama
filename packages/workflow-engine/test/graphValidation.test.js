const assert = require('node:assert/strict');
const test = require('node:test');

const workflowEngine = require('..');

function edge(uid, sourceNodeUid, sourcePort, targetNodeUid, targetPort) {
  return { uid, sourceNodeUid, sourcePort, targetNodeUid, targetPort };
}

function validGraph() {
  return {
    nodes: [
      { uid: 'source', nodeType: 'source.selection', bound: true },
      { uid: 'facts', nodeType: 'story.facts' },
      { uid: 'beats', nodeType: 'episode.adaptation' },
      { uid: 'script', nodeType: 'script.structured' },
    ],
    edges: [
      edge('e1', 'source', 'selection', 'facts', 'selection'),
      edge('e2', 'facts', 'facts', 'beats', 'facts'),
      edge('e3', 'beats', 'beats', 'script', 'beats'),
    ],
  };
}

function expectGraphError(graph, code) {
  assert.throws(() => workflowEngine.validateWorkflowGraph(graph), (error) => {
    assert.ok(error instanceof workflowEngine.WorkflowGraphError);
    assert.equal(error.code, code);
    return true;
  });
}

test('validates a bound-root workflow and returns a stable topological order', () => {
  const result = workflowEngine.validateWorkflowGraph(validGraph());
  assert.deepEqual(result.topologicalOrder, ['source', 'facts', 'beats', 'script']);
  assert.equal(result.nodeCount, 4);
  assert.equal(result.edgeCount, 3);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.topologicalOrder));
});

test('rejects unknown ports, incompatible types, repeated inputs, and missing required inputs', () => {
  const unknownPort = validGraph();
  unknownPort.edges[0].sourcePort = 'missing';
  expectGraphError(unknownPort, 'WORKFLOW_GRAPH_PORT_UNKNOWN');

  const typeMismatch = validGraph();
  typeMismatch.edges[0] = edge('e1', 'facts', 'facts', 'script', 'beats');
  expectGraphError(typeMismatch, 'WORKFLOW_GRAPH_TYPE_MISMATCH');

  const cardinality = validGraph();
  cardinality.nodes.push({ uid: 'source-2', nodeType: 'source.selection', bound: true });
  cardinality.edges.push(edge('e4', 'source-2', 'selection', 'facts', 'selection'));
  expectGraphError(cardinality, 'WORKFLOW_GRAPH_INPUT_CARDINALITY');

  const required = validGraph();
  required.edges = required.edges.slice(1);
  expectGraphError(required, 'WORKFLOW_GRAPH_REQUIRED_INPUT');
});

test('rejects duplicate edges, self edges, directed cycles, and hostile accessors', () => {
  const duplicate = validGraph();
  duplicate.edges.push(edge('e4', 'source', 'selection', 'facts', 'selection'));
  expectGraphError(duplicate, 'WORKFLOW_GRAPH_EDGE_DUPLICATE');

  const self = validGraph();
  self.edges[0] = edge('e1', 'source', 'selection', 'source', 'document');
  expectGraphError(self, 'WORKFLOW_GRAPH_SELF_EDGE');

  const cycle = validGraph();
  cycle.edges.push(edge('e4', 'script', 'script', 'source', 'document'));
  expectGraphError(cycle, 'WORKFLOW_GRAPH_CYCLE');

  let getterCalls = 0;
  const hostile = validGraph();
  Object.defineProperty(hostile.nodes[0], 'nodeType', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'source.selection';
    },
  });
  expectGraphError(hostile, 'WORKFLOW_GRAPH_INPUT_INVALID');
  assert.equal(getterCalls, 0);

  let proxyTrapCalls = 0;
  const proxy = new Proxy(validGraph(), {
    getPrototypeOf() {
      proxyTrapCalls += 1;
      return Object.prototype;
    },
  });
  expectGraphError(proxy, 'WORKFLOW_GRAPH_INPUT_INVALID');
  assert.equal(proxyTrapCalls, 0);
});

test('rejects graph inputs to bound nodes and active consumers of disabled nodes', () => {
  const boundInput = validGraph();
  boundInput.nodes[1].bound = true;
  expectGraphError(boundInput, 'WORKFLOW_GRAPH_BOUND_INPUT');

  const disabledDependency = validGraph();
  disabledDependency.nodes[0].disabled = true;
  expectGraphError(disabledDependency, 'WORKFLOW_GRAPH_DISABLED_DEPENDENCY');
});
