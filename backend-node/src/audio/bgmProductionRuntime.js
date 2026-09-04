'use strict';

const { randomUUID } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { LocalStorageProvider } = require('../adapters/v2/storage');
const { createLocalMediaProbe } = require('../media/localMediaProbe');
const { createV2Repositories } = require('../repositories/v2');
const { createBgmImportService, MAX_BGM_IMPORT_BYTES } = require('./bgmImportService');
const { createLocalBgmProvider } = require('./localBgmProvider');

const ALLOWED_DEPENDENCIES = Object.freeze([
  'createUid', 'nowEpochMs', 'mediaProbe', 'storageProvider', 'ffmpegPath',
  'ffprobePath', 'runProcess', 'timeoutMs',
]);
const ARRAY_IS_ARRAY = Array.isArray;
const FORMATS_BY_MIME = Object.freeze({
  'audio/aac': Object.freeze(['aac']),
  'audio/flac': Object.freeze(['flac']),
  'audio/mpeg': Object.freeze(['mp3']),
  'audio/wav': Object.freeze(['wav']),
  'audio/x-wav': Object.freeze(['wav']),
});

function formatMatchesMime(formatNames, mimeType) {
  const allowed = FORMATS_BY_MIME[mimeType];
  if (!allowed || !ARRAY_IS_ARRAY(formatNames)) return false;
  for (let formatIndex = 0; formatIndex < formatNames.length; formatIndex += 1) {
    for (let allowedIndex = 0; allowedIndex < allowed.length; allowedIndex += 1) {
      if (formatNames[formatIndex] === allowed[allowedIndex]) return true;
    }
  }
  return false;
}

function dependencies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Production BGM runtime dependencies are invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    let allowed = false;
    for (let index = 0; index < ALLOWED_DEPENDENCIES.length; index += 1) {
      if (ALLOWED_DEPENDENCIES[index] === key) allowed = true;
    }
    if (typeof key !== 'string' || !allowed) {
      throw new TypeError('Production BGM runtime dependencies are invalid');
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Production BGM runtime dependencies are invalid');
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function createProductionBgmRuntime({ database, localRoot, dependencies: value = {} } = {}) {
  if (!database || typeof database.prepare !== 'function'
    || typeof localRoot !== 'string' || localRoot.length < 1) {
    throw new TypeError('Production BGM runtime configuration is invalid');
  }
  const configured = dependencies(value);
  const repositories = createV2Repositories(database);
  const createUid = configured.createUid ?? randomUUID;
  const nowEpochMs = configured.nowEpochMs ?? Date.now;
  const storageProvider = configured.storageProvider ?? new LocalStorageProvider({ projectRoot: localRoot });
  const mediaProbe = configured.mediaProbe ?? createLocalMediaProbe({
    localRoot,
    maxFileBytes: MAX_BGM_IMPORT_BYTES,
    ...(configured.ffmpegPath ? { ffmpegPath: configured.ffmpegPath } : {}),
    ...(configured.ffprobePath ? { ffprobePath: configured.ffprobePath } : {}),
    ...(configured.runProcess ? { runProcess: configured.runProcess } : {}),
    ...(configured.timeoutMs ? { timeoutMs: configured.timeoutMs } : {}),
  });
  if (!mediaProbe || typeof mediaProbe.inspect !== 'function' || isProxy(mediaProbe)) {
    throw new TypeError('Production BGM runtime dependencies are invalid');
  }
  const provider = createLocalBgmProvider({
    storageProvider,
    repositories,
    async inspectAudio(assetVersion) {
      const evidence = await mediaProbe.inspect({
        schemaVersion: '8.0',
        uid: createUid(),
        assetVersion,
        probedAtEpochMs: nowEpochMs(),
      });
      if (!formatMatchesMime(evidence.formatNames, assetVersion.mimeType)) {
        throw new TypeError('Production BGM media format is invalid');
      }
      return Object.freeze({
        mimeType: evidence.mimeType,
        durationMs: evidence.durationMs,
      });
    },
  });
  const service = createBgmImportService({
    database,
    provider,
    repository: repositories.bgmTracks,
    createUid,
    nowEpochMs,
  });
  return Object.freeze({ bgm: Object.freeze({ service }) });
}

module.exports = Object.freeze({ createProductionBgmRuntime });
