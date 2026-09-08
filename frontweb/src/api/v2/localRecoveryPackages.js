import { parseStrictJson } from '../../security/strictJson.js'
import {
  localRecoveryPackageListView,
  localRecoveryPackageResponseView,
} from '../../remoteAssets/localRecovery.js'
import {
  workflowFormJsonTextRequest,
  workflowJsonTextRequest,
} from './workflowRequest.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const FACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u

function dramaPath(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Local recovery path is invalid')
  return String(value)
}

function characterPath(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('Local recovery path is invalid')
  return encodeURIComponent(value)
}

function endpoint(dramaId, characterUid) {
  return `/v2/dramas/${dramaPath(dramaId)}/characters/${characterPath(characterUid)}/local-recovery-packages`
}

export function createLocalRecoveryPackageAPI({
  formRequest = workflowFormJsonTextRequest,
  jsonRequest = workflowJsonTextRequest,
} = {}) {
  return Object.freeze({
    async importPackage({ dramaId, characterUid, extractionResultUid, characterFactId, file } = {}) {
      if (!UUID.test(extractionResultUid) || typeof characterFactId !== 'string'
        || !FACT_ID.test(characterFactId) || !(file instanceof Blob)
        || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 64 * 1024 * 1024) {
        throw new TypeError('Local recovery upload is invalid')
      }
      const body = new FormData()
      body.append('package', file, typeof file.name === 'string' ? file.name : 'recovery.zip')
      body.append('extractionResultUid', extractionResultUid)
      body.append('characterFactId', characterFactId)
      const text = await formRequest.post(endpoint(dramaId, characterUid), body)
      return localRecoveryPackageResponseView(parseStrictJson(text), characterUid)
    },

    async list(dramaId, characterUid) {
      const text = await jsonRequest.get(endpoint(dramaId, characterUid))
      return localRecoveryPackageListView(parseStrictJson(text), characterUid)
    },
  })
}

export const localRecoveryPackageAPI = createLocalRecoveryPackageAPI()
