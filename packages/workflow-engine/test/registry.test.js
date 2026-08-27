const assert = require('node:assert/strict');
const test = require('node:test');

const workflowEngine = require('..');

test('package consumers receive immutable registry contracts from CommonJS', () => {
  const registry = workflowEngine.getWorkflowRegistry();
  assert.equal(registry.registryVersion, '4.0.0');
  assert.equal(workflowEngine.listNodeTypes().length, 16);
  assert.ok(Object.isFrozen(registry.nodes[0].outputs[0]));
  assert.equal(require.resolve('..'), require.resolve('../dist/index.js'));
});

test('unknown lookup values never appear in public registry errors', () => {
  const sentinel = 'synthetic-sensitive-node-value';
  assert.throws(() => workflowEngine.getNodeTypeDefinition(sentinel), (error) => {
    assert.equal(error.code, 'WORKFLOW_NODE_TYPE_UNKNOWN');
    assert.doesNotMatch(error.message, new RegExp(sentinel));
    assert.doesNotMatch(JSON.stringify(error), new RegExp(sentinel));
    return true;
  });
});
