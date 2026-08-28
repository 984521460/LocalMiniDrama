'use strict';

const MESSAGES = Object.freeze({
  REMOTE_ENVIRONMENT_INPUT_INVALID: 'Remote environment request is invalid',
  REMOTE_ENVIRONMENT_PLAN_CONFLICT: 'Remote initialization plan has changed',
  REMOTE_ENVIRONMENT_SESSION_FAILED: 'Remote environment session failed',
  REMOTE_ENVIRONMENT_PROBE_FAILED: 'Remote environment inspection failed',
  REMOTE_ENVIRONMENT_INITIALIZATION_FAILED: 'Remote environment initialization failed',
  REMOTE_ENVIRONMENT_UNEXPECTED: 'Remote environment operation failed',
});
const TRUSTED_ERRORS = new WeakSet();

class RemoteEnvironmentError extends Error {
  constructor(code) {
    if (!Object.hasOwn(MESSAGES, code)) throw new TypeError('Unknown remote environment error code');
    super(MESSAGES[code]);
    this.name = 'RemoteEnvironmentError';
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

function createRemoteEnvironmentError(code) {
  return new RemoteEnvironmentError(code);
}

function isRemoteEnvironmentError(value) {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && TRUSTED_ERRORS.has(value);
}

module.exports = Object.freeze({
  RemoteEnvironmentError,
  createRemoteEnvironmentError,
  isRemoteEnvironmentError,
});
