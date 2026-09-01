'use strict';

const { LocalStorageProvider } = require('../../adapters/v2/storage/localStorageProvider');
const { createV2Repositories } = require('../../repositories/v2');
const { createConfiguredCharacterCandidateImageProvider } = require('./configuredImageProvider');
const { createCharacterCandidateExecutionService } = require('./service');

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
  const service = createCharacterCandidateExecutionService({
    repositories: createV2Repositories(database),
    provider,
    storage,
    ...(dependencies.createUid ? { createUid: dependencies.createUid } : {}),
    ...(dependencies.normalizeImage ? { normalizeImage: dependencies.normalizeImage } : {}),
    ...(dependencies.timeoutMs ? { timeoutMs: dependencies.timeoutMs } : {}),
  });
  return Object.freeze({
    characterCandidates: Object.freeze({
      execute: service.execute,
      get: service.get,
      isAvailable: provider.isAvailable,
    }),
  });
}

module.exports = Object.freeze({ createProductionCharacterCandidateExecutionRuntime });
