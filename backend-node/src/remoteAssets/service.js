'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { LocalStorageProvider } = require('../adapters/v2/storage/localStorageProvider');
const { MAX_IMAGE_BYTES } = require('../characterCandidates/execution/boundedImageSource');
const { createCharacterCandidateImageNormalizer } = require('../characterCandidates/execution/imageNormalizer');
const {
  CharacterCandidateSourceError,
  createCharacterCandidateSourceResolver,
} = require('../characterCandidates/execution/sourceResolver');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../repositories/v2/errors');
const { remoteConnectionEvidenceSha256 } = require('../remote/connectionProfile');
const { isRemoteSessionError } = require('../remote/remoteSessionService');
const { SftpTransferError } = require('../remote/sftpTransfer');
const {
  canonicalRemoteAssetRecoveryManifest,
  RemoteAssetRecoveryManifestError,
  parseRemoteAssetRecoveryManifestJson,
} = require('./recoveryManifest');
const {
  parseRemoteAssetRecoveryRequest,
  remoteAssetRecoveryRequestSha256,
} = require('./recoveryRequest');
const {
  createQuarantineAssetInstaller,
  QuarantineAssetInstallerError,
} = require('./quarantineAssetInstaller');

const MANIFEST_MAX_BYTES = 256 * 1024;
const TASK_SCOPE = 'character-candidates';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRUSTED_ERRORS = new WeakSet();

class RemoteAssetRecoveryError extends Error {
  constructor(code) {
    super('Remote asset recovery failed');
    this.name = 'RemoteAssetRecoveryError';
    this.code = code;
    TRUSTED_ERRORS.add(this);
    Object.freeze(this);
  }
}

function isRemoteAssetRecoveryError(error) {
  return TRUSTED_ERRORS.has(error);
}

function fail(code) {
  throw new RemoteAssetRecoveryError(code);
}

function exactMethod(value, name, message) {
  if (!value || typeof value !== 'object' || isProxy(value)) throw new TypeError(message);
  let cursor = value;
  while (cursor !== null) {
    if (isProxy(cursor)) throw new TypeError(message);
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function'
        || isProxy(descriptor.value)) throw new TypeError(message);
      return (...args) => Reflect.apply(descriptor.value, value, args);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  throw new TypeError(message);
}

function createRemoteAssetRecoveryService({
  repositories,
  sessionService,
  transfer,
  storage,
  createUid = randomUUID,
  normalizeImage = createCharacterCandidateImageNormalizer(),
} = {}) {
  if (!repositories?.remoteAssetRecoveries || !repositories?.remote
    || !repositories?.assets || typeof repositories?.withTransaction !== 'function'
    || typeof createUid !== 'function' || typeof normalizeImage !== 'function') {
    throw new TypeError('Remote asset recovery dependencies are invalid');
  }
  const openSession = exactMethod(sessionService, 'openSession', 'Remote asset recovery session is invalid');
  const downloadScopedFile = exactMethod(
    transfer, 'downloadScopedFile', 'Remote asset recovery transfer is invalid',
  );
  const readBounded = exactMethod(storage, 'readBounded', 'Remote asset recovery storage is invalid');
  const remove = exactMethod(storage, 'remove', 'Remote asset recovery storage is invalid');
  const resolver = createCharacterCandidateSourceResolver({ repositories });
  const installer = createQuarantineAssetInstaller({ repositories, storage, createUid });
  const active = new Map();

  function stagingLocator(operationUid, name) {
    const logicalName = name.replace(/[^A-Za-z0-9_-]/gu, '-');
    return Object.freeze({
      storageProvider: 'local',
      logicalUri: `asset://remote-recovery-staging/${operationUid}/${logicalName}`,
      relativePath: `remote-recovery-staging/${operationUid}/${name}`,
    });
  }

  function outputLocator(request, ordinal) {
    return Object.freeze({
      storageProvider: 'local',
      logicalUri: `asset://characters/${request.characterUid}/remote-recoveries/${request.operationUid}/${ordinal}`,
      relativePath: `characters/${request.characterUid}/remote-recoveries/${request.operationUid}/${ordinal}.png`,
    });
  }

  async function clean(locators) {
    let complete = true;
    for (let index = 0; index < locators.length; index += 1) {
      try { await remove(locators[index]); } catch { complete = false; }
    }
    return complete;
  }

  function transition(operationUid, method, errorCode) {
    try { return repositories.remoteAssetRecoveries[method](operationUid, errorCode); } catch {
      return fail('REMOTE_ASSET_RECOVERY_SUBMISSION_UNKNOWN');
    }
  }

  async function verifyLocal(recovery) {
    for (let index = 0; index < recovery.items.length; index += 1) {
      const item = recovery.items[index];
      let bytes;
      try {
        bytes = await readBounded(Object.freeze({
          storageProvider: 'local', logicalUri: item.logicalUri, relativePath: item.relativePath,
        }), MAX_IMAGE_BYTES);
        if (!Buffer.isBuffer(bytes) || isProxy(bytes)
          || Object.getPrototypeOf(bytes) !== Buffer.prototype
          || bytes.length !== item.byteLength
          || createHash('sha256').update(bytes).digest('hex') !== item.contentSha256) {
          throw new TypeError();
        }
      } catch {
        return fail('REMOTE_ASSET_RECOVERY_DATA_INVALID');
      } finally {
        if (Buffer.isBuffer(bytes) && !isProxy(bytes)) bytes.fill(0);
      }
    }
  }

  async function terminal(recovery) {
    if (recovery.state === 'succeeded') {
      await verifyLocal(recovery);
      return Object.freeze({ recovery: historyProjection(recovery) });
    }
    if (recovery.state === 'failed') fail(recovery.errorCode);
    if (recovery.state === 'submission_unknown') {
      fail('REMOTE_ASSET_RECOVERY_SUBMISSION_UNKNOWN');
    }
    return null;
  }

  function currentSource(request, expectedSha256) {
    try {
      const current = resolver.resolve(request);
      if (expectedSha256 !== undefined && current.sourceSha256 !== expectedSha256) {
        throw new CharacterCandidateSourceError();
      }
      return current;
    } catch (error) {
      if (error instanceof CharacterCandidateSourceError) {
        return fail('REMOTE_ASSET_RECOVERY_SOURCE_STALE');
      }
      throw error;
    }
  }

  function historyProjection(recovery) {
    let sourceCurrent = false;
    try {
      sourceCurrent = resolver.resolve(recovery.request).sourceSha256 === recovery.sourceSha256;
    } catch { /* historical recovery remains readable after source drift */ }
    return Object.freeze({ ...recovery, sourceCurrent });
  }

  function currentConnection(request) {
    let connection;
    try { connection = repositories.remote.getConnection(request.connectionUid); } catch (error) {
      if (error instanceof V2RepositoryNotFoundError || error instanceof V2RepositoryDataError) {
        return fail('REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE');
      }
      throw error;
    }
    if (connection.status !== 'ready'
      || remoteConnectionEvidenceSha256(connection) !== request.connectionEvidenceSha256) {
      fail('REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE');
    }
    return connection;
  }

  async function handleFailure(request, locators, code) {
    const cleaned = await clean(locators);
    transition(
      request.operationUid,
      cleaned ? 'fail' : 'markUnknown',
      cleaned ? code : undefined,
    );
    return fail(cleaned ? code : 'REMOTE_ASSET_RECOVERY_SUBMISSION_UNKNOWN');
  }

  function transferFailureCode(error, manifestPhase = false) {
    if (error instanceof SftpTransferError) {
      if (error.code === 'SFTP_TRANSFER_HASH_MISMATCH') {
        return manifestPhase
          ? 'REMOTE_ASSET_RECOVERY_MANIFEST_INVALID'
          : 'REMOTE_ASSET_RECOVERY_OUTPUT_INVALID';
      }
      if (error.code === 'SFTP_TRANSFER_INPUT_INVALID'
        || error.code === 'SFTP_TRANSFER_PATH_UNSAFE') {
        return 'REMOTE_ASSET_RECOVERY_MANIFEST_INVALID';
      }
      return 'REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE';
    }
    if (isRemoteSessionError(error)) return 'REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE';
    return 'REMOTE_ASSET_RECOVERY_SUBMISSION_UNKNOWN';
  }

  async function run(request) {
    const requestSha256 = remoteAssetRecoveryRequestSha256(request);
    const prior = (() => {
      try { return repositories.remoteAssetRecoveries.get(request.operationUid); } catch (error) {
        if (error instanceof V2RepositoryNotFoundError) return null;
        if (error instanceof V2RepositoryDataError) fail('REMOTE_ASSET_RECOVERY_DATA_INVALID');
        throw error;
      }
    })();
    const retryable = prior?.state === 'failed'
      && prior.errorCode === 'REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE';
    if (prior) {
      if (prior.requestSha256 !== requestSha256) {
        fail('REMOTE_ASSET_RECOVERY_CONFLICT');
      }
      if (!retryable) {
        const done = await terminal(prior);
        if (done) return done;
        fail('REMOTE_ASSET_RECOVERY_IN_PROGRESS');
      }
    }

    const connection = currentConnection(request);
    const source = currentSource(request);
    let reservation;
    try {
      reservation = retryable
        ? Object.freeze({
          created: true,
          recovery: repositories.remoteAssetRecoveries.retryTransfer(request.operationUid),
        })
        : repositories.remoteAssetRecoveries.reserve({
          request,
          requestSha256,
          source: source.source,
          sourceSha256: source.sourceSha256,
        });
    } catch (error) {
      if (error instanceof V2RepositoryConflictError) {
        fail(retryable ? 'REMOTE_ASSET_RECOVERY_IN_PROGRESS' : 'REMOTE_ASSET_RECOVERY_CONFLICT');
      }
      if (error instanceof V2RepositoryDataError) fail('REMOTE_ASSET_RECOVERY_DATA_INVALID');
      throw error;
    }
    const reservedDone = await terminal(reservation.recovery);
    if (reservedDone) return reservedDone;
    if (!reservation.created) fail('REMOTE_ASSET_RECOVERY_IN_PROGRESS');

    let opened;
    const staged = [];
    try {
      opened = await openSession(request.connectionUid, request.connectionEvidenceSha256);
      if (opened.connection.uid !== connection.uid
        || opened.connection.remoteWorkDir !== connection.remoteWorkDir) {
        throw new TypeError('Remote connection changed during recovery');
      }
    } catch (error) {
      return handleFailure(request, [], transferFailureCode(error));
    }

    let manifest;
    try {
      currentSource(request, source.sourceSha256);
      const locator = stagingLocator(request.operationUid, 'manifest.json');
      const transferred = await downloadScopedFile({
        session: opened.session,
        localRelativePath: locator.relativePath,
        remoteWorkDir: connection.remoteWorkDir,
        taskScope: TASK_SCOPE,
        taskUid: request.remoteTaskUid,
        relativePath: 'manifest.json',
        expectedSha256: null,
        maxBytes: MANIFEST_MAX_BYTES,
      });
      staged.push(locator);
      let manifestBytes;
      try {
        manifestBytes = await readBounded(locator, MANIFEST_MAX_BYTES);
        if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length !== transferred.bytes
          || createHash('sha256').update(manifestBytes).digest('hex') !== transferred.sha256) {
          throw new TypeError();
        }
        const text = manifestBytes.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(manifestBytes)) throw new TypeError();
        manifest = parseRemoteAssetRecoveryManifestJson(text, {
          remoteTaskUid: request.remoteTaskUid,
          sourceManifestSha256: transferred.sha256,
          characterName: source.source.characterName,
        });
      } finally {
        manifestBytes?.fill?.(0);
      }
      if (!await clean([locator])) throw new TypeError('Manifest staging cleanup failed');
      staged.length = 0;
    } catch (error) {
      try { await opened.session.close(); } catch { /* read-only session close */ }
      const code = error instanceof RemoteAssetRecoveryManifestError || error instanceof TypeError
        ? 'REMOTE_ASSET_RECOVERY_MANIFEST_INVALID'
        : transferFailureCode(error, true);
      return handleFailure(request, staged, code);
    }

    const itemLoaders = manifest.items.map((expected, index) => async () => {
      const rawLocator = stagingLocator(request.operationUid, `item-${index}.remote`);
      let rawBytes;
      try {
        currentSource(request, source.sourceSha256);
        const transferred = await downloadScopedFile({
          session: opened.session,
          localRelativePath: rawLocator.relativePath,
          remoteWorkDir: connection.remoteWorkDir,
          taskScope: TASK_SCOPE,
          taskUid: request.remoteTaskUid,
          relativePath: expected.remoteRelativePath,
          expectedSha256: expected.remoteSha256,
          maxBytes: MAX_IMAGE_BYTES,
        });
        staged.push(rawLocator);
        rawBytes = await readBounded(rawLocator, MAX_IMAGE_BYTES);
        if (!Buffer.isBuffer(rawBytes) || rawBytes.length !== transferred.bytes
          || createHash('sha256').update(rawBytes).digest('hex') !== expected.remoteSha256) {
          throw new TypeError();
        }
        const normalized = await normalizeImage(rawBytes, expected.width, expected.height);
        if (!await clean([rawLocator])) throw new TypeError('Output staging cleanup failed');
        staged.splice(staged.indexOf(rawLocator), 1);
        return Object.freeze({
          bytes: normalized.bytes,
          width: normalized.width,
          height: normalized.height,
          mimeType: 'image/png',
          durationMs: null,
          source: Object.freeze({
            remoteRelativePath: expected.remoteRelativePath,
            remoteSha256: expected.remoteSha256,
            remoteByteLength: transferred.bytes,
          }),
        });
      } finally {
        rawBytes?.fill?.(0);
      }
    });

    let committed;
    try {
      const installedResult = await installer.install({
        ownerType: 'character',
        ownerUid: request.characterUid,
        assetType: 'remote_recovery',
        items: itemLoaders,
        destination: (index) => outputLocator(request, index),
        complete(scoped, evidence) {
          const current = createCharacterCandidateSourceResolver({ repositories: scoped }).resolve(request);
          if (current.sourceSha256 !== source.sourceSha256) throw new CharacterCandidateSourceError();
          const liveConnection = scoped.remote.getConnection(request.connectionUid);
          if (liveConnection.status !== 'ready'
            || remoteConnectionEvidenceSha256(liveConnection) !== request.connectionEvidenceSha256) {
            throw new TypeError('Remote connection evidence changed');
          }
          return scoped.remoteAssetRecoveries.complete(
            request.operationUid,
            manifest,
            evidence.map((item) => Object.freeze({
              ordinal: item.ordinal,
              remoteRelativePath: item.remoteRelativePath,
              remoteSha256: item.remoteSha256,
              remoteByteLength: item.remoteByteLength,
              assetUid: item.assetUid,
              assetVersionUid: item.assetVersionUid,
              logicalUri: item.logicalUri,
              relativePath: item.relativePath,
              contentSha256: item.contentSha256,
              byteLength: item.byteLength,
              width: item.width,
              height: item.height,
            })),
          );
        },
      });
      committed = installedResult.result;
    } catch (error) {
      try { await opened.session.close(); } catch { /* remote work was read-only */ }
      const stagedClean = await clean(staged);
      if (!(error instanceof QuarantineAssetInstallerError) || error.committed) {
        return fail('REMOTE_ASSET_RECOVERY_DATA_INVALID');
      }
      const cleaned = error.cleanupComplete && stagedClean;
      const cause = error.cause;
      if (cause instanceof CharacterCandidateSourceError) {
        transition(
          request.operationUid,
          cleaned ? 'fail' : 'markUnknown',
          cleaned ? 'REMOTE_ASSET_RECOVERY_SOURCE_STALE' : undefined,
        );
        return fail(cleaned
          ? 'REMOTE_ASSET_RECOVERY_SOURCE_STALE'
          : 'REMOTE_ASSET_RECOVERY_SUBMISSION_UNKNOWN');
      }
      const code = cause instanceof TypeError
        ? 'REMOTE_ASSET_RECOVERY_OUTPUT_INVALID'
        : transferFailureCode(cause);
      transition(request.operationUid, cleaned ? 'fail' : 'markUnknown', cleaned ? code : undefined);
      return fail(cleaned ? code : 'REMOTE_ASSET_RECOVERY_SUBMISSION_UNKNOWN');
    }
    try { await opened.session.close(); } catch { /* remote work was read-only */ }
    await verifyLocal(committed);
    return Object.freeze({ recovery: historyProjection(committed) });
  }

  function validatedUid(value) {
    if (typeof value !== 'string' || !UUID_V4.test(value)) {
      fail('REMOTE_ASSET_RECOVERY_INPUT_INVALID');
    }
    return value;
  }

  return Object.freeze({
    execute(value) {
      let request;
      try { request = parseRemoteAssetRecoveryRequest(value); } catch {
        return Promise.reject(new RemoteAssetRecoveryError('REMOTE_ASSET_RECOVERY_INPUT_INVALID'));
      }
      const digest = remoteAssetRecoveryRequestSha256(request);
      const running = active.get(request.operationUid);
      if (running) {
        if (running.digest !== digest) {
          return Promise.reject(new RemoteAssetRecoveryError('REMOTE_ASSET_RECOVERY_CONFLICT'));
        }
        return running.promise;
      }
      const lease = repositories.recoveryActivity.acquire(`remote/${request.operationUid}`);
      if (!lease) return Promise.reject(new RemoteAssetRecoveryError('REMOTE_ASSET_RECOVERY_IN_PROGRESS'));
      const promise = run(request).finally(() => {
        active.delete(request.operationUid);
        lease.release();
      });
      active.set(request.operationUid, Object.freeze({ digest, promise }));
      return promise;
    },

    async get(operationUid) {
      try {
        const recovery = repositories.remoteAssetRecoveries.get(validatedUid(operationUid));
        await verifyLocal(recovery);
        return Object.freeze({ recovery: historyProjection(recovery) });
      } catch (error) {
        if (isRemoteAssetRecoveryError(error)) throw error;
        if (error instanceof V2RepositoryNotFoundError) fail('REMOTE_ASSET_RECOVERY_NOT_FOUND');
        if (error instanceof V2RepositoryDataError) fail('REMOTE_ASSET_RECOVERY_DATA_INVALID');
        throw error;
      }
    },

    async list({ dramaUid, characterUid } = {}) {
      try {
        validatedUid(dramaUid);
        validatedUid(characterUid);
        const recoveries = repositories.remoteAssetRecoveries.listByCharacter(dramaUid, characterUid);
        for (let index = 0; index < recoveries.length; index += 1) {
          if (recoveries[index].state === 'succeeded') await verifyLocal(recoveries[index]);
        }
        return Object.freeze({
          schemaVersion: 'remote-asset-recovery-list.v1',
          dramaUid,
          characterUid,
          recoveries: Object.freeze(recoveries.map(historyProjection)),
        });
      } catch (error) {
        if (isRemoteAssetRecoveryError(error)) throw error;
        if (error instanceof V2RepositoryDataError) fail('REMOTE_ASSET_RECOVERY_DATA_INVALID');
        throw error;
      }
    },

    async recoverInterrupted() {
      let recoveredCount = 0;
      let failedCount = 0;
      let recoveries;
      try { recoveries = repositories.remoteAssetRecoveries.listReserved(); } catch {
        return Object.freeze({ recoveredCount: 0, failedCount: 1 });
      }
      for (const recovery of recoveries) {
        const lease = repositories.recoveryActivity.acquire(`remote/${recovery.operationUid}`);
        if (!lease) continue;
        try {
        if (repositories.remoteAssetRecoveries.get(recovery.operationUid).state !== 'reserved') continue;
        const locators = [stagingLocator(recovery.operationUid, 'manifest.json')];
        for (let index = 0; index < 16; index += 1) {
          locators.push(stagingLocator(recovery.operationUid, `item-${index}.remote`));
          locators.push(outputLocator(recovery.request, index));
        }
        const cleaned = await clean(locators);
        try {
          if (cleaned) {
            repositories.remoteAssetRecoveries.fail(
              recovery.operationUid,
              'REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE',
            );
            recoveredCount += 1;
          } else {
            repositories.remoteAssetRecoveries.markUnknown(recovery.operationUid);
            failedCount += 1;
          }
        } catch {
          failedCount += 1;
        }
        } finally { lease.release(); }
      }
      return Object.freeze({ recoveredCount, failedCount });
    },
  });
}

function createProductionRemoteAssetRecoveryService({
  repositories, sessionService, transfer, localRoot,
} = {}) {
  return createRemoteAssetRecoveryService({
    repositories,
    sessionService,
    transfer,
    storage: new LocalStorageProvider({ projectRoot: localRoot }),
  });
}

module.exports = Object.freeze({
  RemoteAssetRecoveryError,
  createProductionRemoteAssetRecoveryService,
  createRemoteAssetRecoveryService,
  isRemoteAssetRecoveryError,
});
