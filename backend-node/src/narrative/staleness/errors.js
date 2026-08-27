const trustedErrors = new WeakSet();

const ERROR_MESSAGES = Object.freeze({
  NARRATIVE_STALENESS_INPUT_INVALID: 'Narrative staleness input is invalid',
  NARRATIVE_STALENESS_NOT_FOUND: 'Narrative staleness root was not found',
  NARRATIVE_STALENESS_CONFLICT: 'Narrative staleness conflicted with another change',
  NARRATIVE_STALENESS_DATA_INVALID: 'Narrative staleness persisted data is invalid',
});

class NarrativeStalenessError extends Error {
  constructor(code) {
    if (!Object.hasOwn(ERROR_MESSAGES, code)) throw new TypeError('Unknown narrative staleness error code');
    super(ERROR_MESSAGES[code]);
    this.name = 'NarrativeStalenessError';
    Object.defineProperty(this, 'code', {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    });
    trustedErrors.add(this);
    Object.freeze(this);
  }
}

function narrativeStalenessError(code) {
  return new NarrativeStalenessError(code);
}

function isNarrativeStalenessError(error) {
  return trustedErrors.has(error);
}

module.exports = {
  NarrativeStalenessError,
  isNarrativeStalenessError,
  narrativeStalenessError,
};
