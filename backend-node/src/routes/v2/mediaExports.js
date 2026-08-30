'use strict';

const express = require('express');

const { exactObject, isAudioModeContractError } = require('../../audio/audioContract');
const response = require('../../response');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function validUid(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

function mediaExportRoutes(log, runtime, database) {
  const router = express.Router();
  const service = runtime?.service ?? null;
  const getDramaUid = database?.prepare?.('SELECT uid FROM dramas WHERE id=?') ?? null;

  function resolveDramaUid(value) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null;
    const dramaId = Number(value);
    if (!Number.isSafeInteger(dramaId) || getDramaUid === null) return null;
    return getDramaUid.get(dramaId)?.uid ?? null;
  }

  function unavailable(res) {
    return response.error(
      res, 503, 'MEDIA_EXPORT_UNAVAILABLE', 'Local media export is unavailable',
    );
  }

  function handleError(res, error, event) {
    if (isAudioModeContractError(error)) {
      const status = error.code.endsWith('_INPUT_INVALID') ? 400 : 409;
      return response.error(res, status, error.code, error.message);
    }
    if (error instanceof V2RepositoryNotFoundError) {
      return response.error(res, 404, 'MEDIA_EXPORT_RUN_NOT_FOUND', 'Media export run was not found');
    }
    if (error instanceof V2RepositoryConflictError) {
      return response.error(res, 409, 'MEDIA_EXPORT_RUN_CONFLICT', 'Media export run conflicted');
    }
    if (error instanceof V2RepositoryDataError) {
      return response.error(res, 409, 'MEDIA_EXPORT_RUN_DATA_INVALID', 'Media export data is invalid');
    }
    log?.error?.(event, { code: 'MEDIA_EXPORT_UNEXPECTED' });
    return response.error(res, 500, 'MEDIA_EXPORT_UNEXPECTED', 'Media export operation failed');
  }

  router.post('/dramas/:dramaId/media-exports', async (req, res) => {
    if (!service) return unavailable(res);
    const dramaUid = resolveDramaUid(req.params.dramaId);
    if (dramaUid === null) {
      return response.error(res, 400, 'MEDIA_EXPORT_RUN_INPUT_INVALID', 'Media export request is invalid');
    }
    try {
      const body = exactObject(
        req.body, ['node_run_uid'], 'MEDIA_EXPORT_RUN_INPUT_INVALID',
      );
      const result = await service.start(
        { nodeRunUid: body.node_run_uid }, dramaUid,
      );
      return response.success(res, result);
    } catch (error) {
      return handleError(res, error, 'media-export-start');
    }
  });

  router.get('/dramas/:dramaId/media-exports', (req, res) => {
    if (!service) return unavailable(res);
    const dramaUid = resolveDramaUid(req.params.dramaId);
    if (dramaUid === null) {
      return response.error(res, 400, 'MEDIA_EXPORT_RUN_INPUT_INVALID', 'Media export request is invalid');
    }
    try {
      return response.success(res, service.listByDrama(dramaUid));
    } catch (error) {
      return handleError(res, error, 'media-export-list');
    }
  });

  router.get('/dramas/:dramaId/media-exports/:runUid', (req, res) => {
    if (!service) return unavailable(res);
    const dramaUid = resolveDramaUid(req.params.dramaId);
    if (dramaUid === null || !validUid(req.params.runUid)) {
      return response.error(res, 400, 'MEDIA_EXPORT_RUN_INPUT_INVALID', 'Media export request is invalid');
    }
    try {
      return response.success(res, service.get(req.params.runUid, dramaUid));
    } catch (error) {
      return handleError(res, error, 'media-export-get');
    }
  });

  return router;
}

module.exports = mediaExportRoutes;
