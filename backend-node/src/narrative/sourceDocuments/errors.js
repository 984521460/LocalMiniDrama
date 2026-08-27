const trustedErrors = new WeakSet();

const ERROR_MESSAGES = Object.freeze({
  SOURCE_DOCUMENT_INPUT_INVALID: 'Source document input is invalid',
  SOURCE_DOCUMENT_DATA_INVALID: 'Source document persisted data is invalid',
  SOURCE_DOCUMENT_LIMIT_EXCEEDED: 'Source document exceeds the supported structure limit',
  SOURCE_DOCUMENT_NOT_FOUND: 'Source document was not found',
  SOURCE_DRAMA_NOT_FOUND: 'Source document drama was not found',
  SOURCE_SELECTION_INVALID: 'Source selection range is invalid',
});

class SourceDocumentError extends Error {
  constructor(code) {
    if (!Object.hasOwn(ERROR_MESSAGES, code)) throw new TypeError('Unknown source document error code');
    super(ERROR_MESSAGES[code]);
    this.name = 'SourceDocumentError';
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

function sourceDocumentError(code) {
  return new SourceDocumentError(code);
}

function isSourceDocumentError(error) {
  return trustedErrors.has(error);
}

module.exports = {
  SourceDocumentError,
  isSourceDocumentError,
  sourceDocumentError,
};
