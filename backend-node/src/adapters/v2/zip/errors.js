const trustedErrors = new WeakSet();

const ERROR_MESSAGES = Object.freeze({
  PROJECT_ARCHIVE_INVALID: 'Project archive is invalid',
  PROJECT_ARCHIVE_UNSAFE_PATH: 'Project archive contains an unsafe entry path',
  PROJECT_ARCHIVE_LIMIT_EXCEEDED: 'Project archive exceeds the supported safety limits',
  PROJECT_ARCHIVE_MANIFEST_INVALID: 'Project archive manifest is invalid or unsupported',
  PROJECT_ARCHIVE_SECRET_DETECTED: 'Project archive contains credential-shaped project data',
  PROJECT_ARCHIVE_UID_CONFLICT: 'Project archive identifiers conflict with existing project data',
});

class ProjectArchiveError extends Error {
  constructor(code) {
    if (!Object.hasOwn(ERROR_MESSAGES, code)) throw new TypeError('Unknown project archive error code');
    super(ERROR_MESSAGES[code]);
    this.name = 'ProjectArchiveError';
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

function archiveError(code) {
  return new ProjectArchiveError(code);
}

function isProjectArchiveError(error) {
  return trustedErrors.has(error);
}

module.exports = {
  ProjectArchiveError,
  archiveError,
  isProjectArchiveError,
};
