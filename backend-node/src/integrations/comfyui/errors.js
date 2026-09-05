'use strict';

const MESSAGES = Object.freeze({
  COMFY_CONNECTION_FAILED: 'ComfyUI connection failed',
  COMFY_HTTP_ERROR: 'ComfyUI HTTP request failed',
  COMFY_REQUEST_ABORTED: 'ComfyUI request was aborted',
  COMFY_RESPONSE_INVALID: 'ComfyUI response is invalid',
  COMFY_SUBMISSION_REJECTED: 'ComfyUI prompt submission was rejected',
  COMFY_EXECUTION_FAILED: 'ComfyUI execution failed',
  COMFY_PROMPT_TIMEOUT: 'ComfyUI prompt wait timed out',
  COMFY_UPLOAD_FAILED: 'ComfyUI input upload failed',
  COMFY_DOWNLOAD_FAILED: 'ComfyUI output download failed',
});
const RETRYABLE = new Set([
  'COMFY_CONNECTION_FAILED',
  'COMFY_HTTP_ERROR',
  'COMFY_REQUEST_ABORTED',
  'COMFY_PROMPT_TIMEOUT',
  'COMFY_UPLOAD_FAILED',
  'COMFY_DOWNLOAD_FAILED',
]);
const trustedErrors = new WeakSet();

class ComfyUiClientError extends Error {
  constructor(code, { status } = {}) {
    const normalizedCode = Object.hasOwn(MESSAGES, code) ? code : 'COMFY_CONNECTION_FAILED';
    super(MESSAGES[normalizedCode]);
    this.name = 'ComfyUiClientError';
    this.code = normalizedCode;
    this.retryable = RETRYABLE.has(normalizedCode);
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
    trustedErrors.add(this);
    Object.freeze(this);
  }
}

function createComfyUiClientError(code, options) {
  return new ComfyUiClientError(code, options);
}

function isComfyUiClientError(error) {
  return Boolean(error && typeof error === 'object' && trustedErrors.has(error));
}

module.exports = {
  ComfyUiClientError,
  createComfyUiClientError,
  isComfyUiClientError,
};
