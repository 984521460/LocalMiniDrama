import { ref } from 'vue'

import { mediaExportAPI } from '../api/v2/mediaExports.js'
import { mediaExportRunView } from '../media/mediaExportRun.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'

const ERROR_CODE = 'MEDIA_EXPORT_REQUEST_FAILED'

function listView(value) {
  if (!Array.isArray(value) || value.length > 100
    || Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).length !== value.length + 1) {
    throw new TypeError(ERROR_CODE)
  }
  const records = value.map(mediaExportRunView)
  if (new Set(records.map((record) => record.uid)).size !== records.length) {
    throw new TypeError(ERROR_CODE)
  }
  return Object.freeze(records)
}

export function useMediaExports({ dramaId, api = mediaExportAPI }) {
  const runs = ref([])
  const busy = ref(false)
  const error = ref(null)
  const guard = createLatestRequestGuard()

  function currentDramaId() {
    return typeof dramaId === 'function' ? dramaId() : dramaId
  }

  async function load() {
    const token = guard.begin()
    const requestedDramaId = currentDramaId()
    busy.value = true
    error.value = null
    try {
      const records = listView(await api.list(requestedDramaId))
      if (!guard.isCurrent(token) || requestedDramaId !== currentDramaId()) return false
      runs.value = records
      return true
    } catch {
      if (!guard.isCurrent(token)) return false
      runs.value = []
      error.value = ERROR_CODE
      return false
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  async function start(nodeRunUid) {
    const token = guard.begin()
    const requestedDramaId = currentDramaId()
    busy.value = true
    error.value = null
    try {
      mediaExportRunView(await api.start(requestedDramaId, nodeRunUid))
      if (!guard.isCurrent(token) || requestedDramaId !== currentDramaId()) return false
      const records = listView(await api.list(requestedDramaId))
      if (!guard.isCurrent(token) || requestedDramaId !== currentDramaId()) return false
      runs.value = records
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
    runs.value = []
    busy.value = false
    error.value = null
  }

  return Object.freeze({ runs, busy, error, load, start, invalidate })
}
