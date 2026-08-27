const {
  NarrativeStalenessError,
  isNarrativeStalenessError,
  narrativeStalenessError,
} = require('./errors');
const { createNarrativeStalenessService } = require('./service');

module.exports = {
  NarrativeStalenessError,
  createNarrativeStalenessService,
  isNarrativeStalenessError,
  narrativeStalenessError,
};
