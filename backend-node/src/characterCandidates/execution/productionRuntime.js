'use strict';

const { LocalStorageProvider } = require('../../adapters/v2/storage/localStorageProvider');
const { createV2Repositories } = require('../../repositories/v2');
const { createConfiguredCharacterCandidateImageProvider } = require('./configuredImageProvider');
const {
  createRemoteComfyCharacterCandidateImageProvider,
} = require('./remoteComfyImageProvider');
const { createCharacterCandidateExecutionService } = require('./service');
const {createRemoteCollectionService}=require('./remoteCollectionService');
const {
  createCharacterReferencePackageExecutionService,
} = require('../referencePackage');

const UNAVAILABLE_REFERENCE_PROVIDER = Object.freeze({
  scope: 'configured-image',
  isAvailable: () => false,
  async generate() {
    throw new TypeError('Remote ComfyUI character reference generation is unavailable');
  },
});

function createProductionCharacterCandidateExecutionRuntime({
  database,
  localRoot,
  dependencies = {},
} = {}) {
  if (!database || typeof database.prepare !== 'function'
    || typeof localRoot !== 'string' || localRoot.length < 1) {
    throw new TypeError('Production character candidate dependencies are invalid');
  }
  let configuredProvider;
  function getConfiguredProvider() {
    if (!configuredProvider) {
      configuredProvider = createConfiguredCharacterCandidateImageProvider({
        database,
        dependencies: dependencies.providerDependencies || {},
      });
    }
    return configuredProvider;
  }
  const provider = dependencies.provider
    || (dependencies.remoteComfyUi
      ? createRemoteComfyCharacterCandidateImageProvider(dependencies.remoteComfyUi)
      : getConfiguredProvider());
  const referenceProvider = dependencies.referenceProvider
    || dependencies.provider
    || (dependencies.remoteComfyUi ? UNAVAILABLE_REFERENCE_PROVIDER : getConfiguredProvider());
  const storage = dependencies.storage || new LocalStorageProvider({ projectRoot: localRoot });
  const repositories = createV2Repositories(database);
  const remoteRecovery = !dependencies.provider && Boolean(dependencies.remoteComfyUi);
  const legacyProvider = remoteRecovery ? Object.freeze({scope:provider.scope,isAvailable:provider.isAvailable,generate:provider.generate}) : provider;
  const service = createCharacterCandidateExecutionService({
    repositories,
    provider: legacyProvider,
    storage,
    ...(dependencies.createUid ? { createUid: dependencies.createUid } : {}),
    ...(dependencies.normalizeImage ? { normalizeImage: dependencies.normalizeImage } : {}),
    ...(dependencies.timeoutMs ? { timeoutMs: dependencies.timeoutMs } : {}),
  });
  const referencePackageService = createCharacterReferencePackageExecutionService({
    repositories,
    candidateExecution: service,
    provider: referenceProvider,
    storage,
    ...(dependencies.createReferenceUid
      ? { createUid: dependencies.createReferenceUid }
      : dependencies.createUid ? { createUid: dependencies.createUid } : {}),
    ...(dependencies.referenceNowEpochMs
      ? { nowEpochMs: dependencies.referenceNowEpochMs }
      : {}),
    ...(dependencies.normalizeReferenceImage
      ? { normalizeImage: dependencies.normalizeReferenceImage }
      : dependencies.normalizeImage ? { normalizeImage: dependencies.normalizeImage } : {}),
    ...(dependencies.referenceTimeoutMs
      ? { timeoutMs: dependencies.referenceTimeoutMs }
      : dependencies.timeoutMs ? { timeoutMs: dependencies.timeoutMs } : {}),
  });
  const collection=remoteRecovery?createRemoteCollectionService({repositories,storage,provider,...(dependencies.createUid?{createUid:dependencies.createUid}:{})}):null;
  return Object.freeze({
    characterCandidates: Object.freeze({
      execute: collection ? collection.execute : service.execute,
      get: service.get,
      listHistory: service.listHistory,
      isAvailable: provider.isAvailable,
      recover: collection?.recover,
      getRecovery: collection?.get,
      listRecoveries: collection?.list,
    }),
    characterReferencePackages: Object.freeze({
      execute: referencePackageService.execute,
      listHistory: referencePackageService.listHistory,
    }),
  });
}

module.exports = Object.freeze({ createProductionCharacterCandidateExecutionRuntime });
