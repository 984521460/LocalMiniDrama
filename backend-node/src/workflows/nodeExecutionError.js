const { ERROR_CODE, ERROR_DETAIL_REF } = require('./runState');

const trustedNodeExecutionErrors = new WeakSet();

class WorkflowNodeExecutionError extends Error {
  constructor(code, { retryable = false, errorDetailRef = null } = {}) {
    if (typeof code !== 'string' || !ERROR_CODE.test(code)) {
      throw new TypeError('Node execution error code is invalid');
    }
    if (typeof retryable !== 'boolean') {
      throw new TypeError('Node execution retry flag is invalid');
    }
    if (errorDetailRef !== null && (
      typeof errorDetailRef !== 'string' || !ERROR_DETAIL_REF.test(errorDetailRef)
    )) {
      throw new TypeError('Node execution detail reference is invalid');
    }
    super('Workflow node execution failed');
    this.name = 'WorkflowNodeExecutionError';
    this.code = code;
    this.retryable = retryable;
    this.errorDetailRef = errorDetailRef;
    trustedNodeExecutionErrors.add(this);
    Object.freeze(this);
  }
}

function createNodeExecutionError(code, options) {
  return new WorkflowNodeExecutionError(code, options);
}

function isNodeExecutionError(value) {
  return Boolean(value && typeof value === 'object' && trustedNodeExecutionErrors.has(value));
}

module.exports = {
  WorkflowNodeExecutionError,
  createNodeExecutionError,
  isNodeExecutionError,
};
