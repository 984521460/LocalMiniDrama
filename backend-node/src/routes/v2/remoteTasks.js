'use strict';

const express = require('express');

const response = require('../../response');
const {
  isMvpBenchmarkExternalAuthorizationError,
} = require('../../benchmark/mvpBenchmarkExternalAuthorization');
const { createRemoteTaskService } = require('../../remote/remoteTaskService');
const { isRemoteTaskError } = require('../../remote/remoteTask');
const { createV2Repositories } = require('../../repositories/v2');

const STATUS_BY_CODE = Object.freeze({
  REMOTE_TASK_INPUT_INVALID: 400,
  REMOTE_TASK_NOT_FOUND: 404,
  REMOTE_TASK_CONFLICT: 409,
  REMOTE_TASK_DEPENDENCY_NOT_READY: 409,
  REMOTE_TASK_SUBMISSION_FAILED: 502,
  REMOTE_TASK_RECOVERY_FAILED: 502,
  REMOTE_TASK_DATA_INVALID: 500,
  REMOTE_TASK_UNEXPECTED: 500,
});

function remoteTaskRoutes(log, runtime = {}, database) {
  const router = express.Router();
  const repositories = database ? createV2Repositories(database) : null;
  const benchmarkExecutionGate = repositories?.mvpBenchmarkExternalAuthorizations ?? null;
  let service = runtime.remoteTasks || null;
  const coordinator = runtime.remoteCoordinator || null;
  if (!service && database && runtime.comfyClient && runtime.comfyDependencyChecker) {
    service = createRemoteTaskService({
      repository: repositories.remote,
      manifestRepository: repositories.comfyManifests,
      executionGate: repositories.mvpBenchmarkExternalAuthorizations,
      client: runtime.comfyClient,
      dependencyChecker: runtime.comfyDependencyChecker,
      ...(typeof runtime.createUid === 'function' ? { createUid: runtime.createUid } : {}),
    });
  }

  function unavailable(res) {
    return response.error(
      res,
      503,
      'REMOTE_TASK_STATE_UNAVAILABLE',
      'Remote task state is unavailable',
    );
  }

  function handleError(res, error, event) {
    if (isMvpBenchmarkExternalAuthorizationError(error)
      && error.code === 'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE') {
      return response.error(res, 409, error.code, error.message);
    }
    if (isRemoteTaskError(error)) {
      const status = STATUS_BY_CODE[error.code] || 500;
      if (status >= 500) log?.error?.(event, { code: error.code });
      return response.error(res, status, error.code, error.message);
    }
    log?.error?.(event, { code: 'REMOTE_TASK_UNEXPECTED' });
    return response.error(
      res,
      500,
      'REMOTE_TASK_UNEXPECTED',
      'Remote task operation failed',
    );
  }

  router.post('/remote-tasks', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      const result = await service.prepare(req.body);
      return result.created ? response.created(res, result) : response.success(res, result);
    } catch (error) {
      return handleError(res, error, 'remote-task-prepare');
    }
  });

  router.post('/remote-tasks/recover-all', async (_req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(res, await service.recoverAll());
    } catch (error) {
      return handleError(res, error, 'remote-task-recover-all');
    }
  });

  router.get('/remote-tasks/:taskUid', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(res, await service.get(req.params.taskUid));
    } catch (error) {
      return handleError(res, error, 'remote-task-detail');
    }
  });

  router.post('/remote-tasks/:taskUid/submit', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      benchmarkExecutionGate?.assertH3TaskExecutionOpen(req.params.taskUid);
      return response.success(res, await service.submit(req.params.taskUid, req.body));
    } catch (error) {
      return handleError(res, error, 'remote-task-submit');
    }
  });

  router.post('/remote-tasks/:taskUid/execute', async (req, res) => {
    if (!coordinator) return unavailable(res);
    try {
      benchmarkExecutionGate?.assertH3TaskExecutionOpen(req.params.taskUid);
      return response.success(res, await coordinator.execute(req.params.taskUid, req.body));
    } catch (error) {
      return handleError(res, error, 'remote-task-execute');
    }
  });

  router.post('/remote-tasks/:taskUid/heartbeat', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      benchmarkExecutionGate?.assertH3TaskExecutionOpen(req.params.taskUid);
      return response.success(res, await service.heartbeat(req.params.taskUid, req.body));
    } catch (error) {
      return handleError(res, error, 'remote-task-heartbeat');
    }
  });

  router.get('/remote-tasks/:taskUid/retry-classification', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(res, service.retryClassification(req.params.taskUid));
    } catch (error) {
      return handleError(res, error, 'remote-task-retry-classification');
    }
  });

  router.post('/remote-tasks/:taskUid/retry', async (req, res) => {
    if (!coordinator || typeof coordinator.retry !== 'function') return unavailable(res);
    try {
      benchmarkExecutionGate?.assertH3TaskExecutionOpen(req.params.taskUid);
      return response.success(res, await coordinator.retry(req.params.taskUid, req.body));
    } catch (error) {
      return handleError(res, error, 'remote-task-retry');
    }
  });

  router.post('/remote-tasks/:taskUid/recover', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      benchmarkExecutionGate?.assertH3TaskExecutionOpen(req.params.taskUid);
      return response.success(res, await service.recover(req.params.taskUid));
    } catch (error) {
      return handleError(res, error, 'remote-task-recover');
    }
  });

  return router;
}

module.exports = remoteTaskRoutes;
