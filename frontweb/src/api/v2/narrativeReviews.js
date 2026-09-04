import request from '../../utils/request.js'
import { workflowJsonTextRequest } from './workflowRequest.js'
import { parseNarrativeFactEvidenceTraceJson } from '../../narrative/factEvidenceTrace.js'
import { parseNarrativeAdaptationComparisonJson } from '../../narrative/adaptationComparison.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const FACT_ID = /^[a-z][a-z0-9-]{0,63}$/u

function resultInput(resultUid) {
  if (typeof resultUid !== 'string' || !UUID_V4.test(resultUid)) {
    throw new TypeError('Narrative result request is invalid')
  }
  return Object.freeze({ resultUid })
}

function traceInput(resultUid, factId) {
  const result = resultInput(resultUid)
  if (typeof factId !== 'string' || !FACT_ID.test(factId)) {
    throw new TypeError('Narrative fact evidence request is invalid')
  }
  return Object.freeze({ resultUid: result.resultUid, factId })
}

export const narrativeReviewAPI = {
  listForDrama(dramaId) {
    return request.get(`/v2/dramas/${dramaId}/narrative-results`)
  },

  get(resultUid) {
    return request.get(`/v2/narrative-results/${resultUid}`)
  },

  getFactEvidence(resultUid, factId) {
    const expected = traceInput(resultUid, factId)
    return workflowJsonTextRequest
      .get(`/v2/narrative-results/${expected.resultUid}/evidence/${expected.factId}`)
      .then((text) => parseNarrativeFactEvidenceTraceJson(text, expected))
  },

  getAdaptationComparison(resultUid) {
    const expected = resultInput(resultUid)
    return workflowJsonTextRequest
      .get(`/v2/narrative-results/${expected.resultUid}/adaptation-comparison`)
      .then((text) => parseNarrativeAdaptationComparisonJson(text, {
        adaptationResultUid: expected.resultUid,
      }))
  },

  review(resultUid, decision, comment) {
    return request.post(`/v2/narrative-results/${resultUid}/reviews`, {
      decision,
      ...(comment ? { comment } : {}),
    })
  },
}
