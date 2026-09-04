import { ref } from 'vue'

import { mvpBenchmarkFinalizationAPI } from '../api/v2/mvpBenchmarkFinalization.js'
import { mvpBenchmarkAuthorizationView } from '../benchmark/mvpAuthorization.js'
import { mvpBenchmarkPreflightBatchView } from '../benchmark/mvpPreflight.js'
import { mvpBenchmarkSessionView } from '../benchmark/mvpSession.js'
import { mvpBenchmarkShotTaskOrder } from '../benchmark/mvpShotOrder.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'
import { mediaExportRunView } from '../media/mediaExportRun.js'

const ERROR_CODE = 'MVP_BENCHMARK_FINALIZATION_REQUEST_FAILED'
const FREEZE = Object.freeze
const REFLECT_APPLY = Reflect.apply
const REGEXP_TEST = RegExp.prototype.test
const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export function createMvpBenchmarkFinalizationState({ finalize }) {
  if (typeof finalize !== 'function') {
    throw new TypeError('MVP benchmark finalization state is invalid')
  }
  const run = ref(null)
  const busy = ref(false)
  const error = ref(null)
  const guard = createLatestRequestGuard()

  async function submit(
    sessionValue, authorizationValue, batchValue, bgmTrackUid, shotTaskOrderValue,
  ) {
    const token = guard.begin()
    busy.value = true
    error.value = null
    try {
      const session = mvpBenchmarkSessionView(sessionValue)
      const authorization = mvpBenchmarkAuthorizationView(authorizationValue, {
        sessionUid: session.uid,
        dramaUid: session.dramaUid,
        sessionPlanSha256: session.planSha256,
      })
      const batch = mvpBenchmarkPreflightBatchView(batchValue, session, authorization)
      if (typeof bgmTrackUid !== 'string'
        || !REFLECT_APPLY(REGEXP_TEST, UID, [bgmTrackUid])) {
        throw new TypeError(ERROR_CODE)
      }
      const shotTaskOrder = mvpBenchmarkShotTaskOrder(shotTaskOrderValue, session)
      const result = mediaExportRunView(
        await finalize(session, authorization, batch, bgmTrackUid, shotTaskOrder),
      )
      if (!guard.isCurrent(token)) return false
      run.value = result
      return true
    } catch {
      if (!guard.isCurrent(token)) return false
      run.value = null
      error.value = ERROR_CODE
      return false
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  function invalidate() {
    guard.invalidate()
    run.value = null
    busy.value = false
    error.value = null
  }

  return FREEZE({ run, busy, error, finalize: submit, invalidate })
}

export function useMvpBenchmarkFinalization({ api = mvpBenchmarkFinalizationAPI } = {}) {
  return createMvpBenchmarkFinalizationState({
    finalize: (session, authorization, batch, bgmTrackUid, shotTaskOrder) => (
      api.finalize(session, authorization, batch, bgmTrackUid, shotTaskOrder)
    ),
  })
}
