'use strict';

const express = require('express');
const { randomUUID } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const {
  createMvpBenchmarkReadiness,
  parseMvpBenchmarkReadiness,
} = require('../../benchmark/mvpBenchmarkReadiness');
const {
  createMvpBenchmarkReadinessRepository,
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
  createV2Repositories,
} = require('../../repositories/v2');
const {
  isMvpBenchmarkSessionError,
} = require('../../benchmark/mvpBenchmarkSession');
const {
  isMvpBenchmarkExternalAuthorizationError,
  parseMvpBenchmarkExternalAuthorizationUid,
} = require('../../benchmark/mvpBenchmarkExternalAuthorization');
const {
  isMvpBenchmarkExecutionPreflightError,
} = require('../../benchmark/mvpBenchmarkExecutionPreflight');
const {
  isMvpBenchmarkProductionExecutionError,
} = require('../../benchmark/mvpBenchmarkProductionExecutionService');
const {
  isMvpBenchmarkFinalizationError,
} = require('../../benchmark/mvpBenchmarkFinalizationService');
const {
  isMvpBenchmarkHumanAvReviewError,
} = require('../../benchmark/mvpBenchmarkHumanAvReview');
const {
  MvpBenchmarkAccountingStatusError,
} = require('../../benchmark/mvpBenchmarkAccountingStatusService');
const {
  MvpBenchmarkCloseoutStatusError,
  REQUEST_SCHEMA_VERSION: CLOSEOUT_REQUEST_SCHEMA_VERSION,
} = require('../../benchmark/mvpBenchmarkCloseoutStatus');
const { MvpBenchmarkResumeError } = require('../../benchmark/mvpBenchmarkResumeService');
const response = require('../../response');

const DATE_NOW = Date.now;
const ARRAY_IS_ARRAY = Array.isArray;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_CREATE = Object.create;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REFLECT_APPLY = Reflect.apply;
const SHA256 = /^[0-9a-f]{64}$/u;

function exactEmptyBody(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || ARRAY_IS_ARRAY(value)) return false;
  try {
    const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
    const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
    return (prototype === Object.prototype || prototype === null)
      && REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]).length === 0;
  } catch {
    return false;
  }
}

function exactAuthorizationSeed(value) {
  const keys = ['maximumCostCnyFen', 'validityDurationMs'];
  if (!value || typeof value !== 'object' || isProxy(value) || ARRAY_IS_ARRAY(value)) return null;
  try {
    const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
    const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
    if ((prototype !== Object.prototype && prototype !== null)
      || REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]).length !== keys.length) return null;
    const output = REFLECT_APPLY(OBJECT_CREATE, Object, [null]);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptors, key])) return null;
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable
        || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function exactExecutionSeed(value) {
  const keys = [
    'schemaVersion', 'expectedBatchSha256', 'expectedOrdinal', 'expectedItemKind',
    'expectedItemUid',
  ];
  if (!value || typeof value !== 'object' || isProxy(value) || ARRAY_IS_ARRAY(value)) return null;
  try {
    const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
    const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
    if ((prototype !== Object.prototype && prototype !== null)
      || REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]).length !== keys.length) return null;
    const output = REFLECT_APPLY(OBJECT_CREATE, Object, [null]);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptors, key])) return null;
      const descriptor = descriptors[key];
      if (!descriptor.enumerable
        || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function exactFinalizationSeed(value) {
  const keys = ['schemaVersion', 'expectedBatchSha256', 'bgmTrackUid'];
  if (!value || typeof value !== 'object' || isProxy(value) || ARRAY_IS_ARRAY(value)) {
    return null;
  }
  try {
    const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
    const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
    if ((prototype !== Object.prototype && prototype !== null)
      || REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]).length !== keys.length) {
      return null;
    }
    const output = REFLECT_APPLY(OBJECT_CREATE, Object, [null]);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptors, key])) return null;
      const descriptor = descriptors[key];
      if (!descriptor.enumerable
        || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function exactHumanAvReviewSeed(value) {
  const keys = [
    'schemaVersion', 'expectedBatchSha256', 'exportRunUid',
    'videoPlaybackAccepted', 'subtitleSyncAccepted', 'bgmBalanceAccepted', 'reviewNote',
  ];
  if (!value || typeof value !== 'object' || isProxy(value) || ARRAY_IS_ARRAY(value)) {
    return null;
  }
  try {
    const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
    const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
    if ((prototype !== Object.prototype && prototype !== null)
      || REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]).length !== keys.length) {
      return null;
    }
    const output = REFLECT_APPLY(OBJECT_CREATE, Object, [null]);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptors, key])) return null;
      const descriptor = descriptors[key];
      if (!descriptor.enumerable
        || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function mvpBenchmarkRoutes(log, runtime, database) {
  const router = express.Router();
  const readinessRepository = createMvpBenchmarkReadinessRepository(database);
  const repositories = createV2Repositories(database);
  const sessionRepository = repositories.mvpBenchmarkSessions;
  const authorizationRepository = repositories.mvpBenchmarkExternalAuthorizations;
  const preflightRepository = repositories.mvpBenchmarkExecutionPreflights;

  function preflightService() {
    try {
      if (!runtime || typeof runtime !== 'object' || isProxy(runtime)) return null;
      const benchmarkRuntime = Object.getOwnPropertyDescriptor(runtime, 'mvpBenchmark')?.value;
      if (!benchmarkRuntime || typeof benchmarkRuntime !== 'object'
        || isProxy(benchmarkRuntime)) return null;
      const service = benchmarkRuntime
        && Object.getOwnPropertyDescriptor(benchmarkRuntime, 'preflight')?.value;
      if (!service || typeof service !== 'object' || isProxy(service)) return null;
      const prepareBatch = service
        && Object.getOwnPropertyDescriptor(service, 'prepareBatch')?.value;
      if (typeof prepareBatch !== 'function' || isProxy(prepareBatch)) return null;
      return Object.freeze({ service, prepareBatch });
    } catch {
      return null;
    }
  }

  function executionService() {
    try {
      if (!runtime || typeof runtime !== 'object' || isProxy(runtime)) return null;
      const benchmarkRuntime = Object.getOwnPropertyDescriptor(runtime, 'mvpBenchmark')?.value;
      if (!benchmarkRuntime || typeof benchmarkRuntime !== 'object'
        || isProxy(benchmarkRuntime)) return null;
      const service = Object.getOwnPropertyDescriptor(benchmarkRuntime, 'execution')?.value;
      if (!service || typeof service !== 'object' || isProxy(service)) return null;
      const executeNext = Object.getOwnPropertyDescriptor(service, 'executeNext')?.value;
      const readProgress = Object.getOwnPropertyDescriptor(service, 'readProgress')?.value;
      if (typeof executeNext !== 'function' || isProxy(executeNext)
        || typeof readProgress !== 'function' || isProxy(readProgress)) return null;
      return Object.freeze({ service, executeNext, readProgress });
    } catch {
      return null;
    }
  }

  function finalizationService() {
    try {
      if (!runtime || typeof runtime !== 'object' || isProxy(runtime)) return null;
      const benchmarkRuntime = Object.getOwnPropertyDescriptor(runtime, 'mvpBenchmark')?.value;
      if (!benchmarkRuntime || typeof benchmarkRuntime !== 'object'
        || isProxy(benchmarkRuntime)) return null;
      const service = Object.getOwnPropertyDescriptor(benchmarkRuntime, 'finalization')?.value;
      if (!service || typeof service !== 'object' || isProxy(service)) return null;
      const finalize = Object.getOwnPropertyDescriptor(service, 'finalize')?.value;
      if (typeof finalize !== 'function' || isProxy(finalize)) return null;
      return Object.freeze({ finalize, service });
    } catch {
      return null;
    }
  }

  function humanAvReviewService() {
    try {
      if (!runtime || typeof runtime !== 'object' || isProxy(runtime)) return null;
      const benchmarkRuntime = Object.getOwnPropertyDescriptor(runtime, 'mvpBenchmark')?.value;
      if (!benchmarkRuntime || typeof benchmarkRuntime !== 'object'
        || isProxy(benchmarkRuntime)) return null;
      const service = Object.getOwnPropertyDescriptor(benchmarkRuntime, 'humanAvReview')?.value;
      if (!service || typeof service !== 'object' || isProxy(service)) return null;
      const review = Object.getOwnPropertyDescriptor(service, 'review')?.value;
      const get = Object.getOwnPropertyDescriptor(service, 'get')?.value;
      if (typeof review !== 'function' || isProxy(review)
        || typeof get !== 'function' || isProxy(get)) return null;
      return Object.freeze({ get, review, service });
    } catch {
      return null;
    }
  }

  function resumeService() {
    try {
      if (!runtime || typeof runtime !== 'object' || isProxy(runtime)) return null;
      const benchmarkRuntime = Object.getOwnPropertyDescriptor(runtime, 'mvpBenchmark')?.value;
      if (!benchmarkRuntime || typeof benchmarkRuntime !== 'object'
        || isProxy(benchmarkRuntime)) return null;
      const service = Object.getOwnPropertyDescriptor(benchmarkRuntime, 'resume')?.value;
      if (!service || typeof service !== 'object' || isProxy(service)) return null;
      const read = Object.getOwnPropertyDescriptor(service, 'read')?.value;
      if (typeof read !== 'function' || isProxy(read)) return null;
      return Object.freeze({ read, service });
    } catch {
      return null;
    }
  }

  function accountingStatusService() {
    try {
      if (!runtime || typeof runtime !== 'object' || isProxy(runtime)) return null;
      const benchmarkRuntime = Object.getOwnPropertyDescriptor(runtime, 'mvpBenchmark')?.value;
      if (!benchmarkRuntime || typeof benchmarkRuntime !== 'object'
        || isProxy(benchmarkRuntime)) return null;
      const service = Object.getOwnPropertyDescriptor(benchmarkRuntime, 'accountingStatus')?.value;
      if (!service || typeof service !== 'object' || isProxy(service)) return null;
      const read = Object.getOwnPropertyDescriptor(service, 'read')?.value;
      if (typeof read !== 'function' || isProxy(read)) return null;
      return Object.freeze({ read, service });
    } catch {
      return null;
    }
  }

  function closeoutStatusService() {
    try {
      if (!runtime || typeof runtime !== 'object' || isProxy(runtime)) return null;
      const benchmarkRuntime = Object.getOwnPropertyDescriptor(runtime, 'mvpBenchmark')?.value;
      if (!benchmarkRuntime || typeof benchmarkRuntime !== 'object'
        || isProxy(benchmarkRuntime)) return null;
      const service = Object.getOwnPropertyDescriptor(benchmarkRuntime, 'closeoutStatus')?.value;
      if (!service || typeof service !== 'object' || isProxy(service)) return null;
      const read = Object.getOwnPropertyDescriptor(service, 'read')?.value;
      if (typeof read !== 'function' || isProxy(read)) return null;
      return Object.freeze({ read, service });
    } catch {
      return null;
    }
  }

  function sessionError(res, error) {
    if (error instanceof V2RepositoryNotFoundError) {
      return response.error(res, 404, 'MVP_BENCHMARK_SESSION_NOT_FOUND', 'MVP benchmark session was not found');
    }
    if (error instanceof V2RepositoryConflictError) {
      return response.error(res, 409, 'MVP_BENCHMARK_SESSION_CONFLICT', 'MVP benchmark session source state conflicts with the request');
    }
    if (error instanceof V2RepositoryDataError) {
      return response.error(res, 409, 'MVP_BENCHMARK_SESSION_DATA_INVALID', 'MVP benchmark session state is invalid');
    }
    if (isMvpBenchmarkSessionError(error) || error instanceof TypeError) {
      return response.error(res, 400, 'MVP_BENCHMARK_SESSION_INPUT_INVALID', 'MVP benchmark session request is invalid');
    }
    log?.error?.('mvp-benchmark-session-unexpected', {
      code: 'MVP_BENCHMARK_SESSION_UNEXPECTED',
    });
    return response.error(res, 500, 'MVP_BENCHMARK_SESSION_UNEXPECTED', 'MVP benchmark session operation failed');
  }

  function authorizationError(res, error) {
    if (error instanceof V2RepositoryNotFoundError) {
      return response.error(res, 404, 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_NOT_FOUND', 'MVP benchmark external authorization was not found');
    }
    if (error instanceof V2RepositoryConflictError) {
      return response.error(res, 409, 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_CONFLICT', 'MVP benchmark external authorization source state conflicts with the request');
    }
    if (error instanceof V2RepositoryDataError) {
      return response.error(res, 409, 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_DATA_INVALID', 'MVP benchmark external authorization state is invalid');
    }
    if (isMvpBenchmarkExternalAuthorizationError(error) || error instanceof TypeError) {
      return response.error(res, 400, 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID', 'MVP benchmark external authorization request is invalid');
    }
    log?.error?.('mvp-benchmark-external-authorization-unexpected', {
      code: 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_UNEXPECTED',
    });
    return response.error(res, 500, 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_UNEXPECTED', 'MVP benchmark external authorization operation failed');
  }

  function preflightError(res, error) {
    if (error instanceof V2RepositoryNotFoundError) {
      return response.error(res, 404, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_NOT_FOUND', 'MVP benchmark execution preflight was not found');
    }
    if (error instanceof V2RepositoryConflictError) {
      return response.error(res, 409, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_CONFLICT', 'MVP benchmark execution preflight source state conflicts with the request');
    }
    if (error instanceof V2RepositoryDataError) {
      return response.error(res, 409, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_DATA_INVALID', 'MVP benchmark execution preflight state is invalid');
    }
    if (isMvpBenchmarkExecutionPreflightError(error)) {
      if (error.code === 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE') {
        return response.error(res, 503, error.code, 'MVP benchmark execution preflight is unavailable');
      }
      if (error.code === 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_EXPIRED') {
        return response.error(res, 409, error.code, 'MVP benchmark execution preflight has expired');
      }
      return response.error(res, 400, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID', 'MVP benchmark execution preflight request is invalid');
    }
    if (isMvpBenchmarkExternalAuthorizationError(error)) {
      if (error.code === 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_EXPIRED') {
        return response.error(res, 409, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_EXPIRED', 'MVP benchmark execution preflight has expired');
      }
      if (error.code === 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_DATA_INVALID') {
        return response.error(res, 409, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_DATA_INVALID', 'MVP benchmark execution preflight state is invalid');
      }
      return response.error(res, 400, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID', 'MVP benchmark execution preflight request is invalid');
    }
    if (error instanceof TypeError) {
      return response.error(res, 400, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID', 'MVP benchmark execution preflight request is invalid');
    }
    log?.error?.('mvp-benchmark-execution-preflight-unexpected', {
      code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNEXPECTED',
    });
    return response.error(res, 500, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNEXPECTED', 'MVP benchmark execution preflight operation failed');
  }

  function executionError(res, error) {
    if (isMvpBenchmarkProductionExecutionError(error)) {
      const status = error.code === 'MVP_BENCHMARK_PRODUCTION_EXECUTION_INPUT_INVALID' ? 400
        : error.code === 'MVP_BENCHMARK_PRODUCTION_EXECUTION_IN_PROGRESS' ? 409
          : error.code === 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE' ? 503 : 502;
      return response.error(res, status, error.code, error.message);
    }
    if (isMvpBenchmarkExternalAuthorizationError(error)) {
      return response.error(
        res, 409, 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
        'MVP benchmark production execution is unavailable',
      );
    }
    if (error instanceof TypeError) {
      return response.error(
        res, 400, 'MVP_BENCHMARK_PRODUCTION_EXECUTION_INPUT_INVALID',
        'MVP benchmark production execution input is invalid',
      );
    }
    log?.error?.('mvp-benchmark-production-execution-unexpected', {
      code: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNEXPECTED',
    });
    return response.error(
      res, 500, 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNEXPECTED',
      'MVP benchmark production execution failed',
    );
  }

  function finalizationError(res, error) {
    if (isMvpBenchmarkFinalizationError(error)) {
      const status = error.code === 'MVP_BENCHMARK_FINALIZATION_INPUT_INVALID' ? 400
        : error.code === 'MVP_BENCHMARK_FINALIZATION_IN_PROGRESS' ? 409
          : error.code === 'MVP_BENCHMARK_FINALIZATION_UNAVAILABLE' ? 409 : 502;
      return response.error(res, status, error.code, error.message);
    }
    if (error instanceof V2RepositoryNotFoundError) {
      return response.error(
        res, 404, 'MVP_BENCHMARK_FINALIZATION_UNAVAILABLE',
        'MVP benchmark finalization is unavailable',
      );
    }
    if (error instanceof V2RepositoryConflictError || error instanceof V2RepositoryDataError) {
      return response.error(
        res, 409, 'MVP_BENCHMARK_FINALIZATION_UNAVAILABLE',
        'MVP benchmark finalization is unavailable',
      );
    }
    log?.error?.('mvp-benchmark-finalization-unexpected', {
      code: 'MVP_BENCHMARK_FINALIZATION_UNEXPECTED',
    });
    return response.error(
      res, 500, 'MVP_BENCHMARK_FINALIZATION_UNEXPECTED',
      'MVP benchmark finalization failed',
    );
  }

  function humanAvReviewError(res, error) {
    if (isMvpBenchmarkHumanAvReviewError(error)) {
      const status = error.code === 'MVP_BENCHMARK_HUMAN_AV_REVIEW_INPUT_INVALID'
        ? 400 : error.code === 'MVP_BENCHMARK_HUMAN_AV_REVIEW_NOT_FOUND' ? 404 : 409;
      return response.error(res, status, error.code, error.message);
    }
    if (error instanceof V2RepositoryConflictError || error instanceof V2RepositoryDataError) {
      return response.error(
        res, 409, 'MVP_BENCHMARK_HUMAN_AV_REVIEW_UNAVAILABLE',
        'MVP benchmark human audiovisual review is unavailable',
      );
    }
    if (error instanceof TypeError) {
      return response.error(
        res, 400, 'MVP_BENCHMARK_HUMAN_AV_REVIEW_INPUT_INVALID',
        'MVP benchmark human audiovisual review input is invalid',
      );
    }
    log?.error?.('mvp-benchmark-human-av-review-unexpected', {
      code: 'MVP_BENCHMARK_HUMAN_AV_REVIEW_UNEXPECTED',
    });
    return response.error(
      res, 500, 'MVP_BENCHMARK_HUMAN_AV_REVIEW_UNEXPECTED',
      'MVP benchmark human audiovisual review failed',
    );
  }

  function resumeError(res, error) {
    if (error instanceof MvpBenchmarkResumeError) {
      const status = error.code === 'MVP_BENCHMARK_RESUME_INPUT_INVALID' ? 400 : 409;
      return response.error(res, status, error.code, error.message);
    }
    log?.error?.('mvp-benchmark-resume-unexpected', {
      code: 'MVP_BENCHMARK_RESUME_UNEXPECTED',
    });
    return response.error(
      res, 500, 'MVP_BENCHMARK_RESUME_UNEXPECTED',
      'MVP benchmark resume operation failed',
    );
  }

  function accountingStatusError(res, error) {
    if (error instanceof MvpBenchmarkAccountingStatusError) {
      const status = error.code === 'MVP_BENCHMARK_ACCOUNTING_STATUS_INPUT_INVALID'
        ? 400 : 409;
      return response.error(res, status, error.code, error.message);
    }
    if (error instanceof V2RepositoryNotFoundError) {
      return response.error(
        res, 404, 'MVP_BENCHMARK_ACCOUNTING_STATUS_NOT_FOUND',
        'MVP benchmark accounting status was not found',
      );
    }
    if (error instanceof V2RepositoryConflictError || error instanceof V2RepositoryDataError) {
      return response.error(
        res, 409, 'MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE',
        'MVP benchmark accounting status is unavailable',
      );
    }
    log?.error?.('mvp-benchmark-accounting-status-unexpected', {
      code: 'MVP_BENCHMARK_ACCOUNTING_STATUS_UNEXPECTED',
    });
    return response.error(
      res, 500, 'MVP_BENCHMARK_ACCOUNTING_STATUS_UNEXPECTED',
      'MVP benchmark accounting status operation failed',
    );
  }

  function closeoutStatusError(res, error) {
    if (error instanceof MvpBenchmarkCloseoutStatusError) {
      const status = error.code === 'MVP_BENCHMARK_CLOSEOUT_STATUS_INPUT_INVALID'
        ? 400 : 409;
      return response.error(res, status, error.code, error.message);
    }
    if (error instanceof V2RepositoryNotFoundError) {
      return response.error(
        res, 404, 'MVP_BENCHMARK_CLOSEOUT_STATUS_NOT_FOUND',
        'MVP benchmark closeout status was not found',
      );
    }
    if (error instanceof V2RepositoryConflictError || error instanceof V2RepositoryDataError) {
      return response.error(
        res, 409, 'MVP_BENCHMARK_CLOSEOUT_STATUS_UNAVAILABLE',
        'MVP benchmark closeout status is unavailable',
      );
    }
    log?.error?.('mvp-benchmark-closeout-status-unexpected', {
      code: 'MVP_BENCHMARK_CLOSEOUT_STATUS_UNEXPECTED',
    });
    return response.error(
      res, 500, 'MVP_BENCHMARK_CLOSEOUT_STATUS_UNEXPECTED',
      'MVP benchmark closeout status operation failed',
    );
  }

  function pathAuthorization(parameters) {
    const dramaUid = parseMvpBenchmarkExternalAuthorizationUid(parameters.dramaUid);
    const sessionUid = parseMvpBenchmarkExternalAuthorizationUid(parameters.sessionUid);
    const authorizationUid = parseMvpBenchmarkExternalAuthorizationUid(
      parameters.authorizationUid,
    );
    const authorization = authorizationRepository.get(authorizationUid);
    if (authorization.dramaUid !== dramaUid || authorization.sessionUid !== sessionUid) {
      throw new V2RepositoryNotFoundError('MVP benchmark execution preflight');
    }
    return authorization;
  }

  router.get('/mvp-benchmark/readiness', (_req, res) => {
    try {
      const readiness = createMvpBenchmarkReadiness({ runtime, readinessRepository });
      return response.success(
        res,
        parseMvpBenchmarkReadiness(readiness, { runtime, readinessRepository }),
      );
    } catch {
      log?.error?.('mvp-benchmark-readiness-unexpected', {
        code: 'MVP_BENCHMARK_READINESS_UNEXPECTED',
      });
      return response.error(
        res,
        500,
        'MVP_BENCHMARK_READINESS_UNEXPECTED',
        'MVP benchmark readiness could not be assessed',
      );
    }
  });

  router.get(
    '/dramas/:dramaUid/mvp-benchmark/workflow-runs/:workflowRunUid/resume',
    async (req, res) => {
      try {
        const configured = resumeService();
        if (!configured) {
          return response.error(
            res, 503, 'MVP_BENCHMARK_RESUME_UNAVAILABLE',
            'MVP benchmark resume state is unavailable',
          );
        }
        return response.success(res, await REFLECT_APPLY(
          configured.read,
          configured.service,
          [{ dramaUid: req.params.dramaUid, workflowRunUid: req.params.workflowRunUid }],
        ));
      } catch (error) {
        return resumeError(res, error);
      }
    },
  );

  router.get(
    '/dramas/:dramaUid/mvp-benchmark/sessions/:sessionUid/authorizations/:authorizationUid/batches/:batchSha256/accounting-status',
    (req, res) => {
      try {
        const configured = accountingStatusService();
        if (!configured) {
          return response.error(
            res, 503, 'MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE',
            'MVP benchmark accounting status is unavailable',
          );
        }
        return response.success(res, REFLECT_APPLY(
          configured.read,
          configured.service,
          [{
            dramaUid: req.params.dramaUid,
            sessionUid: req.params.sessionUid,
            authorizationUid: req.params.authorizationUid,
            batchSha256: req.params.batchSha256,
          }],
        ));
      } catch (error) {
        return accountingStatusError(res, error);
      }
    },
  );

  router.get(
    '/dramas/:dramaUid/mvp-benchmark/sessions/:sessionUid/authorizations/:authorizationUid/batches/:batchSha256/closeout-status',
    (req, res) => {
      try {
        const configured = closeoutStatusService();
        if (!configured) {
          return response.error(
            res, 503, 'MVP_BENCHMARK_CLOSEOUT_STATUS_UNAVAILABLE',
            'MVP benchmark closeout status is unavailable',
          );
        }
        return response.success(res, REFLECT_APPLY(
          configured.read,
          configured.service,
          [{
            schemaVersion: CLOSEOUT_REQUEST_SCHEMA_VERSION,
            dramaUid: req.params.dramaUid,
            sessionUid: req.params.sessionUid,
            authorizationUid: req.params.authorizationUid,
            batchSha256: req.params.batchSha256,
          }],
        ));
      } catch (error) {
        return closeoutStatusError(res, error);
      }
    },
  );

  router.post('/dramas/:dramaUid/mvp-benchmark/sessions', (req, res) => {
    if (req.body?.dramaUid !== req.params.dramaUid) {
      return response.error(res, 400, 'MVP_BENCHMARK_SESSION_INPUT_INVALID', 'MVP benchmark session request is invalid');
    }
    try {
      return response.created(res, sessionRepository.prepare(req.body));
    } catch (error) {
      return sessionError(res, error);
    }
  });

  router.post(
    '/dramas/:dramaUid/mvp-benchmark/workflow-runs/:workflowRunUid/session',
    (req, res) => {
      if (!exactEmptyBody(req.body)) {
        return response.error(
          res,
          400,
          'MVP_BENCHMARK_SESSION_INPUT_INVALID',
          'MVP benchmark session request is invalid',
        );
      }
      try {
        return response.created(res, sessionRepository.prepareFromWorkflow({
          uid: randomUUID(),
          dramaUid: req.params.dramaUid,
          workflowRunUid: req.params.workflowRunUid,
          createdAtEpochMs: REFLECT_APPLY(DATE_NOW, Date, []),
        }));
      } catch (error) {
        return sessionError(res, error);
      }
    },
  );

  router.get(
    '/dramas/:dramaUid/mvp-benchmark/sessions/:sessionUid/authorizations/:authorizationUid/batches/:batchSha256/human-av-review',
    (req, res) => {
      try {
        const configured = humanAvReviewService();
        if (!configured) {
          return response.error(
            res, 503, 'MVP_BENCHMARK_HUMAN_AV_REVIEW_UNAVAILABLE',
            'MVP benchmark human audiovisual review is unavailable',
          );
        }
        return response.success(res, REFLECT_APPLY(configured.get, configured.service, [{
          dramaUid: req.params.dramaUid,
          sessionUid: req.params.sessionUid,
          authorizationUid: req.params.authorizationUid,
          expectedBatchSha256: req.params.batchSha256,
        }]));
      } catch (error) {
        return humanAvReviewError(res, error);
      }
    },
  );

  router.post(
    '/dramas/:dramaUid/mvp-benchmark/sessions/:sessionUid/authorizations/:authorizationUid/human-av-review',
    (req, res) => {
      try {
        const seed = exactHumanAvReviewSeed(req.body);
        if (!seed) {
          return response.error(
            res, 400, 'MVP_BENCHMARK_HUMAN_AV_REVIEW_INPUT_INVALID',
            'MVP benchmark human audiovisual review input is invalid',
          );
        }
        const configured = humanAvReviewService();
        if (!configured) {
          return response.error(
            res, 503, 'MVP_BENCHMARK_HUMAN_AV_REVIEW_UNAVAILABLE',
            'MVP benchmark human audiovisual review is unavailable',
          );
        }
        return response.created(res, REFLECT_APPLY(configured.review, configured.service, [{
          ...seed,
          dramaUid: req.params.dramaUid,
          sessionUid: req.params.sessionUid,
          authorizationUid: req.params.authorizationUid,
        }]));
      } catch (error) {
        return humanAvReviewError(res, error);
      }
    },
  );

  router.get('/dramas/:dramaUid/mvp-benchmark/sessions/:sessionUid', (req, res) => {
    try {
      const session = sessionRepository.get(req.params.sessionUid);
      if (session.dramaUid !== req.params.dramaUid) {
        return response.error(res, 404, 'MVP_BENCHMARK_SESSION_NOT_FOUND', 'MVP benchmark session was not found');
      }
      return response.success(res, session);
    } catch (error) {
      return sessionError(res, error);
    }
  });

  router.post(
    '/dramas/:dramaUid/mvp-benchmark/sessions/:sessionUid/authorizations',
    (req, res) => {
      if (req.body?.dramaUid !== req.params.dramaUid
        || req.body?.sessionUid !== req.params.sessionUid) {
        return response.error(res, 400, 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID', 'MVP benchmark external authorization request is invalid');
      }
      try {
        return response.created(res, authorizationRepository.prepare(req.body));
      } catch (error) {
        return authorizationError(res, error);
      }
    },
  );

  router.get(
    '/dramas/:dramaUid/mvp-benchmark/sessions/:sessionUid/authorizations/:authorizationUid/execution-progress/:batchSha256',
    async (req, res) => {
      try {
        const expectedBatchSha256 = req.params.batchSha256;
        if (typeof expectedBatchSha256 !== 'string' || !SHA256.test(expectedBatchSha256)) {
          return response.error(
            res, 400, 'MVP_BENCHMARK_PRODUCTION_EXECUTION_INPUT_INVALID',
            'MVP benchmark production execution input is invalid',
          );
        }
        const configured = executionService();
        if (!configured) {
          return response.error(
            res, 503, 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
            'MVP benchmark production execution is unavailable',
          );
        }
        const result = await REFLECT_APPLY(configured.readProgress, configured.service, [{
          schemaVersion: 'mvp-benchmark-production-execution-progress-request.v1',
          authorizationUid: parseMvpBenchmarkExternalAuthorizationUid(
            req.params.authorizationUid,
          ),
          dramaUid: parseMvpBenchmarkExternalAuthorizationUid(req.params.dramaUid),
          sessionUid: parseMvpBenchmarkExternalAuthorizationUid(req.params.sessionUid),
          expectedBatchSha256,
        }]);
        return response.success(res, result);
      } catch (error) {
        return executionError(res, error);
      }
    },
  );

  router.post(
    '/dramas/:dramaUid/mvp-benchmark/sessions/:sessionUid/connections/:connectionUid/authorization',
    (req, res) => {
      const seed = exactAuthorizationSeed(req.body);
      if (!seed) {
        return response.error(res, 400, 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID', 'MVP benchmark external authorization request is invalid');
      }
      try {
        const dramaUid = parseMvpBenchmarkExternalAuthorizationUid(req.params.dramaUid);
        const sessionUid = parseMvpBenchmarkExternalAuthorizationUid(req.params.sessionUid);
        const connectionUid = parseMvpBenchmarkExternalAuthorizationUid(req.params.connectionUid);
        return response.created(res, authorizationRepository.prepareFromSession({
          uid: randomUUID(),
          sessionUid,
          dramaUid,
          connectionUid,
          maximumCostCnyFen: seed.maximumCostCnyFen,
          validityDurationMs: seed.validityDurationMs,
        }));
      } catch (error) {
        return authorizationError(res, error);
      }
    },
  );

  router.get(
    '/dramas/:dramaUid/mvp-benchmark/sessions/:sessionUid/authorizations/:authorizationUid',
    (req, res) => {
      try {
        const dramaUid = parseMvpBenchmarkExternalAuthorizationUid(req.params.dramaUid);
        const sessionUid = parseMvpBenchmarkExternalAuthorizationUid(req.params.sessionUid);
        const authorizationUid = parseMvpBenchmarkExternalAuthorizationUid(
          req.params.authorizationUid,
        );
        const authorization = authorizationRepository.get(authorizationUid);
        if (authorization.dramaUid !== dramaUid
          || authorization.sessionUid !== sessionUid) {
          return response.error(res, 404, 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_NOT_FOUND', 'MVP benchmark external authorization was not found');
        }
        return response.success(res, authorization);
      } catch (error) {
        return authorizationError(res, error);
      }
    },
  );

  router.post(
    '/dramas/:dramaUid/mvp-benchmark/sessions/:sessionUid/authorizations/:authorizationUid/preflight',
    async (req, res) => {
      try {
        const authorization = pathAuthorization(req.params);
        if (!exactEmptyBody(req.body)) {
          return response.error(res, 400, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID', 'MVP benchmark execution preflight request is invalid');
        }
        const configured = preflightService();
        if (!configured) {
          return response.error(res, 503, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE', 'MVP benchmark execution preflight is unavailable');
        }
        const result = await REFLECT_APPLY(
          configured.prepareBatch, configured.service, [authorization.uid],
        );
        return response.created(res, result);
      } catch (error) {
        return preflightError(res, error);
      }
    },
  );

  router.get(
    '/dramas/:dramaUid/mvp-benchmark/sessions/:sessionUid/authorizations/:authorizationUid/preflight',
    (req, res) => {
      try {
        const authorization = pathAuthorization(req.params);
        const batch = preflightRepository.getBatchByAuthorization(authorization.uid);
        if (!batch) throw new V2RepositoryNotFoundError('MVP benchmark execution preflight');
        return response.success(res, batch);
      } catch (error) {
        return preflightError(res, error);
      }
    },
  );

  router.post(
    '/dramas/:dramaUid/mvp-benchmark/sessions/:sessionUid/authorizations/:authorizationUid/execute-next',
    async (req, res) => {
      try {
        const seed = exactExecutionSeed(req.body);
        if (!seed) {
          return response.error(
            res, 400, 'MVP_BENCHMARK_PRODUCTION_EXECUTION_INPUT_INVALID',
            'MVP benchmark production execution input is invalid',
          );
        }
        const configured = executionService();
        if (!configured) {
          return response.error(
            res, 503, 'MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE',
            'MVP benchmark production execution is unavailable',
          );
        }
        const result = await REFLECT_APPLY(configured.executeNext, configured.service, [{
          schemaVersion: seed.schemaVersion,
          authorizationUid: parseMvpBenchmarkExternalAuthorizationUid(
            req.params.authorizationUid,
          ),
          dramaUid: parseMvpBenchmarkExternalAuthorizationUid(req.params.dramaUid),
          sessionUid: parseMvpBenchmarkExternalAuthorizationUid(req.params.sessionUid),
          expectedBatchSha256: seed.expectedBatchSha256,
          expectedOrdinal: seed.expectedOrdinal,
          expectedItemKind: seed.expectedItemKind,
          expectedItemUid: seed.expectedItemUid,
        }]);
        return response.success(res, result);
      } catch (error) {
        return executionError(res, error);
      }
    },
  );

  router.post(
    '/dramas/:dramaUid/mvp-benchmark/sessions/:sessionUid/authorizations/:authorizationUid/finalize',
    async (req, res) => {
      try {
        const seed = exactFinalizationSeed(req.body);
        if (!seed) {
          return response.error(
            res, 400, 'MVP_BENCHMARK_FINALIZATION_INPUT_INVALID',
            'MVP benchmark finalization input is invalid',
          );
        }
        const configured = finalizationService();
        if (!configured) {
          return response.error(
            res, 503, 'MVP_BENCHMARK_FINALIZATION_UNAVAILABLE',
            'MVP benchmark finalization is unavailable',
          );
        }
        const result = await REFLECT_APPLY(configured.finalize, configured.service, [{
          schemaVersion: seed.schemaVersion,
          authorizationUid: parseMvpBenchmarkExternalAuthorizationUid(
            req.params.authorizationUid,
          ),
          dramaUid: parseMvpBenchmarkExternalAuthorizationUid(req.params.dramaUid),
          sessionUid: parseMvpBenchmarkExternalAuthorizationUid(req.params.sessionUid),
          expectedBatchSha256: seed.expectedBatchSha256,
          bgmTrackUid: parseMvpBenchmarkExternalAuthorizationUid(seed.bgmTrackUid),
        }]);
        return response.success(res, result);
      } catch (error) {
        return finalizationError(res, error);
      }
    },
  );

  return router;
}

module.exports = mvpBenchmarkRoutes;
