const assert = require('node:assert/strict');
const test = require('node:test');

const workflowEngine = require('..');

function plan() {
  return {
    nodes: [
      { uid: 'a', enabled: true },
      { uid: 'b', enabled: true },
      { uid: 'c', enabled: true },
      { uid: 'd', enabled: true },
      { uid: 'off', enabled: false },
    ],
    edges: [
      { sourceNodeUid: 'a', targetNodeUid: 'b' },
      { sourceNodeUid: 'a', targetNodeUid: 'c' },
      { sourceNodeUid: 'b', targetNodeUid: 'd' },
      { sourceNodeUid: 'c', targetNodeUid: 'd' },
    ],
    topologicalOrder: ['a', 'b', 'c', 'd', 'off'],
  };
}

test('projects full, node, downstream, and exact selection scopes in topological order', () => {
  const cases = [
    [{ mode: 'full' }, ['a', 'b', 'c', 'd']],
    [{ mode: 'node', nodeUid: 'c' }, ['c']],
    [{ mode: 'downstream', nodeUid: 'b' }, ['b', 'd']],
    [{ mode: 'selection', nodeUids: ['d', 'a'] }, ['a', 'd']],
  ];
  for (const [scope, expected] of cases) {
    const result = workflowEngine.createExecutionScope(plan(), scope);
    assert.deepEqual(result.executionOrder, expected);
    assert.deepEqual(
      result.skippedNodeUids,
      plan().topologicalOrder.filter((uid) => !expected.includes(uid)),
    );
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.executionOrder));
  }
});

test('scope validation rejects unknown, disabled, duplicate, empty, and hostile inputs', () => {
  const invalid = [
    { mode: 'node', nodeUid: 'missing' },
    { mode: 'downstream', nodeUid: 'off' },
    { mode: 'selection', nodeUids: [] },
    { mode: 'selection', nodeUids: ['a', 'a'] },
    { mode: 'selection', nodeUids: ['a', 'off'] },
    { mode: 'full', nodeUid: 'a' },
  ];
  for (const scope of invalid) {
    assert.throws(
      () => workflowEngine.createExecutionScope(plan(), scope),
      (error) => error instanceof workflowEngine.WorkflowExecutionScopeError,
    );
  }

  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'mode', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'full';
    },
  });
  assert.throws(
    () => workflowEngine.createExecutionScope(plan(), hostile),
    (error) => error.code === 'WORKFLOW_SCOPE_INPUT_INVALID',
  );
  assert.equal(getterCalls, 0);
});
