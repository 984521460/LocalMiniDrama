const express = require('express');
const { types: { isPromise, isProxy } } = require('node:util');

const response = require('../../response');
const { WindowsCredentialVault } = require('../../adapters/v2/credentials');
const { raceNativePromise } = require('../../integrations/comfyui/asyncControl');
const { createRemoteConnectionService, isRemoteConnectionError } = require('../../remote/connectionService');
const { parseRemoteConnectionUid } = require('../../remote/connectionProfile');
const {
  RemoteSessionError,
  createRemoteSessionService,
  isRemoteSessionError,
} = require('../../remote/remoteSessionService');
const {
  createRemoteHostIdentityService,
  isRemoteHostIdentityError,
  remoteHostIdentityErrorDetails,
} = require('../../remote/hostIdentity');
const { createSshTransport } = require('../../remote/sshTransport');
const { createSshTunnelManager } = require('../../remote/sshTunnel');
const { createV2Repositories } = require('../../repositories/v2');

const STATUS_BY_CODE = Object.freeze({
  REMOTE_CONNECTION_INPUT_INVALID: 400,
  REMOTE_CONNECTION_NOT_FOUND: 404,
  REMOTE_CONNECTION_CONFLICT: 409,
  REMOTE_CONNECTION_DATA_INVALID: 500,
  REMOTE_CREDENTIAL_OPERATION_FAILED: 500,
  REMOTE_CREDENTIAL_CLEANUP_REQUIRED: 500,
  REMOTE_CONNECTION_UNEXPECTED: 500,
  REMOTE_HOST_IDENTITY_INPUT_INVALID: 400,
  REMOTE_HOST_IDENTITY_DATA_INVALID: 500,
  REMOTE_HOST_PROBE_FAILED: 502,
  REMOTE_HOST_FINGERPRINT_MISMATCH: 409,
  REMOTE_HOST_FINGERPRINT_CHANGED: 409,
  REMOTE_HOST_IDENTITY_UNEXPECTED: 500,
  REMOTE_SESSION_INPUT_INVALID: 400,
  REMOTE_SESSION_NOT_READY: 409,
  REMOTE_SESSION_DATA_INVALID: 500,
  REMOTE_SESSION_CREDENTIAL_FAILED: 502,
  REMOTE_SESSION_CONNECT_FAILED: 502,
  REMOTE_SESSION_TUNNEL_FAILED: 502,
  REMOTE_SESSION_UNEXPECTED: 500,
});

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u;
const promiseThen = Promise.prototype.then;
const DEFAULT_EXPERT_TUNNEL_TIMEOUT_MS = 30_000;

function isExactEmptyObject(value) {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return (prototype === Object.prototype || prototype === null)
      && Reflect.ownKeys(descriptors).length === 0;
  } catch {
    return false;
  }
}

function expertTunnelSnapshot(value, connectionUid) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    return Object.freeze({ handle: null, close: null, target: null });
  }
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return Object.freeze({ handle: null, close: null, target: null });
  }
  const closeDescriptor = descriptors.close;
  const safeClose = closeDescriptor && Object.hasOwn(closeDescriptor, 'value')
    && typeof closeDescriptor.value === 'function' && !isProxy(closeDescriptor.value)
    ? closeDescriptor.value
    : null;
  const keys = Reflect.ownKeys(descriptors);
  const expected = ['host', 'port', 'origin', 'close'];
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== expected.length
    || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    return Object.freeze({ handle: null, close: safeClose, target: value });
  }
  const snapshot = Object.create(null);
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return Object.freeze({ handle: null, close: safeClose, target: value });
    }
    snapshot[key] = descriptor.value;
  }
  const match = typeof snapshot.origin === 'string' ? LOOPBACK_ORIGIN.exec(snapshot.origin) : null;
  const originPort = match ? Number(match[1]) : NaN;
  if (snapshot.host !== '127.0.0.1'
    || !Number.isInteger(snapshot.port) || snapshot.port < 1 || snapshot.port > 65535
    || originPort !== snapshot.port || typeof snapshot.close !== 'function' || isProxy(snapshot.close)) {
    return Object.freeze({ handle: null, close: safeClose, target: value });
  }
  const handle = Object.freeze({
    publicValue: Object.freeze({
      contractVersion: 'remote-expert-tunnel.v1',
      connectionUid,
      status: 'ready',
      origin: snapshot.origin,
    }),
    close: snapshot.close,
    target: value,
  });
  return Object.freeze({ handle, close: snapshot.close, target: value });
}

async function closeTunnelHandle(close, target) {
  let result;
  try { result = Reflect.apply(close, target, []); } catch {
    throw new RemoteSessionError('REMOTE_SESSION_TUNNEL_FAILED');
  }
  if (result === undefined) return;
  try { await raceNativePromise(result, { timeoutMs: 30_000 }); } catch {
    throw new RemoteSessionError('REMOTE_SESSION_TUNNEL_FAILED');
  }
}

async function expertTunnelHandle(value, connectionUid) {
  const candidate = expertTunnelSnapshot(value, connectionUid);
  if (candidate.handle) return candidate.handle;
  if (candidate.close) {
    try { await closeTunnelHandle(candidate.close, candidate.target); } catch {
      throw new RemoteSessionError('REMOTE_SESSION_TUNNEL_FAILED');
    }
  }
  throw new RemoteSessionError('REMOTE_SESSION_TUNNEL_FAILED');
}

function isExactNativePromise(value) {
  if (!isPromise(value) || isProxy(value)) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.getPrototypeOf(value) === Promise.prototype
      && !Object.hasOwn(descriptors, 'then')
      && !Object.hasOwn(descriptors, 'constructor');
  } catch {
    return false;
  }
}

function expertTunnelTimeout(runtime) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(runtime, 'expertTunnelTimeoutMs'); } catch {
    return null;
  }
  if (!descriptor) return DEFAULT_EXPERT_TUNNEL_TIMEOUT_MS;
  if (!Object.hasOwn(descriptor, 'value')
    || !Number.isSafeInteger(descriptor.value)
    || descriptor.value < 1 || descriptor.value > 300_000) return null;
  return descriptor.value;
}

function createExpertTunnelOperation(serviceHandle, connectionEvidence, timeoutMs) {
  const connectionUid = connectionEvidence.uid;
  let resolvePublic;
  let rejectPublic;
  const operation = {
    closePromise: null,
    cleanupRequired: false,
    connectionEvidence,
    disposed: false,
    handle: null,
    settled: false,
    timer: null,
    promise: new Promise((resolve, reject) => {
      resolvePublic = resolve;
      rejectPublic = reject;
    }),
  };

  const settle = (callback, value) => {
    if (operation.settled) return;
    operation.settled = true;
    if (operation.timer !== null) clearTimeout(operation.timer);
    callback(value);
  };
  operation.dispose = (error) => {
    operation.disposed = true;
    settle(rejectPublic, error);
  };

  let pending;
  try { pending = Reflect.apply(serviceHandle.open, serviceHandle.target, [connectionUid]); } catch {
    operation.dispose(new RemoteSessionError('REMOTE_SESSION_TUNNEL_FAILED'));
    return operation;
  }
  if (!isExactNativePromise(pending)) {
    operation.dispose(new RemoteSessionError('REMOTE_SESSION_TUNNEL_FAILED'));
    return operation;
  }

  operation.timer = setTimeout(() => {
    operation.dispose(new RemoteSessionError('REMOTE_SESSION_TUNNEL_FAILED'));
  }, timeoutMs);

  const acceptLateSafe = async (value) => {
    try {
      const handle = await expertTunnelHandle(value, connectionUid);
      if (operation.disposed) {
        try { await closeTunnelHandle(handle.close, handle.target); } catch { /* fixed failure already returned */ }
        return;
      }
      operation.handle = handle;
      settle(resolvePublic, handle);
    } catch (error) {
      settle(
        rejectPublic,
        isRemoteSessionError(error)
          ? error
          : new RemoteSessionError('REMOTE_SESSION_TUNNEL_FAILED'),
      );
    }
  };
  Reflect.apply(promiseThen, pending, [
    (value) => { void acceptLateSafe(value); },
    () => settle(rejectPublic, new RemoteSessionError('REMOTE_SESSION_TUNNEL_FAILED')),
  ]);
  return operation;
}

function expertSessionHandle(value) {
  if (value === null || typeof value !== 'object' || isProxy(value)) return null;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, 'openComfyTunnel'); } catch {
    return null;
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')
    || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) return null;
  return Object.freeze({ target: value, open: descriptor.value });
}

function expertConnectionUid(value) {
  try { return parseRemoteConnectionUid(value); } catch {
    throw new RemoteSessionError('REMOTE_SESSION_INPUT_INVALID');
  }
}

function sameExpertConnection(left, right) {
  return right.status === 'ready'
    && right.hostFingerprint !== null
    && right.uid === left.uid
    && right.stateVersion === left.stateVersion
    && right.host === left.host
    && right.port === left.port
    && right.username === left.username
    && right.hostFingerprint === left.hostFingerprint
    && right.comfyHost === left.comfyHost
    && right.comfyPort === left.comfyPort
    && right.credentialConfigured === left.credentialConfigured;
}

function expertConnectionEvidence(connection) {
  return Object.freeze({
    uid: connection.uid,
    stateVersion: connection.stateVersion,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    hostFingerprint: connection.hostFingerprint,
    comfyHost: connection.comfyHost,
    comfyPort: connection.comfyPort,
    credentialConfigured: connection.credentialConfigured,
  });
}

function remoteConnectionRoutes(log, runtime = {}, database) {
  const router = express.Router();
  let service = null;
  let hostIdentityService = null;
  let expertSessionService = null;
  const expertTunnelTimeoutMs = expertTunnelTimeout(runtime);
  const activeExpertTunnels = new Map();
  if (database) {
    const repository = createV2Repositories(database).remote;
    const credentialVault = runtime.credentialVault || new WindowsCredentialVault();
    const sshTransport = runtime.sshTransport || createSshTransport();
    service = createRemoteConnectionService({
      repository,
      vault: credentialVault,
      ...(typeof runtime.createUid === 'function' ? { createUid: runtime.createUid } : {}),
    });
    hostIdentityService = createRemoteHostIdentityService({
      repository,
      probeHostIdentity: typeof runtime.probeHostIdentity === 'function'
        ? runtime.probeHostIdentity
        : sshTransport.probeHostIdentity,
    });
    try {
      expertSessionService = expertSessionHandle(runtime.remoteSessionService || createRemoteSessionService({
        repository,
        vault: credentialVault,
        sshTransport,
        tunnelManager: runtime.tunnelManager || createSshTunnelManager(),
      }));
      if (expertTunnelTimeoutMs === null) expertSessionService = null;
    } catch {
      expertSessionService = null;
    }
  }

  function unavailable(res) {
    return response.error(
      res,
      503,
      'REMOTE_CONNECTION_STATE_UNAVAILABLE',
      'Remote connection state is unavailable',
    );
  }

  async function closeExpertTunnel(connectionUid) {
    const operation = activeExpertTunnels.get(connectionUid);
    if (!operation) return;
    operation.dispose(new RemoteSessionError('REMOTE_SESSION_NOT_READY'));
    if (!operation.handle) {
      if (activeExpertTunnels.get(connectionUid) === operation) {
        activeExpertTunnels.delete(connectionUid);
      }
      return;
    }
    operation.cleanupRequired = true;
    if (operation.closePromise) {
      await operation.closePromise;
      return;
    }
    const closeAttempt = (async () => {
      await closeTunnelHandle(operation.handle.close, operation.handle.target);
      operation.cleanupRequired = false;
      operation.handle = null;
      if (activeExpertTunnels.get(connectionUid) === operation) {
        activeExpertTunnels.delete(connectionUid);
      }
    })();
    operation.closePromise = closeAttempt;
    try {
      await closeAttempt;
    } catch {
      if (operation.closePromise === closeAttempt) operation.closePromise = null;
      throw new RemoteSessionError('REMOTE_SESSION_TUNNEL_FAILED');
    }
  }

  function handleError(res, error, event) {
    if (isRemoteConnectionError(error)) {
      const status = STATUS_BY_CODE[error.code] || 500;
      const details = error.code === 'REMOTE_CREDENTIAL_CLEANUP_REQUIRED'
        ? { credential_ref: error.credentialRef }
        : undefined;
      if (status >= 500) log?.error?.(event, { code: error.code });
      return response.error(res, status, error.code, error.message, details);
    }
    if (isRemoteHostIdentityError(error)) {
      const status = STATUS_BY_CODE[error.code] || 500;
      if (status >= 500) log?.error?.(event, { code: error.code });
      return response.error(
        res,
        status,
        error.code,
        error.message,
        remoteHostIdentityErrorDetails(error),
      );
    }
    if (isRemoteSessionError(error)) {
      const status = STATUS_BY_CODE[error.code] || 500;
      if (status >= 500) log?.error?.(event, { code: error.code });
      return response.error(res, status, error.code, error.message);
    }
    log?.error?.(event, { code: 'REMOTE_CONNECTION_UNEXPECTED' });
    return response.error(
      res,
      500,
      'REMOTE_CONNECTION_UNEXPECTED',
      'Remote connection operation failed',
    );
  }

  router.post('/remote-connections', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.created(res, await service.create(req.body));
    } catch (error) {
      return handleError(res, error, 'remote-connection-create');
    }
  });

  router.get('/remote-connections', async (_req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(res, await service.list());
    } catch (error) {
      return handleError(res, error, 'remote-connection-list');
    }
  });

  router.get('/remote-connections/:connectionUid', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(res, await service.get(req.params.connectionUid));
    } catch (error) {
      return handleError(res, error, 'remote-connection-detail');
    }
  });

  router.put('/remote-connections/:connectionUid', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      const updated = await service.update(req.params.connectionUid, req.body);
      await closeExpertTunnel(updated.uid);
      return response.success(res, updated);
    } catch (error) {
      return handleError(res, error, 'remote-connection-update');
    }
  });

  router.put('/remote-connections/:connectionUid/credential', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      const updated = await service.replaceCredential(req.params.connectionUid, req.body);
      await closeExpertTunnel(updated.uid);
      return response.success(res, updated);
    } catch (error) {
      return handleError(res, error, 'remote-connection-credential-replace');
    }
  });

  router.post('/remote-connections/:connectionUid/host-identity/probe', async (req, res) => {
    if (!hostIdentityService) return unavailable(res);
    try {
      return response.success(res, await hostIdentityService.probe(req.params.connectionUid));
    } catch (error) {
      if (isRemoteHostIdentityError(error)
        && error.code === 'REMOTE_HOST_FINGERPRINT_CHANGED') {
        try { await closeExpertTunnel(expertConnectionUid(req.params.connectionUid)); } catch (closeError) {
          return handleError(res, closeError, 'remote-expert-tunnel-close-after-host-change');
        }
      }
      return handleError(res, error, 'remote-host-identity-probe');
    }
  });

  router.post('/remote-connections/:connectionUid/host-identity/confirm', async (req, res) => {
    if (!hostIdentityService) return unavailable(res);
    try {
      const confirmed = await hostIdentityService.confirm(req.params.connectionUid, req.body);
      await closeExpertTunnel(expertConnectionUid(req.params.connectionUid));
      return response.success(res, confirmed);
    } catch (error) {
      if (isRemoteHostIdentityError(error)
        && error.code === 'REMOTE_HOST_FINGERPRINT_CHANGED') {
        try { await closeExpertTunnel(expertConnectionUid(req.params.connectionUid)); } catch (closeError) {
          return handleError(res, closeError, 'remote-expert-tunnel-close-after-host-change');
        }
      }
      return handleError(res, error, 'remote-host-identity-confirm');
    }
  });

  router.post('/remote-connections/:connectionUid/expert-tunnel', async (req, res) => {
    if (!expertSessionService) return unavailable(res);
    if (!isExactEmptyObject(req.body)) {
      return response.error(
        res,
        400,
        'REMOTE_SESSION_INPUT_INVALID',
        'Remote session request is invalid',
      );
    }
    try {
      const connectionUid = expertConnectionUid(req.params.connectionUid);
      const connection = await service.get(connectionUid);
      if (connection.status !== 'ready' || connection.hostFingerprint === null) {
        await closeExpertTunnel(connectionUid);
        throw new RemoteSessionError('REMOTE_SESSION_NOT_READY');
      }
      let operation = activeExpertTunnels.get(connectionUid);
      if (operation && (operation.disposed || operation.cleanupRequired)) {
        await closeExpertTunnel(connectionUid);
        throw new RemoteSessionError('REMOTE_SESSION_NOT_READY');
      }
      if (operation && !sameExpertConnection(operation.connectionEvidence, connection)) {
        await closeExpertTunnel(connectionUid);
        throw new RemoteSessionError('REMOTE_SESSION_NOT_READY');
      }
      if (!operation) {
        operation = createExpertTunnelOperation(
          expertSessionService,
          expertConnectionEvidence(connection),
          expertTunnelTimeoutMs,
        );
        activeExpertTunnels.set(connectionUid, operation);
        Reflect.apply(promiseThen, operation.promise, [undefined, () => {
          if (activeExpertTunnels.get(connectionUid) === operation) {
            activeExpertTunnels.delete(connectionUid);
          }
        }]);
      }
      const handle = await operation.promise;
      let currentConnection;
      try {
        currentConnection = await service.get(connectionUid);
      } catch (error) {
        await closeExpertTunnel(connectionUid);
        throw error;
      }
      if (activeExpertTunnels.get(connectionUid) !== operation
        || !sameExpertConnection(operation.connectionEvidence, currentConnection)) {
        await closeExpertTunnel(connectionUid);
        throw new RemoteSessionError('REMOTE_SESSION_NOT_READY');
      }
      return response.success(res, handle.publicValue);
    } catch (error) {
      return handleError(res, error, 'remote-expert-tunnel-open');
    }
  });

  router.delete('/remote-connections/:connectionUid/expert-tunnel', async (req, res) => {
    if (!expertSessionService) return unavailable(res);
    try {
      const connectionUid = expertConnectionUid(req.params.connectionUid);
      await closeExpertTunnel(connectionUid);
      return response.success(res, Object.freeze({
        contractVersion: 'remote-expert-tunnel.v1',
        connectionUid,
        status: 'closed',
      }));
    } catch (error) {
      return handleError(res, error, 'remote-expert-tunnel-close');
    }
  });

  return router;
}

module.exports = remoteConnectionRoutes;
