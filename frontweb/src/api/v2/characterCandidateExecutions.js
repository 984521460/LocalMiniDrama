import { workflowJsonTextRequest } from './workflowRequest.js'
import { parseStrictJson } from '../../security/strictJson.js'
import { workflowUidPath } from '../../security/workflowBoundary.js'
import {
  characterCandidateExecutionHistoryPageView,
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

function historyCursor(value) {
  if (value === null) return ''
  if (typeof value !== 'string'
    || !/^[0-9]{1,15}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new TypeError('Character candidate history request is invalid')
  }
  return `?cursor=${encodeURIComponent(value)}`
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

  async listHistory(dramaId, dramaUid, characterUid, cursor = null) {
    const expectedDramaUid = workflowUidPath(dramaUid)
    const expectedCharacterUid = workflowUidPath(characterUid)
    const text = await workflowJsonTextRequest.get(
      `/v2/dramas/${dramaIdPath(dramaId)}/characters/${expectedCharacterUid}`
        + `/candidate-executions/history${historyCursor(cursor)}`,
    )
    const page = characterCandidateExecutionHistoryPageView(parseStrictJson(text))
    if (page.dramaUid !== expectedDramaUid || page.characterUid !== expectedCharacterUid) {
      throw new TypeError('Character candidate history response is invalid')
    }
    return page
  },
})
