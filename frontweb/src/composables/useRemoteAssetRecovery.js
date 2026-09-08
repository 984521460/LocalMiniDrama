import { ref } from 'vue'

import { remoteAssetRecoveryAPI } from '../api/v2/remoteAssetRecoveries.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'
import { createRemoteAssetRecoveryRequest } from '../remoteAssets/recovery.js'

export function useRemoteAssetRecovery({
  api = remoteAssetRecoveryAPI,
  createOperationUid = () => globalThis.crypto.randomUUID(),
} = {}) {
  const busy = ref(false)
  const error = ref(null)
  const recoveries = ref(Object.freeze([]))
  const guard = createLatestRequestGuard()

  async function execute(input) {
    const token = guard.begin()
    busy.value = true
    error.value = null
    try {
      const { dramaId, ...requestInput } = input
      const response = await api.execute(dramaId, createRemoteAssetRecoveryRequest({
        ...requestInput,
        operationUid: createOperationUid(),
      }))
      if (!guard.isCurrent(token)) return null
      const next = [response.recovery]
      for (let index = 0; index < recoveries.value.length; index += 1) {
        if (recoveries.value[index].operationUid !== response.recovery.operationUid) {
          next[next.length] = recoveries.value[index]
        }
      }
      recoveries.value = Object.freeze(next)
      return response
    } catch {
      if (guard.isCurrent(token)) error.value = 'REMOTE_ASSET_RECOVERY_REQUEST_FAILED'
      return null
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  async function refresh({ dramaId, dramaUid, characterUid }) {
    const token = guard.begin()
    busy.value = true
    error.value = null
    try {
      const result = await api.list(dramaId, dramaUid, characterUid)
      if (!guard.isCurrent(token)) return null
      recoveries.value = result.recoveries
      return result
    } catch {
      if (guard.isCurrent(token)) error.value = 'REMOTE_ASSET_RECOVERY_REQUEST_FAILED'
      return null
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  function invalidate() {
    guard.invalidate()
    busy.value = false
    error.value = null
    recoveries.value = Object.freeze([])
  }

  return Object.freeze({ busy, error, recoveries, execute, refresh, invalidate })
}
