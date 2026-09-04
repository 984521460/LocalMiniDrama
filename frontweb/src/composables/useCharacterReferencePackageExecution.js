import { ref } from 'vue'

import { characterReferencePackageAPI } from '../api/v2/characterReferencePackages.js'
import {
  createCharacterReferencePackageExecutionRequest,
} from '../characterCandidates/characterReferencePackageExecution.js'

export function useCharacterReferencePackageExecution({ packageApi = characterReferencePackageAPI } = {}) {
  const busy = ref(false)
  const error = ref(null)
  const last = ref(null)
  let generation = 0

  async function execute(value) {
    const current = ++generation
    busy.value = true
    error.value = null
    try {
      const { dramaId, ...requestInput } = value
      const request = createCharacterReferencePackageExecutionRequest(requestInput)
      const result = await packageApi.execute(dramaId, request)
      if (current !== generation) return null
      last.value = result
      return result
    } catch {
      if (current === generation) {
        last.value = null
        error.value = 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_FAILED'
      }
      return null
    } finally {
      if (current === generation) busy.value = false
    }
  }

  function invalidate() {
    generation += 1
    busy.value = false
    error.value = null
    last.value = null
  }

  return Object.freeze({ busy, error, last, execute, invalidate })
}
