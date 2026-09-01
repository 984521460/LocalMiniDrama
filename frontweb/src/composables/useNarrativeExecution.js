import { ref } from 'vue'

import { narrativeExecutionAPI } from '../api/v2/narrativeExecutions.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'
import { createNarrativeExecutionRequest } from '../narrative/narrativeExecution.js'

const ERROR_CODE = 'NARRATIVE_EXECUTION_REQUEST_FAILED'

export function useNarrativeExecution({
  api = narrativeExecutionAPI,
  createOperationUid = () => globalThis.crypto.randomUUID(),
} = {}) {
  const busy = ref(false)
  const error = ref(null)
  const last = ref(null)
  const guard = createLatestRequestGuard()

  async function execute(input) {
    const token = guard.begin()
    busy.value = true
    error.value = null
    try {
      const request = createNarrativeExecutionRequest({
        ...input,
        operationUid: createOperationUid(),
      })
      const response = await api.execute(input.dramaId, request)
      if (!guard.isCurrent(token)) return null
      last.value = response
      return response
    } catch {
      if (!guard.isCurrent(token)) return null
      error.value = ERROR_CODE
      return null
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  function invalidate() {
    guard.invalidate()
    busy.value = false
    error.value = null
    last.value = null
  }

  return Object.freeze({ busy, error, last, execute, invalidate })
}
