import { ref } from 'vue'

import {
  mvpBenchmarkAccountingStatusAPI,
} from '../api/v2/mvpBenchmarkAccountingStatus.js'
import {
  mvpBenchmarkAccountingStatusView,
} from '../benchmark/mvpAccountingStatus.js'
import { mvpBenchmarkAuthorizationView } from '../benchmark/mvpAuthorization.js'
import { mvpBenchmarkPreflightBatchView } from '../benchmark/mvpPreflight.js'
import { mvpBenchmarkSessionView } from '../benchmark/mvpSession.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'

const ERROR_CODE = 'MVP_BENCHMARK_ACCOUNTING_STATUS_REQUEST_FAILED'

export function createMvpBenchmarkAccountingStatusState({ getStatus }) {
  if (typeof getStatus !== 'function') {
    throw new TypeError('MVP benchmark accounting status state is invalid')
  }
  const status = ref(null)
  const busy = ref(false)
  const error = ref(null)
  const guard = createLatestRequestGuard()

  async function load(sessionValue, authorizationValue, batchValue) {
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
      const result = mvpBenchmarkAccountingStatusView(
        await getStatus(session, authorization, batch),
        session,
        authorization,
        batch,
      )
      if (!guard.isCurrent(token)) return false
      status.value = result
      return true
    } catch {
      if (!guard.isCurrent(token)) return false
      status.value = null
      error.value = ERROR_CODE
      return false
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  function invalidate() {
    guard.invalidate()
    status.value = null
    busy.value = false
    error.value = null
  }

  return Object.freeze({ status, busy, error, load, invalidate })
}

export function useMvpBenchmarkAccountingStatus({
  api = mvpBenchmarkAccountingStatusAPI,
} = {}) {
  return createMvpBenchmarkAccountingStatusState({
    getStatus: (session, authorization, batch) => api.getStatus(
      session, authorization, batch,
    ),
  })
}
