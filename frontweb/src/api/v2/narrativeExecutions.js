import { workflowJsonTextRequest } from './workflowRequest.js'
import { parseStrictJson } from '../../security/strictJson.js'
import { workflowUidPath } from '../../security/workflowBoundary.js'
import {
  narrativeExecutionRequestView,
  narrativeExecutionResponseView,
} from '../../narrative/narrativeExecution.js'

function dramaIdPath(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Narrative execution request is invalid')
  }
  return String(value)
}

function parsed(promise) {
  return promise.then((text) => narrativeExecutionResponseView(parseStrictJson(text)))
}

export const narrativeExecutionAPI = Object.freeze({
  execute(dramaId, request) {
    const body = narrativeExecutionRequestView(request)
    return parsed(workflowJsonTextRequest.post(
      `/v2/dramas/${dramaIdPath(dramaId)}/narrative-executions`,
      body,
    ))
  },

  get(operationUid) {
    return parsed(workflowJsonTextRequest.get(
      `/v2/narrative-executions/${workflowUidPath(operationUid)}`,
    ))
  },
})
