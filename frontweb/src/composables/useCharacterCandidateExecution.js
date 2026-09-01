import { ref } from 'vue'

import { characterCandidateExecutionAPI } from '../api/v2/characterCandidateExecutions.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'
import {
  createCharacterCandidateExecutionRequest,
} from '../characterCandidates/characterCandidateExecution.js'

const ERROR_CODE = 'CHARACTER_CANDIDATE_EXECUTION_REQUEST_FAILED'

export function useCharacterCandidateExecution({
  api = characterCandidateExecutionAPI,
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
      const { dramaId, ...requestInput } = input
      const request = createCharacterCandidateExecutionRequest({
        ...requestInput,
        operationUid: createOperationUid(),
      })
      const response = await api.execute(dramaId, request)
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
