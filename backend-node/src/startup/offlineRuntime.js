"use strict";
const { createV2Repositories } = require("../repositories/v2");
const { LocalStorageProvider } = require("../adapters/v2/storage/localStorageProvider");
const { createLocalPackageImportService } = require("../remoteAssets/localPackageImportService");
const { createCharacterCandidateExecutionService } = require("../characterCandidates/execution/service");
const { createCharacterReferencePackageExecutionService } = require("../characterCandidates/referencePackage/s\
ervice");
const { createRemoteCollectionService } = require("../characterCandidates/execution/remoteCollectionService");
function denied() {
  const e = new Error("Offline-safe mode prohibits external operations");
  e.code = "OFFLINE_SAFE_MODE";
  throw e;
}
function createOfflineRuntime({ database, localRoot }) {
  const repositories = createV2Repositories(database), storage = new LocalStorageProvider({ projectRoot: localRoot });
  const provider = Object.freeze({ scope: "configured-image", isAvailable: () => false, generate: async () => denied() });
  const candidates = createCharacterCandidateExecutionService({ repositories, storage, provider });
  const reference = createCharacterReferencePackageExecutionService({ repositories, storage, provider, candidateExecution: candidates });
  const local = createLocalPackageImportService({ repositories, storage });
  const collections = createRemoteCollectionService({ repositories, storage, provider: { recoveryBinding: denied,
  submit: denied, collect: denied }, recoveryEnabled: false });
  return Object.freeze({ characterCandidates: Object.freeze({ ...candidates, listRecoveries: collections.list,
  getRecovery: collections.get, recover: denied }), characterReferencePackages: reference, remoteAssetRecoveries: Object.
  freeze({ execute: denied, get: denied, list: denied, importPackage: local.execute, listPackages: local.list }) });
}
module.exports = { createOfflineRuntime };
