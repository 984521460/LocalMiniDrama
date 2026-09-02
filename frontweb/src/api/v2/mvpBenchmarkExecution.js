import { mvpBenchmarkAuthorizationView } from '../../benchmark/mvpAuthorization.js'
import {
  parseMvpBenchmarkProductionExecutionProgressJson,
  parseMvpBenchmarkProductionExecutionStepJson,
} from '../../benchmark/mvpExecution.js'
import { mvpBenchmarkPreflightBatchView } from '../../benchmark/mvpPreflight.js'
import { mvpBenchmarkSessionView } from '../../benchmark/mvpSession.js'
import { workflowJsonTextRequest } from './workflowRequest.js'

const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger
const REFLECT_APPLY = Reflect.apply
const FREEZE = Object.freeze

export const mvpBenchmarkExecutionAPI = FREEZE({
  async getProgress(sessionValue, authorizationValue, batchValue) {
    const session = mvpBenchmarkSessionView(sessionValue)
    const authorization = mvpBenchmarkAuthorizationView(authorizationValue, {
      sessionUid: session.uid,
      dramaUid: session.dramaUid,
      sessionPlanSha256: session.planSha256,
    })
    const batch = mvpBenchmarkPreflightBatchView(batchValue, session, authorization)
    const text = await workflowJsonTextRequest.get(
      `/v2/dramas/${encodeURIComponent(session.dramaUid)}/mvp-benchmark/sessions/${encodeURIComponent(session.uid)}/authorizations/${encodeURIComponent(authorization.uid)}/execution-progress/${encodeURIComponent(batch.batchSha256)}`,
    )
    return parseMvpBenchmarkProductionExecutionProgressJson(
      text, session, authorization, batch,
    )
  },
  async executeNext(sessionValue, authorizationValue, batchValue, ordinalValue) {
    const session = mvpBenchmarkSessionView(sessionValue)
    const authorization = mvpBenchmarkAuthorizationView(authorizationValue, {
      sessionUid: session.uid,
      dramaUid: session.dramaUid,
      sessionPlanSha256: session.planSha256,
    })
    const batch = mvpBenchmarkPreflightBatchView(batchValue, session, authorization)
    const ordinal = ordinalValue
    const reservation = REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [ordinal])
      ? batch.reservations[ordinal] : null
    if (!reservation) throw new TypeError('MVP benchmark execution request is invalid')
    const text = await workflowJsonTextRequest.post(
      `/v2/dramas/${encodeURIComponent(session.dramaUid)}/mvp-benchmark/sessions/${encodeURIComponent(session.uid)}/authorizations/${encodeURIComponent(authorization.uid)}/execute-next`,
      FREEZE({
        schemaVersion: 'mvp-benchmark-production-execution-request.v1',
        expectedBatchSha256: batch.batchSha256,
        expectedOrdinal: ordinal,
        expectedItemKind: reservation.itemKind,
        expectedItemUid: reservation.itemUid,
      }),
    )
    return parseMvpBenchmarkProductionExecutionStepJson(
      text, session, authorization, batch,
    )
  },
})
