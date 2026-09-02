import { ref } from 'vue'

import { mvpBenchmarkResumeAPI } from '../api/v2/mvpBenchmarkResume.js'
import { mvpBenchmarkResumeSnapshotView } from '../benchmark/mvpResume.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'

const ERROR_CODE = 'MVP_BENCHMARK_RESUME_REQUEST_FAILED'

export function createMvpBenchmarkResumeState({ getSnapshot }) {
  if (typeof getSnapshot !== 'function') {
    throw new TypeError('MVP benchmark resume state is invalid')
  }
  const snapshot = ref(null)
  const busy = ref(false)
  const error = ref(null)
  const guard = createLatestRequestGuard()

  async function load(dramaUid, workflowRunUid) {
    const token = guard.begin()
    busy.value = true
    error.value = null
    try {
      const result = mvpBenchmarkResumeSnapshotView(
        await getSnapshot(dramaUid, workflowRunUid),
        { dramaUid, workflowRunUid },
      )
      if (!guard.isCurrent(token)) return false
      snapshot.value = result
      return true
    } catch {
      if (!guard.isCurrent(token)) return false
      snapshot.value = null
      error.value = ERROR_CODE
      return false
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  function invalidate() {
    guard.invalidate()
    snapshot.value = null
    busy.value = false
    error.value = null
  }

  return Object.freeze({ snapshot, busy, error, load, invalidate })
}

export function useMvpBenchmarkResume({ api = mvpBenchmarkResumeAPI } = {}) {
  return createMvpBenchmarkResumeState({
    getSnapshot: (dramaUid, workflowRunUid) => api.getSnapshot(dramaUid, workflowRunUid),
  })
}
