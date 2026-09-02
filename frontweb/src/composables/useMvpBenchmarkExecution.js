import { ref } from 'vue'

import { mvpBenchmarkExecutionAPI } from '../api/v2/mvpBenchmarkExecution.js'
import { mvpBenchmarkAuthorizationView } from '../benchmark/mvpAuthorization.js'
import {
  mvpBenchmarkProductionExecutionProgressView,
  mvpBenchmarkProductionExecutionStepView,
} from '../benchmark/mvpExecution.js'
import { mvpBenchmarkPreflightBatchView } from '../benchmark/mvpPreflight.js'
import { mvpBenchmarkSessionView } from '../benchmark/mvpSession.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'

const ERROR_CODE = 'MVP_BENCHMARK_EXECUTION_REQUEST_FAILED'
const FREEZE = Object.freeze

export function createMvpBenchmarkExecutionState({ executeNext, getProgress }) {
  if (typeof executeNext !== 'function' || typeof getProgress !== 'function') {
    throw new TypeError('MVP benchmark execution state is invalid')
  }
  const step = ref(null)
  const progress = ref(null)
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
      const previousProgress = progress.value
      if (previous?.batchComplete || previousProgress?.batchComplete) {
        throw new TypeError('MVP benchmark execution progress is invalid')
      }
      const expectedOrdinal = previous?.completedCount ?? previousProgress?.completedCount ?? 0
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
      const priorCompletedCount = previous?.completedCount ?? previousProgress?.completedCount
      if (priorCompletedCount !== undefined
        && result.completedCount !== priorCompletedCount + 1) {
        throw new TypeError('MVP benchmark execution progress is invalid')
      }
      step.value = result
      progress.value = null
      return true
    } catch {
      if (!guard.isCurrent(token)) return false
      error.value = ERROR_CODE
      return false
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  async function refresh(sessionValue, authorizationValue, batchValue) {
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
      const result = mvpBenchmarkProductionExecutionProgressView(
        await getProgress(session, authorization, batch),
        session,
        authorization,
        batch,
      )
      if (!guard.isCurrent(token)) return false
      step.value = null
      progress.value = result
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
    progress.value = null
    busy.value = false
    error.value = null
  }

  return FREEZE({ step, progress, busy, error, executeNext: execute, refresh, invalidate })
}

export function useMvpBenchmarkExecution({ api = mvpBenchmarkExecutionAPI } = {}) {
  return createMvpBenchmarkExecutionState({
    executeNext: (session, authorization, batch, expectedOrdinal) => (
      api.executeNext(session, authorization, batch, expectedOrdinal)
    ),
    getProgress: (session, authorization, batch) => (
      api.getProgress(session, authorization, batch)
    ),
  })
}
