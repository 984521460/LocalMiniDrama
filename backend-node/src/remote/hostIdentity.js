const { types: { isProxy } } = require('node:util');

const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../repositories/v2/errors');
const {
  parseRemoteConnectionUid,
  parseRemoteHostFingerprint,
} = require('./connectionProfile');

const ALGORITHMS = new Set([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'rsa-sha2-256',
  'rsa-sha2-512',
  'ssh-rsa',
]);
const MESSAGES = Object.freeze({
  REMOTE_HOST_IDENTITY_INPUT_INVALID: 'Remote host identity request is invalid',
  REMOTE_CONNECTION_NOT_FOUND: 'Remote connection was not found',
  REMOTE_CONNECTION_CONFLICT: 'Remote connection state conflict',
  REMOTE_HOST_IDENTITY_DATA_INVALID: 'Remote host identity state is invalid',
  REMOTE_HOST_PROBE_FAILED: 'Remote host identity probe failed',
  REMOTE_HOST_FINGERPRINT_MISMATCH: 'Observed host fingerprint does not match the confirmation',
  REMOTE_HOST_FINGERPRINT_CHANGED: 'Remote host fingerprint changed',
  REMOTE_HOST_IDENTITY_UNEXPECTED: 'Remote host identity operation failed',
});
const trustedErrors = new WeakMap();

function fail() {
  throw new TypeError('Remote host identity value is invalid');
}

function exactObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail();
  }
  if (prototype !== Object.prototype && prototype !== null) fail();
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) fail();
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    output[key] = descriptor.value;
  }
  return output;
}

function stateVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) fail();
  return value;
}

function algorithm(value) {
  if (typeof value !== 'string' || !ALGORITHMS.has(value)) fail();
  return value;
}

function createHostIdentityConfirmationRequest(value) {
  const input = exactObject(value, ['expectedStateVersion', 'fingerprint']);
  return Object.freeze({
    expectedStateVersion: stateVersion(input.expectedStateVersion),
    fingerprint: parseRemoteHostFingerprint(input.fingerprint),
  });
}

function parseObservation(value) {
  const input = exactObject(value, ['algorithm', 'fingerprint']);
  return Object.freeze({
    algorithm: algorithm(input.algorithm),
    fingerprint: parseRemoteHostFingerprint(input.fingerprint),
  });
}

function candidate(record, observation, status) {
  return Object.freeze({
    connectionUid: record.uid,
    algorithm: observation.algorithm,
    fingerprint: observation.fingerprint,
    stateVersion: record.stateVersion,
    requiresConfirmation: status === 'pending',
    status,
  });
}

class RemoteHostIdentityError extends Error {
  constructor(code, details) {
    super(MESSAGES[code] || MESSAGES.REMOTE_HOST_IDENTITY_UNEXPECTED);
    this.name = 'RemoteHostIdentityError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'REMOTE_HOST_IDENTITY_UNEXPECTED';
    trustedErrors.set(this, Object.freeze({
      code: this.code,
      details: details ? Object.freeze({ ...details }) : undefined,
    }));
    Object.freeze(this);
  }
}

function createError(code, details) {
  return new RemoteHostIdentityError(code, details);
}

function isRemoteHostIdentityError(error) {
  return trustedErrors.has(error);
}

function remoteHostIdentityErrorDetails(error) {
  return trustedErrors.get(error)?.details;
}

function translateError(error) {
  if (isRemoteHostIdentityError(error)) return error;
  if (error instanceof V2RepositoryNotFoundError) return createError('REMOTE_CONNECTION_NOT_FOUND');
  if (error instanceof V2RepositoryConflictError) return createError('REMOTE_CONNECTION_CONFLICT');
  if (error instanceof V2RepositoryDataError) return createError('REMOTE_HOST_IDENTITY_DATA_INVALID');
  if (error instanceof TypeError) return createError('REMOTE_HOST_IDENTITY_INPUT_INVALID');
  return createError('REMOTE_HOST_IDENTITY_UNEXPECTED');
}

function validateDependencies(repository, probeHostIdentity) {
  if (!repository || typeof repository !== 'object'
    || typeof repository.getConnection !== 'function'
    || typeof repository.confirmHostFingerprint !== 'function'
    || typeof repository.markHostFingerprintChanged !== 'function'
    || typeof probeHostIdentity !== 'function') {
    throw new TypeError('Remote host identity dependencies are invalid');
  }
}

function createRemoteHostIdentityService({ repository, probeHostIdentity } = {}) {
  validateDependencies(repository, probeHostIdentity);

  async function observe(record) {
    let raw;
    try {
      raw = await probeHostIdentity(Object.freeze({
        host: record.host,
        port: record.port,
        username: record.username,
      }));
    } catch {
      throw createError('REMOTE_HOST_PROBE_FAILED');
    }
    try {
      return parseObservation(raw);
    } catch {
      throw createError('REMOTE_HOST_IDENTITY_DATA_INVALID');
    }
  }

  async function detectChanged(record, observation) {
    const changed = record.status === 'changed' ? record : repository.markHostFingerprintChanged({
      uid: record.uid,
      expectedStateVersion: record.stateVersion,
      expectedFingerprint: record.hostFingerprint,
    });
    throw createError('REMOTE_HOST_FINGERPRINT_CHANGED', {
      algorithm: observation.algorithm,
      expectedFingerprint: record.hostFingerprint,
      observedFingerprint: observation.fingerprint,
      stateVersion: changed.stateVersion,
    });
  }

  async function probe(uid) {
    try {
      const record = repository.getConnection(parseRemoteConnectionUid(uid));
      const observation = await observe(record);
      if (record.hostFingerprint === null) return candidate(record, observation, 'pending');
      if (record.status === 'changed' && record.hostFingerprint === observation.fingerprint) {
        return candidate(record, observation, 'pending');
      }
      if (record.hostFingerprint === observation.fingerprint && record.status !== 'changed') {
        return candidate(record, observation, 'confirmed');
      }
      return await detectChanged(record, observation);
    } catch (error) {
      throw translateError(error);
    }
  }

  async function confirm(uid, value) {
    try {
      const connectionUid = parseRemoteConnectionUid(uid);
      const input = createHostIdentityConfirmationRequest(value);
      const record = repository.getConnection(connectionUid);
      if (record.stateVersion !== input.expectedStateVersion) {
        throw createError('REMOTE_CONNECTION_CONFLICT');
      }
      const observation = await observe(record);
      if (record.hostFingerprint !== null && record.hostFingerprint !== observation.fingerprint) {
        return await detectChanged(record, observation);
      }
      if (observation.fingerprint !== input.fingerprint) {
        throw createError('REMOTE_HOST_FINGERPRINT_MISMATCH', {
          algorithm: observation.algorithm,
          observedFingerprint: observation.fingerprint,
          stateVersion: record.stateVersion,
        });
      }
      if (record.hostFingerprint === observation.fingerprint && record.status !== 'changed') {
        return candidate(record, observation, 'confirmed');
      }
      const confirmed = repository.confirmHostFingerprint({
        uid: connectionUid,
        expectedStateVersion: input.expectedStateVersion,
        fingerprint: input.fingerprint,
      });
      return candidate(confirmed, observation, 'confirmed');
    } catch (error) {
      throw translateError(error);
    }
  }

  return Object.freeze({ confirm, probe });
}

module.exports = {
  RemoteHostIdentityError,
  createHostIdentityConfirmationRequest,
  createRemoteHostIdentityService,
  isRemoteHostIdentityError,
  remoteHostIdentityErrorDetails,
};
