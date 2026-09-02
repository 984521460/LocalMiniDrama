const express = require('express');

const {
  createVoiceProfileConfigurationService,
  getVoiceProfileConfigurationErrorCode,
} = require('../../audio/voiceProfileConfigurationService');
const response = require('../../response');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2');

function dataProperty(value, name) {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function voiceProfileRoutes(log, runtime = {}, database) {
  const router = express.Router();
  let service = null;
  if (database) {
    try {
      service = createVoiceProfileConfigurationService({
        database,
        credentialVault: dataProperty(runtime, 'credentialVault'),
        createUid: dataProperty(runtime, 'createUid'),
        createVersionUid: dataProperty(runtime, 'createVersionUid'),
        createProfileUid: dataProperty(runtime, 'createProfileUid'),
        createSelectionUid: dataProperty(runtime, 'createSelectionUid'),
        nowEpochMs: dataProperty(runtime, 'nowEpochMs'),
        timeoutMs: dataProperty(runtime, 'timeoutMs'),
      });
    } catch {
      service = null;
    }
  }

  function unavailable(res) {
    return response.error(
      res,
      503,
      'VOICE_PROFILE_STATE_UNAVAILABLE',
      'Voice profile state is unavailable',
    );
  }

  function knownError(res, error) {
    const configurationCode = getVoiceProfileConfigurationErrorCode(error);
    if (configurationCode === 'VOICE_PROFILE_CREDENTIAL_INVALID') {
      response.error(res, 409, configurationCode, 'Voice profile credential is invalid');
      return true;
    }
    if (configurationCode === 'VOICE_PROFILE_CREDENTIAL_UNAVAILABLE') {
      response.error(res, 503, configurationCode, 'Voice profile credential state is unavailable');
      return true;
    }
    if (error instanceof V2RepositoryNotFoundError) {
      response.error(res, 404, 'VOICE_PROFILE_NOT_FOUND', 'Voice profile was not found');
      return true;
    }
    if (error instanceof V2RepositoryConflictError) {
      response.error(res, 409, 'VOICE_PROFILE_CONFLICT', 'Voice profile state conflict');
      return true;
    }
    if (error instanceof V2RepositoryDataError) {
      response.error(res, 409, 'VOICE_PROFILE_DATA_INVALID', 'Voice profile state is invalid');
      return true;
    }
    return false;
  }

  function inputError(res) {
    return response.error(res, 400, 'VOICE_PROFILE_INPUT_INVALID', 'Voice profile request is invalid');
  }

  router.get('/dramas/:dramaUid/characters/:characterUid/voice-configuration', (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(
        res,
        service.getState(req.params.dramaUid, req.params.characterUid),
      );
    } catch (error) {
      if (knownError(res, error)) return undefined;
      if (error instanceof TypeError) return inputError(res);
      return response.error(res, 500, 'VOICE_PROFILE_UNEXPECTED', 'Voice profile operation failed');
    }
  });

  router.post('/dramas/:dramaUid/characters/:characterUid/identity-versions', (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.created(res, service.createIdentityVersion(
        req.params.dramaUid, req.params.characterUid, req.body,
      ));
    } catch (error) {
      if (knownError(res, error)) return undefined;
      if (error instanceof TypeError) return inputError(res);
      return response.error(res, 500, 'VOICE_PROFILE_UNEXPECTED', 'Voice profile operation failed');
    }
  });

  router.post('/dramas/:dramaUid/characters/:characterUid/voice-versions', (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.created(res, service.createVoiceVersion(
        req.params.dramaUid, req.params.characterUid, req.body,
      ));
    } catch (error) {
      if (knownError(res, error)) return undefined;
      if (error instanceof TypeError) return inputError(res);
      return response.error(res, 500, 'VOICE_PROFILE_UNEXPECTED', 'Voice profile operation failed');
    }
  });

  router.post('/dramas/:dramaUid/characters/:characterUid/voice-profiles', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      const profile = await service.createProfile(
        req.params.dramaUid, req.params.characterUid, req.body,
      );
      return response.created(res, profile);
    } catch (error) {
      if (knownError(res, error)) return undefined;
      if (error instanceof TypeError) return inputError(res);
      try { log?.error?.('voice-profile-create-unexpected', { code: 'VOICE_PROFILE_UNEXPECTED' }); } catch { /* fixed */ }
      return response.error(res, 500, 'VOICE_PROFILE_UNEXPECTED', 'Voice profile operation failed');
    }
  });

  router.get('/dramas/:dramaUid/characters/:characterUid/voice-profiles', (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(
        res,
        service.getState(req.params.dramaUid, req.params.characterUid).profiles,
      );
    } catch (error) {
      if (knownError(res, error)) return undefined;
      return inputError(res);
    }
  });

  router.get('/dramas/:dramaUid/characters/:characterUid/voice-profiles/active', (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(
        res,
        service.getActive(req.params.dramaUid, req.params.characterUid),
      );
    } catch (error) {
      if (knownError(res, error)) return undefined;
      return inputError(res);
    }
  });

  router.get('/dramas/:dramaUid/characters/:characterUid/voice-profiles/:profileUid', (req, res) => {
    if (!service) return unavailable(res);
    try {
      return response.success(res, service.getProfile(
        req.params.dramaUid, req.params.characterUid, req.params.profileUid,
      ));
    } catch (error) {
      if (knownError(res, error)) return undefined;
      return inputError(res);
    }
  });

  router.post(
    '/dramas/:dramaUid/characters/:characterUid/voice-profiles/:profileUid/activate',
    async (req, res) => {
      if (!service) return unavailable(res);
      try {
        return response.created(res, await service.activateProfile(
          req.params.dramaUid,
          req.params.characterUid,
          req.params.profileUid,
          req.body,
        ));
      } catch (error) {
        if (knownError(res, error)) return undefined;
        if (error instanceof TypeError) return inputError(res);
        try { log?.error?.('voice-profile-activate-unexpected', { code: 'VOICE_PROFILE_UNEXPECTED' }); } catch { /* fixed */ }
        return response.error(res, 500, 'VOICE_PROFILE_UNEXPECTED', 'Voice profile operation failed');
      }
    },
  );

  return router;
}

module.exports = voiceProfileRoutes;
