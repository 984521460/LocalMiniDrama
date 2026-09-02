import { mvpBenchmarkSessionView } from '../../benchmark/mvpSession.js'
import { parseStrictJson } from '../../security/strictJson.js'
import { workflowJsonTextRequest } from './workflowRequest.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const REGEXP_TEST = RegExp.prototype.test

function uid(value) {
  if (typeof value !== 'string' || !Reflect.apply(REGEXP_TEST, UUID_V4, [value])) {
    throw new TypeError('MVP benchmark session request is invalid')
  }
  return value
}

export const mvpBenchmarkSessionAPI = Object.freeze({
  async prepareWorkflowSession(dramaUid, workflowRunUid) {
    const drama = uid(dramaUid)
    const run = uid(workflowRunUid)
    const text = await workflowJsonTextRequest.post(
      `/v2/dramas/${encodeURIComponent(drama)}/mvp-benchmark/workflow-runs/${encodeURIComponent(run)}/session`,
      {},
    )
    return mvpBenchmarkSessionView(parseStrictJson(text), {
      dramaUid: drama,
      workflowRunUid: run,
    })
  },
})
