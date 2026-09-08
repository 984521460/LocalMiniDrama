'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { readLocalRecoveryPackage } = require('./localRecoveryPackage');
const { projectLocalRecoveryItem } = require('./localRecoveryItem');
const { createQuarantineAssetInstaller, QuarantineAssetInstallerError } = require('./quarantineAssetInstaller');
const { createCharacterCandidateSourceResolver } = require('../characterCandidates/execution/sourceResolver');
const { characterCandidateSourceSha256 } = require('../characterCandidates/execution/source');
const { createCharacterCandidateImageNormalizer } = require('../characterCandidates/execution/imageNormalizer');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../repositories/v2/errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRUSTED_ERRORS = new WeakSet();
const ERROR_CODES = new Set([
  'LOCAL_PACKAGE_IMPORT_INPUT_INVALID',
  'LOCAL_PACKAGE_IMPORT_CONFLICT',
  'LOCAL_PACKAGE_IMPORT_IN_PROGRESS',
  'LOCAL_PACKAGE_IMPORT_DATA_INVALID',
  'LOCAL_PACKAGE_IMPORT_FAILED',
  'LOCAL_PACKAGE_IMPORT_SUBMISSION_UNKNOWN',
]);

class LocalPackageImportError extends Error {
  constructor(code) {
    super('Local package import failed');
    this.name = 'LocalPackageImportError';
    this.code = ERROR_CODES.has(code) ? code : 'LOCAL_PACKAGE_IMPORT_FAILED';
    TRUSTED_ERRORS.add(this);
    Object.freeze(this);
  }
}

function isLocalPackageImportError(error) {
  return TRUSTED_ERRORS.has(error);
}

function fail(code) {
  throw new LocalPackageImportError(code);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function createLocalPackageImportService({ repositories, storage, createUid = randomUUID } = {}) {
  if (!repositories?.localRecoveryPackages || !repositories?.assets
    || typeof repositories?.withTransaction !== 'function') {
    throw new TypeError('Local package import dependencies are invalid');
  }
  const resolver = createCharacterCandidateSourceResolver({ repositories });
  const normalize = createCharacterCandidateImageNormalizer();
  const installer = createQuarantineAssetInstaller({ repositories, storage, createUid });
  const active = new Map();

  function locator(characterUid, operationUid, ordinal) {
    const relativePath = `characters/${characterUid}/local-recoveries/${operationUid}/${ordinal}.png`;
    return Object.freeze({
      storageProvider: 'local',
      logicalUri: `asset://${relativePath}`,
      relativePath,
    });
  }

  async function project(row) {
    if (characterCandidateSourceSha256(row.source) !== row.sourceSha256
      || row.source.characterUid !== row.characterUid || row.source.dramaUid !== row.dramaUid
      || !Array.isArray(row.items) || row.items.length < 1 || row.items.length > 16) {
      fail('LOCAL_PACKAGE_IMPORT_DATA_INVALID');
    }
    const items = [];
    for (const [index, rawItem] of row.items.entries()) {
      let item;
      try { item = projectLocalRecoveryItem(rawItem, row.characterUid, row.uid, index); } catch {
        fail('LOCAL_PACKAGE_IMPORT_DATA_INVALID');
      }
      const expected = locator(row.characterUid, row.uid, index);
      let asset;
      let version;
      try {
        asset = repositories.assets.get(item.assetUid);
        version = repositories.assets.getVersion(item.assetVersionUid);
      } catch {
        fail('LOCAL_PACKAGE_IMPORT_DATA_INVALID');
      }
      if (item.ordinal !== index || item.relativePath !== expected.relativePath
        || item.logicalUri !== expected.logicalUri
        || typeof item.originalName !== 'string' || typeof item.originalSha256 !== 'string'
        || asset.ownerUid !== row.characterUid || asset.ownerType !== 'character'
        || asset.assetType !== 'local_recovery' || asset.status !== 'draft'
        || asset.currentVersionUid !== null || version.assetUid !== asset.uid
        || version.logicalUri !== expected.logicalUri || version.relativePath !== expected.relativePath
        || version.sha256 !== item.sha256 || version.mimeType !== 'image/png'
        || version.status !== 'ready' || version.storageProvider !== 'local'
        || version.width !== item.width || version.height !== item.height
        || version.durationMs !== null) fail('LOCAL_PACKAGE_IMPORT_DATA_INVALID');
      let bytes;
      try {
        bytes = await storage.readBounded(expected, 16 * 1024 * 1024);
        if (!Buffer.isBuffer(bytes) || bytes.length !== item.byteLength
          || digest(bytes) !== item.sha256) fail('LOCAL_PACKAGE_IMPORT_DATA_INVALID');
      } catch (error) {
        if (isLocalPackageImportError(error)) throw error;
        fail('LOCAL_PACKAGE_IMPORT_DATA_INVALID');
      }
      items.push(item);
    }
    let sourceCurrent = false;
    try {
      sourceCurrent = resolver.resolve({
        dramaUid: row.dramaUid,
        characterUid: row.characterUid,
        extractionResultUid: row.source.extractionResultUid,
        characterFactId: row.source.characterFactId,
      }).sourceSha256 === row.sourceSha256;
    } catch { /* historical import remains readable after source drift */ }
    return Object.freeze({
      uid: row.uid,
      dramaUid: row.dramaUid,
      characterUid: row.characterUid,
      packageSha256: row.packageSha256,
      sourceManifestSha256: row.manifestSha256,
      remoteTaskUid: row.remoteTaskUid,
      characterName: row.source.characterName,
      quarantineStatus: 'unapproved',
      sourceCurrent,
      createdAt: row.createdAt,
      items: Object.freeze(items),
    });
  }

  async function markFailed(operationUid, cleanupComplete, errorCode = 'LOCAL_PACKAGE_IMPORT_FAILED') {
    try {
      if (cleanupComplete) {
        repositories.localRecoveryPackages.fail(operationUid, errorCode);
      } else {
        repositories.localRecoveryPackages.markUnknown(operationUid);
      }
    } catch {
      fail('LOCAL_PACKAGE_IMPORT_SUBMISSION_UNKNOWN');
    }
    fail(cleanupComplete
      ? 'LOCAL_PACKAGE_IMPORT_FAILED'
      : 'LOCAL_PACKAGE_IMPORT_SUBMISSION_UNKNOWN');
  }

  async function run(input, bytes) {
    let source;
    let pkg;
    try {
      source = resolver.resolve(input);
      pkg = await readLocalRecoveryPackage(bytes);
    } catch {
      fail('LOCAL_PACKAGE_IMPORT_INPUT_INVALID');
    }
    const selected = pkg.items.filter((item) => item.name === source.source.characterName);
    if (!selected.length) fail('LOCAL_PACKAGE_IMPORT_INPUT_INVALID');
    let reservation;
    try {
      reservation = repositories.localRecoveryPackages.reserve({
        operationUid: createUid(),
        dramaUid: input.dramaUid,
        characterUid: input.characterUid,
        packageSha256: pkg.packageSha256,
        manifestSha256: pkg.sourceManifestSha256,
        remoteTaskUid: pkg.remoteTaskUid,
        source: source.source,
        sourceSha256: source.sourceSha256,
      });
    } catch (error) {
      if (error instanceof V2RepositoryConflictError) fail('LOCAL_PACKAGE_IMPORT_CONFLICT');
      fail('LOCAL_PACKAGE_IMPORT_FAILED');
    }
    const { attempt } = reservation;
    if (!reservation.created) {
      if (attempt.state === 'succeeded') {
        try { return project(repositories.localRecoveryPackages.get(attempt.operationUid)); } catch (error) {
          if (isLocalPackageImportError(error)) throw error;
          fail('LOCAL_PACKAGE_IMPORT_DATA_INVALID');
        }
      }
      if (attempt.state === 'reserved') fail('LOCAL_PACKAGE_IMPORT_IN_PROGRESS');
      fail('LOCAL_PACKAGE_IMPORT_SUBMISSION_UNKNOWN');
    }
    if (attempt.attemptCount > 1) {
      const stale = Array.from({ length: 16 }, (_, ordinal) => (
        locator(input.characterUid, attempt.operationUid, ordinal)
      ));
      if (!await installer.cleanup(stale)) {
        return markFailed(attempt.operationUid, false);
      }
    }
    try {
      const installed = await installer.install({
        ownerType: 'character',
        ownerUid: input.characterUid,
        assetType: 'local_recovery',
        items: selected.map((item) => async () => {
          const normalized = await normalize(item.bytes, item.verifiedWidth, item.verifiedHeight);
          return Object.freeze({
            bytes: normalized.bytes,
            width: normalized.width,
            height: normalized.height,
            mimeType: 'image/png',
            durationMs: null,
            source: Object.freeze({
              originalName: item.localPackageName,
              originalSha256: item.sha256,
            }),
          });
        }),
        destination: (ordinal) => locator(input.characterUid, attempt.operationUid, ordinal),
        complete(scoped, evidence) {
          return scoped.localRecoveryPackages.complete(attempt.operationUid, evidence.map((item) => ({
            ordinal: item.ordinal,
            assetUid: item.assetUid,
            assetVersionUid: item.assetVersionUid,
            logicalUri: item.logicalUri,
            relativePath: item.relativePath,
            sha256: item.contentSha256,
            byteLength: item.byteLength,
            width: item.width,
            height: item.height,
            originalName: item.originalName,
            originalSha256: item.originalSha256,
          })));
        },
      });
      return project(installed.result);
    } catch (error) {
      if (!(error instanceof QuarantineAssetInstallerError)) {
        return markFailed(attempt.operationUid, false);
      }
      if (error.committed) fail('LOCAL_PACKAGE_IMPORT_DATA_INVALID');
      return markFailed(attempt.operationUid, error.cleanupComplete);
    }
  }

  return Object.freeze({
    async execute(input, bytes) {
      if (!input || Object.keys(input).sort().join(',') !==
        'characterFactId,characterUid,dramaUid,extractionResultUid'
        || ![input.dramaUid, input.characterUid, input.extractionResultUid].every((item) => UUID.test(item))
        || typeof input.characterFactId !== 'string'
        || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(input.characterFactId)
        || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 64 * 1024 * 1024) {
        fail('LOCAL_PACKAGE_IMPORT_INPUT_INVALID');
      }
      const key = `${input.characterUid}:${digest(bytes)}`;
      const requestIdentity = JSON.stringify([
        input.dramaUid, input.characterUid, input.extractionResultUid, input.characterFactId,
      ]);
      if (active.has(key)) {
        if (active.get(key).requestIdentity !== requestIdentity) {
          fail('LOCAL_PACKAGE_IMPORT_CONFLICT');
        }
        return active.get(key).promise;
      }
      const lease = repositories.recoveryActivity.acquire(`local/${input.characterUid}/${digest(bytes)}`);
      if (!lease) fail('LOCAL_PACKAGE_IMPORT_IN_PROGRESS');
      const promise = run({ ...input }, bytes).finally(() => {
        active.delete(key);
        lease.release();
      });
      active.set(key, { requestIdentity, promise });
      return promise;
    },

    async list(dramaUid, characterUid) {
      if (!UUID.test(dramaUid) || !UUID.test(characterUid)) {
        fail('LOCAL_PACKAGE_IMPORT_INPUT_INVALID');
      }
      try {
        const rows = repositories.localRecoveryPackages.listByCharacter(dramaUid, characterUid);
        return await Promise.all(rows.map(project));
      } catch (error) {
        if (isLocalPackageImportError(error)) throw error;
        if (error instanceof V2RepositoryDataError || error instanceof V2RepositoryNotFoundError) {
          fail('LOCAL_PACKAGE_IMPORT_DATA_INVALID');
        }
        fail('LOCAL_PACKAGE_IMPORT_FAILED');
      }
    },

    async recoverInterrupted() {
      let recoveredCount = 0;
      let failedCount = 0;
      const attempts = repositories.localRecoveryPackages.listReserved();
      for (const attempt of attempts) {
        const lease = repositories.recoveryActivity.acquire(`local/${attempt.characterUid}/${attempt.packageSha256}`);
        if (!lease) continue;
        try {
        if (repositories.localRecoveryPackages.getAttempt(attempt.operationUid).state !== 'reserved') continue;
        const locators = Array.from({ length: 16 }, (_, ordinal) => (
          locator(attempt.characterUid, attempt.operationUid, ordinal)
        ));
        const cleaned = await installer.cleanup(locators);
        try {
          if (cleaned) {
            repositories.localRecoveryPackages.fail(
              attempt.operationUid,
              'LOCAL_PACKAGE_IMPORT_INTERRUPTED',
            );
            recoveredCount += 1;
          } else {
            repositories.localRecoveryPackages.markUnknown(attempt.operationUid);
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

module.exports = Object.freeze({
  LocalPackageImportError,
  createLocalPackageImportService,
  isLocalPackageImportError,
});
