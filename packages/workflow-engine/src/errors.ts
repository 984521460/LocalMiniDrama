export const WORKFLOW_REGISTRY_ERROR_MESSAGES = Object.freeze({
  WORKFLOW_NODE_TYPE_UNKNOWN: 'Workflow node type is not registered',
  WORKFLOW_PORT_DIRECTION_INVALID: 'Workflow port direction is invalid',
  WORKFLOW_PORT_UNKNOWN: 'Workflow port is not registered',
} as const);

export type WorkflowRegistryErrorCode = keyof typeof WORKFLOW_REGISTRY_ERROR_MESSAGES;

export class WorkflowRegistryError extends Error {
  readonly code: WorkflowRegistryErrorCode;

  constructor(code: WorkflowRegistryErrorCode) {
    super(WORKFLOW_REGISTRY_ERROR_MESSAGES[code]);
    this.name = 'WorkflowRegistryError';
    this.code = code;
  }

  toJSON(): Readonly<{ name: string; code: WorkflowRegistryErrorCode; message: string }> {
    return Object.freeze({ name: this.name, code: this.code, message: this.message });
  }
}
