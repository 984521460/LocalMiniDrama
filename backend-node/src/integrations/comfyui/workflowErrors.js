'use strict';

const MESSAGES = Object.freeze({
  COMFY_WORKFLOW_INVALID: 'ComfyUI workflow is invalid',
  COMFY_WORKFLOW_LIMIT_EXCEEDED: 'ComfyUI workflow exceeds the supported limit',
  COMFY_WORKFLOW_MARKER_INVALID: 'ComfyUI workflow marker is invalid',
  COMFY_WORKFLOW_BINDING_INVALID: 'ComfyUI workflow binding is invalid',
  COMFY_WORKFLOW_INPUT_INVALID: 'ComfyUI workflow input is invalid',
});
const TRUSTED_ERRORS = new WeakSet();

class ComfyWorkflowError extends Error {
  constructor(code) {
    if (!Object.hasOwn(MESSAGES, code)) throw new TypeError('Unknown ComfyUI workflow error code');
    super(MESSAGES[code]);
    this.name = 'ComfyWorkflowError';
    Object.defineProperty(this, 'code', {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    });
    TRUSTED_ERRORS.add(this);
    Object.freeze(this);
  }
}

function createComfyWorkflowError(code) {
  return new ComfyWorkflowError(code);
}

function isComfyWorkflowError(value) {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && TRUSTED_ERRORS.has(value);
}

module.exports = Object.freeze({
  ComfyWorkflowError,
  createComfyWorkflowError,
  isComfyWorkflowError,
});
