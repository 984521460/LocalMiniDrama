export const WORKFLOW_GRAPH_ERROR_MESSAGES = Object.freeze({
  WORKFLOW_GRAPH_BOUND_INPUT: 'Bound workflow graph nodes cannot receive graph inputs',
  WORKFLOW_GRAPH_CYCLE: 'Workflow graph contains a directed cycle',
  WORKFLOW_GRAPH_DISABLED_DEPENDENCY: 'Active workflow graph nodes cannot depend on disabled nodes',
  WORKFLOW_GRAPH_EDGE_DUPLICATE: 'Workflow graph contains a duplicate edge',
  WORKFLOW_GRAPH_ENDPOINT_UNKNOWN: 'Workflow graph edge endpoint is unknown',
  WORKFLOW_GRAPH_INPUT_CARDINALITY: 'Workflow graph input cardinality is invalid',
  WORKFLOW_GRAPH_INPUT_INVALID: 'Workflow graph input is invalid',
  WORKFLOW_GRAPH_NODE_DUPLICATE: 'Workflow graph contains a duplicate node',
  WORKFLOW_GRAPH_NODE_UNKNOWN: 'Workflow graph node type is unknown',
  WORKFLOW_GRAPH_PORT_UNKNOWN: 'Workflow graph port is unknown',
  WORKFLOW_GRAPH_REQUIRED_INPUT: 'Workflow graph required input is missing',
  WORKFLOW_GRAPH_SELF_EDGE: 'Workflow graph contains a self edge',
  WORKFLOW_GRAPH_TOO_LARGE: 'Workflow graph exceeds the supported limit',
  WORKFLOW_GRAPH_TYPE_MISMATCH: 'Workflow graph port types are incompatible',
} as const);

export type WorkflowGraphErrorCode = keyof typeof WORKFLOW_GRAPH_ERROR_MESSAGES;

export class WorkflowGraphError extends Error {
  readonly code: WorkflowGraphErrorCode;

  constructor(code: WorkflowGraphErrorCode) {
    super(WORKFLOW_GRAPH_ERROR_MESSAGES[code]);
    this.name = 'WorkflowGraphError';
    this.code = code;
  }

  toJSON(): Readonly<{ name: string; code: WorkflowGraphErrorCode; message: string }> {
    return Object.freeze({ name: this.name, code: this.code, message: this.message });
  }
}
