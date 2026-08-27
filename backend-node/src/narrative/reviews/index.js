const { createNarrativeReviewService } = require('./service');
const {
  NarrativeReviewError,
  isNarrativeReviewError,
  narrativeReviewError,
} = require('./errors');

module.exports = {
  NarrativeReviewError,
  createNarrativeReviewService,
  isNarrativeReviewError,
  narrativeReviewError,
};
