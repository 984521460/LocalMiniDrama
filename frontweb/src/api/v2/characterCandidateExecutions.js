import { workflowJsonTextRequest } from './workflowRequest.js'
import { parseStrictJson } from '../../security/strictJson.js'
import { workflowUidPath } from '../../security/workflowBoundary.js'
import {
  characterCandidateExecutionRequestView,
  characterCandidateExecutionResponseView,
} from '../../characterCandidates/characterCandidateExecution.js'

function dramaIdPath(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Character candidate execution request is invalid')
  }
  return String(value)
}

function parsed(promise) {
  return promise.then((text) => (
    characterCandidateExecutionResponseView(parseStrictJson(text))
  ))
}

export const characterCandidateExecutionAPI = Object.freeze({
  execute(dramaId, request) {
    const body = characterCandidateExecutionRequestView(request)
    return parsed(workflowJsonTextRequest.post(
      `/v2/dramas/${dramaIdPath(dramaId)}/characters/${body.characterUid}/candidate-executions`,
      body,
    ))
  },

  get(operationUid) {
    return parsed(workflowJsonTextRequest.get(
      `/v2/character-candidate-executions/${workflowUidPath(operationUid)}`,
    ))
  },
})
