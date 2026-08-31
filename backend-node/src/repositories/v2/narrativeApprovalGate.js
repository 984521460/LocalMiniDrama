const {
  createNarrativeReviewService,
  isNarrativeReviewError,
} = require('../../narrative/reviews');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
} = require('./errors');

function createNarrativeApprovalGate({ narrativeReviews, sources } = {}) {
  const service = createNarrativeReviewService({
    repositories: { narrativeReviews, sources },
  });

  function requireApprovedNarrative(resultUid, expectedType) {
    try {
      const approved = service.requireApproved(resultUid, expectedType);
      const detail = service.getResult(resultUid);
      if (detail.result.uid !== resultUid || detail.result.resultType !== expectedType
        || detail.approval?.reviewRef !== approved.approval.reviewRef) {
        throw new V2RepositoryDataError('narrative approval chain', 'persisted record');
      }
      return Object.freeze({
        record: detail.result,
        result: approved.result,
        approval: approved.approval,
      });
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      if (!isNarrativeReviewError(error)) throw error;
      if (error.code === 'NARRATIVE_REVIEW_DATA_INVALID') {
        throw new V2RepositoryDataError('narrative approval chain', 'persisted record');
      }
      throw new V2RepositoryConflictError('narrative approval chain', 'referenced');
    }
  }

  function requireApprovedShot(resultUid) {
    const approved = requireApprovedNarrative(resultUid, 'shot');
    return Object.freeze({ result: approved.result, approval: approved.approval });
  }

  return Object.freeze({ requireApprovedNarrative, requireApprovedShot });
}

module.exports = { createNarrativeApprovalGate };
