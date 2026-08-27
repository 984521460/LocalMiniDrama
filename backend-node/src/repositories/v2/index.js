const { types: { isPromise } } = require('node:util');

const { createAssetRepository } = require('./assetRepository');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { createRemoteRepository } = require('./remoteRepository');
const { createProjectArchiveRepository } = require('./projectArchiveRepository');
const { createNarrativeReviewRepository } = require('./narrativeReviewRepository');
const { assertDatabase } = require('./repositorySupport');
const { createRunRepository } = require('./runRepository');
const { createSourceRepository } = require('./sourceRepository');
const { createWorkflowRepository } = require('./workflowRepository');

const promiseThen = Promise.prototype.then;

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

  const aggregates = {
    assets: createAssetRepository(database),
    narrativeReviews: createNarrativeReviewRepository(database),
    projectArchives: createProjectArchiveRepository(database),
    remote: createRemoteRepository(database),
    runs: createRunRepository(database),
    sources: createSourceRepository(database),
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
