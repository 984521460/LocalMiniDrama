import request from './workflowRequest.js'
import { continuityUidPath } from '../../assets/shotContinuity.js'

export const shotContinuityAPI = Object.freeze({
  list(resultUid) {
    return request.get(
      `/v2/narrative-results/${continuityUidPath(resultUid)}/continuity-snapshots`,
    )
  },

  compare(fromSnapshotUid, toSnapshotUid) {
    return request.get(
      `/v2/continuity-snapshots/${continuityUidPath(fromSnapshotUid)}`
        + `/compare/${continuityUidPath(toSnapshotUid)}`,
    )
  },
})
