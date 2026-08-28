const express = require('express');
const { randomUUID } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const response = require('../../response');
const { isGenerationHistoryError } = require('../../assets/generationHistory');
const {
  createV2Repositories,
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SELECTION_FIELDS = Object.freeze([
  'history_uid',
  'selected_version_uid',
  'expected_state_version',
]);

function selectionBody(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== SELECTION_FIELDS.length) return null;
    const output = Object.create(null);
    for (const field of SELECTION_FIELDS) {
      const descriptor = descriptors[field];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      output[field] = descriptor.value;
    }
    if (!UUID_V4.test(output.history_uid)
      || !UUID_V4.test(output.selected_version_uid)
      || !Number.isSafeInteger(output.expected_state_version)
      || output.expected_state_version < 0) return null;
    return output;
  } catch {
    return null;
  }
}

function generationHistoryRoutes(log, runtime = {}, database) {
  const router = express.Router();
  const repository = database ? createV2Repositories(database).generationHistory : null;
  const createEventUid = typeof runtime.createEventUid === 'function'
    ? runtime.createEventUid
    : randomUUID;
  const nowEpochMs = typeof runtime.nowEpochMs === 'function' ? runtime.nowEpochMs : Date.now;

  function unavailable(res) {
    return response.error(
      res,
      503,
      'GENERATION_HISTORY_STATE_UNAVAILABLE',
      'Generation history state is unavailable',
    );
  }

  function invalidInput(res) {
    return response.error(
      res,
      400,
      'GENERATION_HISTORY_INPUT_INVALID',
      'Generation history request is invalid',
    );
  }

  function handleError(res, error, event) {
    if (error instanceof V2RepositoryNotFoundError) {
      return response.error(
        res,
        404,
        'GENERATION_HISTORY_NOT_FOUND',
        'Generation history state was not found',
      );
    }
    if (error instanceof V2RepositoryConflictError) {
      return response.error(
        res,
        409,
        'GENERATION_HISTORY_CONFLICT',
        'Generation history state conflict',
      );
    }
    if (error instanceof V2RepositoryDataError) {
      return response.error(
        res,
        500,
        'GENERATION_HISTORY_DATA_INVALID',
        'Generation history persisted state is invalid',
      );
    }
    if (isGenerationHistoryError(error)) return invalidInput(res);
    log?.error?.(event, { code: 'GENERATION_HISTORY_UNEXPECTED' });
    return response.error(
      res,
      500,
      'GENERATION_HISTORY_UNEXPECTED',
      'Generation history operation failed',
    );
  }

  router.get('/assets/:assetUid/generation-history', (req, res) => {
    if (!repository) return unavailable(res);
    if (!UUID_V4.test(req.params.assetUid)) return invalidInput(res);
    try {
      return response.success(res, Object.freeze({
        history: repository.listByAsset(req.params.assetUid),
        selection: repository.getSelectionState(req.params.assetUid),
      }));
    } catch (error) {
      return handleError(res, error, 'generation-history-list');
    }
  });

  router.get('/assets/:assetUid/version-selection', (req, res) => {
    if (!repository) return unavailable(res);
    if (!UUID_V4.test(req.params.assetUid)) return invalidInput(res);
    try {
      return response.success(res, repository.getSelectionState(req.params.assetUid));
    } catch (error) {
      return handleError(res, error, 'generation-history-selection');
    }
  });

  router.post('/assets/:assetUid/version-selection', (req, res) => {
    if (!repository) return unavailable(res);
    if (!UUID_V4.test(req.params.assetUid)) return invalidInput(res);
    const body = selectionBody(req.body);
    if (!body) return invalidInput(res);
    try {
      const current = repository.getSelectionState(req.params.assetUid);
      if (current.stateVersion !== body.expected_state_version) {
        throw new V2RepositoryConflictError('asset version selection', 'created');
      }
      return response.created(res, repository.select({
        uid: createEventUid(),
        historyUid: body.history_uid,
        assetUid: req.params.assetUid,
        selectedVersionUid: body.selected_version_uid,
        previousVersionUid: current.selectedVersionUid,
        stateVersion: current.stateVersion + 1,
        changedAtEpochMs: nowEpochMs(),
      }));
    } catch (error) {
      return handleError(res, error, 'generation-history-select');
    }
  });

  return router;
}

module.exports = generationHistoryRoutes;
