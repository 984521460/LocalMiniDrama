const { types: { isPromise } } = require('node:util');

const { createAssetRepository } = require('./assetRepository');
const { createBgmTrackRepository } = require('./bgmTrackRepository');
const { createCharacterCandidateRepository } = require('./characterCandidateRepository');
const { createCharacterReferencePackageRepository } = require('./characterReferencePackageRepository');
const { createCharacterVersionRepository } = require('./characterVersionRepository');
const { createComfyManifestRepository } = require('./comfyManifestRepository');
const { createGenerationHistoryRepository } = require('./generationHistoryRepository');
const { createH3GenerationIntentRepository } = require('./h3GenerationIntentRepository');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { createRemoteRepository } = require('./remoteRepository');
const { createProjectArchiveRepository } = require('./projectArchiveRepository');
const { createNarrativeReviewRepository } = require('./narrativeReviewRepository');
const { createNarrativeApprovalGate } = require('./narrativeApprovalGate');
const { assertDatabase } = require('./repositorySupport');
const { createRunRepository } = require('./runRepository');
const { createScenePropVersionRepository } = require('./scenePropVersionRepository');
const { createShotContinuitySnapshotRepository } = require('./shotContinuitySnapshotRepository');
const { createSourceRepository } = require('./sourceRepository');
const { createVoiceProfileRepository } = require('./voiceProfileRepository');
const { createWorkflowRepository } = require('./workflowRepository');

const promiseThen = Promise.prototype.then;

function createLazyProjectArchiveRepository(database) {
  let target;
  function getTarget() {
    if (!target) target = createProjectArchiveRepository(database);
    return target;
  }
  return Object.freeze({
    exportSnapshot(...args) {
      return getTarget().exportSnapshot(...args);
    },
    hasUidConflict(...args) {
      return getTarget().hasUidConflict(...args);
    },
    importSnapshot(...args) {
      return getTarget().importSnapshot(...args);
    },
  });
}

function createTransactionScope(repositories) {
  let active = true;

  function assertActive() {
    if (!active) {
      throw new TypeError('Repository transaction scope has expired');
    }
  }

  function wrap(target) {
    const facade = {};
    for (const [key, value] of Object.entries(target)) {
      if (typeof value === 'function') {
        facade[key] = (...args) => {
          assertActive();
          return Reflect.apply(value, target, args);
        };
      } else if (value && typeof value === 'object') {
        facade[key] = wrap(value);
      } else {
        facade[key] = value;
      }
    }
    return Object.freeze(facade);
  }

  return Object.freeze({
    repositories: wrap(repositories),
    revoke() {
      active = false;
    },
  });
}

function createV2Repositories(database) {
  assertDatabase(database);

  const assets = createAssetRepository(database);
  const characterReferencePackages = createCharacterReferencePackageRepository(database);
  const characterVersions = createCharacterVersionRepository(database);
  const comfyManifests = createComfyManifestRepository(database);
  const narrativeReviews = createNarrativeReviewRepository(database);
  const remote = createRemoteRepository(database);
  const scenePropVersions = createScenePropVersionRepository(database);
  const sources = createSourceRepository(database);
  const narrativeApprovalGate = createNarrativeApprovalGate({ narrativeReviews, sources });
  const generationHistory = createGenerationHistoryRepository(database, {
    requireApprovedShot: narrativeApprovalGate.requireApprovedShot,
  });
  const h3GenerationIntents = createH3GenerationIntentRepository(database, {
    assets,
    comfyManifests,
    generationHistory,
    remote,
    requireApprovedShot: narrativeApprovalGate.requireApprovedShot,
  });
  const aggregates = {
    assets,
    bgmTracks: createBgmTrackRepository(database),
    characterCandidates: createCharacterCandidateRepository(database),
    characterReferencePackages,
    characterVersions,
    comfyManifests,
    generationHistory,
    h3GenerationIntents,
    narrativeReviews,
    projectArchives: createLazyProjectArchiveRepository(database),
    remote,
    runs: createRunRepository(database),
    scenePropVersions,
    shotContinuitySnapshots: createShotContinuitySnapshotRepository(database, {
      characterReferencePackages,
      characterVersions,
      requireApprovedShot: narrativeApprovalGate.requireApprovedShot,
      scenePropVersions,
    }),
    sources,
    voiceProfiles: createVoiceProfileRepository(database),
    workflows: createWorkflowRepository(database),
  };
  let repositories;

  function withTransaction(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Repository transaction callback must be a function');
    }
    let result;
    const run = database.transaction(() => {
      const scope = createTransactionScope(repositories);
      try {
        result = callback(scope.repositories);
      } finally {
        scope.revoke();
      }
      if (isPromise(result)) {
        Reflect.apply(promiseThen, result, [undefined, () => {}]);
        throw new TypeError('Repository transaction callback must be synchronous');
      }
      if (result && typeof result.then === 'function') {
        throw new TypeError('Repository transaction callback must be synchronous');
      }
    });
    run();
    return result;
  }

  repositories = Object.freeze({ ...aggregates, withTransaction });
  return repositories;
}

module.exports = {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryError,
  V2RepositoryNotFoundError,
  createV2Repositories,
};
