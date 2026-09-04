const { types: { isPromise } } = require('node:util');

const { createAssetRepository } = require('./assetRepository');
const { createAudioTtsSubmissionStore } = require('../../audio/audioTtsSubmissionStore');
const { createAudioModeIntentRepository } = require('./audioModeIntentRepository');
const {
  createMvpBenchmarkExecutionGate,
} = require('../../benchmark/mvpBenchmarkExecutionGate');
const { createBgmTrackRepository } = require('./bgmTrackRepository');
const { createCharacterCandidateRepository } = require('./characterCandidateRepository');
const {
  createCharacterCandidateExecutionRepository,
} = require('./characterCandidateExecutionRepository');
const { createCharacterReferencePackageRepository } = require('./characterReferencePackageRepository');
const { createCharacterVersionRepository } = require('./characterVersionRepository');
const { createComfyManifestRepository } = require('./comfyManifestRepository');
const { createGenerationHistoryRepository } = require('./generationHistoryRepository');
const { createH3GenerationIntentRepository } = require('./h3GenerationIntentRepository');
const { createMediaExportRunRepository } = require('./mediaExportRunRepository');
const {
  createMvpBenchmarkReadinessRepository,
} = require('./mvpBenchmarkReadinessRepository');
const {
  createMvpBenchmarkExternalAuthorizationRepository,
} = require('./mvpBenchmarkExternalAuthorizationRepository');
const {
  createMvpBenchmarkExecutionPreflightRepository,
} = require('./mvpBenchmarkExecutionPreflightRepository');
const {
  createMvpBenchmarkExecutionAccountingRepository,
} = require('./mvpBenchmarkExecutionAccountingRepository');
const {
  createMvpBenchmarkSessionRepository,
} = require('./mvpBenchmarkSessionRepository');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { createRemoteRepository } = require('./remoteRepository');
const { createProjectArchiveRepository } = require('./projectArchiveRepository');
const { createNarrativeReviewRepository } = require('./narrativeReviewRepository');
const { createNarrativeExecutionRepository } = require('./narrativeExecutionRepository');
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
    exportStructuredV21(...args) {
      return getTarget().exportStructuredV21(...args);
    },
    hasUidConflict(...args) {
      return getTarget().hasUidConflict(...args);
    },
    importSnapshot(...args) {
      return getTarget().importSnapshot(...args);
    },
  });
}

function createLazyMediaExportRunRepository(database) {
  let target;
  function getTarget() {
    if (!target) target = createMediaExportRunRepository(database);
    return target;
  }
  return Object.freeze({
    complete(...args) {
      return getTarget().complete(...args);
    },
    fail(...args) {
      return getTarget().fail(...args);
    },
    get(...args) {
      return getTarget().get(...args);
    },
    getExecutionPlan(...args) {
      return getTarget().getExecutionPlan(...args);
    },
    getBySourceNodeRun(...args) {
      return getTarget().getBySourceNodeRun(...args);
    },
    listByDrama(...args) {
      return getTarget().listByDrama(...args);
    },
    prepareFromNode(...args) {
      return getTarget().prepareFromNode(...args);
    },
    recoverInterrupted(...args) {
      return getTarget().recoverInterrupted(...args);
    },
    start(...args) {
      return getTarget().start(...args);
    },
  });
}

function createLazyNarrativeExecutionRepository(database) {
  let target;
  function getTarget() {
    if (!target) target = createNarrativeExecutionRepository(database);
    return target;
  }
  return Object.freeze({
    complete(...args) {
      return getTarget().complete(...args);
    },
    fail(...args) {
      return getTarget().fail(...args);
    },
    get(...args) {
      return getTarget().get(...args);
    },
    markUnknown(...args) {
      return getTarget().markUnknown(...args);
    },
    recoverInterrupted(...args) {
      return getTarget().recoverInterrupted(...args);
    },
    reserve(...args) {
      return getTarget().reserve(...args);
    },
  });
}

function createLazyCharacterCandidateExecutionRepository(database) {
  let target;
  function getTarget() {
    if (!target) target = createCharacterCandidateExecutionRepository(database);
    return target;
  }
  return Object.freeze({
    complete(...args) { return getTarget().complete(...args); },
    fail(...args) { return getTarget().fail(...args); },
    get(...args) { return getTarget().get(...args); },
    getCharacterSource(...args) { return getTarget().getCharacterSource(...args); },
    markUnknown(...args) { return getTarget().markUnknown(...args); },
    recoverInterrupted(...args) { return getTarget().recoverInterrupted(...args); },
    reserve(...args) { return getTarget().reserve(...args); },
  });
}

function createLazyMvpBenchmarkSessionRepository(database, dependencies) {
  let target;
  function getTarget() {
    if (!target) target = createMvpBenchmarkSessionRepository(database, dependencies);
    return target;
  }
  return Object.freeze({
    get(...args) {
      return getTarget().get(...args);
    },
    getStored(...args) {
      return getTarget().getStored(...args);
    },
    getStoredByWorkflowRun(...args) {
      return getTarget().getStoredByWorkflowRun(...args);
    },
    prepare(...args) {
      return getTarget().prepare(...args);
    },
    prepareFromWorkflow(...args) {
      return getTarget().prepareFromWorkflow(...args);
    },
  });
}

function createLazyMvpBenchmarkExternalAuthorizationRepository(database, dependencies) {
  let target;
  function getTarget() {
    if (!target) target = createMvpBenchmarkExternalAuthorizationRepository(database, dependencies);
    return target;
  }
  const repository = Object.freeze({
    assertAudioIntentExecutionOpen(...args) {
      return getTarget().assertAudioIntentExecutionOpen(...args);
    },
    assertH3TaskExecutionOpen(...args) {
      return getTarget().assertH3TaskExecutionOpen(...args);
    },
    get(...args) {
      return getTarget().get(...args);
    },
    getStoredBySession(...args) {
      return getTarget().getStoredBySession(...args);
    },
    prepare(...args) {
      return getTarget().prepare(...args);
    },
    prepareFromSession(...args) {
      return getTarget().prepareFromSession(...args);
    },
    requireActive(...args) {
      return getTarget().requireActive(...args);
    },
  });
  const executionEvidence = Object.freeze({
    getStored(...args) {
      return getTarget().getStored(...args);
    },
  });
  return Object.freeze({ executionEvidence, repository });
}

function createLazyMvpBenchmarkExecutionPreflightRepository(database, dependencies) {
  let target;
  function getTarget() {
    if (!target) target = createMvpBenchmarkExecutionPreflightRepository(database, dependencies);
    return target;
  }
  const repository = Object.freeze({
    attest(...args) {
      return getTarget().attest(...args);
    },
    getAttestation(...args) {
      return getTarget().getAttestation(...args);
    },
    getBatchByAuthorization(...args) {
      return getTarget().getBatchByAuthorization(...args);
    },
    getStoredBatchByAuthorization(...args) {
      return getTarget().getStoredBatchByAuthorization(...args);
    },
    getBatchPreparation(...args) {
      return getTarget().getBatchPreparation(...args);
    },
    getReservation(...args) {
      return getTarget().getReservation(...args);
    },
    getReservationByItem(...args) {
      return getTarget().getReservationByItem(...args);
    },
    reserve(...args) {
      return getTarget().reserve(...args);
    },
    prepareBatch(...args) {
      return getTarget().prepareBatch(...args);
    },
  });
  const executionEvidence = Object.freeze({
    getStoredAttestation(...args) {
      return getTarget().getStoredAttestation(...args);
    },
    getStoredBatchByAuthorization(...args) {
      return getTarget().getStoredBatchByAuthorization(...args);
    },
    getStoredReservation(...args) {
      return getTarget().getStoredReservation(...args);
    },
  });
  return Object.freeze({ executionEvidence, repository });
}

function createLazyMvpBenchmarkExecutionAccountingRepository(database) {
  let target;
  function getTarget() {
    if (!target) target = createMvpBenchmarkExecutionAccountingRepository(database);
    return target;
  }
  return Object.freeze({
    confirmRelease(...args) { return getTarget().confirmRelease(...args); },
    getActualCostCnyFen(...args) { return getTarget().getActualCostCnyFen(...args); },
    getReleaseObligation(...args) { return getTarget().getReleaseObligation(...args); },
    getSettlement(...args) { return getTarget().getSettlement(...args); },
    getSettlementByReservation(...args) {
      return getTarget().getSettlementByReservation(...args);
    },
    inspectTerminalReservation(...args) {
      return getTarget().inspectTerminalReservation(...args);
    },
    listOpenReleaseObligations(...args) {
      return getTarget().listOpenReleaseObligations(...args);
    },
    recoverOpen(...args) { return getTarget().recoverOpen(...args); },
    settle(...args) { return getTarget().settle(...args); },
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
  const narrativeExecutions = createLazyNarrativeExecutionRepository(database);
  const characterCandidateExecutions = createLazyCharacterCandidateExecutionRepository(database);
  const remote = createRemoteRepository(database);
  const scenePropVersions = createScenePropVersionRepository(database);
  const sources = createSourceRepository(database);
  const narrativeApprovalGate = createNarrativeApprovalGate({ narrativeReviews, sources });
  const runs = createRunRepository(database);
  const workflows = createWorkflowRepository(database);
  const voiceProfiles = createVoiceProfileRepository(database);
  const shotContinuitySnapshots = createShotContinuitySnapshotRepository(database, {
    characterReferencePackages,
    characterVersions,
    requireApprovedShot: narrativeApprovalGate.requireApprovedShot,
    scenePropVersions,
  });
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
  const audioModeIntents = createAudioModeIntentRepository(database, {
    requireApprovedNarrative: narrativeApprovalGate.requireApprovedNarrative,
    runs,
    shotContinuitySnapshots,
    voiceProfiles,
    workflows,
  });
  const audioTtsSubmissions = createAudioTtsSubmissionStore(database, { audioModeIntents });
  const mvpBenchmarkSessions = createLazyMvpBenchmarkSessionRepository(database, {
    assets,
    audioModeIntents,
    h3GenerationIntents,
    remote,
    runs,
    workflows,
  });
  const authorizationFacades = createLazyMvpBenchmarkExternalAuthorizationRepository(database, {
    mvpBenchmarkSessions,
    remote,
  });
  const mvpBenchmarkExternalAuthorizations = authorizationFacades.repository;
  const executionAuthorizations = Object.freeze({
    assertAudioIntentExecutionOpen:
      mvpBenchmarkExternalAuthorizations.assertAudioIntentExecutionOpen,
    assertH3TaskExecutionOpen:
      mvpBenchmarkExternalAuthorizations.assertH3TaskExecutionOpen,
    get: mvpBenchmarkExternalAuthorizations.get,
    getStored: authorizationFacades.executionEvidence.getStored,
    requireActive: mvpBenchmarkExternalAuthorizations.requireActive,
  });
  const preflightFacades = createLazyMvpBenchmarkExecutionPreflightRepository(database, {
    authorizations: executionAuthorizations,
    sessions: mvpBenchmarkSessions,
  });
  const mvpBenchmarkExecutionPreflights = preflightFacades.repository;
  const executionPreflights = Object.freeze({
    getAttestation: mvpBenchmarkExecutionPreflights.getAttestation,
    getBatchByAuthorization: mvpBenchmarkExecutionPreflights.getBatchByAuthorization,
    getStoredAttestation: preflightFacades.executionEvidence.getStoredAttestation,
    getStoredBatchByAuthorization:
      preflightFacades.executionEvidence.getStoredBatchByAuthorization,
    getStoredReservation: preflightFacades.executionEvidence.getStoredReservation,
  });
  const mvpBenchmarkExecutionGate = createMvpBenchmarkExecutionGate({
    audioModeIntents,
    authorizations: executionAuthorizations,
    h3GenerationIntents,
    preflights: executionPreflights,
    remote,
  });
  const mvpBenchmarkExecutionAccounting =
    createLazyMvpBenchmarkExecutionAccountingRepository(database);
  const aggregates = {
    assets,
    audioModeIntents,
    audioTtsSubmissions,
    bgmTracks: createBgmTrackRepository(database),
    characterCandidates: createCharacterCandidateRepository(database),
    characterCandidateExecutions,
    characterReferencePackages,
    characterVersions,
    comfyManifests,
    generationHistory,
    h3GenerationIntents,
    mediaExportRuns: createLazyMediaExportRunRepository(database),
    mvpBenchmarkExternalAuthorizations,
    mvpBenchmarkExecutionAccounting,
    mvpBenchmarkExecutionGate,
    mvpBenchmarkExecutionPreflights,
    mvpBenchmarkReadiness: createMvpBenchmarkReadinessRepository(database),
    mvpBenchmarkSessions,
    narrativeReviews,
    narrativeExecutions,
    projectArchives: createLazyProjectArchiveRepository(database),
    remote,
    runs,
    scenePropVersions,
    shotContinuitySnapshots,
    sources,
    voiceProfiles,
    workflows,
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
  createMvpBenchmarkReadinessRepository,
  createV2Repositories,
};
