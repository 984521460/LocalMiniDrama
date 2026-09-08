'use strict';

const express = require('express');

const response = require('../../response');
const {
  RemoteAssetRecoveryError,
  isRemoteAssetRecoveryError,
} = require('../../remoteAssets');
const { createV2Repositories } = require('../../repositories/v2');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function legacyDramaId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function statusFor(code) {
  if (code === 'REMOTE_ASSET_RECOVERY_NOT_FOUND') return 404;
  if (code === 'REMOTE_ASSET_RECOVERY_INPUT_INVALID') return 400;
  if (code === 'REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE') return 503;
  if (code === 'REMOTE_ASSET_RECOVERY_MANIFEST_INVALID'
    || code === 'REMOTE_ASSET_RECOVERY_OUTPUT_INVALID') return 422;
  if (code === 'REMOTE_ASSET_RECOVERY_DATA_INVALID') return 500;
  return 409;
}

function remoteAssetRecoveryRoutes(database, log, runtime) {
  const router = express.Router();
  const sources = createV2Repositories(database).sources;
  const service = runtime && typeof runtime.execute === 'function'
    && typeof runtime.get === 'function' && typeof runtime.list === 'function'
    ? runtime : null;

  function unavailable(res) {
    return response.error(
      res,
      503,
      'REMOTE_ASSET_RECOVERY_UNAVAILABLE',
      'Remote asset recovery is unavailable',
    );
  }

  function handle(res, error, event) {
    if (isRemoteAssetRecoveryError(error)) {
      return response.error(res, statusFor(error.code), error.code, error.message);
    }
    log?.error?.(event, { code: 'REMOTE_ASSET_RECOVERY_UNEXPECTED' });
    return response.error(
      res,
      500,
      'REMOTE_ASSET_RECOVERY_UNEXPECTED',
      'Remote asset recovery failed',
    );
  }

  function dramaFor(value) {
    const dramaId = legacyDramaId(value);
    return dramaId === null ? null : sources.findDramaByLegacyId(dramaId);
  }

  router.post('/dramas/:dramaId/characters/:characterUid/remote-asset-recoveries', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      const drama = dramaFor(req.params.dramaId);
      if (!drama || req.body?.dramaUid !== drama.uid
        || req.body?.characterUid !== req.params.characterUid) {
        throw new RemoteAssetRecoveryError('REMOTE_ASSET_RECOVERY_INPUT_INVALID');
      }
      return response.success(res, await service.execute(req.body));
    } catch (error) {
      return handle(res, error, 'remote-asset-recovery-create');
    }
  });

  router.get('/dramas/:dramaId/characters/:characterUid/remote-asset-recoveries', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      const drama = dramaFor(req.params.dramaId);
      if (!drama || !UUID_V4.test(req.params.characterUid)) {
        throw new RemoteAssetRecoveryError('REMOTE_ASSET_RECOVERY_INPUT_INVALID');
      }
      return response.success(res, await service.list({
        dramaUid: drama.uid,
        characterUid: req.params.characterUid,
      }));
    } catch (error) {
      return handle(res, error, 'remote-asset-recovery-list');
    }
  });

  router.get('/remote-asset-recoveries/:operationUid', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      if (!UUID_V4.test(req.params.operationUid)) {
        throw new RemoteAssetRecoveryError('REMOTE_ASSET_RECOVERY_INPUT_INVALID');
      }
      return response.success(res, await service.get(req.params.operationUid));
    } catch (error) {
      return handle(res, error, 'remote-asset-recovery-get');
    }
  });

  return router;
}

module.exports = remoteAssetRecoveryRoutes;
