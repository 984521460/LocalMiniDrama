'use strict';

const { createReferenceOwnershipResolver } = require('../../assets/referenceOwnership');
const { createV2Repositories } = require('../../repositories/v2');
const {
  createConfiguredNarrativeTextProvider,
  createNarrativeExecutionService,
} = require('.');

function createProductionNarrativeExecutionRuntime({ database, log, dependencies = {} } = {}) {
  if (!database || typeof database.prepare !== 'function' || !log) {
    throw new TypeError('Production narrative execution dependencies are invalid');
  }
  const provider = createConfiguredNarrativeTextProvider({
    database,
    log,
    dependencies: dependencies.provider || {},
  });
  const service = createNarrativeExecutionService({
    repositories: createV2Repositories(database),
    provider,
    assetOwnership: createReferenceOwnershipResolver(database),
    ...(dependencies.createUid ? { createUid: dependencies.createUid } : {}),
    ...(dependencies.timeoutMs ? { timeoutMs: dependencies.timeoutMs } : {}),
  });
  return Object.freeze({
    narrativeTasks: Object.freeze({
      execute: service.execute,
      get: service.get,
      isAvailable: provider.isAvailable,
    }),
  });
}

module.exports = Object.freeze({ createProductionNarrativeExecutionRuntime });
