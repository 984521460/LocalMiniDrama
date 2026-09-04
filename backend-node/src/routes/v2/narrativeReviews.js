const express = require('express');

const response = require('../../response');
const {
  createNarrativeReviewService,
  isNarrativeReviewError,
} = require('../../narrative/reviews');
const { createV2Repositories } = require('../../repositories/v2');

function parseDramaId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function narrativeReviewRoutes(database, log, options = {}) {
  const router = express.Router();
  const service = createNarrativeReviewService({
    repositories: createV2Repositories(database),
    ...(options.createUid ? { createUid: options.createUid } : {}),
  });

  function handleError(res, error, event) {
    if (isNarrativeReviewError(error)) {
      const status = error.code.endsWith('_NOT_FOUND') ? 404
        : ['NARRATIVE_REVIEW_NOT_APPROVED', 'NARRATIVE_REVIEW_STALE', 'NARRATIVE_REVIEW_CONFLICT'].includes(error.code) ? 409
          : error.code === 'NARRATIVE_REVIEW_DATA_INVALID' ? 500 : 400;
      return response.error(res, status, error.code, error.message);
    }
    log?.error?.(event, { code: 'NARRATIVE_REVIEW_UNEXPECTED' });
    return response.error(res, 500, 'NARRATIVE_REVIEW_UNEXPECTED', 'Narrative review operation failed');
  }

  router.get('/dramas/:dramaId/narrative-results', (req, res) => {
    try {
      const dramaId = parseDramaId(req.params.dramaId);
      if (dramaId === null) {
        return response.error(res, 400, 'NARRATIVE_REVIEW_INPUT_INVALID', 'Narrative review input is invalid');
      }
      return response.success(res, service.listForDrama(dramaId));
    } catch (error) {
      return handleError(res, error, 'narrative-review-list');
    }
  });

  router.get('/narrative-results/:resultUid', (req, res) => {
    try {
      return response.success(res, service.getResult(req.params.resultUid));
    } catch (error) {
      return handleError(res, error, 'narrative-review-detail');
    }
  });

  router.get('/narrative-results/:resultUid/evidence/:factId', (req, res) => {
    try {
      return response.success(
        res,
        service.getFactEvidence(req.params.resultUid, req.params.factId),
      );
    } catch (error) {
      return handleError(res, error, 'narrative-review-evidence');
    }
  });

  router.post('/narrative-results/:resultUid/reviews', (req, res) => {
    try {
      const body = req.body || {};
      return response.created(res, service.reviewResult({
        resultUid: req.params.resultUid,
        decision: body.decision,
        ...(Object.hasOwn(body, 'comment') ? { comment: body.comment } : {}),
      }));
    } catch (error) {
      return handleError(res, error, 'narrative-review-create');
    }
  });

  return router;
}

module.exports = narrativeReviewRoutes;
