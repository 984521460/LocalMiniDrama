import { mvpBenchmarkPreflightBatchView } from './mvpPreflight.js'
import { parseStrictJson } from '../security/strictJson.js'

const {
  create: CREATE,
  freeze: FREEZE,
  getOwnPropertyDescriptors: GET_OWN_PROPERTY_DESCRIPTORS,
  getPrototypeOf: GET_PROTOTYPE_OF,
  hasOwn: HAS_OWN,
} = Object
const { isArray: IS_ARRAY } = Array
const { ownKeys: OWN_KEYS } = Reflect
const REFLECT_APPLY = Reflect.apply
const WEAK_SET_ADD = WeakSet.prototype.add
const WEAK_SET_HAS = WeakSet.prototype.has
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger
const TRUSTED_STEPS = new WeakSet()
const ERROR_MESSAGE = 'MVP benchmark production execution data is invalid'
const STEP_KEYS = FREEZE([
  'schemaVersion', 'authorizationUid', 'sessionUid', 'dramaUid', 'completedCount',
  'totalCount', 'batchComplete', 'item', 'batchSha256',
])
const ITEM_KEYS = FREEZE(['ordinal', 'itemKind', 'itemUid', 'status'])

function invalid() {
  throw new TypeError(ERROR_MESSAGE)
}

function exactObject(value, expectedKeys) {
  if (!value || typeof value !== 'object' || IS_ARRAY(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = GET_PROTOTYPE_OF(value)
    descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value)
  } catch {
    invalid()
  }
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const actualKeys = OWN_KEYS(descriptors)
  if (actualKeys.length !== expectedKeys.length) invalid()
  const output = CREATE(null)
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index]
    if (!HAS_OWN(descriptors, key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !HAS_OWN(descriptor, 'value')) invalid()
    output[key] = descriptor.value
  }
  for (let index = 0; index < actualKeys.length; index += 1) {
    if (typeof actualKeys[index] !== 'string' || !HAS_OWN(output, actualKeys[index])) invalid()
  }
  return output
}

function safeInteger(value, minimum, maximum) {
  if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [value])
    || value < minimum || value > maximum) invalid()
  return value
}

function projectStep(value, sessionValue, authorizationValue, batchValue) {
  const batch = mvpBenchmarkPreflightBatchView(
    batchValue, sessionValue, authorizationValue,
  )
  const input = exactObject(value, STEP_KEYS)
  const completedCount = safeInteger(input.completedCount, 1, 64)
  const totalCount = safeInteger(input.totalCount, 2, 64)
  const batchComplete = input.batchComplete
  if (input.schemaVersion !== 'mvp-benchmark-production-execution-step.v1'
    || input.authorizationUid !== batch.authorizationUid
    || input.sessionUid !== batch.sessionUid
    || input.dramaUid !== batch.dramaUid
    || input.batchSha256 !== batch.batchSha256
    || totalCount !== batch.reservations.length
    || completedCount > totalCount
    || typeof batchComplete !== 'boolean'
    || batchComplete !== (completedCount === totalCount)) invalid()

  let item = null
  if (batchComplete) {
    if (input.item !== null) invalid()
  } else {
    const itemInput = exactObject(input.item, ITEM_KEYS)
    const ordinal = safeInteger(itemInput.ordinal, 0, 63)
    const reservation = batch.reservations[ordinal]
    if (ordinal !== completedCount - 1 || !reservation
      || itemInput.itemKind !== reservation.itemKind
      || itemInput.itemUid !== reservation.itemUid
      || itemInput.status !== 'succeeded') invalid()
    item = FREEZE({
      ordinal,
      itemKind: itemInput.itemKind,
      itemUid: itemInput.itemUid,
      status: 'succeeded',
    })
  }

  return FREEZE({
    schemaVersion: input.schemaVersion,
    authorizationUid: input.authorizationUid,
    sessionUid: input.sessionUid,
    dramaUid: input.dramaUid,
    batchSha256: input.batchSha256,
    completedCount,
    totalCount,
    batchComplete,
    item,
  })
}

function trustStep(value) {
  REFLECT_APPLY(WEAK_SET_ADD, TRUSTED_STEPS, [value])
  return value
}

export function parseMvpBenchmarkProductionExecutionStepJson(
  text, sessionValue, authorizationValue, batchValue,
) {
  return trustStep(projectStep(
    parseStrictJson(text), sessionValue, authorizationValue, batchValue,
  ))
}

export function mvpBenchmarkProductionExecutionStepView(
  value, sessionValue, authorizationValue, batchValue,
) {
  if (!value || typeof value !== 'object'
    || !REFLECT_APPLY(WEAK_SET_HAS, TRUSTED_STEPS, [value])) invalid()
  return trustStep(projectStep(value, sessionValue, authorizationValue, batchValue))
}
