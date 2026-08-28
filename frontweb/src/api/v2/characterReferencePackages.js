import request from './workflowRequest.js'
import {
  characterReferencePackageRequest,
  characterUidPath,
} from '../../assets/characterReferencePackage.js'

function packageUidPath(value) {
  return characterUidPath(value)
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
})
