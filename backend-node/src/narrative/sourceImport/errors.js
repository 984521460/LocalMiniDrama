const trustedErrors = new WeakSet();

const SOURCE_TEXT_ERROR_MESSAGES = Object.freeze({
  SOURCE_TEXT_FILE_INVALID: 'Source text file is invalid',
  SOURCE_TEXT_TYPE_UNSUPPORTED: 'Source text file type is unsupported',
  SOURCE_TEXT_FILE_TOO_LARGE: 'Source text file exceeds the configured size limit',
  SOURCE_TEXT_BINARY_REJECTED: 'Source text file contains binary content',
  SOURCE_TEXT_ENCODING_REQUIRED: 'Source text file encoding requires user selection',
  SOURCE_TEXT_ENCODING_UNSUPPORTED: 'Source text file encoding is unsupported',
  SOURCE_TEXT_DECODE_FAILED: 'Source text file could not be decoded safely',
});

class SourceTextImportError extends Error {
  constructor(code) {
    if (!Object.hasOwn(SOURCE_TEXT_ERROR_MESSAGES, code)) {
      throw new TypeError('Unknown source text import error code');
    }
    super(SOURCE_TEXT_ERROR_MESSAGES[code]);
    this.name = 'SourceTextImportError';
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

function sourceTextImportError(code) {
  return new SourceTextImportError(code);
}

function isSourceTextImportError(error) {
  return trustedErrors.has(error);
}

module.exports = {
  SourceTextImportError,
  isSourceTextImportError,
  sourceTextImportError,
};
