import { mvpBenchmarkAuthorizationView } from './mvpAuthorization.js'
import { mvpBenchmarkSessionView } from './mvpSession.js'
import { parseStrictJson } from '../security/strictJson.js'

const {
  defineProperty: DEFINE_PROPERTY,
  freeze: FREEZE,
  getOwnPropertyDescriptors: GET_OWN_PROPERTY_DESCRIPTORS,
  getPrototypeOf: GET_PROTOTYPE_OF,
  hasOwn: HAS_OWN,
} = Object
const { isArray: IS_ARRAY } = Array
const { ownKeys: OWN_KEYS } = Reflect
const REFLECT_APPLY = Reflect.apply
const REGEXP_TEST = RegExp.prototype.test
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger
const SET_ADD = Set.prototype.add
const SET_HAS = Set.prototype.has
const WEAK_SET_ADD = WeakSet.prototype.add
const WEAK_SET_HAS = WeakSet.prototype.has
const TRUSTED_BATCHES = new WeakSet()
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const ERROR_MESSAGE = 'MVP benchmark preflight data is invalid'
const BATCH_KEYS = FREEZE([
  'schemaVersion', 'authorizationUid', 'sessionUid', 'dramaUid', 'attestationUid',
  'reservations', 'estimatedCostCnyFen', 'preparedAtEpochMs', 'batchSha256',
])
const RESERVATION_KEYS = FREEZE([
  'schemaVersion', 'uid', 'authorizationUid', 'attestationUid', 'sessionUid',
  'dramaUid', 'itemKind', 'itemUid', 'requestSha256', 'estimate',
  'estimatedCostCnyFen', 'attemptNumber', 'reservedAtEpochMs', 'reservationSha256',
])
const ESTIMATE_KEYS = FREEZE([
  'schemaVersion', 'itemKind', 'itemUid', 'requestSha256', 'estimatedCostCnyFen',
  'policyUid', 'estimateSha256',
])

function invalid() {
  throw new TypeError(ERROR_MESSAGE)
}

function append(target, value) {
  DEFINE_PROPERTY(target, String(target.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
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
  const output = Object.create(null)
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index]
    if (!HAS_OWN(descriptors, key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !HAS_OWN(descriptor, 'value')) invalid()
    output[key] = descriptor.value
  }
  for (let index = 0; index < actualKeys.length; index += 1) {
    if (typeof actualKeys[index] !== 'string' || !HAS_OWN(output, actualKeys[index])) invalid()
  }
  return output
}

function denseArray(value, length) {
  if (!IS_ARRAY(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = GET_PROTOTYPE_OF(value)
    descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value)
  } catch {
    invalid()
  }
  if (prototype !== Array.prototype || !HAS_OWN(descriptors, 'length')
    || descriptors.length?.value !== length
    || OWN_KEYS(descriptors).length !== length + 1) invalid()
  const output = []
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    if (!HAS_OWN(descriptors, key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !HAS_OWN(descriptor, 'value')) invalid()
    append(output, descriptor.value)
  }
  return output
}

function uuid(value) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, UUID_V4, [value])) invalid()
  return value
}

function sha256(value) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, SHA256, [value])) invalid()
  return value
}

function safeInteger(value, minimum, maximum) {
  if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [value])
    || value < minimum || value > maximum) invalid()
  return value
}

function estimateView(value, expected) {
  const input = exactObject(value, ESTIMATE_KEYS)
  const estimatedCostCnyFen = safeInteger(input.estimatedCostCnyFen, 0, 1_000_000)
  if (input.schemaVersion !== 'mvp-benchmark-cost-estimate.v1'
    || input.itemKind !== expected.itemKind
    || uuid(input.itemUid) !== expected.itemUid
    || sha256(input.requestSha256) !== expected.requestSha256) invalid()
  return FREEZE({
    schemaVersion: input.schemaVersion,
    itemKind: input.itemKind,
    itemUid: input.itemUid,
    requestSha256: input.requestSha256,
    estimatedCostCnyFen,
    policyUid: uuid(input.policyUid),
    estimateSha256: sha256(input.estimateSha256),
  })
}

function reservationView(value, expected) {
  const input = exactObject(value, RESERVATION_KEYS)
  const estimate = estimateView(input.estimate, expected)
  const estimatedCostCnyFen = safeInteger(input.estimatedCostCnyFen, 0, 1_000_000)
  if (input.schemaVersion !== 'mvp-benchmark-execution-reservation.v1'
    || input.authorizationUid !== expected.authorizationUid
    || input.attestationUid !== expected.attestationUid
    || input.sessionUid !== expected.sessionUid
    || input.dramaUid !== expected.dramaUid
    || input.itemKind !== expected.itemKind
    || uuid(input.itemUid) !== expected.itemUid
    || sha256(input.requestSha256) !== expected.requestSha256
    || input.attemptNumber !== 1
    || estimatedCostCnyFen !== estimate.estimatedCostCnyFen
    || input.reservedAtEpochMs !== expected.preparedAtEpochMs) invalid()
  return FREEZE({
    schemaVersion: input.schemaVersion,
    uid: uuid(input.uid),
    authorizationUid: input.authorizationUid,
    attestationUid: input.attestationUid,
    sessionUid: input.sessionUid,
    dramaUid: input.dramaUid,
    itemKind: input.itemKind,
    itemUid: input.itemUid,
    requestSha256: input.requestSha256,
    estimate,
    estimatedCostCnyFen,
    attemptNumber: 1,
    reservedAtEpochMs: input.reservedAtEpochMs,
    reservationSha256: sha256(input.reservationSha256),
  })
}

function projectBatch(value, sessionValue, authorizationValue) {
  const session = mvpBenchmarkSessionView(sessionValue)
  const authorization = mvpBenchmarkAuthorizationView(authorizationValue, {
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    sessionPlanSha256: session.planSha256,
  })
  if (authorization.h3SubmissionLimit !== session.h3Tasks.length
    || authorization.ttsSubmissionLimit !== session.audioIntents.length) invalid()
  const input = exactObject(value, BATCH_KEYS)
  const attestationUid = uuid(input.attestationUid)
  const preparedAtEpochMs = safeInteger(input.preparedAtEpochMs, 0, 253402300799999)
  const length = session.h3Tasks.length + session.audioIntents.length
  if (input.schemaVersion !== 'mvp-benchmark-execution-preflight-batch.v1'
    || input.authorizationUid !== authorization.uid
    || input.sessionUid !== session.uid
    || input.dramaUid !== session.dramaUid
    || preparedAtEpochMs < authorization.authorizedAtEpochMs
    || preparedAtEpochMs >= authorization.expiresAtEpochMs) invalid()
  const source = denseArray(input.reservations, length)
  const reservations = []
  const reservationUids = new Set()
  let estimatedCostCnyFen = 0
  for (let index = 0; index < source.length; index += 1) {
    const h3 = index < session.h3Tasks.length
    const item = h3 ? session.h3Tasks[index] : session.audioIntents[index - session.h3Tasks.length]
    const reservation = reservationView(source[index], {
      authorizationUid: authorization.uid,
      attestationUid,
      sessionUid: session.uid,
      dramaUid: session.dramaUid,
      itemKind: h3 ? 'h3' : 'tts',
      itemUid: h3 ? item.taskUid : item.intentUid,
      requestSha256: h3 ? item.planEvidenceSha256 : item.planSha256,
      preparedAtEpochMs,
    })
    if (REFLECT_APPLY(SET_HAS, reservationUids, [reservation.uid])) invalid()
    REFLECT_APPLY(SET_ADD, reservationUids, [reservation.uid])
    estimatedCostCnyFen += reservation.estimatedCostCnyFen
    if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [estimatedCostCnyFen])
      || estimatedCostCnyFen > authorization.maximumCostCnyFen) invalid()
    append(reservations, reservation)
  }
  if (input.estimatedCostCnyFen !== estimatedCostCnyFen) invalid()
  return FREEZE({
    schemaVersion: input.schemaVersion,
    authorizationUid: input.authorizationUid,
    sessionUid: input.sessionUid,
    dramaUid: input.dramaUid,
    attestationUid,
    reservations: FREEZE(reservations),
    estimatedCostCnyFen,
    preparedAtEpochMs,
    batchSha256: sha256(input.batchSha256),
  })
}

function trustBatch(value) {
  REFLECT_APPLY(WEAK_SET_ADD, TRUSTED_BATCHES, [value])
  return value
}

export function parseMvpBenchmarkPreflightBatchJson(text, sessionValue, authorizationValue) {
  return trustBatch(projectBatch(parseStrictJson(text), sessionValue, authorizationValue))
}

export function mvpBenchmarkPreflightBatchView(value, sessionValue, authorizationValue) {
  if (!value || typeof value !== 'object'
    || !REFLECT_APPLY(WEAK_SET_HAS, TRUSTED_BATCHES, [value])) invalid()
  return trustBatch(projectBatch(value, sessionValue, authorizationValue))
}
