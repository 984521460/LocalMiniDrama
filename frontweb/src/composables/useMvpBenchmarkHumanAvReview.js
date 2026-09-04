import { ref } from 'vue'

import {
  mvpBenchmarkHumanAvReviewAPI,
} from '../api/v2/mvpBenchmarkHumanAvReview.js'
import { mvpBenchmarkHumanAvReviewView } from '../benchmark/mvpHumanAvReview.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'

const ERROR_CODE = 'MVP_BENCHMARK_HUMAN_AV_REVIEW_REQUEST_FAILED'
const FREEZE = Object.freeze

export function createMvpBenchmarkHumanAvReviewState({ get, review }) {
  if (typeof get !== 'function' || typeof review !== 'function') {
    throw new TypeError('MVP benchmark human audiovisual review state is invalid')
  }
  const value = ref(null)
  const busy = ref(false)
  const error = ref(null)
  const guard = createLatestRequestGuard()

  async function request(method, session, authorization, batch, exportRun, seed) {
    const token = guard.begin()
    busy.value = true
    error.value = null
    try {
      const result = method === 'review'
        ? await review(session, authorization, batch, exportRun, seed)
        : await get(session, authorization, batch, exportRun)
      const projected = mvpBenchmarkHumanAvReviewView(
        result, session, authorization, batch, exportRun,
      )
      if (!guard.isCurrent(token)) return false
      value.value = projected
      return true
    } catch {
      if (!guard.isCurrent(token)) return false
      value.value = null
      error.value = ERROR_CODE
      return false
    } finally {
      if (guard.isCurrent(token)) busy.value = false
    }
  }

  function invalidate() {
    guard.invalidate()
    value.value = null
    busy.value = false
    error.value = null
  }

  return FREEZE({
    review: value,
    busy,
    error,
    load: (session, authorization, batch, exportRun) => (
      request('get', session, authorization, batch, exportRun)
    ),
    submit: (session, authorization, batch, exportRun, seed) => (
      request('review', session, authorization, batch, exportRun, seed)
    ),
    invalidate,
  })
}

export function useMvpBenchmarkHumanAvReview({
  api = mvpBenchmarkHumanAvReviewAPI,
} = {}) {
  return createMvpBenchmarkHumanAvReviewState({
    get: (session, authorization, batch, exportRun) => (
      api.get(session, authorization, batch, exportRun)
    ),
    review: (session, authorization, batch, exportRun, seed) => (
      api.review(session, authorization, batch, exportRun, seed)
    ),
  })
}
