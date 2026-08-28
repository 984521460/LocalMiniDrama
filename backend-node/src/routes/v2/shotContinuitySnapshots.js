const express = require('express');
const { randomUUID } = require('node:crypto');

const response = require('../../response');
const {
  createShotContinuitySnapshotRequest,
} = require('../../assets/shotContinuitySnapshot');
const {
  createNarrativeReviewService,
  isNarrativeReviewError,
} = require('../../narrative/reviews');
const {
  createV2Repositories,
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2');

function shotContinuitySnapshotRoutes(log, runtime = {}, database) {
  const router = express.Router();
  const repositories = database ? createV2Repositories(database) : null;
  const repository = repositories?.shotContinuitySnapshots || null;
  const createSnapshotUid = typeof runtime.createSnapshotUid === 'function'
    ? runtime.createSnapshotUid
    : randomUUID;
  const nowEpochMs = typeof runtime.nowEpochMs === 'function' ? runtime.nowEpochMs : Date.now;
  const reviewService = repositories ? createNarrativeReviewService({ repositories }) : null;

  function unavailable(res) {
    return response.error(
      res,
      503,
      'SHOT_CONTINUITY_STATE_UNAVAILABLE',
      'Shot continuity state is unavailable',
    );
  }

  function resolveApprovedShot(resultUid, shotId) {
    if (typeof runtime.getApprovedShot === 'function') {
      return runtime.getApprovedShot(resultUid, shotId);
    }
    const detail = reviewService.getResult(resultUid);
    if (detail.result.resultType !== 'shot'
      || detail.result.status !== 'approved'
      || !detail.approval) throw new V2RepositoryConflictError('shot planning result', 'referenced');
    const shot = detail.result.result?.output?.shots?.find((entry) => entry.shotId === shotId);
    if (!shot) throw new V2RepositoryNotFoundError('planned shot');
    return Object.freeze({
      dramaUid: detail.result.dramaUid,
      shotResultUid: detail.result.uid,
      shotResultHash: detail.result.resultHash,
      shotEnvelopeHash: detail.result.envelopeHash,
      shotApprovalRef: detail.approval.reviewRef,
      shotId: shot.shotId,
      shotOrdinal: shot.ordinal,
    });
  }

  function handleError(res, error, event) {
    if (error instanceof V2RepositoryNotFoundError) {
      return response.error(
        res,
        404,
        'SHOT_CONTINUITY_NOT_FOUND',
        'Shot continuity state was not found',
      );
    }
    if (isNarrativeReviewError(error) && error.code === 'NARRATIVE_REVIEW_NOT_FOUND') {
      return response.error(
        res,
        404,
        'SHOT_CONTINUITY_NOT_FOUND',
        'Shot continuity state was not found',
      );
    }
    if (error instanceof V2RepositoryConflictError
      || (isNarrativeReviewError(error)
        && ['NARRATIVE_REVIEW_NOT_APPROVED', 'NARRATIVE_REVIEW_STALE', 'NARRATIVE_REVIEW_CONFLICT']
          .includes(error.code))) {
      return response.error(
        res,
        409,
        'SHOT_CONTINUITY_CONFLICT',
        'Shot continuity state conflict',
      );
    }
    if (error instanceof V2RepositoryDataError
      || (isNarrativeReviewError(error) && error.code === 'NARRATIVE_REVIEW_DATA_INVALID')) {
      return response.error(
        res,
        500,
        'SHOT_CONTINUITY_DATA_INVALID',
        'Shot continuity persisted state is invalid',
      );
    }
    if (error instanceof TypeError
      || (isNarrativeReviewError(error) && error.code === 'NARRATIVE_REVIEW_INPUT_INVALID')) {
      return response.error(
        res,
        400,
        'SHOT_CONTINUITY_INPUT_INVALID',
        'Shot continuity request is invalid',
      );
    }
    log?.error?.(event, { code: 'SHOT_CONTINUITY_UNEXPECTED' });
    return response.error(
      res,
      500,
      'SHOT_CONTINUITY_UNEXPECTED',
      'Shot continuity operation failed',
    );
  }

  router.post('/narrative-results/:resultUid/shots/:shotId/continuity-snapshots', (req, res) => {
    if (!repository) return unavailable(res);
    try {
      const request = createShotContinuitySnapshotRequest(req.body);
      const approved = resolveApprovedShot(req.params.resultUid, req.params.shotId);
      return response.created(res, repository.create({
        snapshotUid: createSnapshotUid(),
        dramaUid: approved.dramaUid,
        shotResultUid: approved.shotResultUid,
        shotResultHash: approved.shotResultHash,
        shotEnvelopeHash: approved.shotEnvelopeHash,
        shotApprovalRef: approved.shotApprovalRef,
        shotId: approved.shotId,
        shotOrdinal: approved.shotOrdinal,
        scene: request.scene,
        characters: request.characters,
        props: request.props,
        createdAtEpochMs: nowEpochMs(),
      }));
    } catch (error) {
      return handleError(res, error, 'shot-continuity-create');
    }
  });

  router.get('/narrative-results/:resultUid/continuity-snapshots', (req, res) => {
    if (!repository) return unavailable(res);
    try {
      return response.success(res, repository.list(req.params.resultUid));
    } catch (error) {
      return handleError(res, error, 'shot-continuity-list');
    }
  });

  router.get('/continuity-snapshots/:snapshotUid', (req, res) => {
    if (!repository) return unavailable(res);
    try {
      return response.success(res, repository.get(req.params.snapshotUid));
    } catch (error) {
      return handleError(res, error, 'shot-continuity-detail');
    }
  });

  router.get('/continuity-snapshots/:fromSnapshotUid/compare/:toSnapshotUid', (req, res) => {
    if (!repository) return unavailable(res);
    try {
      return response.success(res, repository.compare(
        req.params.fromSnapshotUid,
        req.params.toSnapshotUid,
      ));
    } catch (error) {
      return handleError(res, error, 'shot-continuity-compare');
    }
  });

  return router;
}

module.exports = shotContinuitySnapshotRoutes;
