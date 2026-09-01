'use strict';

const {
  createEpisodeAdaptationInputHash,
  normalizeAdaptationDomain,
} = require('../tasks/episodeAdaptationTask');
const {
  createScriptInputHash,
  normalizeScriptDomain,
} = require('../tasks/scriptDomain');
const {
  createShotPlanningInputHash,
  normalizeShotDomain,
} = require('../tasks/shotDomain');
const { normalizeSource } = require('../tasks/sourceEvidence');

function narrativeExecutionExpectedInputHash(resultType, context) {
  if (!context || typeof context !== 'object') {
    throw new TypeError('Narrative execution context is invalid');
  }
  if (resultType === 'extraction') return normalizeSource(context.source).inputHash;
  if (resultType === 'adaptation') {
    return createEpisodeAdaptationInputHash(normalizeAdaptationDomain(context.domain));
  }
  if (resultType === 'script') {
    return createScriptInputHash(normalizeScriptDomain(context.domain));
  }
  if (resultType === 'shot') {
    return createShotPlanningInputHash(normalizeShotDomain(context.domain));
  }
  throw new TypeError('Narrative execution result type is invalid');
}

module.exports = Object.freeze({ narrativeExecutionExpectedInputHash });
