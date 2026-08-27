const DEFINITIONS = Object.freeze({
  V2_COMPATIBILITY_MAPPING_FAILED: 'The legacy value cannot be mapped safely',
  V2_COMPATIBILITY_STORAGE_FAILED: 'The compatibility data source is unavailable',
});

class V2CompatibilityError extends Error {
  constructor(code) {
    const message = DEFINITIONS[code];
    if (!message) throw new TypeError('Unknown compatibility error code');
    super(message);
    this.name = 'V2CompatibilityError';
    Object.defineProperty(this, 'code', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: code,
    });
    Object.freeze(this);
  }
}

function createCompatibilityError(code = 'V2_COMPATIBILITY_MAPPING_FAILED') {
  return new V2CompatibilityError(code);
}

module.exports = {
  V2CompatibilityError,
  createCompatibilityError,
};
