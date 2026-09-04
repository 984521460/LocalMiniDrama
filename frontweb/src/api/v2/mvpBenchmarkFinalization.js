import { mvpBenchmarkAuthorizationView } from '../../benchmark/mvpAuthorization.js'
import { mvpBenchmarkPreflightBatchView } from '../../benchmark/mvpPreflight.js'
import { mvpBenchmarkSessionView } from '../../benchmark/mvpSession.js'
import { mediaExportRunView } from '../../media/mediaExportRun.js'
import { parseStrictJson } from '../../security/strictJson.js'
import { workflowJsonTextRequest } from './workflowRequest.js'

const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const ENCODE_URI_COMPONENT = encodeURIComponent
const FREEZE = Object.freeze
const REFLECT_APPLY = Reflect.apply
const REGEXP_TEST = RegExp.prototype.test

export const mvpBenchmarkFinalizationAPI = FREEZE({
  async finalize(sessionValue, authorizationValue, batchValue, bgmTrackUidValue) {
    const session = mvpBenchmarkSessionView(sessionValue)
    const authorization = mvpBenchmarkAuthorizationView(authorizationValue, {
      sessionUid: session.uid,
      dramaUid: session.dramaUid,
      sessionPlanSha256: session.planSha256,
    })
    const batch = mvpBenchmarkPreflightBatchView(batchValue, session, authorization)
    const bgmTrackUid = bgmTrackUidValue
    if (typeof bgmTrackUid !== 'string'
      || !REFLECT_APPLY(REGEXP_TEST, UID, [bgmTrackUid])) {
      throw new TypeError('MVP benchmark finalization request is invalid')
    }
    const text = await workflowJsonTextRequest.post(
      `/v2/dramas/${ENCODE_URI_COMPONENT(session.dramaUid)}/mvp-benchmark/sessions/${ENCODE_URI_COMPONENT(session.uid)}/authorizations/${ENCODE_URI_COMPONENT(authorization.uid)}/finalize`,
      FREEZE({
        schemaVersion: 'mvp-benchmark-finalization-request.v1',
        expectedBatchSha256: batch.batchSha256,
        bgmTrackUid,
      }),
    )
    return mediaExportRunView(parseStrictJson(text))
  },
})
