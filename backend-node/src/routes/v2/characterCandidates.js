const express = require('express');
const { randomUUID } = require('node:crypto');

const response = require('../../response');
const {
  createCharacterCandidateBatchService,
  isCharacterCandidateError,
} = require('../../assets/characterCandidateBatch');
const {
  createV2Repositories,
  V2RepositoryConflictError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2');

function bodySnapshot(value, allowed) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== allowed.length) throw new TypeError();
    const output = Object.create(null);
    for (const key of allowed) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError();
      }
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

const GENERATE_FIELDS = Object.freeze([
  'prompt_semantic_uid',
  'profile_uid',
  'manifest_uid',
  'width',
  'height',
  'seed',
  'candidate_count',
]);
const LOCK_FIELDS = Object.freeze([
  'candidate_uid',
  'identity_version_uid',
  'expected_state_version',
]);

function statusFor(error) {
  if (error.code === 'CHARACTER_CANDIDATE_GENERATOR_UNAVAILABLE') return 503;
  if (
    error.code === 'CHARACTER_CANDIDATE_GENERATION_FAILED'
    || error.code === 'CHARACTER_CANDIDATE_OUTPUT_INVALID'
  ) return 502;
  return 400;
}

function characterCandidateRoutes(log, runtime = {}, database) {
  const router = express.Router();
  const service = createCharacterCandidateBatchService(runtime);
  const repository = database ? createV2Repositories(database).characterCandidates : null;
  const createLockEventUid = typeof runtime.createLockEventUid === 'function'
    ? runtime.createLockEventUid
    : randomUUID;
  const nowEpochMs = typeof runtime.nowEpochMs === 'function' ? runtime.nowEpochMs : Date.now;

  function stateError(res, error) {
    if (error instanceof V2RepositoryNotFoundError) {
      response.error(res, 404, 'CHARACTER_CANDIDATE_NOT_FOUND', 'Character candidate state was not found');
      return true;
    }
    if (error instanceof V2RepositoryConflictError) {
      response.error(res, 409, 'CHARACTER_CANDIDATE_CONFLICT', 'Character candidate state conflict');
      return true;
    }
    return false;
  }

  router.post('/characters/:characterUid/candidate-batches', async (req, res) => {
    try {
      const body = bodySnapshot(req.body, GENERATE_FIELDS);
      if (body === null) {
        return response.error(
          res,
          400,
          'CHARACTER_CANDIDATE_INPUT_INVALID',
          'Character candidate request is invalid',
        );
      }
      const batch = await service.generate({
        schemaVersion: '5.0',
        characterUid: req.params.characterUid,
        promptSemanticUid: body.prompt_semantic_uid,
        profileUid: body.profile_uid,
        manifestUid: body.manifest_uid,
        width: body.width,
        height: body.height,
        seed: body.seed,
        candidateCount: body.candidate_count,
      });
      return response.created(res, repository ? repository.appendBatch(batch) : batch);
    } catch (error) {
      if (isCharacterCandidateError(error)) {
        return response.error(res, statusFor(error), error.code, error.message);
      }
      const handled = stateError(res, error);
      if (handled) return handled;
      log?.error?.('character-candidate-unexpected', { code: 'CHARACTER_CANDIDATE_UNEXPECTED' });
      return response.error(
        res,
        500,
        'CHARACTER_CANDIDATE_UNEXPECTED',
        'Character candidate operation failed',
      );
    }
  });

  router.get('/characters/:characterUid/candidate-batches', (req, res) => {
    if (!repository) {
      return response.error(res, 503, 'CHARACTER_CANDIDATE_STATE_UNAVAILABLE', 'Character candidate state is unavailable');
    }
    try {
      return response.success(res, repository.listBatches(req.params.characterUid));
    } catch (error) {
      const handled = stateError(res, error);
      if (handled) return handled;
      return response.error(res, 400, 'CHARACTER_CANDIDATE_INPUT_INVALID', 'Character candidate request is invalid');
    }
  });

  router.get('/characters/:characterUid/identity-lock', (req, res) => {
    if (!repository) {
      return response.error(res, 503, 'CHARACTER_CANDIDATE_STATE_UNAVAILABLE', 'Character candidate state is unavailable');
    }
    try {
      return response.success(res, repository.getLockState(req.params.characterUid));
    } catch (error) {
      const handled = stateError(res, error);
      if (handled) return handled;
      return response.error(res, 400, 'CHARACTER_CANDIDATE_INPUT_INVALID', 'Character candidate request is invalid');
    }
  });

  for (const [path, operation] of [
    ['/characters/:characterUid/identity-lock', 'lock'],
    ['/characters/:characterUid/identity-unlock', 'unlock'],
  ]) {
    router.post(path, (req, res) => {
      if (!repository) {
        return response.error(res, 503, 'CHARACTER_CANDIDATE_STATE_UNAVAILABLE', 'Character candidate state is unavailable');
      }
      try {
        const body = bodySnapshot(req.body, LOCK_FIELDS);
        if (body === null) {
          return response.error(res, 400, 'CHARACTER_CANDIDATE_INPUT_INVALID', 'Character candidate request is invalid');
        }
        const state = repository[operation]({
          eventUid: createLockEventUid(),
          characterUid: req.params.characterUid,
          candidateUid: body.candidate_uid,
          identityVersionUid: body.identity_version_uid,
          expectedStateVersion: body.expected_state_version,
          changedAtEpochMs: nowEpochMs(),
        });
        return response.created(res, state);
      } catch (error) {
        const handled = stateError(res, error);
        if (handled) return handled;
        return response.error(res, 400, 'CHARACTER_CANDIDATE_INPUT_INVALID', 'Character candidate request is invalid');
      }
    });
  }

  return router;
}

module.exports = characterCandidateRoutes;
