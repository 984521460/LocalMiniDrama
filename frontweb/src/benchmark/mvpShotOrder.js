import { mvpBenchmarkSessionView } from './mvpSession.js'

const FREEZE = Object.freeze
const REFLECT_APPLY = Reflect.apply
const WEAK_SET_ADD = WeakSet.prototype.add
const WEAK_SET_HAS = WeakSet.prototype.has
const SET_CONSTRUCTOR = Set
const SET_ADD = Set.prototype.add
const SET_HAS = Set.prototype.has
const TRUSTED_ORDERS = new WeakSet()
const ERROR_MESSAGE = 'MVP benchmark shot order is invalid'

function invalid() {
  throw new TypeError(ERROR_MESSAGE)
}

function trustedOrder(values) {
  const order = FREEZE(values)
  REFLECT_APPLY(WEAK_SET_ADD, TRUSTED_ORDERS, [order])
  return order
}

export function createMvpBenchmarkShotTaskOrder(sessionValue) {
  const session = mvpBenchmarkSessionView(sessionValue)
  const order = []
  for (let index = 0; index < session.h3Tasks.length; index += 1) {
    order[index] = session.h3Tasks[index].taskUid
  }
  return trustedOrder(order)
}

export function mvpBenchmarkShotTaskOrder(value, sessionValue) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null
    || !REFLECT_APPLY(WEAK_SET_HAS, TRUSTED_ORDERS, [value])) invalid()
  const session = mvpBenchmarkSessionView(sessionValue)
  if (value.length !== session.h3Tasks.length) invalid()
  const expected = new SET_CONSTRUCTOR()
  const actual = new SET_CONSTRUCTOR()
  for (let index = 0; index < session.h3Tasks.length; index += 1) {
    REFLECT_APPLY(SET_ADD, expected, [session.h3Tasks[index].taskUid])
  }
  for (let index = 0; index < value.length; index += 1) {
    const taskUid = value[index]
    if (!REFLECT_APPLY(SET_HAS, expected, [taskUid])
      || REFLECT_APPLY(SET_HAS, actual, [taskUid])) invalid()
    REFLECT_APPLY(SET_ADD, actual, [taskUid])
  }
  return value
}

export function moveMvpBenchmarkShotTask(
  value, sessionValue, taskUid, direction,
) {
  const current = mvpBenchmarkShotTaskOrder(value, sessionValue)
  if (direction !== -1 && direction !== 1) invalid()
  let currentIndex = -1
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] === taskUid) currentIndex = index
  }
  const targetIndex = currentIndex + direction
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= current.length) return current
  const next = []
  for (let index = 0; index < current.length; index += 1) next[index] = current[index]
  next[currentIndex] = next[targetIndex]
  next[targetIndex] = taskUid
  return trustedOrder(next)
}
