const { randomUUID } = require('node:crypto');

const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../repositories/v2/errors');
const {
  createRemoteConnectionRequest,
  createRemoteConnectionUpdateRequest,
  createRemoteCredentialReplacementRequest,
  parseRemoteConnectionUid,
  publicRemoteConnection,
} = require('./connectionProfile');

const trustedErrors = new WeakMap();
const MESSAGES = Object.freeze({
  REMOTE_CONNECTION_INPUT_INVALID: 'Remote connection request is invalid',
  REMOTE_CONNECTION_NOT_FOUND: 'Remote connection was not found',
  REMOTE_CONNECTION_CONFLICT: 'Remote connection state conflict',
  REMOTE_CONNECTION_DATA_INVALID: 'Remote connection persisted state is invalid',
  REMOTE_CREDENTIAL_OPERATION_FAILED: 'Remote credential operation failed',
  REMOTE_CREDENTIAL_CLEANUP_REQUIRED: 'Remote credential cleanup is required',
  REMOTE_CONNECTION_UNEXPECTED: 'Remote connection operation failed',
});

class RemoteConnectionError extends Error {
  constructor(code, credentialRef) {
    super(MESSAGES[code] || MESSAGES.REMOTE_CONNECTION_UNEXPECTED);
    this.name = 'RemoteConnectionError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'REMOTE_CONNECTION_UNEXPECTED';
    if (credentialRef) this.credentialRef = credentialRef;
    trustedErrors.set(this, Object.freeze({ code: this.code, credentialRef }));
    Object.freeze(this);
  }
}

function createError(code, credentialRef) {
  return new RemoteConnectionError(code, credentialRef);
}

function isRemoteConnectionError(error) {
  return trustedErrors.has(error);
}

function ownErrorCode(error) {
  try {
    return Object.getOwnPropertyDescriptor(error, 'code')?.value;
  } catch {
    return undefined;
  }
}

function translateError(error) {
  if (isRemoteConnectionError(error)) return error;
  if (error instanceof V2RepositoryNotFoundError) return createError('REMOTE_CONNECTION_NOT_FOUND');
  if (error instanceof V2RepositoryConflictError) return createError('REMOTE_CONNECTION_CONFLICT');
  if (error instanceof V2RepositoryDataError) return createError('REMOTE_CONNECTION_DATA_INVALID');
  if (error instanceof TypeError) return createError('REMOTE_CONNECTION_INPUT_INVALID');
  const code = ownErrorCode(error);
  if (typeof code === 'string' && code.startsWith('CREDENTIAL_')) {
    return createError('REMOTE_CREDENTIAL_OPERATION_FAILED');
  }
  return createError('REMOTE_CONNECTION_UNEXPECTED');
}

function validateDependencies(repository, vault, createUid) {
  if (!repository || typeof repository !== 'object'
    || typeof repository.createConnection !== 'function'
    || typeof repository.getConnection !== 'function'
    || typeof repository.listConnections !== 'function'
    || typeof repository.replaceCredential !== 'function'
    || typeof repository.updateConnection !== 'function'
    || !vault || typeof vault !== 'object'
    || typeof vault.store !== 'function'
    || typeof vault.inspect !== 'function'
    || typeof vault.remove !== 'function'
    || typeof createUid !== 'function') {
    throw new TypeError('Remote connection service dependencies are invalid');
  }
}

function createRemoteConnectionService({ repository, vault, createUid = randomUUID } = {}) {
  validateDependencies(repository, vault, createUid);

  async function credentialState(record) {
    try {
      const descriptor = await vault.inspect(record.credentialRef);
      return { kind: descriptor.kind, configured: descriptor.configured };
    } catch (error) {
      if (ownErrorCode(error) === 'CREDENTIAL_NOT_FOUND') {
        return { kind: 'ssh_password', configured: false };
      }
      throw translateError(error);
    }
  }

  async function expose(record) {
    return publicRemoteConnection(record, await credentialState(record));
  }

  async function removeAndConfirm(ref) {
    try {
      await vault.remove(ref);
    } catch {
      // A failed bridge response is indeterminate until the vault is inspected.
    }
    try {
      await vault.inspect(ref);
      return false;
    } catch (error) {
      return ownErrorCode(error) === 'CREDENTIAL_NOT_FOUND';
    }
  }

  async function create(value) {
    let descriptor;
    try {
      const input = createRemoteConnectionRequest(value);
      descriptor = await vault.store({ kind: 'ssh_password', secret: input.secret });
      const record = repository.createConnection({
        uid: createUid(),
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username,
        hostFingerprint: null,
        credentialRef: descriptor.ref,
        status: 'unverified',
        authMethod: input.authMethod,
        comfyHost: input.comfyHost,
        comfyPort: input.comfyPort,
        remoteWorkDir: input.remoteWorkDir,
      });
      return publicRemoteConnection(record, { kind: descriptor.kind, configured: descriptor.configured });
    } catch (error) {
      if (descriptor?.ref) {
        const cleaned = await removeAndConfirm(descriptor.ref);
        if (!cleaned) throw createError('REMOTE_CREDENTIAL_CLEANUP_REQUIRED', descriptor.ref);
      }
      throw translateError(error);
    }
  }

  async function get(uid) {
    try {
      return await expose(repository.getConnection(parseRemoteConnectionUid(uid)));
    } catch (error) {
      throw translateError(error);
    }
  }

  async function list() {
    try {
      return await Promise.all(repository.listConnections().map(expose));
    } catch (error) {
      throw translateError(error);
    }
  }

  async function update(uid, value) {
    try {
      const input = createRemoteConnectionUpdateRequest(value);
      return await expose(repository.updateConnection({ uid: parseRemoteConnectionUid(uid), ...input }));
    } catch (error) {
      throw translateError(error);
    }
  }

  async function replaceCredential(uid, value) {
    let descriptor;
    let persisted = false;
    try {
      const connectionUid = parseRemoteConnectionUid(uid);
      const input = createRemoteCredentialReplacementRequest(value);
      const current = repository.getConnection(connectionUid);
      if (current.stateVersion !== input.expectedStateVersion) {
        throw createError('REMOTE_CONNECTION_CONFLICT');
      }
      descriptor = await vault.store({ kind: 'ssh_password', secret: input.secret });
      const record = repository.replaceCredential({
        uid: connectionUid,
        expectedStateVersion: input.expectedStateVersion,
        credentialRef: descriptor.ref,
      });
      persisted = true;
      if (!await removeAndConfirm(current.credentialRef)) {
        throw createError('REMOTE_CREDENTIAL_CLEANUP_REQUIRED', current.credentialRef);
      }
      return publicRemoteConnection(record, {
        kind: descriptor.kind,
        configured: descriptor.configured,
      });
    } catch (error) {
      if (!persisted && descriptor?.ref && !await removeAndConfirm(descriptor.ref)) {
        throw createError('REMOTE_CREDENTIAL_CLEANUP_REQUIRED', descriptor.ref);
      }
      throw translateError(error);
    }
  }

  return Object.freeze({ create, get, list, replaceCredential, update });
}

module.exports = {
  RemoteConnectionError,
  createRemoteConnectionService,
  isRemoteConnectionError,
};
