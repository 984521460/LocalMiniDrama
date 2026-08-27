const trustedErrors = new WeakSet();

const ERROR_MESSAGES = Object.freeze({
  NARRATIVE_REVIEW_INPUT_INVALID: 'Narrative review input is invalid',
  NARRATIVE_REVIEW_DATA_INVALID: 'Narrative review persisted data is invalid',
  NARRATIVE_REVIEW_NOT_FOUND: 'Narrative review result was not found',
  NARRATIVE_REVIEW_NOT_APPROVED: 'Narrative result is not approved for downstream use',
  NARRATIVE_REVIEW_STALE: 'Stale narrative results cannot be reviewed or used',
  NARRATIVE_REVIEW_CONFLICT: 'Narrative review state conflicted with another change',
});

class NarrativeReviewError extends Error {
  constructor(code) {
    if (!Object.hasOwn(ERROR_MESSAGES, code)) throw new TypeError('Unknown narrative review error code');
    super(ERROR_MESSAGES[code]);
    this.name = 'NarrativeReviewError';
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

function narrativeReviewError(code) {
  return new NarrativeReviewError(code);
}

function isNarrativeReviewError(error) {
  return trustedErrors.has(error);
}

module.exports = {
  NarrativeReviewError,
  isNarrativeReviewError,
  narrativeReviewError,
};
