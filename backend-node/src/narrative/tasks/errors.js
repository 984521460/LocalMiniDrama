const ERROR_MESSAGES = Object.freeze({
  NARRATIVE_TASK_INPUT_INVALID: 'Narrative task input is invalid',
  NARRATIVE_TASK_RESPONSE_INVALID: 'Narrative task response is invalid',
  NARRATIVE_TASK_EVIDENCE_INVALID: 'Narrative task evidence is invalid',
  NARRATIVE_TASK_REFERENCE_INVALID: 'Narrative task references are invalid',
  NARRATIVE_TASK_LIMIT_EXCEEDED: 'Narrative task limit was exceeded',
});

class NarrativeTaskError extends Error {
  constructor(code) {
    if (!Object.hasOwn(ERROR_MESSAGES, code)) throw new TypeError('Unknown narrative task error code');
    super(ERROR_MESSAGES[code]);
    this.name = 'NarrativeTaskError';
    this.code = code;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

function narrativeTaskError(code) {
  return new NarrativeTaskError(code);
}

module.exports = {
  NarrativeTaskError,
  narrativeTaskError,
};
