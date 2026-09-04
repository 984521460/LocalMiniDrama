import { ref } from 'vue'

import { bgmLibraryAPI } from '../api/v2/bgmLibrary.js'
import {
  bgmLibraryTrackListView,
  bgmLibraryTrackView,
} from '../audio/bgmLibrary.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'

const ERROR_CODE = 'BGM_LIBRARY_REQUEST_FAILED'

export function createBgmLibraryState({ list, importTrack }) {
  if (typeof list !== 'function' || typeof importTrack !== 'function') {
    throw new TypeError('BGM library state is invalid')
  }
  const tracks = ref(Object.freeze([]))
  const selectedTrackUid = ref('')
  const busy = ref(false)
  const error = ref(null)
  const guard = createLatestRequestGuard()

  async function load(dramaUid) {
    const token = guard.begin()
    busy.value = true
    error.value = null
    try {
      const result = bgmLibraryTrackListView(await list(dramaUid), dramaUid)
      if (!guard.isCurrent(token)) return false
      tracks.value = result
      let selectionStillValid = false
      for (let index = 0; index < result.length; index += 1) {
        if (result[index].uid === selectedTrackUid.value && result[index].exportEligible) {
          selectionStillValid = true
        }
      }
      if (!selectionStillValid) {
        selectedTrackUid.value = ''
      }
      return true
    } catch {
      if (!guard.isCurrent(token)) return false
      tracks.value = Object.freeze([])
      selectedTrackUid.value = ''
      error.value = ERROR_CODE
      return false
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  async function add(dramaUid, input) {
    const token = guard.begin()
    busy.value = true
    error.value = null
    try {
      const result = bgmLibraryTrackView(await importTrack(dramaUid, input), dramaUid)
      if (!guard.isCurrent(token)) return false
      const next = []
      for (let index = 0; index < tracks.value.length; index += 1) {
        if (tracks.value[index].uid === result.uid) throw new TypeError()
        next[index] = tracks.value[index]
      }
      next[next.length] = result
      tracks.value = Object.freeze(next)
      return true
    } catch {
      if (!guard.isCurrent(token)) return false
      error.value = ERROR_CODE
      return false
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  function select(trackUid) {
    let candidate = null
    for (let index = 0; index < tracks.value.length; index += 1) {
      const track = tracks.value[index]
      if (track.uid === trackUid && track.exportEligible) candidate = track
    }
    if (!candidate) return false
    selectedTrackUid.value = candidate.uid
    return true
  }

  function invalidate() {
    guard.invalidate()
    tracks.value = Object.freeze([])
    selectedTrackUid.value = ''
    busy.value = false
    error.value = null
  }

  return Object.freeze({
    tracks, selectedTrackUid, busy, error,
    load, importTrack: add, select, invalidate,
  })
}

export function useBgmLibrary({ api = bgmLibraryAPI } = {}) {
  return createBgmLibraryState({
    list: (dramaUid) => api.list(dramaUid),
    importTrack: (dramaUid, input) => api.importTrack(dramaUid, input),
  })
}
