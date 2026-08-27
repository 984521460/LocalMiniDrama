export const WORKFLOW_EXECUTION_SCOPE_ERROR_MESSAGES = Object.freeze({
  WORKFLOW_SCOPE_INPUT_INVALID: 'Workflow execution scope input is invalid',
  WORKFLOW_SCOPE_NODE_DISABLED: 'Workflow execution scope contains a disabled node',
  WORKFLOW_SCOPE_NODE_UNKNOWN: 'Workflow execution scope contains an unknown node',
  WORKFLOW_SCOPE_SELECTION_DUPLICATE: 'Workflow execution scope contains a duplicate node',
  WORKFLOW_SCOPE_SELECTION_EMPTY: 'Workflow execution selection cannot be empty',
} as const);

export type WorkflowExecutionScopeErrorCode = keyof typeof WORKFLOW_EXECUTION_SCOPE_ERROR_MESSAGES;

export class WorkflowExecutionScopeError extends Error {
  readonly code: WorkflowExecutionScopeErrorCode;

  constructor(code: WorkflowExecutionScopeErrorCode) {
    super(WORKFLOW_EXECUTION_SCOPE_ERROR_MESSAGES[code]);
    this.name = 'WorkflowExecutionScopeError';
    this.code = code;
    Object.freeze(this);
  }
}
