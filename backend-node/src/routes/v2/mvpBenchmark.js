'use strict';

const express = require('express');

const {
  createMvpBenchmarkReadiness,
  parseMvpBenchmarkReadiness,
} = require('../../benchmark/mvpBenchmarkReadiness');
const {
  createMvpBenchmarkReadinessRepository,
} = require('../../repositories/v2');
const response = require('../../response');

function mvpBenchmarkRoutes(log, runtime, database) {
  const router = express.Router();
  const readinessRepository = createMvpBenchmarkReadinessRepository(database);

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

  return router;
}

module.exports = mvpBenchmarkRoutes;
