'use strict';

const { createHash, randomUUID } = require('node:crypto');

const MAX_ITEM_BYTES = 16 * 1024 * 1024;

class QuarantineAssetInstallerError extends Error {
  constructor({ cause, cleanupComplete, committed }) {
    super('Quarantined asset installation failed', { cause });
    this.name = 'QuarantineAssetInstallerError';
    this.cleanupComplete = cleanupComplete;
    this.committed = committed;
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function createQuarantineAssetInstaller({ repositories, storage, createUid = randomUUID } = {}) {
  if (!repositories?.assets || typeof repositories?.withTransaction !== 'function'
    || !storage || typeof storage.write !== 'function'
    || typeof storage.readBounded !== 'function' || typeof storage.remove !== 'function'
    || typeof createUid !== 'function') {
    throw new TypeError('Quarantined asset installer dependencies are invalid');
  }

  async function cleanup(locators) {
    let complete = true;
    for (let index = locators.length - 1; index >= 0; index -= 1) {
      try { await storage.remove(locators[index]); } catch { complete = false; }
    }
    return complete;
  }

  return Object.freeze({
    async install({ ownerType, ownerUid, assetType, items, destination, complete, reuseVerifiedFile = false } = {}) {
      if (ownerType !== 'character'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(ownerUid)
        || !['local_recovery', 'remote_recovery', 'character_candidate'].includes(assetType)
        || !Array.isArray(items) || items.length < 1 || items.length > 16
        || items.some((item) => typeof item !== 'function')
        || typeof destination !== 'function' || typeof complete !== 'function') {
        throw new TypeError('Quarantined asset installation input is invalid');
      }
      const installed = [];
      const evidence = [];
      let committed = false;
      let result;
      try {
        for (let ordinal = 0; ordinal < items.length; ordinal += 1) {
          const prepared = await items[ordinal]();
          if (!prepared || !Buffer.isBuffer(prepared.bytes)
            || prepared.bytes.length < 1 || prepared.bytes.length > MAX_ITEM_BYTES
            || !Number.isSafeInteger(prepared.width) || prepared.width < 1
            || !Number.isSafeInteger(prepared.height) || prepared.height < 1
            || prepared.mimeType !== 'image/png' || prepared.durationMs !== null
            || (prepared.source !== undefined
              && (!prepared.source || typeof prepared.source !== 'object'
                || Array.isArray(prepared.source)))) {
            throw new TypeError('Quarantined asset item is invalid');
          }
          const locator = destination(ordinal);
          const assetUid = createUid();
          const assetVersionUid = createUid();
          if (!locator || locator.storageProvider !== 'local'
            || typeof locator.logicalUri !== 'string' || typeof locator.relativePath !== 'string'
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(assetUid)
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(assetVersionUid)) {
            throw new TypeError('Quarantined asset destination is invalid');
          }
          const contentSha256 = digest(prepared.bytes);
          let reused = false;
          if (reuseVerifiedFile) {
            try {
              const existing = await storage.readBounded(locator, MAX_ITEM_BYTES);
              if (existing.length !== prepared.bytes.length || digest(existing) !== contentSha256) {
                throw new TypeError('Existing asset file does not match the recovered output');
              }
              reused = true;
            } catch (error) {
              if (error?.code !== 'LOCAL_STORAGE_ENTRY_NOT_FOUND') throw error;
            }
          }
          if (!reused) {
            await storage.write(locator, prepared.bytes);
            installed.push(locator);
          }
          evidence.push(Object.freeze({
            ...(prepared.source || {}),
            ordinal,
            assetUid,
            assetVersionUid,
            logicalUri: locator.logicalUri,
            relativePath: locator.relativePath,
            contentSha256,
            byteLength: prepared.bytes.length,
            width: prepared.width,
            height: prepared.height,
            mimeType: prepared.mimeType,
            durationMs: prepared.durationMs,
          }));
        }
        repositories.withTransaction((scoped) => {
          for (const item of evidence) {
            scoped.assets.create({
              uid: item.assetUid,
              ownerType,
              ownerUid,
              assetType,
              status: 'draft',
            });
            scoped.assets.addVersion({
              uid: item.assetVersionUid,
              assetUid: item.assetUid,
              storageProvider: 'local',
              logicalUri: item.logicalUri,
              relativePath: item.relativePath,
              sha256: item.contentSha256,
              mimeType: item.mimeType,
              width: item.width,
              height: item.height,
              durationMs: item.durationMs,
              parentUid: null,
              status: 'ready',
            });
          }
          result = complete(scoped, Object.freeze(evidence));
        });
        committed = true;
        for (const item of evidence) {
          const bytes = await storage.readBounded(Object.freeze({
            storageProvider: 'local',
            logicalUri: item.logicalUri,
            relativePath: item.relativePath,
          }), MAX_ITEM_BYTES);
          if (!Buffer.isBuffer(bytes) || bytes.length !== item.byteLength
            || digest(bytes) !== item.contentSha256) {
            throw new TypeError('Installed quarantined asset could not be verified');
          }
        }
        return Object.freeze({ result, evidence: Object.freeze(evidence) });
      } catch (cause) {
        const cleanupComplete = committed ? false : await cleanup(installed);
        throw new QuarantineAssetInstallerError({ cause, cleanupComplete, committed });
      }
    },

    cleanup,
  });
}

module.exports = Object.freeze({
  QuarantineAssetInstallerError,
  createQuarantineAssetInstaller,
});
