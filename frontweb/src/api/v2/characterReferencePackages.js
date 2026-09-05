import request from './workflowRequest.js'
import { workflowJsonTextRequest } from './workflowRequest.js'
import { parseStrictJson } from '../../security/strictJson.js'
import { workflowUidPath } from '../../security/workflowBoundary.js'
import {
  characterReferencePackageRequest,
  characterUidPath,
} from '../../assets/characterReferencePackage.js'
import {
  characterReferencePackageExecutionRequestView,
  characterReferencePackageExecutionResponseView,
  characterReferencePackageExecutionHistoryPageView,
} from '../../characterCandidates/characterReferencePackageExecution.js'

function packageUidPath(value) {
  return characterUidPath(value)
}

function dramaIdPath(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Character reference package execution request is invalid')
  }
  return String(value)
}

function historyCursor(value) {
  if (value === null) return ''
  if (typeof value !== 'string'
    || !/^[0-9]{1,15}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new TypeError('Character reference package history request is invalid')
  }
  return `?cursor=${encodeURIComponent(value)}`
}

export const characterReferencePackageAPI = Object.freeze({
  list(characterUid) {
    return request.get(`/v2/characters/${characterUidPath(characterUid)}/reference-packages`)
  },

  get(characterUid, packageUid) {
    return request.get(
      `/v2/characters/${characterUidPath(characterUid)}/reference-packages/${packageUidPath(packageUid)}`,
    )
  },

  create(characterUid, input) {
    return request.post(
      `/v2/characters/${characterUidPath(characterUid)}/reference-packages`,
      characterReferencePackageRequest(input),
    )
  },

  async execute(dramaId, input) {
    const body = characterReferencePackageExecutionRequestView(input)
    const text = await workflowJsonTextRequest.post(
      `/v2/dramas/${dramaIdPath(dramaId)}/characters/${body.characterUid}/reference-package-executions`,
      body,
    )
    return characterReferencePackageExecutionResponseView(parseStrictJson(text), body)
  },

  async listHistory(dramaId, dramaUid, characterUid, cursor = null) {
    const expectedDramaUid = workflowUidPath(dramaUid)
    const expectedCharacterUid = characterUidPath(characterUid)
    const text = await workflowJsonTextRequest.get(
      `/v2/dramas/${dramaIdPath(dramaId)}/characters/${expectedCharacterUid}`
        + `/reference-package-executions/history${historyCursor(cursor)}`,
    )
    const page = characterReferencePackageExecutionHistoryPageView(parseStrictJson(text))
    if (page.dramaUid !== expectedDramaUid || page.characterUid !== expectedCharacterUid) {
      throw new TypeError('Character reference package history response is invalid')
    }
    return page
  },
})
