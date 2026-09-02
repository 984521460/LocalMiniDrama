import { mvpBenchmarkAuthorizationView } from '../../benchmark/mvpAuthorization.js'
import { parseMvpBenchmarkPreflightBatchJson } from '../../benchmark/mvpPreflight.js'
import { mvpBenchmarkSessionView } from '../../benchmark/mvpSession.js'
import { workflowJsonTextRequest } from './workflowRequest.js'

export const mvpBenchmarkPreflightAPI = Object.freeze({
  async createPreflight(sessionValue, authorizationValue) {
    const session = mvpBenchmarkSessionView(sessionValue)
    const authorization = mvpBenchmarkAuthorizationView(authorizationValue, {
      sessionUid: session.uid,
      dramaUid: session.dramaUid,
      sessionPlanSha256: session.planSha256,
    })
    const text = await workflowJsonTextRequest.post(
      `/v2/dramas/${encodeURIComponent(session.dramaUid)}/mvp-benchmark/sessions/${encodeURIComponent(session.uid)}/authorizations/${encodeURIComponent(authorization.uid)}/preflight`,
      Object.freeze({}),
    )
    return parseMvpBenchmarkPreflightBatchJson(text, session, authorization)
  },
})
