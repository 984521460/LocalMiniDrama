import { workflowJsonTextRequest } from './workflowRequest.js'
import { dramaIdPath, workflowUidPath } from '../../security/workflowBoundary.js'
import { mediaExportRunRequest } from '../../media/mediaExportRun.js'
import { parseStrictJson } from '../../security/strictJson.js'

function parsed(request) {
  return request.then((text) => parseStrictJson(text))
}

export const mediaExportAPI = Object.freeze({
  list(dramaId) {
    return parsed(workflowJsonTextRequest.get(
      `/v2/dramas/${dramaIdPath(dramaId)}/media-exports`,
    ))
  },

  get(dramaId, runUid) {
    return parsed(workflowJsonTextRequest.get(
      `/v2/dramas/${dramaIdPath(dramaId)}/media-exports/${workflowUidPath(runUid)}`,
    ))
  },

  start(dramaId, nodeRunUid) {
    return parsed(workflowJsonTextRequest.post(
      `/v2/dramas/${dramaIdPath(dramaId)}/media-exports`,
      mediaExportRunRequest({ nodeRunUid }),
    ))
  },
})
