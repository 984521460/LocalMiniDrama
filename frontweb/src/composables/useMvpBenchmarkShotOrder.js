import { ref } from 'vue'

import { mvpBenchmarkSessionView } from '../benchmark/mvpSession.js'
import {
  createMvpBenchmarkShotTaskOrder,
  moveMvpBenchmarkShotTask,
  mvpBenchmarkShotTaskOrder,
} from '../benchmark/mvpShotOrder.js'

const FREEZE = Object.freeze
const ERROR_MESSAGE = 'MVP benchmark shot order is invalid'

function invalid() {
  throw new TypeError(ERROR_MESSAGE)
}

export function useMvpBenchmarkShotOrder() {
  const order = ref(FREEZE([]))
  let sessionUid = null
  let sourceSession = null

  function sync(sessionValue) {
    try {
      const session = mvpBenchmarkSessionView(sessionValue)
      const original = createMvpBenchmarkShotTaskOrder(session)
      sessionUid = session.uid
      sourceSession = session
      order.value = original
      return true
    } catch {
      invalidate()
      return false
    }
  }

  function move(taskUid, direction) {
    if (sessionUid === null || (direction !== -1 && direction !== 1)) return false
    const next = moveMvpBenchmarkShotTask(order.value, sourceSession, taskUid, direction)
    if (next === order.value) return false
    order.value = next
    return true
  }

  function reset() {
    if (sessionUid === null) return false
    order.value = createMvpBenchmarkShotTaskOrder(sourceSession)
    return true
  }

  function snapshot(sessionValue) {
    const session = mvpBenchmarkSessionView(sessionValue)
    if (session.uid !== sessionUid) invalid()
    return mvpBenchmarkShotTaskOrder(order.value, session)
  }

  function invalidate() {
    sessionUid = null
    sourceSession = null
    order.value = FREEZE([])
  }

  return FREEZE({ order, sync, move, reset, snapshot, invalidate })
}
