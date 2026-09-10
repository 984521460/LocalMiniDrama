'use strict';

const express = require('express');

const response = require('../../response');
const {
  CharacterCandidateExecutionError,
  isCharacterCandidateExecutionError,
} = require('../../characterCandidates/execution');
const { createV2Repositories } = require('../../repositories/v2');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HISTORY_CURSOR = /^[0-9]{1,15}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function legacyDramaId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function historyCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 64 || !HISTORY_CURSOR.test(value)) {
    throw new CharacterCandidateExecutionError(
      'CHARACTER_CANDIDATE_EXECUTION_INPUT_INVALID',
    );
  }
  return value;
}

function statusFor(code) {
  if (code === 'CHARACTER_CANDIDATE_EXECUTION_NOT_FOUND') return 404;
  if (code === 'CHARACTER_CANDIDATE_EXECUTION_INPUT_INVALID') return 400;
  if (code === 'CHARACTER_CANDIDATE_EXECUTION_UNAVAILABLE') return 503;
  if (code === 'CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID') return 422;
  if (code === 'CHARACTER_CANDIDATE_EXECUTION_DATA_INVALID') return 500;
  return 409;
}

function characterCandidateExecutionRoutes(database, log, runtime) {
  const router = express.Router();
  const sources = createV2Repositories(database).sources;
  const service = runtime && typeof runtime.execute === 'function'
    && typeof runtime.get === 'function' ? runtime : null;

  function unavailable(res) {
    return response.error(
      res,
      503,
      'CHARACTER_CANDIDATE_EXECUTION_UNAVAILABLE',
      'Character candidate execution is unavailable',
    );
  }

  function handle(res, error, event) {
    if (typeof error?.code === 'string' && error.code.startsWith('CHARACTER_COLLECTION_')) {
      return response.error(res,409,error.code,'角色续收需检查；不会重新提交生成');
    }
    if (isCharacterCandidateExecutionError(error)) {
      return response.error(res, statusFor(error.code), error.code, error.message);
    }
    log?.error?.(event, { code: 'CHARACTER_CANDIDATE_EXECUTION_UNEXPECTED' });
    return response.error(
      res,
      500,
      'CHARACTER_CANDIDATE_EXECUTION_UNEXPECTED',
      'Character candidate execution failed',
    );
  }

  router.post('/dramas/:dramaId/characters/:characterUid/candidate-executions', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      const dramaId = legacyDramaId(req.params.dramaId);
      const drama = dramaId === null ? null : sources.findDramaByLegacyId(dramaId);
      if (!drama || req.body?.dramaUid !== drama.uid
        || req.body?.characterUid !== req.params.characterUid) {
        throw new CharacterCandidateExecutionError(
          'CHARACTER_CANDIDATE_EXECUTION_INPUT_INVALID',
        );
      }
      return response.success(res, await service.execute(req.body));
    } catch (error) {
      return handle(res, error, 'character-candidate-execution-create');
    }
  });

  router.get('/dramas/:dramaId/characters/:characterUid/candidate-recoveries', async (req,res)=>{
    if(!runtime?.listRecoveries)return response.success(res,{schemaVersion:'character-candidate-recovery-list.v1',records:[]});
    try{const drama=sources.findDramaByLegacyId(legacyDramaId(req.params.dramaId));if(!drama||!UUID_V4.test(req.params.characterUid))return response.badRequest(res,'角色范围无效');
      return response.success(res,await runtime.listRecoveries({dramaUid:drama.uid,characterUid:req.params.characterUid}));
    }catch(error){return handle(res,error,'candidate-recovery-list');}
  });
  router.post('/dramas/:dramaId/characters/:characterUid/candidate-recoveries/:operationUid/recover',async(req,res)=>{
    if(!runtime?.recover||!runtime?.getRecovery)return unavailable(res);
    try{const drama=sources.findDramaByLegacyId(legacyDramaId(req.params.dramaId));if(!drama||!UUID_V4.test(req.params.operationUid)||Object.keys(req.body||{}).length) return response.badRequest(res,'续收范围无效');
      const current=await runtime.getRecovery(req.params.operationUid);if(current.dramaUid!==drama.uid||current.characterUid!==req.params.characterUid)return response.badRequest(res,'续收归属不匹配');
      return response.success(res,await runtime.recover(req.params.operationUid));
    }catch(error){return handle(res,error,'candidate-recovery');}
  });

  router.get('/dramas/:dramaId/characters/:characterUid/candidate-executions/history', async (req, res) => {
    if (!service || typeof service.listHistory !== 'function') return unavailable(res);
    try {
      const dramaId = legacyDramaId(req.params.dramaId);
      const drama = dramaId === null ? null : sources.findDramaByLegacyId(dramaId);
      if (!drama || !UUID_V4.test(req.params.characterUid)) {
        throw new CharacterCandidateExecutionError(
          'CHARACTER_CANDIDATE_EXECUTION_INPUT_INVALID',
        );
      }
      return response.success(res, await service.listHistory({
        dramaUid: drama.uid,
        characterUid: req.params.characterUid,
        cursor: historyCursor(req.query.cursor),
      }));
    } catch (error) {
      return handle(res, error, 'character-candidate-execution-history');
    }
  });

  router.get('/character-candidate-executions/:operationUid', async (req, res) => {
    if (!service) return unavailable(res);
    try {
      if (!UUID_V4.test(req.params.operationUid)) {
        throw new CharacterCandidateExecutionError(
          'CHARACTER_CANDIDATE_EXECUTION_INPUT_INVALID',
        );
      }
      return response.success(res, await service.get(req.params.operationUid));
    } catch (error) {
      return handle(res, error, 'character-candidate-execution-get');
    }
  });

  return router;
}

module.exports = characterCandidateExecutionRoutes;
