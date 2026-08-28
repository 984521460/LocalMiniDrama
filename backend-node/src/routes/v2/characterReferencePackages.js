const express = require('express');
const { randomUUID } = require('node:crypto');

const response = require('../../response');
const {
  createCharacterReferencePackageRequest,
} = require('../../assets/characterReferencePackage');
const {
  createV2Repositories,
  V2RepositoryConflictError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2');

function characterReferencePackageRoutes(log, runtime = {}, database) {
  const router = express.Router();
  const repository = database ? createV2Repositories(database).characterReferencePackages : null;
  const createPackageUid = typeof runtime.createPackageUid === 'function'
    ? runtime.createPackageUid
    : randomUUID;
  const createItemUid = typeof runtime.createItemUid === 'function'
    ? runtime.createItemUid
    : randomUUID;
  const nowEpochMs = typeof runtime.nowEpochMs === 'function' ? runtime.nowEpochMs : Date.now;

  function unavailable(res) {
    return response.error(
      res,
      503,
      'CHARACTER_REFERENCE_PACKAGE_STATE_UNAVAILABLE',
      'Character reference package state is unavailable',
    );
  }

  function knownError(res, error) {
    if (error instanceof V2RepositoryNotFoundError) {
      response.error(
        res,
        404,
        'CHARACTER_REFERENCE_PACKAGE_NOT_FOUND',
        'Character reference package state was not found',
      );
      return true;
    }
    if (error instanceof V2RepositoryConflictError) {
      response.error(
        res,
        409,
        'CHARACTER_REFERENCE_PACKAGE_CONFLICT',
        'Character reference package state conflict',
      );
      return true;
    }
    return false;
  }

  router.post('/characters/:characterUid/reference-packages', (req, res) => {
    if (!repository) return unavailable(res);
    try {
      const request = createCharacterReferencePackageRequest(req.body);
      const packageRecord = repository.create({
        packageUid: createPackageUid(),
        characterUid: req.params.characterUid,
        appearanceVersionUid: request.appearanceVersionUid,
        costumeVersionUid: request.costumeVersionUid,
        expectedLockStateVersion: request.expectedLockStateVersion,
        createdAtEpochMs: nowEpochMs(),
        items: request.items.map((item, ordinal) => Object.freeze({
          uid: createItemUid(),
          ordinal,
          kind: item.kind,
          assetVersionUid: item.assetVersionUid,
        })),
      });
      return response.created(res, packageRecord);
    } catch (error) {
      if (knownError(res, error)) return undefined;
      if (error instanceof TypeError) {
        return response.error(
          res,
          400,
          'CHARACTER_REFERENCE_PACKAGE_INPUT_INVALID',
          'Character reference package request is invalid',
        );
      }
      log?.error?.('character-reference-package-unexpected', {
        code: 'CHARACTER_REFERENCE_PACKAGE_UNEXPECTED',
      });
      return response.error(
        res,
        500,
        'CHARACTER_REFERENCE_PACKAGE_UNEXPECTED',
        'Character reference package operation failed',
      );
    }
  });

  router.get('/characters/:characterUid/reference-packages', (req, res) => {
    if (!repository) return unavailable(res);
    try {
      return response.success(res, repository.list(req.params.characterUid));
    } catch (error) {
      if (knownError(res, error)) return undefined;
      return response.error(
        res,
        400,
        'CHARACTER_REFERENCE_PACKAGE_INPUT_INVALID',
        'Character reference package request is invalid',
      );
    }
  });

  router.get('/characters/:characterUid/reference-packages/:packageUid', (req, res) => {
    if (!repository) return unavailable(res);
    try {
      const packageRecord = repository.get(req.params.packageUid);
      if (packageRecord.characterUid !== req.params.characterUid) {
        return response.error(
          res,
          404,
          'CHARACTER_REFERENCE_PACKAGE_NOT_FOUND',
          'Character reference package state was not found',
        );
      }
      return response.success(res, packageRecord);
    } catch (error) {
      if (knownError(res, error)) return undefined;
      return response.error(
        res,
        400,
        'CHARACTER_REFERENCE_PACKAGE_INPUT_INVALID',
        'Character reference package request is invalid',
      );
    }
  });

  return router;
}

module.exports = characterReferencePackageRoutes;
