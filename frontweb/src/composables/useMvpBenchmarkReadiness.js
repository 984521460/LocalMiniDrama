import { ref } from 'vue'

import { mvpBenchmarkAPI } from '../api/v2/mvpBenchmark.js'
import { mvpBenchmarkReadinessView } from '../benchmark/mvpReadiness.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'

const ERROR_CODE = 'MVP_BENCHMARK_READINESS_REQUEST_FAILED'

export function useMvpBenchmarkReadiness({ api = mvpBenchmarkAPI } = {}) {
  const readiness = ref(null)
  const busy = ref(false)
  const error = ref(null)
  const guard = createLatestRequestGuard()

  async function load() {
    const token = guard.begin()
    busy.value = true
    error.value = null
    try {
      const result = mvpBenchmarkReadinessView(await api.getReadiness())
      if (!guard.isCurrent(token)) return false
      readiness.value = result
      return true
    } catch {
      if (!guard.isCurrent(token)) return false
      readiness.value = null
      error.value = ERROR_CODE
      return false
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  function invalidate() {
    guard.invalidate()
    readiness.value = null
    busy.value = false
    error.value = null
  }

  return FREEZE_RESULT({ readiness, busy, error, load, invalidate })
}

function FREEZE_RESULT(value) {
  return Object.freeze(value)
}
