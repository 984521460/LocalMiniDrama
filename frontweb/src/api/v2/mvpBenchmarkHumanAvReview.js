import {
  mvpBenchmarkHumanAvReviewSeed,
  parseMvpBenchmarkHumanAvReviewJson,
} from '../../benchmark/mvpHumanAvReview.js'
import { mvpBenchmarkAuthorizationView } from '../../benchmark/mvpAuthorization.js'
import { mvpBenchmarkPreflightBatchView } from '../../benchmark/mvpPreflight.js'
import { mvpBenchmarkSessionView } from '../../benchmark/mvpSession.js'
import { mediaExportRunView } from '../../media/mediaExportRun.js'
import { workflowJsonTextRequest } from './workflowRequest.js'

const ENCODE_URI_COMPONENT = encodeURIComponent
const FREEZE = Object.freeze

function context(sessionValue, authorizationValue, batchValue, exportRunValue) {
  const session = mvpBenchmarkSessionView(sessionValue)
  const authorization = mvpBenchmarkAuthorizationView(authorizationValue, {
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    sessionPlanSha256: session.planSha256,
  })
  const batch = mvpBenchmarkPreflightBatchView(batchValue, session, authorization)
  const exportRun = mediaExportRunView(exportRunValue)
  if (exportRun.status !== 'succeeded'
    || exportRun.dramaUid !== session.dramaUid
    || exportRun.workflowRunUid !== session.workflowRunUid) {
    throw new TypeError('MVP benchmark human audiovisual review request is invalid')
  }
  const root = `/v2/dramas/${ENCODE_URI_COMPONENT(session.dramaUid)}`
    + `/mvp-benchmark/sessions/${ENCODE_URI_COMPONENT(session.uid)}`
    + `/authorizations/${ENCODE_URI_COMPONENT(authorization.uid)}`
  return FREEZE({ authorization, batch, exportRun, root, session })
}

export const mvpBenchmarkHumanAvReviewAPI = FREEZE({
  async get(sessionValue, authorizationValue, batchValue, exportRunValue) {
    const value = context(
      sessionValue, authorizationValue, batchValue, exportRunValue,
    )
    const text = await workflowJsonTextRequest.get(
      `${value.root}/batches/${ENCODE_URI_COMPONENT(value.batch.batchSha256)}/human-av-review`,
    )
    return parseMvpBenchmarkHumanAvReviewJson(
      text, value.session, value.authorization, value.batch, value.exportRun,
    )
  },

  async review(
    sessionValue, authorizationValue, batchValue, exportRunValue, seedValue,
  ) {
    const value = context(
      sessionValue, authorizationValue, batchValue, exportRunValue,
    )
    const seed = mvpBenchmarkHumanAvReviewSeed(seedValue)
    const text = await workflowJsonTextRequest.post(
      `${value.root}/human-av-review`,
      FREEZE({
        schemaVersion: 'mvp-benchmark-human-av-review-request.v1',
        expectedBatchSha256: value.batch.batchSha256,
        exportRunUid: value.exportRun.uid,
        ...seed,
      }),
    )
    return parseMvpBenchmarkHumanAvReviewJson(
      text, value.session, value.authorization, value.batch, value.exportRun,
    )
  },
})
