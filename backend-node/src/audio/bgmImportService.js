'use strict';

const { types: { isProxy } } = require('node:util');

const {
  canonicalUid,
  exactObject,
  fail,
  isAudioModeContractError,
} = require('./audioContract');
const { createBgmTrack } = require('./bgmTrack');

const MAX_BGM_IMPORT_BYTES = 32 * 1024 * 1024;
const INPUT_KEYS = Object.freeze([
  'dramaUid', 'title', 'mimeType', 'licenseBasis', 'commercialUseAllowed',
  'derivativesAllowed', 'bytes',
]);
const MIME_TYPES = Object.freeze(new Set([
  'audio/aac', 'audio/flac', 'audio/mpeg', 'audio/wav', 'audio/x-wav',
]));
const LICENSE_BASES = Object.freeze(new Set([
  'user-owned', 'licensed', 'public-domain', 'provider-grant',
]));
const BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), 'byteLength',
).get;
const SET_HAS = Set.prototype.has;

function dependency(value, name) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || isProxy(value)) {
    throw new TypeError('BGM import service dependencies are invalid');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')
    || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) {
    throw new TypeError('BGM import service dependencies are invalid');
  }
  return descriptor.value;
}

function trackView(value) {
  const license = value.license;
  return Object.freeze({
    schemaVersion: 'bgm-library-track.v1',
    uid: value.uid,
    dramaUid: value.dramaUid,
    title: value.title,
    mimeType: value.assetVersion.mimeType,
    durationMs: value.assetVersion.durationMs,
    license: Object.freeze({
      basis: license.basis,
      commercialUseAllowed: license.commercialUseAllowed,
      derivativesAllowed: license.derivativesAllowed,
    }),
    exportEligible: license.commercialUseAllowed && license.derivativesAllowed,
    createdAtEpochMs: value.createdAtEpochMs,
  });
}

function createBgmImportService(value) {
  const options = exactObject(
    value, ['database', 'provider', 'repository', 'createUid', 'nowEpochMs'],
    'BGM_IMPORT_INVALID',
  );
  if (!options.database || typeof options.database.prepare !== 'function'
    || isProxy(options.database) || typeof options.createUid !== 'function'
    || isProxy(options.createUid) || typeof options.nowEpochMs !== 'function'
    || isProxy(options.nowEpochMs)) fail('BGM_IMPORT_INVALID');
  const importTrack = dependency(options.provider, 'importTrack');
  const listByDrama = dependency(options.repository, 'listByDrama');
  const dramaExists = options.database.prepare('SELECT EXISTS(SELECT 1 FROM dramas WHERE uid=?)').pluck();

  function requireDrama(dramaUid) {
    canonicalUid(dramaUid, 'BGM_IMPORT_INVALID');
    if (dramaExists.get(dramaUid) !== 1) fail('BGM_IMPORT_INVALID');
    return dramaUid;
  }

  return Object.freeze({
    async importTrack(valueToImport) {
      try {
        const input = exactObject(valueToImport, INPUT_KEYS, 'BGM_IMPORT_INVALID');
        const dramaUid = requireDrama(input.dramaUid);
        if (!Reflect.apply(SET_HAS, MIME_TYPES, [input.mimeType])
          || !Reflect.apply(SET_HAS, LICENSE_BASES, [input.licenseBasis])
          || typeof input.commercialUseAllowed !== 'boolean'
          || typeof input.derivativesAllowed !== 'boolean'
          || isProxy(input.bytes) || !Buffer.isBuffer(input.bytes)
          || Reflect.apply(BUFFER_BYTE_LENGTH, input.bytes, []) < 1
          || Reflect.apply(BUFFER_BYTE_LENGTH, input.bytes, []) > MAX_BGM_IMPORT_BYTES) {
          fail('BGM_IMPORT_INVALID');
        }
        const createdAtEpochMs = options.nowEpochMs();
        if (!Number.isSafeInteger(createdAtEpochMs) || createdAtEpochMs < 0) {
          fail('BGM_IMPORT_INVALID');
        }
        const record = await Reflect.apply(importTrack, options.provider, [{
          uid: options.createUid(),
          dramaUid,
          assetUid: options.createUid(),
          assetVersionUid: options.createUid(),
          title: input.title,
          mimeType: input.mimeType,
          license: {
            schemaVersion: 'bgm-license.v1',
            uid: options.createUid(),
            basis: input.licenseBasis,
            attestationKind: 'user-attestation',
            commercialUseAllowed: input.commercialUseAllowed,
            derivativesAllowed: input.derivativesAllowed,
            attributionRequired: false,
            attributionText: null,
            attestedAtEpochMs: createdAtEpochMs,
          },
          bytes: input.bytes,
          createdAtEpochMs,
        }]);
        return trackView(createBgmTrack(record, 'BGM_IMPORT_INVALID'));
      } catch (error) {
        if (isAudioModeContractError(error)) throw error;
        return fail('BGM_IMPORT_FAILED');
      }
    },
    listByDrama(dramaUidValue) {
      try {
        const dramaUid = requireDrama(dramaUidValue);
        const records = Reflect.apply(listByDrama, options.repository, [dramaUid]);
        const output = [];
        for (let index = 0; index < records.length; index += 1) {
          output[index] = trackView(records[index]);
        }
        return Object.freeze(output);
      } catch (error) {
        if (isAudioModeContractError(error)) throw error;
        return fail('BGM_IMPORT_FAILED');
      }
    },
  });
}

module.exports = Object.freeze({ MAX_BGM_IMPORT_BYTES, createBgmImportService, trackView });
