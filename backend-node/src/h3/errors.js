'use strict';

const MESSAGES = Object.freeze({
  H3_PROFILE_INVALID: 'H3 profile is invalid',
  H3_PROMPT_INVALID: 'H3 shot prompt is invalid',
  H3_GENERATION_INPUT_INVALID: 'H3 generation input is invalid',
  H3_WORKFLOW_UNVERIFIED: 'H3 workflow mode has not passed its real validation gate',
  H3_OUTPUT_INVALID: 'H3 video output is invalid',
  H3_REAL_VALIDATION_INVALID: 'H3 real validation evidence is invalid',
  H3_API_REQUEST_INVALID: 'MiniMax H3 API request is invalid',
  H3_API_UNAVAILABLE: 'MiniMax H3 API provider is unavailable',
  H3_API_REQUEST_ABORTED: 'MiniMax H3 API request did not settle in time',
  H3_API_UPSTREAM_FAILED: 'MiniMax H3 API request failed',
  H3_API_RESPONSE_INVALID: 'MiniMax H3 API response is invalid',
  H3_API_SUBMISSION_UNKNOWN: 'MiniMax H3 API submission state is unknown',
  H3_HISTORY_CONFLICT: 'H3 generation history conflict',
});
const TRUSTED_ERRORS = new WeakSet();

class H3ContractError extends TypeError {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'H3_GENERATION_INPUT_INVALID';
    super(MESSAGES[safeCode]);
    this.name = 'H3ContractError';
    this.code = safeCode;
    TRUSTED_ERRORS.add(this);
    Object.freeze(this);
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

function fail(code) {
  throw new H3ContractError(code);
}

function isH3ContractError(error) {
  return (typeof error === 'object' || typeof error === 'function')
    && error !== null
    && TRUSTED_ERRORS.has(error);
}

module.exports = Object.freeze({ H3ContractError, fail, isH3ContractError });
