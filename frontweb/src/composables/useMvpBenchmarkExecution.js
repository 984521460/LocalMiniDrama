import { ref } from 'vue'

import { mvpBenchmarkExecutionAPI } from '../api/v2/mvpBenchmarkExecution.js'
import { mvpBenchmarkAuthorizationView } from '../benchmark/mvpAuthorization.js'
import { mvpBenchmarkProductionExecutionStepView } from '../benchmark/mvpExecution.js'
import { mvpBenchmarkPreflightBatchView } from '../benchmark/mvpPreflight.js'
import { mvpBenchmarkSessionView } from '../benchmark/mvpSession.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'

const ERROR_CODE = 'MVP_BENCHMARK_EXECUTION_REQUEST_FAILED'
const FREEZE = Object.freeze

export function createMvpBenchmarkExecutionState({ executeNext }) {
  if (typeof executeNext !== 'function') {
    throw new TypeError('MVP benchmark execution state is invalid')
  }
  const step = ref(null)
  const busy = ref(false)
  const error = ref(null)
  const guard = createLatestRequestGuard()

  async function execute(sessionValue, authorizationValue, batchValue) {
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
      const previous = step.value
      if (previous?.batchComplete) {
        throw new TypeError('MVP benchmark execution progress is invalid')
      }
      const expectedOrdinal = previous?.completedCount ?? 0
      if (!batch.reservations[expectedOrdinal]) {
        throw new TypeError('MVP benchmark execution progress is invalid')
      }
      const result = mvpBenchmarkProductionExecutionStepView(
        await executeNext(session, authorization, batch, expectedOrdinal),
        session,
        authorization,
        batch,
      )
      if (!guard.isCurrent(token)) return false
      if (previous && (previous.batchComplete
        || result.completedCount !== previous.completedCount + 1)) {
        throw new TypeError('MVP benchmark execution progress is invalid')
      }
      step.value = result
      return true
    } catch {
      if (!guard.isCurrent(token)) return false
      error.value = ERROR_CODE
      return false
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  function invalidate() {
    guard.invalidate()
    step.value = null
    busy.value = false
    error.value = null
  }

  return FREEZE({ step, busy, error, executeNext: execute, invalidate })
}

export function useMvpBenchmarkExecution({ api = mvpBenchmarkExecutionAPI } = {}) {
  return createMvpBenchmarkExecutionState({
    executeNext: (session, authorization, batch, expectedOrdinal) => (
      api.executeNext(session, authorization, batch, expectedOrdinal)
    ),
  })
}
