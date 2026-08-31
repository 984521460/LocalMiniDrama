'use strict';

const express = require('express');

const response = require('../../response');
const { createV2Repositories } = require('../../repositories/v2');
const {
  H3_PROFILE,
  H3_REAL_VALIDATION_MATRIX,
  compileH3GenerationWorkflow,
  createH3ExecutionIntentService,
  createH3TextToVideoWorkflowBundle,
  isH3ContractError,
} = require('../../h3');
const { provisionH3TextToVideoManifest } = require('../../h3/provisioning');
const { isRemoteTaskError } = require('../../remote/remoteTask');

const STATUS_BY_CODE = Object.freeze({
  H3_GENERATION_INPUT_INVALID: 400,
  H3_API_REQUEST_INVALID: 400,
  H3_API_UNAVAILABLE: 503,
  H3_API_REQUEST_ABORTED: 504,
  H3_API_UPSTREAM_FAILED: 502,
  H3_API_RESPONSE_INVALID: 502,
  H3_API_SUBMISSION_UNKNOWN: 409,
  H3_WORKFLOW_UNVERIFIED: 409,
  H3_HISTORY_CONFLICT: 409,
  H3_PROFILE_INVALID: 500,
  REMOTE_TASK_INPUT_INVALID: 400,
  REMOTE_TASK_NOT_FOUND: 404,
  REMOTE_TASK_CONFLICT: 409,
  REMOTE_TASK_DEPENDENCY_NOT_READY: 409,
  REMOTE_TASK_SUBMISSION_FAILED: 502,
  REMOTE_TASK_RECOVERY_FAILED: 502,
  REMOTE_TASK_DATA_INVALID: 500,
  REMOTE_TASK_UNEXPECTED: 500,
});

function publicIntent(intent) {
  return Object.freeze({
    schemaVersion: intent.schemaVersion,
    uid: intent.uid,
    taskUid: intent.taskUid,
    generationRunUid: intent.generationRunUid,
    historyUid: intent.historyUid,
    assetUid: intent.assetUid,
    manifestUid: intent.manifestUid,
    parentVersionUid: intent.parentVersionUid,
    createdAtEpochMs: intent.createdAtEpochMs,
  });
}

function h3Routes(log, database, runtime = {}) {
  const router = express.Router();
  const apiService = runtime?.apiService || null;
  const localExecution = runtime?.localExecution || null;
  const provisioned = database ? provisionH3TextToVideoManifest(database) : null;
  const intentService = database
    ? createH3ExecutionIntentService({ repositories: createV2Repositories(database) })
    : null;

  function handleError(res, error) {
    if (isH3ContractError(error) || isRemoteTaskError(error)) {
      const status = STATUS_BY_CODE[error.code] || 500;
      if (status >= 500) log?.error?.('h3-operation', { code: error.code });
      return response.error(res, status, error.code, error.message);
    }
    log?.error?.('h3-operation', { code: 'H3_UNEXPECTED' });
    return response.error(res, 500, 'H3_UNEXPECTED', 'H3 operation failed');
  }

  router.get('/h3/profile', (_req, res) => response.success(res, H3_PROFILE));
  router.get('/h3/real-validation', (_req, res) => (
    response.success(res, H3_REAL_VALIDATION_MATRIX)
  ));
  router.get('/h3/t2v-workflow', (_req, res) => {
    if (!provisioned) {
      return response.error(res, 503, 'H3_STATE_UNAVAILABLE', 'H3 state is unavailable');
    }
    const bundle = createH3TextToVideoWorkflowBundle();
    return response.success(res, Object.freeze({
      manifest: provisioned.manifest,
      workflowBase64: Buffer.from(bundle.workflowJson, 'utf8').toString('base64'),
    }));
  });
  router.post('/h3/compile-t2v', (req, res) => {
    if (!provisioned) {
      return response.error(res, 503, 'H3_STATE_UNAVAILABLE', 'H3 state is unavailable');
    }
    try {
      return response.success(res, compileH3GenerationWorkflow(req.body));
    } catch (error) {
      return handleError(res, error);
    }
  });
  router.post('/h3/prepare-t2v-intent', (req, res) => {
    if (!intentService) {
      return response.error(res, 503, 'H3_STATE_UNAVAILABLE', 'H3 state is unavailable');
    }
    try {
      return response.success(res, publicIntent(intentService.prepare(req.body)));
    } catch (error) {
      return handleError(res, error);
    }
  });
  router.post('/h3/local-t2v/:taskUid/execute', async (req, res) => {
    if (!localExecution || typeof localExecution.execute !== 'function') {
      return response.error(
        res,
        503,
        'H3_LOCAL_EXECUTION_UNAVAILABLE',
        'H3 local execution is unavailable',
      );
    }
    try {
      return response.success(
        res,
        await localExecution.execute(req.params.taskUid, req.body),
      );
    } catch (error) {
      return handleError(res, error);
    }
  });
  router.post('/h3/api/tasks', async (req, res) => {
    if (!apiService) {
      return response.error(res, 503, 'H3_API_UNAVAILABLE', 'MiniMax H3 API provider is unavailable');
    }
    try {
      return response.success(res, await apiService.submit(
        req.body,
        req.get('Idempotency-Key'),
      ));
    } catch (error) {
      return handleError(res, error);
    }
  });
  router.get('/h3/api/tasks/:taskId', async (req, res) => {
    if (!apiService) {
      return response.error(res, 503, 'H3_API_UNAVAILABLE', 'MiniMax H3 API provider is unavailable');
    }
    try {
      return response.success(res, await apiService.query(req.params.taskId));
    } catch (error) {
      return handleError(res, error);
    }
  });
  return router;
}

module.exports = h3Routes;
