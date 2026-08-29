const { randomUUID } = require('node:crypto');
const express = require('express');

const {
  createVoiceProfileActivationRequest,
  createVoiceProfilePublicRecord,
  createVoiceProfileRequest,
} = require('../../audio/voiceProfile');
const response = require('../../response');
const {
  createV2Repositories,
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2');

function voiceProfileRoutes(log, runtime = {}, database) {
  const router = express.Router();
  const repository = database ? createV2Repositories(database).voiceProfiles : null;
  const createProfileUid = typeof runtime.createProfileUid === 'function'
    ? runtime.createProfileUid
    : randomUUID;
  const createSelectionUid = typeof runtime.createSelectionUid === 'function'
    ? runtime.createSelectionUid
    : randomUUID;
  const nowEpochMs = typeof runtime.nowEpochMs === 'function' ? runtime.nowEpochMs : Date.now;

  function unavailable(res) {
    return response.error(
      res,
      503,
      'VOICE_PROFILE_STATE_UNAVAILABLE',
      'Voice profile state is unavailable',
    );
  }

  function knownError(res, error) {
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

  function matchesRoute(record, req) {
    return record.dramaUid === req.params.dramaUid
      && record.characterUid === req.params.characterUid;
  }

  router.post('/dramas/:dramaUid/characters/:characterUid/voice-profiles', (req, res) => {
    if (!repository) return unavailable(res);
    try {
      const request = createVoiceProfileRequest(req.body);
      const profile = repository.create({
        schemaVersion: '8.0',
        uid: createProfileUid(),
        dramaUid: req.params.dramaUid,
        characterUid: req.params.characterUid,
        characterVoiceVersionUid: request.characterVoiceVersionUid,
        parentUid: request.parentUid,
        revision: request.revision,
        provider: request.provider,
        model: request.model,
        voiceKey: request.voiceKey,
        credentialRef: request.credentialRef,
        sourceKind: 'provider-preset',
        status: 'ready',
        defaultEmotion: request.defaultEmotion,
        emotionMap: request.emotionMap,
        minimumSpeedPermille: request.minimumSpeedPermille,
        defaultSpeedPermille: request.defaultSpeedPermille,
        maximumSpeedPermille: request.maximumSpeedPermille,
        createdAtEpochMs: nowEpochMs(),
      });
      return response.created(res, createVoiceProfilePublicRecord(profile));
    } catch (error) {
      if (knownError(res, error)) return undefined;
      if (error instanceof TypeError) return inputError(res);
      log?.error?.('voice-profile-create-unexpected', { code: 'VOICE_PROFILE_UNEXPECTED' });
      return response.error(res, 500, 'VOICE_PROFILE_UNEXPECTED', 'Voice profile operation failed');
    }
  });

  router.get('/dramas/:dramaUid/characters/:characterUid/voice-profiles', (req, res) => {
    if (!repository) return unavailable(res);
    try {
      const profiles = repository.list(req.params.characterUid)
        .filter((profile) => profile.dramaUid === req.params.dramaUid)
        .map(createVoiceProfilePublicRecord);
      return response.success(res, Object.freeze(profiles));
    } catch (error) {
      if (knownError(res, error)) return undefined;
      return inputError(res);
    }
  });

  router.get('/dramas/:dramaUid/characters/:characterUid/voice-profiles/active', (req, res) => {
    if (!repository) return unavailable(res);
    try {
      const active = repository.getActive(req.params.characterUid);
      if (!active || !matchesRoute(active.profile, req)) {
        return response.error(res, 404, 'VOICE_PROFILE_NOT_FOUND', 'Voice profile was not found');
      }
      return response.success(res, Object.freeze({
        selection: active.selection,
        profile: createVoiceProfilePublicRecord(active.profile),
      }));
    } catch (error) {
      if (knownError(res, error)) return undefined;
      return inputError(res);
    }
  });

  router.get('/dramas/:dramaUid/characters/:characterUid/voice-profiles/:profileUid', (req, res) => {
    if (!repository) return unavailable(res);
    try {
      const profile = repository.get(req.params.profileUid);
      if (!matchesRoute(profile, req)) {
        return response.error(res, 404, 'VOICE_PROFILE_NOT_FOUND', 'Voice profile was not found');
      }
      return response.success(res, createVoiceProfilePublicRecord(profile));
    } catch (error) {
      if (knownError(res, error)) return undefined;
      return inputError(res);
    }
  });

  router.post(
    '/dramas/:dramaUid/characters/:characterUid/voice-profiles/:profileUid/activate',
    (req, res) => {
      if (!repository) return unavailable(res);
      try {
        const request = createVoiceProfileActivationRequest(req.body);
        const profile = repository.get(req.params.profileUid);
        if (!matchesRoute(profile, req)) {
          return response.error(res, 404, 'VOICE_PROFILE_NOT_FOUND', 'Voice profile was not found');
        }
        const current = repository.getActive(req.params.characterUid);
        const currentStateVersion = current?.selection.stateVersion ?? 0;
        if (request.expectedStateVersion !== currentStateVersion) {
          throw new V2RepositoryConflictError('voice profile selection', 'created');
        }
        const selection = repository.activate({
          schemaVersion: '8.0',
          uid: createSelectionUid(),
          dramaUid: req.params.dramaUid,
          characterUid: req.params.characterUid,
          voiceProfileUid: profile.uid,
          previousVoiceProfileUid: current?.profile.uid ?? null,
          stateVersion: currentStateVersion + 1,
          changedAtEpochMs: nowEpochMs(),
        });
        return response.created(res, Object.freeze({
          selection,
          profile: createVoiceProfilePublicRecord(profile),
        }));
      } catch (error) {
        if (knownError(res, error)) return undefined;
        if (error instanceof TypeError) return inputError(res);
        log?.error?.('voice-profile-activate-unexpected', { code: 'VOICE_PROFILE_UNEXPECTED' });
        return response.error(res, 500, 'VOICE_PROFILE_UNEXPECTED', 'Voice profile operation failed');
      }
    },
  );

  return router;
}

module.exports = voiceProfileRoutes;
