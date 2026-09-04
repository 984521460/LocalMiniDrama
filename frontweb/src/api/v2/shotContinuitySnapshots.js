import request from './workflowRequest.js'
import {
  continuityUidPath,
  shotContinuitySnapshotListView,
} from '../../assets/shotContinuity.js'

export const shotContinuityAPI = Object.freeze({
  list(resultUid) {
    return request.get(
      `/v2/narrative-results/${continuityUidPath(resultUid)}/continuity-snapshots`,
    )
  },

  async materialize(resultUid) {
    return shotContinuitySnapshotListView(await request.post(
      `/v2/narrative-results/${continuityUidPath(resultUid)}`
        + '/continuity-snapshots/materialize',
      {},
    ))
  },

  compare(fromSnapshotUid, toSnapshotUid) {
    return request.get(
      `/v2/continuity-snapshots/${continuityUidPath(fromSnapshotUid)}`
        + `/compare/${continuityUidPath(toSnapshotUid)}`,
    )
  },
})
