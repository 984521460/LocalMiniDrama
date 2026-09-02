import { ref } from 'vue'

import { mvpBenchmarkSessionAPI } from '../api/v2/mvpBenchmarkSession.js'
import { mvpBenchmarkSessionView } from '../benchmark/mvpSession.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'

const ERROR_CODE = 'MVP_BENCHMARK_SESSION_REQUEST_FAILED'

export function useMvpBenchmarkSession({ api = mvpBenchmarkSessionAPI } = {}) {
  const session = ref(null)
  const busy = ref(false)
  const error = ref(null)
  const guard = createLatestRequestGuard()

  async function prepare(dramaUid, workflowRunUid) {
    const token = guard.begin()
    busy.value = true
    error.value = null
    try {
      const result = mvpBenchmarkSessionView(
        await api.prepareWorkflowSession(dramaUid, workflowRunUid),
        { dramaUid, workflowRunUid },
      )
      if (!guard.isCurrent(token)) return false
      session.value = result
      return true
    } catch {
      if (!guard.isCurrent(token)) return false
      session.value = null
      error.value = ERROR_CODE
      return false
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  function invalidate() {
    guard.invalidate()
    session.value = null
    busy.value = false
    error.value = null
  }

  return Object.freeze({ session, busy, error, prepare, invalidate })
}
