'use strict';

const {
  normalizeNarrativeResult,
  resultHashes,
} = require('../reviews/contracts');
const { sha256Canonical } = require('../tasks/jsonSnapshot');
const {
  parseNarrativeExecutionRequestJson,
} = require('./request');

const PREDECESSOR = Object.freeze({
  adaptation: 'extraction',
  script: 'adaptation',
  shot: 'script',
});

function canonicalResultJson(value, resultType) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 16 * 1024 * 1024) {
    throw new TypeError('Narrative execution result is invalid');
  }
  const parsed = JSON.parse(value);
  if (JSON.stringify(parsed) !== value) {
    throw new TypeError('Narrative execution result is invalid');
  }
  const normalized = normalizeNarrativeResult(resultType, parsed);
  if (JSON.stringify(normalized) !== value) {
    throw new TypeError('Narrative execution result is invalid');
  }
  return normalized;
}

function matchesAudit(request, result, upstream) {
  if (request.resultType === 'extraction') return upstream === null;
  if (result[`upstream${request.resultType === 'adaptation' ? 'Result' : request.resultType === 'script' ? 'Adaptation' : 'Script'}Hash`]
      !== request.upstreamResultHash) return false;
  if (request.resultType === 'adaptation') {
    return result.approvalRef === request.upstreamApprovalRef
      && sha256Canonical(result.durationBudget) === sha256Canonical(request.durationBudget)
      && sha256Canonical(result.style) === sha256Canonical(request.style);
  }
  if (request.resultType === 'script') {
    return result.adaptationApprovalRef === request.upstreamApprovalRef
      && upstream !== null
      && result.upstreamExtractionHash === upstream.upstreamResultHash
      && result.extractionApprovalRef === upstream.approvalRef;
  }
  return result.scriptApprovalRef === request.upstreamApprovalRef
    && result.assetCatalogHash === sha256Canonical(request.assetVersions);
}

function narrativeExecutionResultMatchesRequest({
  requestJson,
  resultType,
  resultJson,
  expectedInputHash,
  inputHash,
  resultHash,
  envelopeHash,
  upstreamResultJson,
}) {
  try {
    const request = parseNarrativeExecutionRequestJson(requestJson);
    if (request.resultType !== resultType) return false;
    const result = canonicalResultJson(resultJson, resultType);
    const hashes = resultHashes(result);
    if (result.inputHash !== expectedInputHash || result.inputHash !== inputHash
      || hashes.resultHash !== resultHash
      || hashes.envelopeHash !== envelopeHash) return false;
    const upstream = request.resultType === 'extraction'
      ? null : canonicalResultJson(upstreamResultJson, PREDECESSOR[request.resultType]);
    return matchesAudit(request, result, upstream);
  } catch {
    return false;
  }
}

function narrativeExecutionResultMatchesRequestSql(
  requestJson,
  resultType,
  resultJson,
  expectedInputHash,
  inputHash,
  resultHash,
  envelopeHash,
  upstreamResultJson,
) {
  return narrativeExecutionResultMatchesRequest({
    requestJson,
    resultType,
    resultJson,
    expectedInputHash,
    inputHash,
    resultHash,
    envelopeHash,
    upstreamResultJson,
  }) ? 1 : 0;
}

module.exports = Object.freeze({
  narrativeExecutionResultMatchesRequest,
  narrativeExecutionResultMatchesRequestSql,
});
