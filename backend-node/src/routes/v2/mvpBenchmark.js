'use strict';

const express = require('express');

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
const response = require('../../response');

function mvpBenchmarkRoutes(log, runtime, database) {
  const router = express.Router();
  const readinessRepository = createMvpBenchmarkReadinessRepository(database);
  const sessionRepository = createV2Repositories(database).mvpBenchmarkSessions;

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

  return router;
}

module.exports = mvpBenchmarkRoutes;
