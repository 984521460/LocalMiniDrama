'use strict';

const express = require('express');

const { isAudioModeContractError } = require('../../audio/audioContract');
const response = require('../../response');
const {
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2');

function audioTtsExecutionRoutes(log, runtime = {}) {
  const router = express.Router();
  const service = runtime.service ?? null;

  function unavailable(res) {
    return response.error(
      res, 503, 'AUDIO_TTS_EXECUTION_UNAVAILABLE', 'Audio TTS execution is unavailable',
    );
  }

  function handleError(res, error, event) {
    if (error instanceof V2RepositoryNotFoundError) {
      return response.error(res, 404, 'AUDIO_TTS_EXECUTION_NOT_FOUND', 'Audio TTS execution was not found');
    }
    if (error instanceof V2RepositoryDataError) {
      return response.error(res, 409, 'AUDIO_TTS_EXECUTION_DATA_INVALID', 'Audio TTS execution state is invalid');
    }
    if (isAudioModeContractError(error)) {
      const status = error.code === 'AUDIO_TTS_EXECUTION_NOT_FOUND' ? 404
        : error.code === 'AUDIO_TTS_EXECUTION_INPUT_INVALID' ? 400
        : error.code === 'AUDIO_TTS_PROVIDER_UNAVAILABLE' ? 503
          : error.code === 'AUDIO_TTS_EXECUTION_FAILED'
            || error.code === 'AUDIO_TTS_PROVIDER_REJECTED'
            || error.code === 'AUDIO_TTS_RESPONSE_INVALID'
            || error.code === 'AUDIO_TTS_REQUEST_ABORTED' ? 502 : 409;
      return response.error(res, status, error.code, error.message);
    }
    try { log?.error?.(event, { code: 'AUDIO_TTS_EXECUTION_UNEXPECTED' }); } catch { /* fixed */ }
    return response.error(
      res, 500, 'AUDIO_TTS_EXECUTION_UNEXPECTED', 'Audio TTS execution failed',
    );
  }

  router.post('/dramas/:dramaUid/audio-tts-executions/:intentUid/execute', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      const record = await service.execute(req.params.intentUid, req.params.dramaUid);
      return response.success(res, record);
    } catch (error) {
      return handleError(res, error, 'audio-tts-execution');
    }
  });

  router.get('/dramas/:dramaUid/audio-tts-executions/:intentUid', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      const record = await service.get(req.params.intentUid, req.params.dramaUid);
      if (!record) {
        return response.error(res, 404, 'AUDIO_TTS_EXECUTION_NOT_FOUND', 'Audio TTS execution was not found');
      }
      return response.success(res, record);
    } catch (error) {
      return handleError(res, error, 'audio-tts-execution-get');
    }
  });

  return router;
}

module.exports = audioTtsExecutionRoutes;
