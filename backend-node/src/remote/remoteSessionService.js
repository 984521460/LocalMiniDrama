const {
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../repositories/v2/errors');
const {
  parseRemoteConnectionUid,
  remoteConnectionEvidenceSha256,
} = require('./connectionProfile');

const MESSAGES = Object.freeze({
  REMOTE_SESSION_INPUT_INVALID: 'Remote session request is invalid',
  REMOTE_CONNECTION_NOT_FOUND: 'Remote connection was not found',
  REMOTE_SESSION_NOT_READY: 'Remote connection host identity is not confirmed',
  REMOTE_SESSION_DATA_INVALID: 'Remote session persisted state is invalid',
  REMOTE_SESSION_CREDENTIAL_FAILED: 'Remote session credential access failed',
  REMOTE_SESSION_CONNECT_FAILED: 'Remote session connection failed',
  REMOTE_SESSION_TUNNEL_FAILED: 'Remote session tunnel failed',
  REMOTE_SESSION_UNEXPECTED: 'Remote session operation failed',
});
const trustedErrors = new WeakSet();

class RemoteSessionError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.REMOTE_SESSION_UNEXPECTED);
    this.name = 'RemoteSessionError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'REMOTE_SESSION_UNEXPECTED';
    trustedErrors.add(this);
    Object.freeze(this);
  }
}

function createError(code) {
  return new RemoteSessionError(code);
}

function isRemoteSessionError(error) {
  return trustedErrors.has(error);
}

function ownErrorCode(error) {
  try {
    return Object.getOwnPropertyDescriptor(error, 'code')?.value;
  } catch {
    return undefined;
  }
}

function translate(error, fallback) {
  if (isRemoteSessionError(error)) return error;
  if (error instanceof V2RepositoryNotFoundError) return createError('REMOTE_CONNECTION_NOT_FOUND');
  if (error instanceof V2RepositoryDataError) return createError('REMOTE_SESSION_DATA_INVALID');
  if (error instanceof TypeError) return createError('REMOTE_SESSION_INPUT_INVALID');
  const code = ownErrorCode(error);
  if (typeof code === 'string' && code.startsWith('CREDENTIAL_')) {
    return createError('REMOTE_SESSION_CREDENTIAL_FAILED');
  }
  return createError(fallback);
}

function isWellFormedSecretString(value) {
  if (value.length < 1 || value.length > 2560) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) return false;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isValidUtf8SecretBuffer(value) {
  if (value.length < 1 || value.length > 2560) return false;
  for (let index = 0; index < value.length;) {
    const first = value[index];
    if (first >= 0x01 && first <= 0x7f) {
      index += 1;
      continue;
    }
    let continuationCount;
    let secondMinimum = 0x80;
    let secondMaximum = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) {
      continuationCount = 1;
    } else if (first >= 0xe0 && first <= 0xef) {
      continuationCount = 2;
      if (first === 0xe0) secondMinimum = 0xa0;
      if (first === 0xed) secondMaximum = 0x9f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      continuationCount = 3;
      if (first === 0xf0) secondMinimum = 0x90;
      if (first === 0xf4) secondMaximum = 0x8f;
    } else {
      return false;
    }
    if (index + continuationCount >= value.length) return false;
    const second = value[index + 1];
    if (second < secondMinimum || second > secondMaximum) return false;
    for (let offset = 2; offset <= continuationCount; offset += 1) {
      const continuation = value[index + offset];
      if (continuation < 0x80 || continuation > 0xbf) return false;
    }
    index += continuationCount + 1;
  }
  return true;
}

function credentialBuffer(value) {
  if (Buffer.isBuffer(value)) {
    if (isValidUtf8SecretBuffer(value)) return value;
    value.fill(0);
    return null;
  }
  if (typeof value !== 'string' || !isWellFormedSecretString(value)) return null;
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= 2560) return bytes;
  bytes.fill(0);
  return null;
}

function createRemoteSessionService({ repository, vault, sshTransport, tunnelManager } = {}) {
  if (!repository || typeof repository !== 'object' || typeof repository.getConnection !== 'function'
    || !vault || typeof vault !== 'object' || typeof vault.read !== 'function'
    || !sshTransport || typeof sshTransport !== 'object' || typeof sshTransport.connect !== 'function'
    || !tunnelManager || typeof tunnelManager !== 'object' || typeof tunnelManager.open !== 'function') {
    throw new TypeError('Remote session dependencies are invalid');
  }

  async function openSession(uid, expectedEvidenceSha256) {
    let secret;
    try {
      const record = repository.getConnection(parseRemoteConnectionUid(uid));
      if (expectedEvidenceSha256 !== undefined
        && (typeof expectedEvidenceSha256 !== 'string'
          || !/^[0-9a-f]{64}$/u.test(expectedEvidenceSha256)
          || remoteConnectionEvidenceSha256(record) !== expectedEvidenceSha256)) {
        throw createError('REMOTE_SESSION_NOT_READY');
      }
      if (record.status !== 'ready' || record.hostFingerprint === null) {
        throw createError('REMOTE_SESSION_NOT_READY');
      }
      try {
        secret = credentialBuffer(await vault.read(record.credentialRef));
      } catch {
        throw createError('REMOTE_SESSION_CREDENTIAL_FAILED');
      }
      if (secret === null) {
        throw createError('REMOTE_SESSION_CREDENTIAL_FAILED');
      }
      let session;
      try {
        session = await sshTransport.connect({
          endpoint: Object.freeze({
            host: record.host,
            port: record.port,
            username: record.username,
          }),
          expectedFingerprint: record.hostFingerprint,
          secret,
        });
      } catch (error) {
        throw translate(error, 'REMOTE_SESSION_CONNECT_FAILED');
      }
      if (!session || typeof session !== 'object' || typeof session.close !== 'function') {
        throw createError('REMOTE_SESSION_CONNECT_FAILED');
      }
      return Object.freeze({ connection: record, session });
    } catch (error) {
      throw translate(error, 'REMOTE_SESSION_UNEXPECTED');
    } finally {
      secret?.fill?.(0);
    }
  }

  async function openComfyTunnel(uid) {
    const opened = await openSession(uid);
    try {
      return await tunnelManager.open({
        session: opened.session,
        remotePort: opened.connection.comfyPort,
      });
    } catch (error) {
      try { await opened.session.close(); } catch { /* bounded cleanup */ }
      throw translate(error, 'REMOTE_SESSION_TUNNEL_FAILED');
    }
  }

  return Object.freeze({ openComfyTunnel, openSession });
}

module.exports = {
  RemoteSessionError,
  createRemoteSessionService,
  isRemoteSessionError,
};
