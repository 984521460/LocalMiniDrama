'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { createAssetLocator } = require('@local-mini-drama/storage');
const { LocalStorageProvider } = require('../adapters/v2/storage');
const {
  canonicalUid,
  epoch,
  exactObject,
  fail,
  isAudioModeContractError,
} = require('./audioContract');
const { createBgmLicense, publicText } = require('./bgmLicense');
const { EXTENSION_BY_MIME } = require('./bgmTrack');

const OPTIONS_KEYS = Object.freeze(['storageProvider', 'repositories', 'inspectAudio']);
const REQUEST_KEYS = Object.freeze([
  'uid',
  'dramaUid',
  'assetUid',
  'assetVersionUid',
  'title',
  'mimeType',
  'license',
  'bytes',
  'createdAtEpochMs',
]);
const INSPECTION_KEYS = Object.freeze(['mimeType', 'durationMs']);
const MAXIMUM_BYTES = 256 * 1024 * 1024;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const typedArraySet = Uint8Array.prototype.set;
const storageWrite = LocalStorageProvider.prototype.write;
const storageReadBounded = LocalStorageProvider.prototype.readBounded;
const storageRemove = LocalStorageProvider.prototype.remove;

function exactMethod(value, name) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || isProxy(value)) {
    fail('BGM_IMPORT_INVALID');
  }
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, name);
  } catch {
    return fail('BGM_IMPORT_INVALID');
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
    fail('BGM_IMPORT_INVALID');
  }
  return descriptor.value;
}

function snapshotBytes(value) {
  try {
    if (isProxy(value) || !Buffer.isBuffer(value) || Object.getPrototypeOf(value) !== Buffer.prototype) {
      fail('BGM_IMPORT_INVALID');
    }
    const byteLength = Reflect.apply(typedArrayByteLength, value, []);
    const backing = Reflect.apply(typedArrayBuffer, value, []);
    if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAXIMUM_BYTES
      || (typeof SharedArrayBuffer === 'function' && backing instanceof SharedArrayBuffer)) {
      fail('BGM_IMPORT_INVALID');
    }
    const snapshot = Buffer.allocUnsafe(byteLength);
    Reflect.apply(typedArraySet, snapshot, [value, 0]);
    return snapshot;
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail('BGM_IMPORT_INVALID');
  }
}

function createLocalBgmProvider(value) {
  const options = exactObject(value, OPTIONS_KEYS, 'BGM_IMPORT_INVALID');
  if (isProxy(options.storageProvider)
    || !(options.storageProvider instanceof LocalStorageProvider)
    || typeof options.inspectAudio !== 'function'
    || isProxy(options.inspectAudio)) fail('BGM_IMPORT_INVALID');
  const withTransaction = exactMethod(options.repositories, 'withTransaction');

  return Object.freeze({
    id: 'local-library',

    async importTrack(valueToImport) {
      const input = exactObject(valueToImport, REQUEST_KEYS, 'BGM_IMPORT_INVALID');
      const bytes = snapshotBytes(input.bytes);
      const license = createBgmLicense(input.license, 'BGM_IMPORT_INVALID');
      const uid = canonicalUid(input.uid, 'BGM_IMPORT_INVALID');
      const dramaUid = canonicalUid(input.dramaUid, 'BGM_IMPORT_INVALID');
      const assetUid = canonicalUid(input.assetUid, 'BGM_IMPORT_INVALID');
      const assetVersionUid = canonicalUid(input.assetVersionUid, 'BGM_IMPORT_INVALID');
      const title = publicText(input.title, 'BGM_IMPORT_INVALID');
      const createdAtEpochMs = epoch(input.createdAtEpochMs, 'BGM_IMPORT_INVALID');
      if (license.attestedAtEpochMs > createdAtEpochMs) fail('BGM_IMPORT_INVALID');
      const extension = EXTENSION_BY_MIME[input.mimeType];
      if (!extension) fail('BGM_IMPORT_INVALID');

      const locator = createAssetLocator({
        logicalSegments: ['dramas', dramaUid, 'bgm', assetUid, assetVersionUid],
        relativeSegments: [
          'projects', dramaUid, 'assets', 'bgm', assetUid,
          `${assetVersionUid}.${extension}`,
        ],
      });
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      let wrote = false;
      try {
        await Reflect.apply(storageWrite, options.storageProvider, [locator, bytes]);
        wrote = true;
        const inspection = exactObject(
          await Reflect.apply(options.inspectAudio, undefined, [Object.freeze({
            uid: assetVersionUid,
            assetUid,
            storageProvider: locator.storageProvider,
            logicalUri: locator.logicalUri,
            relativePath: locator.relativePath,
            sha256,
            mimeType: input.mimeType,
            width: null,
            height: null,
            durationMs: null,
            parentUid: null,
            status: 'ready',
            createdAt: new Date(createdAtEpochMs).toISOString(),
          })]),
          INSPECTION_KEYS,
          'BGM_IMPORT_INVALID',
        );
        if (inspection.mimeType !== input.mimeType
          || !Number.isSafeInteger(inspection.durationMs)
          || inspection.durationMs < 1
          || inspection.durationMs > 3_600_000) fail('BGM_IMPORT_INVALID');
        const persistedBytes = snapshotBytes(
          await Reflect.apply(
            storageReadBounded,
            options.storageProvider,
            [locator, bytes.byteLength],
          ),
        );
        if (persistedBytes.byteLength !== bytes.byteLength
          || createHash('sha256').update(persistedBytes).digest('hex') !== sha256) {
          fail('BGM_IMPORT_FAILED');
        }
        return Reflect.apply(withTransaction, options.repositories, [(repositories) => {
          repositories.assets.create({
            uid: assetUid,
            ownerType: 'drama',
            ownerUid: dramaUid,
            assetType: 'bgm',
            status: 'draft',
          });
          repositories.assets.addVersion({
            uid: assetVersionUid,
            assetUid,
            storageProvider: locator.storageProvider,
            logicalUri: locator.logicalUri,
            relativePath: locator.relativePath,
            sha256,
            mimeType: input.mimeType,
            width: null,
            height: null,
            durationMs: inspection.durationMs,
            parentUid: null,
            status: 'ready',
          }, { makeCurrent: true });
          return repositories.bgmTracks.create({
            schemaVersion: 'bgm-track.v1',
            uid,
            dramaUid,
            title,
            sourceKind: 'local-import',
            providerId: 'local-library',
            assetVersionUid,
            license,
            createdAtEpochMs,
          });
        }]);
      } catch (error) {
        if (wrote) {
          try {
            const removed = await Reflect.apply(storageRemove, options.storageProvider, [locator]);
            if (!removed) fail('BGM_IMPORT_CLEANUP_FAILED');
          } catch {
            return fail('BGM_IMPORT_CLEANUP_FAILED');
          }
        }
        if (isAudioModeContractError(error)
          && error.code === 'BGM_IMPORT_CLEANUP_FAILED') throw error;
        return fail('BGM_IMPORT_FAILED');
      }
    },
  });
}

module.exports = Object.freeze({ createLocalBgmProvider });
