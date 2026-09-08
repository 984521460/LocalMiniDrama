import { parseStrictJson } from '../../security/strictJson.js'
import {
  remoteAssetRecoveryListView,
  remoteAssetRecoveryRequestView,
  remoteAssetRecoveryResponseView,
} from '../../remoteAssets/recovery.js'
import { workflowJsonTextRequest } from './workflowRequest.js'

function uidPath(value) {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new TypeError('Remote asset recovery path is invalid')
  }
  return encodeURIComponent(value)
}

function dramaIdPath(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Remote asset recovery path is invalid')
  return String(value)
}

function parsed(text) {
  return remoteAssetRecoveryResponseView(parseStrictJson(text))
}

export const remoteAssetRecoveryAPI = Object.freeze({
  execute(dramaId, request) {
    const body = remoteAssetRecoveryRequestView(request)
    return workflowJsonTextRequest.post(
      `/v2/dramas/${dramaIdPath(dramaId)}/characters/${uidPath(body.characterUid)}/remote-asset-recoveries`,
      body,
    ).then(parsed)
  },

  get(operationUid) {
    return workflowJsonTextRequest.get(
      `/v2/remote-asset-recoveries/${uidPath(operationUid)}`,
    ).then(parsed)
  },

  async list(dramaId, dramaUid, characterUid) {
    const expectedDramaUid = uidPath(dramaUid)
    const expectedCharacterUid = uidPath(characterUid)
    const text = await workflowJsonTextRequest.get(
      `/v2/dramas/${dramaIdPath(dramaId)}/characters/${expectedCharacterUid}/remote-asset-recoveries`,
    )
    const list = remoteAssetRecoveryListView(parseStrictJson(text))
    if (list.dramaUid !== expectedDramaUid || list.characterUid !== expectedCharacterUid) {
      throw new TypeError('Remote asset recovery response is invalid')
    }
    return list
  },
})
