'use strict';

const {
  NarrativeExecutionError,
  createNarrativeExecutionService,
  isNarrativeExecutionError,
} = require('./service');
const {
  NarrativeExecutionRequestError,
  canonicalNarrativeExecutionRequest,
  narrativeExecutionRequestSha256,
  parseNarrativeExecutionRequest,
  parseNarrativeExecutionRequestJson,
} = require('./request');
const {
  createConfiguredNarrativeTextProvider,
} = require('./configuredTextProvider');

module.exports = Object.freeze({
  NarrativeExecutionError,
  NarrativeExecutionRequestError,
  canonicalNarrativeExecutionRequest,
  createConfiguredNarrativeTextProvider,
  createNarrativeExecutionService,
  isNarrativeExecutionError,
  narrativeExecutionRequestSha256,
  parseNarrativeExecutionRequest,
  parseNarrativeExecutionRequestJson,
});
