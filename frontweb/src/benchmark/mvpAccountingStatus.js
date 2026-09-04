import { mvpBenchmarkAuthorizationView } from './mvpAuthorization.js'
import { mvpBenchmarkPreflightBatchView } from './mvpPreflight.js'
import { mvpBenchmarkSessionView } from './mvpSession.js'
import { parseStrictJson } from '../security/strictJson.js'

const {
  create: CREATE,
  defineProperty: DEFINE_PROPERTY,
  freeze: FREEZE,
  getOwnPropertyDescriptors: GET_OWN_PROPERTY_DESCRIPTORS,
  getPrototypeOf: GET_PROTOTYPE_OF,
  hasOwn: HAS_OWN,
} = Object
const ARRAY_CONSTRUCTOR = Array
const { isArray: IS_ARRAY, prototype: ARRAY_PROTOTYPE } = Array
const OBJECT_PROTOTYPE = Object.prototype
const { isSafeInteger: IS_SAFE_INTEGER } = Number
const { ownKeys: OWN_KEYS } = Reflect
const REFLECT_APPLY = Reflect.apply
const REGEXP_TEST = RegExp.prototype.test
const WEAK_SET_ADD = WeakSet.prototype.add
const WEAK_SET_HAS = WeakSet.prototype.has
const TRUSTED_STATUS = new WeakSet()
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const ROOT_KEYS = FREEZE([
  'schemaVersion', 'dramaUid', 'sessionUid', 'authorizationUid', 'batchSha256',
  'totalCount', 'settledCount', 'actualCostCnyFen', 'allSettled', 'releaseState',
  'obligationSha256', 'receiptSha256', 'items',
])
const ITEM_KEYS = FREEZE([
  'ordinal', 'itemKind', 'itemUid', 'reservationUid', 'settlementState',
  'settlementUid', 'settlementSha256', 'actualCostCnyFen',
])
const ERROR_MESSAGE = 'MVP benchmark accounting status data is invalid'

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
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) invalid()
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

function denseArray(value, maximumLength) {
  if (!IS_ARRAY(value) || GET_PROTOTYPE_OF(value) !== ARRAY_PROTOTYPE) invalid()
  const descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value)
  if (!HAS_OWN(descriptors, 'length')) invalid()
  const length = descriptors.length.value
  if (!IS_SAFE_INTEGER(length) || length < 1 || length > maximumLength
    || OWN_KEYS(descriptors).length !== length + 1) invalid()
  const output = new ARRAY_CONSTRUCTOR(length)
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    if (!HAS_OWN(descriptors, key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !HAS_OWN(descriptor, 'value')) invalid()
    DEFINE_PROPERTY(output, key, {
      configurable: true, enumerable: true, value: descriptor.value, writable: true,
    })
  }
  return output
}

function uid(value) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, UUID_V4, [value])) invalid()
  return value
}

function sha256(value) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, SHA256, [value])) invalid()
  return value
}

function integer(value, minimum, maximum) {
  if (!IS_SAFE_INTEGER(value) || value < minimum || value > maximum) invalid()
  return value
}

function project(value, sessionValue, authorizationValue, batchValue) {
  const session = mvpBenchmarkSessionView(sessionValue)
  const authorization = mvpBenchmarkAuthorizationView(authorizationValue, {
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    sessionPlanSha256: session.planSha256,
  })
  const batch = mvpBenchmarkPreflightBatchView(batchValue, session, authorization)
  const input = exactObject(value, ROOT_KEYS)
  if (input.schemaVersion !== 'mvp-benchmark-accounting-status.v1'
    || uid(input.dramaUid) !== session.dramaUid
    || uid(input.sessionUid) !== session.uid
    || uid(input.authorizationUid) !== authorization.uid
    || sha256(input.batchSha256) !== batch.batchSha256) invalid()
  const items = denseArray(input.items, 128)
  if (items.length !== batch.reservations.length
    || integer(input.totalCount, 1, 128) !== items.length) invalid()
  const projected = new ARRAY_CONSTRUCTOR(items.length)
  let settledCount = 0
  let actualCostCnyFen = 0
  for (let index = 0; index < items.length; index += 1) {
    const item = exactObject(items[index], ITEM_KEYS)
    const reservation = batch.reservations[index]
    if (integer(item.ordinal, 0, 127) !== index
      || item.itemKind !== reservation.itemKind
      || uid(item.itemUid) !== reservation.itemUid
      || uid(item.reservationUid) !== reservation.uid) invalid()
    if (item.settlementState === 'pending') {
      if (item.settlementUid !== null || item.settlementSha256 !== null
        || item.actualCostCnyFen !== null) invalid()
    } else if (item.settlementState === 'settled') {
      const actual = integer(item.actualCostCnyFen, 0, reservation.estimatedCostCnyFen)
      settledCount += 1
      actualCostCnyFen += actual
      if (!IS_SAFE_INTEGER(actualCostCnyFen) || actualCostCnyFen > 1_000_000) invalid()
      uid(item.settlementUid)
      sha256(item.settlementSha256)
    } else {
      invalid()
    }
    projected[index] = FREEZE({
      ordinal: index,
      itemKind: item.itemKind,
      itemUid: item.itemUid,
      reservationUid: item.reservationUid,
      settlementState: item.settlementState,
      settlementUid: item.settlementUid,
      settlementSha256: item.settlementSha256,
      actualCostCnyFen: item.actualCostCnyFen,
    })
  }
  if (integer(input.settledCount, 0, items.length) !== settledCount
    || integer(input.actualCostCnyFen, 0, 1_000_000) !== actualCostCnyFen
    || input.allSettled !== (settledCount === items.length)) invalid()
  if (input.releaseState === 'required') {
    if (input.receiptSha256 !== null) invalid()
  } else if (input.releaseState === 'released') {
    sha256(input.receiptSha256)
  } else {
    invalid()
  }
  const output = FREEZE({
    schemaVersion: 'mvp-benchmark-accounting-status.v1',
    dramaUid: input.dramaUid,
    sessionUid: input.sessionUid,
    authorizationUid: input.authorizationUid,
    batchSha256: input.batchSha256,
    totalCount: items.length,
    settledCount,
    actualCostCnyFen,
    allSettled: input.allSettled,
    releaseState: input.releaseState,
    obligationSha256: sha256(input.obligationSha256),
    receiptSha256: input.receiptSha256,
    items: FREEZE(projected),
  })
  REFLECT_APPLY(WEAK_SET_ADD, TRUSTED_STATUS, [output])
  return output
}

export function parseMvpBenchmarkAccountingStatusJson(
  text, session, authorization, batch,
) {
  return project(parseStrictJson(text), session, authorization, batch)
}

export function mvpBenchmarkAccountingStatusView(
  value, session, authorization, batch,
) {
  if (!value || typeof value !== 'object'
    || !REFLECT_APPLY(WEAK_SET_HAS, TRUSTED_STATUS, [value])) invalid()
  const expectedSession = mvpBenchmarkSessionView(session)
  const expectedAuthorization = mvpBenchmarkAuthorizationView(authorization, {
    sessionUid: expectedSession.uid,
    dramaUid: expectedSession.dramaUid,
    sessionPlanSha256: expectedSession.planSha256,
  })
  const expectedBatch = mvpBenchmarkPreflightBatchView(
    batch, expectedSession, expectedAuthorization,
  )
  if (value.dramaUid !== expectedSession.dramaUid
    || value.sessionUid !== expectedSession.uid
    || value.authorizationUid !== expectedAuthorization.uid
    || value.batchSha256 !== expectedBatch.batchSha256) invalid()
  return value
}
