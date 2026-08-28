'use strict';

const express = require('express');

const response = require('../../response');
const { isRemoteEnvironmentError } = require('../../remote/remoteEnvironmentErrors');

const STATUS_BY_CODE = Object.freeze({
  REMOTE_ENVIRONMENT_INPUT_INVALID: 400,
  REMOTE_ENVIRONMENT_PLAN_CONFLICT: 409,
  REMOTE_ENVIRONMENT_SESSION_FAILED: 502,
  REMOTE_ENVIRONMENT_PROBE_FAILED: 502,
  REMOTE_ENVIRONMENT_INITIALIZATION_FAILED: 502,
  REMOTE_ENVIRONMENT_UNEXPECTED: 500,
});

function remoteEnvironmentRoutes(log, runtime = {}) {
  const router = express.Router();
  const service = runtime.remoteEnvironment || null;

  function unavailable(res) {
    return response.error(
      res,
      503,
      'REMOTE_ENVIRONMENT_UNAVAILABLE',
      'Remote environment management is unavailable',
    );
  }

  function handleError(res, error, event) {
    if (isRemoteEnvironmentError(error)) {
      const status = STATUS_BY_CODE[error.code] || 500;
      if (status >= 500) log?.error?.(event, { code: error.code });
      return response.error(res, status, error.code, error.message);
    }
    log?.error?.(event, { code: 'REMOTE_ENVIRONMENT_UNEXPECTED' });
    return response.error(
      res,
      500,
      'REMOTE_ENVIRONMENT_UNEXPECTED',
      'Remote environment operation failed',
    );
  }

  router.get('/remote-connections/:connectionUid/environment-report', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(res, await service.inspect(req.params.connectionUid));
    } catch (error) {
      return handleError(res, error, 'remote-environment-inspect');
    }
  });

  router.get('/remote-connections/:connectionUid/initialization-plan', (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(res, service.getInitializationPlan(req.params.connectionUid));
    } catch (error) {
      return handleError(res, error, 'remote-environment-plan');
    }
  });

  router.post('/remote-connections/:connectionUid/initialize', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(res, await service.initialize(req.params.connectionUid, req.body));
    } catch (error) {
      return handleError(res, error, 'remote-environment-initialize');
    }
  });

  router.post('/remote-connections/:connectionUid/install-models', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(res, await service.installModels(req.params.connectionUid, req.body));
    } catch (error) {
      return handleError(res, error, 'remote-environment-install-models');
    }
  });

  return router;
}

module.exports = remoteEnvironmentRoutes;
