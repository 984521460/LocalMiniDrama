import { parseMvpBenchmarkCloseoutStatusJson } from '../../benchmark/mvpCloseoutStatus.js'
import { mvpBenchmarkAuthorizationView } from '../../benchmark/mvpAuthorization.js'
import { mvpBenchmarkPreflightBatchView } from '../../benchmark/mvpPreflight.js'
import { mvpBenchmarkSessionView } from '../../benchmark/mvpSession.js'
import { workflowJsonTextRequest } from './workflowRequest.js'

export const mvpBenchmarkCloseoutStatusAPI = Object.freeze({
  async getStatus(sessionValue, authorizationValue, batchValue) {
    const session = mvpBenchmarkSessionView(sessionValue)
    const authorization = mvpBenchmarkAuthorizationView(authorizationValue, {
      sessionUid: session.uid,
      dramaUid: session.dramaUid,
      sessionPlanSha256: session.planSha256,
    })
    const batch = mvpBenchmarkPreflightBatchView(batchValue, session, authorization)
    const path = `/v2/dramas/${encodeURIComponent(session.dramaUid)}`
      + `/mvp-benchmark/sessions/${encodeURIComponent(session.uid)}`
      + `/authorizations/${encodeURIComponent(authorization.uid)}`
      + `/batches/${encodeURIComponent(batch.batchSha256)}/closeout-status`
    const text = await workflowJsonTextRequest.get(path)
    return parseMvpBenchmarkCloseoutStatusJson(text, session, authorization, batch)
  },
})
