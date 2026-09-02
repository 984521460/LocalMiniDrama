import { ref } from 'vue'

import { mvpBenchmarkPreflightAPI } from '../api/v2/mvpBenchmarkPreflight.js'
import { mvpBenchmarkAuthorizationView } from '../benchmark/mvpAuthorization.js'
import { mvpBenchmarkPreflightBatchView } from '../benchmark/mvpPreflight.js'
import { mvpBenchmarkSessionView } from '../benchmark/mvpSession.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'

const ERROR_CODE = 'MVP_BENCHMARK_PREFLIGHT_REQUEST_FAILED'

export function createMvpBenchmarkPreflightState({ createPreflight }) {
  if (typeof createPreflight !== 'function') {
    throw new TypeError('MVP benchmark preflight state is invalid')
  }
  const batch = ref(null)
  const busy = ref(false)
  const error = ref(null)
  const guard = createLatestRequestGuard()

  async function preflight(sessionValue, authorizationValue) {
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
      const result = mvpBenchmarkPreflightBatchView(
        await createPreflight(session, authorization), session, authorization,
      )
      if (!guard.isCurrent(token)) return false
      batch.value = result
      return true
    } catch {
      if (!guard.isCurrent(token)) return false
      batch.value = null
      error.value = ERROR_CODE
      return false
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  function invalidate() {
    guard.invalidate()
    batch.value = null
    busy.value = false
    error.value = null
  }

  return Object.freeze({ batch, busy, error, preflight, invalidate })
}

export function useMvpBenchmarkPreflight({ api = mvpBenchmarkPreflightAPI } = {}) {
  return createMvpBenchmarkPreflightState({
    createPreflight: (session, authorization) => api.createPreflight(session, authorization),
  })
}
