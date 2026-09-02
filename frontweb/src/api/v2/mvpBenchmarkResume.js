import { parseMvpBenchmarkResumeSnapshotJson } from '../../benchmark/mvpResume.js'
import { workflowJsonTextRequest } from './workflowRequest.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const REFLECT_APPLY = Reflect.apply
const REGEXP_TEST = RegExp.prototype.test

function uid(value) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, UUID_V4, [value])) {
    throw new TypeError('MVP benchmark resume request is invalid')
  }
  return value
}

export const mvpBenchmarkResumeAPI = Object.freeze({
  async getSnapshot(dramaUid, workflowRunUid) {
    const drama = uid(dramaUid)
    const run = uid(workflowRunUid)
    const text = await workflowJsonTextRequest.get(
      `/v2/dramas/${encodeURIComponent(drama)}/mvp-benchmark/workflow-runs/${encodeURIComponent(run)}/resume`,
    )
    return parseMvpBenchmarkResumeSnapshotJson(text, {
      dramaUid: drama,
      workflowRunUid: run,
    })
  },
})
