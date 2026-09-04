import { computed, ref } from 'vue'

import { characterReferencePackageAPI } from '../api/v2/characterReferencePackages.js'
import { narrativeReviewAPI } from '../api/v2/narrativeReviews.js'
import { shotContinuityAPI } from '../api/v2/shotContinuitySnapshots.js'
import { characterReferencePackageView } from '../assets/characterReferencePackage.js'
import {
  continuityReuseSummary,
  shotContinuityComparisonView,
  shotContinuitySnapshotListView,
} from '../assets/shotContinuity.js'
import {
  createLatestRequestGuard,
  groupNarrativeResults,
} from '../components/narrative/narrativeReview.js'

const ERROR_CODE = 'ASSET_VERSION_CONTINUITY_INVALID'

function packageHistoryView(value, characterUid) {
  if (!Array.isArray(value) || value.length > 100 || Object.keys(value).length !== value.length) {
    throw new TypeError(ERROR_CODE)
  }
  const packages = value.map((source) => Object.freeze({
    source,
    view: characterReferencePackageView(source),
  }))
  if (packages.some((record) => record.view.characterUid !== characterUid)
    || new Set(packages.map((record) => record.view.packageUid)).size !== packages.length
    || new Set(packages.map((record) => record.view.lockStateVersion)).size !== packages.length) {
    throw new TypeError(ERROR_CODE)
  }
  return Object.freeze(packages.sort((left, right) => (
    left.view.lockStateVersion - right.view.lockStateVersion
    || left.view.createdAtEpochMs - right.view.createdAtEpochMs
  )))
}

export function useAssetVersionContinuity({
  dramaId,
  reviewApi = narrativeReviewAPI,
  continuityApi = shotContinuityAPI,
  packageApi = characterReferencePackageAPI,
}) {
  const snapshots = ref([])
  const comparisons = ref([])
  const characterHistories = ref([])
  const shotResultUid = ref('')
  const loading = ref(false)
  const materializing = ref(false)
  const error = ref(null)
  const emptyReason = ref('')
  const guard = createLatestRequestGuard()
  const reuse = computed(() => continuityReuseSummary(snapshots.value, comparisons.value))

  function currentDramaId() {
    return typeof dramaId === 'function' ? dramaId() : dramaId
  }

  function clear() {
    snapshots.value = []
    comparisons.value = []
    characterHistories.value = []
    shotResultUid.value = ''
    emptyReason.value = ''
  }

  async function load() {
    const token = guard.begin()
    loading.value = true
    error.value = null
    clear()
    try {
      const requestedDramaId = currentDramaId()
      const reviewRecords = await reviewApi.listForDrama(requestedDramaId)
      if (!guard.isCurrent(token) || requestedDramaId !== currentDramaId()) return false
      const groups = groupNarrativeResults(reviewRecords)
      const shot = groups.find((group) => group.type === 'shot')?.result || null
      if (!shot || shot.status !== 'approved') {
        emptyReason.value = 'SHOT_APPROVAL_REQUIRED'
        return true
      }
      const loadedSnapshots = shotContinuitySnapshotListView(
        await continuityApi.list(shot.uid),
      )
      if (!guard.isCurrent(token)) return false
      if (loadedSnapshots.some((snapshot) => snapshot.shotResultUid !== shot.uid)) {
        throw new TypeError(ERROR_CODE)
      }
      const loadedComparisons = await Promise.all(loadedSnapshots.slice(1).map(
        (snapshot, index) => continuityApi.compare(
          loadedSnapshots[index].snapshotUid,
          snapshot.snapshotUid,
        ),
      ))
      if (!guard.isCurrent(token)) return false
      const comparisonViews = loadedComparisons.map(shotContinuityComparisonView)
      continuityReuseSummary(loadedSnapshots, comparisonViews)

      const characterUids = [...new Set(loadedSnapshots.flatMap(
        (snapshot) => snapshot.characters.map((character) => character.characterUid),
      ))]
      const histories = await Promise.all(characterUids.map(async (characterUid) => ({
        characterUid,
        packages: packageHistoryView(await packageApi.list(characterUid), characterUid),
      })))
      if (!guard.isCurrent(token)) return false
      for (const snapshot of loadedSnapshots) {
        for (const character of snapshot.characters) {
          const history = histories.find((entry) => entry.characterUid === character.characterUid)
          if (!history?.packages.some((entry) => (
            entry.view.packageUid === character.referencePackageUid
            && entry.view.identityVersionUid === character.identityVersionUid
          ))) throw new TypeError(ERROR_CODE)
        }
      }

      snapshots.value = loadedSnapshots
      comparisons.value = Object.freeze(comparisonViews)
      characterHistories.value = Object.freeze(histories.map((history) => Object.freeze(history)))
      shotResultUid.value = shot.uid
      if (loadedSnapshots.length === 0) emptyReason.value = 'CONTINUITY_SNAPSHOTS_EMPTY'
      return true
    } catch {
      if (!guard.isCurrent(token)) return false
      clear()
      error.value = ERROR_CODE
      return false
    } finally {
      if (guard.isCurrent(token)) loading.value = false
    }
  }

  async function materialize() {
    if (loading.value || materializing.value || !shotResultUid.value) return false
    const requestedDramaId = currentDramaId()
    const requestedShotResultUid = shotResultUid.value
    materializing.value = true
    error.value = null
    try {
      const created = shotContinuitySnapshotListView(
        await continuityApi.materialize(requestedShotResultUid),
      )
      if (requestedDramaId !== currentDramaId()
        || shotResultUid.value !== requestedShotResultUid) return false
      if (created.length < 1
        || created.some((snapshot) => snapshot.shotResultUid !== requestedShotResultUid)) {
        throw new TypeError(ERROR_CODE)
      }
      return load()
    } catch {
      if (requestedDramaId !== currentDramaId()
        || shotResultUid.value !== requestedShotResultUid) return false
      error.value = ERROR_CODE
      return false
    } finally {
      materializing.value = false
    }
  }

  function invalidate() {
    guard.invalidate()
    loading.value = false
    error.value = null
    clear()
  }

  return Object.freeze({
    snapshots,
    comparisons,
    characterHistories,
    shotResultUid,
    loading,
    materializing,
    error,
    emptyReason,
    reuse,
    load,
    materialize,
    invalidate,
  })
}
