const trustedErrors = new WeakSet();

const ERROR_MESSAGES = Object.freeze({
  SOURCE_STRUCTURE_INVALID: 'Source text structure input is invalid',
  SOURCE_STRUCTURE_LIMIT_EXCEEDED: 'Source text structure exceeds the supported limit',
  SOURCE_STRUCTURE_OFFSET_INVALID: 'Source text structure offset is invalid',
});

class SourceStructureError extends Error {
  constructor(code) {
    if (!Object.hasOwn(ERROR_MESSAGES, code)) throw new TypeError('Unknown source structure error code');
    super(ERROR_MESSAGES[code]);
    this.name = 'SourceStructureError';
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

function sourceStructureError(code) {
  return new SourceStructureError(code);
}

function isSourceStructureError(error) {
  return trustedErrors.has(error);
}

module.exports = {
  isSourceStructureError,
  sourceStructureError,
};
