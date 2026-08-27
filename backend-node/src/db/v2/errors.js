class V2MigrationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'V2MigrationError';
    this.code = code;
  }
}

function migrationError(code, message, cause) {
  return new V2MigrationError(code, message, { cause });
}

module.exports = {
  V2MigrationError,
  migrationError,
};
