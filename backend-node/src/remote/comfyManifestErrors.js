'use strict';

const MESSAGES = Object.freeze({
  COMFY_MANIFEST_INVALID: 'ComfyUI workflow manifest is invalid',
  COMFY_MANIFEST_WORKFLOW_MISMATCH: 'ComfyUI workflow does not match its manifest',
  COMFY_DEPENDENCY_RESPONSE_INVALID: 'ComfyUI dependency response is invalid',
  COMFY_DEPENDENCIES_MISSING: 'ComfyUI workflow dependencies are not ready',
});
const TRUSTED_ERRORS = new WeakSet();

class ComfyManifestError extends Error {
  constructor(code) {
    if (!Object.hasOwn(MESSAGES, code)) {
      throw new TypeError('Unknown ComfyUI manifest error code');
    }
    super(MESSAGES[code]);
    this.name = 'ComfyManifestError';
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

function createComfyManifestError(code) {
  return new ComfyManifestError(code);
}

function isComfyManifestError(value) {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && TRUSTED_ERRORS.has(value);
}

module.exports = Object.freeze({
  ComfyManifestError,
  createComfyManifestError,
  isComfyManifestError,
});
