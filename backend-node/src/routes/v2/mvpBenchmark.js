'use strict';

const express = require('express');
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
const response = require('../../response');

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
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
          || Reflect.ownKeys(req.body).length !== 0) {
          return response.error(res, 400, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID', 'MVP benchmark execution preflight request is invalid');
        }
        const configured = preflightService();
        if (!configured) {
          return response.error(res, 503, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE', 'MVP benchmark execution preflight is unavailable');
        }
        const result = await Reflect.apply(
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

  return router;
}

module.exports = mvpBenchmarkRoutes;
