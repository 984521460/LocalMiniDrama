const {
  freeze: FREEZE,
  getOwnPropertyDescriptors: GET_OWN_PROPERTY_DESCRIPTORS,
  getPrototypeOf: GET_PROTOTYPE_OF,
  hasOwn: HAS_OWN,
} = Object
const { isArray: IS_ARRAY } = Array
const { ownKeys: OWN_KEYS } = Reflect
const REGEXP_TEST = RegExp.prototype.test
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const ERROR_MESSAGE = 'MVP benchmark authorization data is invalid'
const AUTHORIZATION_KEYS = FREEZE([
  'schemaVersion', 'uid', 'sessionUid', 'dramaUid', 'sessionPlanSha256',
  'connectionUid', 'connectionEvidenceSha256', 'requiredGpuClass',
  'requiredEnvironmentSha256', 'liveEnvironmentCheck', 'maximumCostCnyFen',
  'dataScope', 'h3SubmissionLimit', 'ttsSubmissionLimit', 'perItemAttemptLimit',
  'instanceDisposition', 'authorizedAtEpochMs', 'expiresAtEpochMs',
  'authorizationSha256',
])
const SEED_KEYS = FREEZE(['maximumCostCnyFen', 'validityDurationMs'])

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

function safeInteger(value, minimum, maximum) {
  if (!Reflect.apply(NUMBER_IS_SAFE_INTEGER, Number, [value])
    || value < minimum || value > maximum) invalid()
  return value
}

function uuid(value) {
  if (typeof value !== 'string' || !Reflect.apply(REGEXP_TEST, UUID_V4, [value])) invalid()
  return value
}

function sha256(value) {
  if (typeof value !== 'string' || !Reflect.apply(REGEXP_TEST, SHA256, [value])) invalid()
  return value
}

export function mvpBenchmarkAuthorizationSeed(value) {
  const input = exactObject(value, SEED_KEYS)
  return FREEZE({
    maximumCostCnyFen: safeInteger(input.maximumCostCnyFen, 1, 1_000_000),
    validityDurationMs: safeInteger(input.validityDurationMs, 60_000, 86_400_000),
  })
}

export function mvpBenchmarkAuthorizationView(value, expected = {}) {
  const input = exactObject(value, AUTHORIZATION_KEYS)
  if (input.schemaVersion !== 'mvp-benchmark-external-authorization.v1'
    || input.requiredGpuClass !== 'rtx4090-24gb'
    || input.requiredEnvironmentSha256
      !== '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8'
    || input.liveEnvironmentCheck !== 'required-before-execution'
    || input.dataScope !== 'single-benchmark-session'
    || input.perItemAttemptLimit !== 1
    || input.instanceDisposition !== 'return-after-terminal-or-expiry') invalid()
  const sessionUid = uuid(input.sessionUid)
  const dramaUid = uuid(input.dramaUid)
  const sessionPlanSha256 = sha256(input.sessionPlanSha256)
  const connectionUid = uuid(input.connectionUid)
  const connectionEvidenceSha256 = sha256(input.connectionEvidenceSha256)
  const maximumCostCnyFen = safeInteger(input.maximumCostCnyFen, 1, 1_000_000)
  const authorizedAtEpochMs = safeInteger(input.authorizedAtEpochMs, 0, 253402300799999)
  const expiresAtEpochMs = safeInteger(input.expiresAtEpochMs, 0, 253402300799999)
  const validityDurationMs = expiresAtEpochMs - authorizedAtEpochMs
  if (validityDurationMs < 60_000 || validityDurationMs > 86_400_000
    || expected.sessionUid !== undefined && expected.sessionUid !== sessionUid
    || expected.dramaUid !== undefined && expected.dramaUid !== dramaUid
    || expected.sessionPlanSha256 !== undefined
      && expected.sessionPlanSha256 !== sessionPlanSha256
    || expected.connectionUid !== undefined && expected.connectionUid !== connectionUid
    || expected.connectionEvidenceSha256 !== undefined
      && expected.connectionEvidenceSha256 !== connectionEvidenceSha256
    || expected.maximumCostCnyFen !== undefined
      && expected.maximumCostCnyFen !== maximumCostCnyFen
    || expected.validityDurationMs !== undefined
      && expected.validityDurationMs !== validityDurationMs) invalid()
  return FREEZE({
    schemaVersion: 'mvp-benchmark-external-authorization.v1',
    uid: uuid(input.uid),
    sessionUid,
    dramaUid,
    sessionPlanSha256,
    connectionUid,
    connectionEvidenceSha256,
    requiredGpuClass: input.requiredGpuClass,
    requiredEnvironmentSha256: input.requiredEnvironmentSha256,
    liveEnvironmentCheck: input.liveEnvironmentCheck,
    maximumCostCnyFen,
    dataScope: input.dataScope,
    h3SubmissionLimit: safeInteger(input.h3SubmissionLimit, 4, 6),
    ttsSubmissionLimit: safeInteger(input.ttsSubmissionLimit, 1, 32),
    perItemAttemptLimit: input.perItemAttemptLimit,
    instanceDisposition: input.instanceDisposition,
    authorizedAtEpochMs,
    expiresAtEpochMs,
    authorizationSha256: sha256(input.authorizationSha256),
  })
}
