import { mvpBenchmarkAuthorizationView } from './mvpAuthorization.js'
import { mvpBenchmarkPreflightBatchView } from './mvpPreflight.js'
import { mvpBenchmarkSessionView } from './mvpSession.js'
import { parseStrictJson } from '../security/strictJson.js'

const {
  create: CREATE,
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
  'benchmarkEvidenceComplete', 'mvpComplete', 'completedGateCount', 'totalGateCount',
  'gates', 'remainingMvpEvidenceIds',
])
const GATE_KEYS = FREEZE(['id', 'status', 'evidenceSha256', 'blockerCode'])
const GATES = FREEZE([
  FREEZE({ id: 'production-execution', pending: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_PENDING', failed: 'MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED' }),
  FREEZE({ id: 'final-export', pending: 'MVP_BENCHMARK_FINAL_EXPORT_PENDING', failed: 'MVP_BENCHMARK_FINAL_EXPORT_FAILED' }),
  FREEZE({ id: 'human-av-review', pending: 'MVP_BENCHMARK_HUMAN_AV_REVIEW_PENDING', failed: null }),
  FREEZE({ id: 'accounting-settlement', pending: 'MVP_BENCHMARK_ACCOUNTING_SETTLEMENT_PENDING', failed: null }),
  FREEZE({ id: 'resource-release', pending: 'MVP_BENCHMARK_RESOURCE_RELEASE_PENDING', failed: null }),
])
const GLOBAL_EVIDENCE_IDS = FREEZE([
  'windows-release-lifecycle', 'section-19-project-evidence',
  'licenses-and-sources', 'accepted-residual-risks',
])
const ERROR_MESSAGE = 'MVP benchmark closeout status data is invalid'

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

function denseArray(value, minimumLength, maximumLength) {
  if (!IS_ARRAY(value) || GET_PROTOTYPE_OF(value) !== ARRAY_PROTOTYPE) invalid()
  const descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value)
  if (!HAS_OWN(descriptors, 'length')) invalid()
  const lengthDescriptor = descriptors.length
  if (!HAS_OWN(lengthDescriptor, 'value')) invalid()
  const length = lengthDescriptor.value
  if (!IS_SAFE_INTEGER(length) || length < minimumLength || length > maximumLength
    || OWN_KEYS(descriptors).length !== length + 1) invalid()
  const output = new ARRAY_CONSTRUCTOR(length)
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    if (!HAS_OWN(descriptors, key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !HAS_OWN(descriptor, 'value')) invalid()
    output[index] = descriptor.value
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
  if (input.schemaVersion !== 'mvp-benchmark-closeout-status.v1'
    || uid(input.dramaUid) !== session.dramaUid
    || uid(input.sessionUid) !== session.uid
    || uid(input.authorizationUid) !== authorization.uid
    || sha256(input.batchSha256) !== batch.batchSha256
    || input.mvpComplete !== false
    || integer(input.totalGateCount, GATES.length, GATES.length) !== GATES.length) invalid()
  const rawGates = denseArray(input.gates, GATES.length, GATES.length)
  const gates = new ARRAY_CONSTRUCTOR(GATES.length)
  let completedGateCount = 0
  const expectedRemaining = []
  for (let index = 0; index < GATES.length; index += 1) {
    const definition = GATES[index]
    const gate = exactObject(rawGates[index], GATE_KEYS)
    if (gate.id !== definition.id
      || (gate.status !== 'complete' && gate.status !== 'pending' && gate.status !== 'failed')) invalid()
    if (gate.status === 'complete') {
      sha256(gate.evidenceSha256)
      if (gate.blockerCode !== null) invalid()
      completedGateCount += 1
    } else {
      if (gate.evidenceSha256 !== null) invalid()
      const expectedCode = gate.status === 'pending' ? definition.pending : definition.failed
      if (expectedCode === null || gate.blockerCode !== expectedCode) invalid()
      expectedRemaining.push(gate.id)
    }
    gates[index] = FREEZE({
      id: gate.id,
      status: gate.status,
      evidenceSha256: gate.evidenceSha256,
      blockerCode: gate.blockerCode,
    })
  }
  if (integer(input.completedGateCount, 0, GATES.length) !== completedGateCount
    || input.benchmarkEvidenceComplete !== (completedGateCount === GATES.length)) invalid()
  for (let index = 0; index < GLOBAL_EVIDENCE_IDS.length; index += 1) {
    expectedRemaining.push(GLOBAL_EVIDENCE_IDS[index])
  }
  const remaining = denseArray(input.remainingMvpEvidenceIds, 4, 9)
  if (remaining.length !== expectedRemaining.length) invalid()
  for (let index = 0; index < remaining.length; index += 1) {
    if (remaining[index] !== expectedRemaining[index]) invalid()
  }
  const output = FREEZE({
    schemaVersion: input.schemaVersion,
    dramaUid: input.dramaUid,
    sessionUid: input.sessionUid,
    authorizationUid: input.authorizationUid,
    batchSha256: input.batchSha256,
    benchmarkEvidenceComplete: input.benchmarkEvidenceComplete,
    mvpComplete: false,
    completedGateCount,
    totalGateCount: GATES.length,
    gates: FREEZE(gates),
    remainingMvpEvidenceIds: FREEZE(remaining),
  })
  REFLECT_APPLY(WEAK_SET_ADD, TRUSTED_STATUS, [output])
  return output
}

export function parseMvpBenchmarkCloseoutStatusJson(text, session, authorization, batch) {
  return project(parseStrictJson(text), session, authorization, batch)
}

export function mvpBenchmarkCloseoutStatusView(value, session, authorization, batch) {
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
