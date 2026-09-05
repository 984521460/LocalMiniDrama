import { ref } from 'vue'

import { characterReferencePackageAPI } from '../api/v2/characterReferencePackages.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'

const ERROR_CODE = 'CHARACTER_REFERENCE_PACKAGE_HISTORY_REQUEST_FAILED'

export function useCharacterReferencePackageHistory({ api = characterReferencePackageAPI } = {}) {
  const busy = ref(false)
  const error = ref(null)
  const entries = ref(Object.freeze([]))
  const nextCursor = ref(null)
  const guard = createLatestRequestGuard()

  async function requestPage(input, reset) {
    if (busy.value || (!reset && nextCursor.value === null)) return null
    const token = guard.begin()
    busy.value = true
    error.value = null
    try {
      const cursor = reset ? null : nextCursor.value
      const page = await api.listHistory(
        input.dramaId,
        input.dramaUid,
        input.characterUid,
        cursor,
      )
      if (!guard.isCurrent(token)) return null
      const combined = reset ? [] : [...entries.value]
      const known = new Set()
      for (let index = 0; index < combined.length; index += 1) {
        known.add(combined[index].operationUid)
      }
      for (let index = 0; index < page.entries.length; index += 1) {
        if (known.has(page.entries[index].operationUid)) throw new TypeError()
        known.add(page.entries[index].operationUid)
        combined[combined.length] = page.entries[index]
      }
      entries.value = Object.freeze(combined)
      nextCursor.value = page.nextCursor
      return page
    } catch {
      if (!guard.isCurrent(token)) return null
      error.value = ERROR_CODE
      return null
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  function refresh(input) { return requestPage(input, true) }
  function loadMore(input) { return requestPage(input, false) }
  function invalidate() {
    guard.invalidate()
    busy.value = false
    error.value = null
    entries.value = Object.freeze([])
    nextCursor.value = null
  }

  return Object.freeze({ busy, error, entries, nextCursor, refresh, loadMore, invalidate })
}
