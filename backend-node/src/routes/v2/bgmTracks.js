'use strict';

const express = require('express');
const multer = require('multer');

const { isAudioModeContractError } = require('../../audio/audioContract');
const { MAX_BGM_IMPORT_BYTES } = require('../../audio/bgmImportService');
const response = require('../../response');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BGM_IMPORT_BYTES,
    files: 1,
    fields: 4,
    fieldNameSize: 64,
    fieldSize: 1024,
  },
});

function exactFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
  const expected = [
    'commercial_use_allowed', 'derivatives_allowed', 'license_basis', 'title',
  ];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length) throw new TypeError();
  for (let index = 0; index < expected.length; index += 1) {
    if (!Object.hasOwn(descriptors, expected[index])) throw new TypeError();
    const descriptor = descriptors[expected[index]];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string') throw new TypeError();
  }
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    let found = false;
    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
      if (keys[keyIndex] === expected[expectedIndex]) found = true;
    }
    if (!found) throw new TypeError();
  }
  return value;
}

function booleanField(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TypeError();
}

function bgmTrackRoutes(log, runtime) {
  const router = express.Router();
  const service = runtime?.service ?? null;

  function unavailable(res) {
    return response.error(res, 503, 'BGM_LIBRARY_UNAVAILABLE', 'BGM library is unavailable');
  }

  function handleError(res, error, operation) {
    if (isAudioModeContractError(error)) {
      const status = error.code === 'BGM_IMPORT_INVALID' ? 400 : 409;
      return response.error(res, status, error.code, error.message);
    }
    log?.error?.('bgm-library-unexpected', { operation, code: 'BGM_LIBRARY_UNEXPECTED' });
    return response.error(res, 500, 'BGM_LIBRARY_UNEXPECTED', 'BGM library operation failed');
  }

  router.get('/dramas/:dramaUid/bgm-tracks', (req, res) => {
    if (!service) return unavailable(res);
    if (!UUID_V4.test(req.params.dramaUid)) {
      return response.error(res, 400, 'BGM_IMPORT_INVALID', 'BGM import input is invalid');
    }
    try {
      return response.success(res, service.listByDrama(req.params.dramaUid));
    } catch (error) {
      if (error?.code === 'BGM_IMPORT_INVALID') {
        return response.error(res, 404, 'BGM_LIBRARY_NOT_FOUND', 'BGM library was not found');
      }
      return handleError(res, error, 'list');
    }
  });

  router.post('/dramas/:dramaUid/bgm-tracks', (req, res) => {
    if (!service) return unavailable(res);
    upload.single('file')(req, res, async (uploadError) => {
      if (uploadError) {
        const tooLarge = uploadError.code === 'LIMIT_FILE_SIZE';
        return response.error(
          res,
          tooLarge ? 413 : 400,
          tooLarge ? 'BGM_IMPORT_TOO_LARGE' : 'BGM_IMPORT_INVALID',
          tooLarge ? 'BGM file exceeds the import limit' : 'BGM import input is invalid',
        );
      }
      try {
        if (!UUID_V4.test(req.params.dramaUid) || !req.file?.buffer) throw new TypeError();
        const fields = exactFields(req.body);
        const created = await service.importTrack({
          dramaUid: req.params.dramaUid,
          title: fields.title,
          mimeType: req.file.mimetype,
          licenseBasis: fields.license_basis,
          commercialUseAllowed: booleanField(fields.commercial_use_allowed),
          derivativesAllowed: booleanField(fields.derivatives_allowed),
          bytes: req.file.buffer,
        });
        return response.created(res, created);
      } catch (error) {
        if (error instanceof TypeError && !isAudioModeContractError(error)) {
          return response.error(res, 400, 'BGM_IMPORT_INVALID', 'BGM import input is invalid');
        }
        return handleError(res, error, 'import');
      }
    });
  });

  return router;
}

module.exports = bgmTrackRoutes;
