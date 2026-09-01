'use strict';

const { randomUUID } = require('node:crypto');
const { types: { isPromise, isProxy } } = require('node:util');

const { createNarrativeReviewService, isNarrativeReviewError } = require('../reviews');
const { NarrativeTaskError } = require('../tasks/errors');
const {
  createEpisodeAdaptationTask,
  createNovelExtractionTask,
  createScriptFormattingTask,
  createShotPlanningTask,
} = require('../tasks');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2/errors');
const {
  narrativeExecutionRequestSha256,
  parseNarrativeExecutionRequest,
} = require('./request');
const {
  createNarrativePromise,
  observeNarrativePromise,
  rejectNarrativePromise,
  settleNarrativeProviderPromise,
} = require('./asyncControl');
const {
  NarrativeExecutionSourceError,
  createNarrativeExecutionSourceResolver,
} = require('./sourceResolver');
const {
  narrativeExecutionExpectedInputHash,
} = require('./expectedInput');

const PROVIDER_OUTPUT_KEYS = Object.freeze([
  'model', 'parameters', 'promptVersion', 'rawResponse',
]);
const VERSION = /^[a-z][a-z0-9.-]{0,127}$/u;
const DEFAULT_TIMEOUT_MS = 120000;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const MAP_DELETE = Map.prototype.delete;
const TRUSTED_ERRORS = new WeakSet();

const TASKS = Object.freeze({
  extraction: createNovelExtractionTask(),
  adaptation: createEpisodeAdaptationTask(),
  script: createScriptFormattingTask(),
  shot: createShotPlanningTask(),
});

class NarrativeExecutionError extends Error {
  constructor(code) {
    super('Narrative execution failed');
    this.name = 'NarrativeExecutionError';
    this.code = code;
    TRUSTED_ERRORS.add(this);
    Object.freeze(this);
  }
}

function isNarrativeExecutionError(error) {
  return TRUSTED_ERRORS.has(error);
}

function fail(code) {
  throw new NarrativeExecutionError(code);
}

function exactProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider) || isProxy(provider)) {
    throw new TypeError('Narrative execution provider is invalid');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(provider);
    descriptors = Object.getOwnPropertyDescriptors(provider);
  } catch {
    throw new TypeError('Narrative execution provider is invalid');
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== 3) {
    throw new TypeError('Narrative execution provider is invalid');
  }
  const scope = descriptors.scope;
  const isAvailable = descriptors.isAvailable;
  const generate = descriptors.generate;
  if (!scope?.enumerable || !Object.hasOwn(scope, 'value') || scope.value !== 'configured-text'
    || !isAvailable?.enumerable || !Object.hasOwn(isAvailable, 'value')
    || typeof isAvailable.value !== 'function' || isProxy(isAvailable.value)
    || !generate?.enumerable || !Object.hasOwn(generate, 'value')
    || typeof generate.value !== 'function' || isProxy(generate.value)) {
    throw new TypeError('Narrative execution provider is invalid');
  }
  return Object.freeze({
    scope: scope.value,
    isAvailable: isAvailable.value,
    generate: generate.value,
  });
}

function providerOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('NARRATIVE_EXECUTION_OUTPUT_INVALID');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail('NARRATIVE_EXECUTION_OUTPUT_INVALID');
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== PROVIDER_OUTPUT_KEYS.length) {
    fail('NARRATIVE_EXECUTION_OUTPUT_INVALID');
  }
  const output = Object.create(null);
  for (let index = 0; index < PROVIDER_OUTPUT_KEYS.length; index += 1) {
    const key = PROVIDER_OUTPUT_KEYS[index];
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('NARRATIVE_EXECUTION_OUTPUT_INVALID');
    }
    output[key] = descriptor.value;
  }
  if (typeof output.promptVersion !== 'string' || !VERSION.test(output.promptVersion)
    || typeof output.rawResponse !== 'string'
    || Buffer.byteLength(output.rawResponse, 'utf8') > 4 * 1024 * 1024) {
    fail('NARRATIVE_EXECUTION_OUTPUT_INVALID');
  }
  return output;
}

function createNarrativeExecutionService({
  repositories,
  provider,
  assetOwnership,
  createUid = randomUUID,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!repositories?.narrativeExecutions || !repositories?.narrativeReviews
    || !repositories?.sources || typeof repositories?.withTransaction !== 'function'
    || typeof createUid !== 'function' || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 300000) {
    throw new TypeError('Narrative execution service dependencies are invalid');
  }
  const configuredProvider = exactProvider(provider);
  const reviews = createNarrativeReviewService({ repositories, createUid });
  const resolver = createNarrativeExecutionSourceResolver({
    repositories,
    reviewService: reviews,
    assetOwnership,
  });
  const active = new Map();

  function resolveContext(currentRepositories, request) {
    if (currentRepositories === repositories) return resolver.resolve(request);
    const currentReviews = createNarrativeReviewService({
      repositories: currentRepositories,
      createUid,
    });
    return createNarrativeExecutionSourceResolver({
      repositories: currentRepositories,
      reviewService: currentReviews,
      assetOwnership,
    }).resolve(request);
  }

  function resolveExpectedInputHash(currentRepositories, request) {
    const context = resolveContext(currentRepositories, request);
    return Object.freeze({
      context,
      expectedInputHash: narrativeExecutionExpectedInputHash(request.resultType, context),
    });
  }

  function translateRead(action) {
    try { return action(); } catch (error) {
      if (error instanceof V2RepositoryNotFoundError) return null;
      if (error instanceof V2RepositoryConflictError) fail('NARRATIVE_EXECUTION_CONFLICT');
      if (error instanceof V2RepositoryDataError) fail('NARRATIVE_EXECUTION_DATA_INVALID');
      throw error;
    }
  }

  function terminal(execution) {
    if (execution.state === 'succeeded') {
      let current;
      let detail;
      try {
        current = resolveExpectedInputHash(repositories, execution.request);
        detail = reviews.getResult(execution.resultUid);
      } catch (error) {
        if (error instanceof NarrativeExecutionSourceError
          || error instanceof V2RepositoryNotFoundError
          || error instanceof V2RepositoryDataError
          || isNarrativeReviewError(error)) {
          return fail('NARRATIVE_EXECUTION_SOURCE_STALE');
        }
        return fail('NARRATIVE_EXECUTION_DATA_INVALID');
      }
      if (execution.expectedInputHash !== current.expectedInputHash
        || detail.result.result.inputHash !== execution.expectedInputHash) {
        return fail('NARRATIVE_EXECUTION_SOURCE_STALE');
      }
      return Object.freeze({ execution, result: detail.result });
    }
    if (execution.state === 'failed') fail(execution.errorCode);
    if (execution.state === 'submission_unknown') {
      fail('NARRATIVE_EXECUTION_SUBMISSION_UNKNOWN');
    }
    return null;
  }

  function mark(operationUid, method, code) {
    try {
      return repositories.narrativeExecutions[method](operationUid, code);
    } catch {
      return fail('NARRATIVE_EXECUTION_DATA_INVALID');
    }
  }

  async function run(request) {
    const prior = translateRead(() => repositories.narrativeExecutions.get(request.operationUid));
    if (prior !== null) {
      if (prior.requestSha256 !== narrativeExecutionRequestSha256(request)) {
        fail('NARRATIVE_EXECUTION_CONFLICT');
      }
      const priorResult = terminal(prior);
      if (priorResult) return priorResult;
      fail('NARRATIVE_EXECUTION_IN_PROGRESS');
    }

    let resolved;
    try { resolved = resolveExpectedInputHash(repositories, request); } catch (error) {
      if (error instanceof NarrativeExecutionSourceError
        || error instanceof V2RepositoryNotFoundError
        || error instanceof V2RepositoryDataError
        || isNarrativeReviewError(error)) {
        return fail('NARRATIVE_EXECUTION_SOURCE_STALE');
      }
      throw error;
    }
    const { context, expectedInputHash } = resolved;

    let reservation;
    try {
      reservation = repositories.narrativeExecutions.reserve(request, expectedInputHash);
    } catch (error) {
      if (error instanceof V2RepositoryConflictError) {
        try {
          const current = resolveExpectedInputHash(repositories, request);
          if (current.expectedInputHash !== expectedInputHash) throw new TypeError();
        } catch {
          return fail('NARRATIVE_EXECUTION_SOURCE_STALE');
        }
        fail('NARRATIVE_EXECUTION_CONFLICT');
      }
      if (error instanceof V2RepositoryDataError) fail('NARRATIVE_EXECUTION_DATA_INVALID');
      throw error;
    }
    const existingResult = terminal(reservation.execution);
    if (existingResult) return existingResult;
    if (!reservation.created) fail('NARRATIVE_EXECUTION_IN_PROGRESS');

    let generated;
    try {
      generated = Reflect.apply(configuredProvider.generate, configuredProvider, [{
        schemaVersion: 'narrative-generation-command.v1',
        resultType: request.resultType,
        source: context.source,
        domain: context.domain,
      }]);
    } catch {
      mark(request.operationUid, 'fail', 'NARRATIVE_EXECUTION_PROVIDER_FAILED');
      return fail('NARRATIVE_EXECUTION_PROVIDER_FAILED');
    }
    if (isPromise(generated)) {
      try {
        generated = await settleNarrativeProviderPromise(generated, timeoutMs);
      } catch {
        mark(request.operationUid, 'markUnknown');
        return fail('NARRATIVE_EXECUTION_SUBMISSION_UNKNOWN');
      }
    }

    let result;
    try {
      const output = providerOutput(generated);
      const input = {
        ...(request.resultType === 'extraction'
          ? { source: context.source } : context.domain),
        promptVersion: output.promptVersion,
        model: output.model,
        parameters: output.parameters,
        rawResponseRef: `response:v1:${createUid()}`,
        rawResponse: output.rawResponse,
      };
      result = TASKS[request.resultType].complete(input);
    } catch (error) {
      if (error instanceof NarrativeExecutionError
        || error instanceof NarrativeTaskError) {
        mark(request.operationUid, 'fail', 'NARRATIVE_EXECUTION_OUTPUT_INVALID');
        return fail('NARRATIVE_EXECUTION_OUTPUT_INVALID');
      }
      throw error;
    }
    if (result.inputHash !== expectedInputHash) {
      mark(request.operationUid, 'fail', 'NARRATIVE_EXECUTION_SOURCE_STALE');
      fail('NARRATIVE_EXECUTION_SOURCE_STALE');
    }

    try {
      const stored = repositories.withTransaction((scoped) => {
        let current;
        try {
          current = resolveExpectedInputHash(scoped, request);
        } catch (error) {
          if (error instanceof NarrativeExecutionSourceError
            || error instanceof V2RepositoryNotFoundError
            || error instanceof V2RepositoryDataError
            || isNarrativeReviewError(error)) {
            throw new NarrativeExecutionSourceError();
          }
          throw error;
        }
        if (current.expectedInputHash !== expectedInputHash) {
          throw new NarrativeExecutionSourceError();
        }
        const scopedReviews = createNarrativeReviewService({ repositories: scoped, createUid });
        const record = scopedReviews.recordResult({
          dramaUid: request.dramaUid,
          sourceSelectionUid: request.sourceSelectionUid,
          resultType: request.resultType,
          ...(request.upstreamResultUid === null
            ? {} : { upstreamResultUid: request.upstreamResultUid }),
          result,
        });
        const execution = scoped.narrativeExecutions.complete(request.operationUid, record.uid);
        return Object.freeze({ execution, result: record });
      });
      return stored;
    } catch (error) {
      if (error instanceof NarrativeExecutionSourceError || isNarrativeReviewError(error)) {
        mark(request.operationUid, 'fail', 'NARRATIVE_EXECUTION_SOURCE_STALE');
        return fail('NARRATIVE_EXECUTION_SOURCE_STALE');
      }
      mark(request.operationUid, 'markUnknown');
      return fail('NARRATIVE_EXECUTION_SUBMISSION_UNKNOWN');
    }
  }

  return Object.freeze({
    execute(value) {
      let request;
      try { request = parseNarrativeExecutionRequest(value); } catch {
        return rejectNarrativePromise(
          new NarrativeExecutionError('NARRATIVE_EXECUTION_INPUT_INVALID'),
        );
      }
      const requestSha256 = narrativeExecutionRequestSha256(request);
      const running = Reflect.apply(MAP_GET, active, [request.operationUid]);
      if (running) {
        if (running.requestSha256 !== requestSha256) {
          return rejectNarrativePromise(
            new NarrativeExecutionError('NARRATIVE_EXECUTION_CONFLICT'),
          );
        }
        return running.promise;
      }
      let resolveExecution;
      let rejectExecution;
      const promise = createNarrativePromise((resolve, reject) => {
        resolveExecution = resolve;
        rejectExecution = reject;
      });
      Reflect.apply(MAP_SET, active, [request.operationUid, Object.freeze({
        promise,
        requestSha256,
      })]);
      const finish = (callback, output) => {
        Reflect.apply(MAP_DELETE, active, [request.operationUid]);
        callback(output);
      };
      try {
        observeNarrativePromise(
          run(request),
          (output) => finish(resolveExecution, output),
          (error) => finish(rejectExecution, error),
        );
      } catch (error) {
        finish(rejectExecution, error);
      }
      return promise;
    },

    get(operationUid) {
      const execution = translateRead(() => repositories.narrativeExecutions.get(operationUid));
      if (execution === null) fail('NARRATIVE_EXECUTION_NOT_FOUND');
      return terminal(execution) || Object.freeze({ execution, result: null });
    },
  });
}

module.exports = Object.freeze({
  NarrativeExecutionError,
  createNarrativeExecutionService,
  isNarrativeExecutionError,
});
