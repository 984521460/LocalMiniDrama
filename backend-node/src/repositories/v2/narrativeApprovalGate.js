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

  function requireApprovedShot(resultUid) {
    try {
      return service.requireApproved(resultUid, 'shot');
    } catch (error) {
      if (!isNarrativeReviewError(error)) throw error;
      if (error.code === 'NARRATIVE_REVIEW_DATA_INVALID') {
        throw new V2RepositoryDataError('narrative approval chain', 'persisted record');
      }
      throw new V2RepositoryConflictError('narrative approval chain', 'referenced');
    }
  }

  return Object.freeze({ requireApprovedShot });
}

module.exports = { createNarrativeApprovalGate };
