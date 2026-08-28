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
        secret = await vault.read(record.credentialRef);
      } catch (error) {
        throw translate(error, 'REMOTE_SESSION_CREDENTIAL_FAILED');
      }
      if (!Buffer.isBuffer(secret) || secret.length < 1 || secret.length > 2560) {
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
