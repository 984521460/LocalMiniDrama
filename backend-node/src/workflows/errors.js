const WORKFLOW_ERROR_MESSAGES = Object.freeze({
  WORKFLOW_CONFLICT: 'Workflow changed before the operation completed',
  WORKFLOW_DATA_INVALID: 'Stored workflow data is invalid',
  WORKFLOW_DRAMA_NOT_FOUND: 'Drama was not found',
  WORKFLOW_GRAPH_INVALID: 'Workflow graph is invalid',
  WORKFLOW_EXECUTION_FAILED: 'Workflow execution failed',
  WORKFLOW_EXECUTION_UNAVAILABLE: 'Workflow execution is not available',
  WORKFLOW_INPUT_INVALID: 'Workflow input is invalid',
  WORKFLOW_LIMIT_EXCEEDED: 'Workflow input exceeds the supported limit',
  WORKFLOW_NOT_FOUND: 'Workflow was not found',
  WORKFLOW_RUN_NOT_FOUND: 'Workflow run was not found',
  WORKFLOW_RUN_TRANSITION_INVALID: 'Workflow run state transition is invalid',
});

const trustedErrors = new WeakSet();

class WorkflowError extends Error {
  constructor(code) {
    const message = WORKFLOW_ERROR_MESSAGES[code];
    if (!message) throw new TypeError('Unknown workflow error code');
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    trustedErrors.add(this);
    Object.freeze(this);
  }
}

function createWorkflowError(code) {
  return new WorkflowError(code);
}

function isWorkflowError(value) {
  return Boolean(value && typeof value === 'object' && trustedErrors.has(value));
}

module.exports = {
  WORKFLOW_ERROR_MESSAGES,
  createWorkflowError,
  isWorkflowError,
};
