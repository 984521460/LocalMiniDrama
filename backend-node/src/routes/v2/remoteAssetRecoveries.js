'use strict';

const express = require('express');
const multer = require('multer');

const response = require('../../response');
const {
  RemoteAssetRecoveryError,
  isRemoteAssetRecoveryError,
} = require('../../remoteAssets');
const {
  LocalPackageImportError,
  isLocalPackageImportError,
} = require('../../remoteAssets/localPackageImportService');
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

function localStatusFor(code) {
  if (code === 'LOCAL_PACKAGE_IMPORT_INPUT_INVALID') return 400;
  if (code === 'LOCAL_PACKAGE_IMPORT_DATA_INVALID') return 500;
  if (code === 'LOCAL_PACKAGE_IMPORT_SUBMISSION_UNKNOWN') return 503;
  if (code === 'LOCAL_PACKAGE_IMPORT_FAILED') return 422;
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

  function handleLocal(res, error, event) {
    if (isLocalPackageImportError(error)) {
      return response.error(res, localStatusFor(error.code), error.code, error.message);
    }
    log?.error?.(event, { code: 'LOCAL_PACKAGE_IMPORT_UNEXPECTED' });
    return response.error(res, 500, 'LOCAL_PACKAGE_IMPORT_UNEXPECTED', 'Package import failed');
  }

  function dramaFor(value) {
    const dramaId = legacyDramaId(value);
    return dramaId === null ? null : sources.findDramaByLegacyId(dramaId);
  }

  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: 64 * 1024 * 1024, files: 1, fields: 2, fieldSize: 256, parts: 4,
  } }).single('package');
  router.post('/dramas/:dramaId/characters/:characterUid/local-recovery-packages',
    (req, res, next) => upload(req, res, (error) => {
      if (error) return response.error(
        res, 400, 'LOCAL_PACKAGE_IMPORT_INPUT_INVALID', 'Package upload failed',
      );
      return next();
    }), async (req, res) => {
      if (!runtime?.importPackage) return unavailable(res);
      try {
        const drama = dramaFor(req.params.dramaId);
        if (!drama || !req.file || !UUID_V4.test(req.params.characterUid)
          || Object.keys(req.body).sort().join(',') !== 'characterFactId,extractionResultUid') {
          throw new LocalPackageImportError('LOCAL_PACKAGE_IMPORT_INPUT_INVALID');
        }
        const record = await runtime.importPackage({ dramaUid: drama.uid,
          characterUid: req.params.characterUid, extractionResultUid: req.body.extractionResultUid,
          characterFactId: req.body.characterFactId }, req.file.buffer);
        return response.success(res, { record });
      } catch (error) { return handleLocal(res, error, 'local-package-import'); }
    });
  router.get('/dramas/:dramaId/characters/:characterUid/local-recovery-packages', async (req, res) => {
    if (!runtime?.listPackages) return unavailable(res);
    try {
      const drama = dramaFor(req.params.dramaId);
      if (!drama || !UUID_V4.test(req.params.characterUid)) {
        throw new LocalPackageImportError('LOCAL_PACKAGE_IMPORT_INPUT_INVALID');
      }
      return response.success(res, { records: await runtime.listPackages(drama.uid, req.params.characterUid) });
    } catch (error) { return handleLocal(res, error, 'local-package-list'); }
  });

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
