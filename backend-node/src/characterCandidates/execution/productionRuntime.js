'use strict';

const { LocalStorageProvider } = require('../../adapters/v2/storage/localStorageProvider');
const { createV2Repositories } = require('../../repositories/v2');
const { createConfiguredCharacterCandidateImageProvider } = require('./configuredImageProvider');
const { createCharacterCandidateExecutionService } = require('./service');
const {
  createCharacterReferencePackageExecutionService,
} = require('../referencePackage');

function createProductionCharacterCandidateExecutionRuntime({
  database,
  localRoot,
  dependencies = {},
} = {}) {
  if (!database || typeof database.prepare !== 'function'
    || typeof localRoot !== 'string' || localRoot.length < 1) {
    throw new TypeError('Production character candidate dependencies are invalid');
  }
  const provider = dependencies.provider || createConfiguredCharacterCandidateImageProvider({
    database,
    dependencies: dependencies.providerDependencies || {},
  });
  const storage = dependencies.storage || new LocalStorageProvider({ projectRoot: localRoot });
  const repositories = createV2Repositories(database);
  const service = createCharacterCandidateExecutionService({
    repositories,
    provider,
    storage,
    ...(dependencies.createUid ? { createUid: dependencies.createUid } : {}),
    ...(dependencies.normalizeImage ? { normalizeImage: dependencies.normalizeImage } : {}),
    ...(dependencies.timeoutMs ? { timeoutMs: dependencies.timeoutMs } : {}),
  });
  const referencePackageService = createCharacterReferencePackageExecutionService({
    repositories,
    candidateExecution: service,
    provider,
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
  return Object.freeze({
    characterCandidates: Object.freeze({
      execute: service.execute,
      get: service.get,
      listHistory: service.listHistory,
      isAvailable: provider.isAvailable,
    }),
    characterReferencePackages: Object.freeze({
      execute: referencePackageService.execute,
      listHistory: referencePackageService.listHistory,
    }),
  });
}

module.exports = Object.freeze({ createProductionCharacterCandidateExecutionRuntime });
