import request from './workflowRequest.js'
import { workflowJsonTextRequest } from './workflowRequest.js'
import { parseStrictJson } from '../../security/strictJson.js'
import {
  characterReferencePackageRequest,
  characterUidPath,
} from '../../assets/characterReferencePackage.js'
import {
  characterReferencePackageExecutionRequestView,
  characterReferencePackageExecutionResponseView,
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
})
