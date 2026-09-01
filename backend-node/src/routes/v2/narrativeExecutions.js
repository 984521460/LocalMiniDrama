'use strict';

const express = require('express');

const response = require('../../response');
const {
  NarrativeExecutionError,
  isNarrativeExecutionError,
} = require('../../narrative/execution');
const { createV2Repositories } = require('../../repositories/v2');

function dramaId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function statusFor(code) {
  if (code === 'NARRATIVE_EXECUTION_NOT_FOUND') return 404;
  if (code === 'NARRATIVE_EXECUTION_INPUT_INVALID') return 400;
  if (code === 'NARRATIVE_EXECUTION_OUTPUT_INVALID') return 422;
  if (code === 'NARRATIVE_EXECUTION_PROVIDER_FAILED') return 502;
  if (code === 'NARRATIVE_EXECUTION_DATA_INVALID') return 500;
  return 409;
}

function narrativeExecutionRoutes(database, log, runtime) {
  const router = express.Router();
  const sources = createV2Repositories(database).sources;
  const service = runtime && typeof runtime.execute === 'function'
    && typeof runtime.get === 'function' ? runtime : null;

  function unavailable(res) {
    return response.error(
      res,
      503,
      'NARRATIVE_EXECUTION_UNAVAILABLE',
      'Narrative execution is unavailable',
    );
  }

  function handle(res, error, event) {
    if (isNarrativeExecutionError(error)) {
      return response.error(res, statusFor(error.code), error.code, error.message);
    }
    log?.error?.(event, { code: 'NARRATIVE_EXECUTION_UNEXPECTED' });
    return response.error(
      res,
      500,
      'NARRATIVE_EXECUTION_UNEXPECTED',
      'Narrative execution failed',
    );
  }

  router.post('/dramas/:dramaId/narrative-executions', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      const legacyId = dramaId(req.params.dramaId);
      const drama = legacyId === null ? null : sources.findDramaByLegacyId(legacyId);
      if (!drama || req.body?.dramaUid !== drama.uid) {
        throw new NarrativeExecutionError('NARRATIVE_EXECUTION_INPUT_INVALID');
      }
      return response.success(res, await service.execute(req.body));
    } catch (error) {
      return handle(res, error, 'narrative-execution-create');
    }
  });

  router.get('/narrative-executions/:operationUid', (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(res, service.get(req.params.operationUid));
    } catch (error) {
      return handle(res, error, 'narrative-execution-get');
    }
  });

  return router;
}

module.exports = narrativeExecutionRoutes;
