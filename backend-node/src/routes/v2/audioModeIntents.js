'use strict';

const express = require('express');

const { isAudioModeContractError } = require('../../audio/audioContract');
const { publicAudioModeIntent } = require('../../audio/audioModeIntent');
const response = require('../../response');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
  createV2Repositories,
} = require('../../repositories/v2');

function audioModeIntentRoutes(log, runtime = {}, database) {
  const router = express.Router();
  const repository = runtime.repository
    ?? (database ? createV2Repositories(database).audioModeIntents : null);

  function unavailable(res) {
    return response.error(
      res,
      503,
      'AUDIO_MODE_INTENT_STATE_UNAVAILABLE',
      'Audio mode intent state is unavailable',
    );
  }

  function inputInvalid(res) {
    return response.error(
      res,
      400,
      'AUDIO_MODE_INTENT_INPUT_INVALID',
      'Audio mode intent request is invalid',
    );
  }

  function handleError(res, error, event) {
    if (error instanceof V2RepositoryNotFoundError) {
      return response.error(
        res,
        404,
        'AUDIO_MODE_INTENT_NOT_FOUND',
        'Audio mode intent was not found',
      );
    }
    if (error instanceof V2RepositoryConflictError) {
      return response.error(
        res,
        409,
        'AUDIO_MODE_INTENT_CONFLICT',
        'Audio mode intent source state conflicts with the request',
      );
    }
    if (error instanceof V2RepositoryDataError) {
      return response.error(
        res,
        409,
        'AUDIO_MODE_INTENT_DATA_INVALID',
        'Audio mode intent state is invalid',
      );
    }
    if (isAudioModeContractError(error) || error instanceof TypeError) {
      return inputInvalid(res);
    }
    log?.error?.(event, { code: 'AUDIO_MODE_INTENT_UNEXPECTED' });
    return response.error(
      res,
      500,
      'AUDIO_MODE_INTENT_UNEXPECTED',
      'Audio mode intent operation failed',
    );
  }

  router.post('/dramas/:dramaUid/audio-mode-intents', (req, res) => {
    if (!repository) return unavailable(res);
    if (req.body?.dramaUid !== req.params.dramaUid) return inputInvalid(res);
    try {
      return response.created(res, publicAudioModeIntent(repository.prepare(req.body)));
    } catch (error) {
      return handleError(res, error, 'audio-mode-intent-prepare');
    }
  });

  router.get('/dramas/:dramaUid/audio-mode-intents/:intentUid', (req, res) => {
    if (!repository) return unavailable(res);
    try {
      const intent = repository.get(req.params.intentUid);
      if (intent.dramaUid !== req.params.dramaUid) {
        return response.error(
          res,
          404,
          'AUDIO_MODE_INTENT_NOT_FOUND',
          'Audio mode intent was not found',
        );
      }
      return response.success(res, publicAudioModeIntent(intent));
    } catch (error) {
      return handleError(res, error, 'audio-mode-intent-get');
    }
  });

  return router;
}

module.exports = audioModeIntentRoutes;
