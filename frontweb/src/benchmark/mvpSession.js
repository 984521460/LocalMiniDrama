const {
  defineProperty: DEFINE_PROPERTY,
  freeze: FREEZE,
  getOwnPropertyDescriptors: GET_OWN_PROPERTY_DESCRIPTORS,
  getPrototypeOf: GET_PROTOTYPE_OF,
  hasOwn: HAS_OWN,
} = Object
const { isArray: IS_ARRAY } = Array
const { ownKeys: OWN_KEYS } = Reflect
const REGEXP_TEST = RegExp.prototype.test
const SET_ADD = Set.prototype.add
const SET_CONSTRUCTOR = Set
const SET_HAS = Set.prototype.has
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const ROOT_KEYS = FREEZE([
  'schemaVersion', 'uid', 'dramaUid', 'workflowRunUid', 'workflowUid',
  'graphHash', 'graphRevision', 'h3Tasks', 'audioIntents', 'planSha256',
  'createdAtEpochMs',
])
const H3_KEYS = FREEZE([
  'taskUid', 'intentUid', 'nodeRunUid', 'nodeUid', 'assetUid', 'manifestUid',
  'generationSpecSha256', 'planEvidenceSha256',
])
const AUDIO_KEYS = FREEZE(['intentUid', 'nodeRunUid', 'nodeUid', 'planSha256'])
const ERROR_MESSAGE = 'MVP benchmark session data is invalid'

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
  const result = Object.create(null)
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index]
    if (!HAS_OWN(descriptors, key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !HAS_OWN(descriptor, 'value')) invalid()
    result[key] = descriptor.value
  }
  for (let index = 0; index < actualKeys.length; index += 1) {
    if (typeof actualKeys[index] !== 'string' || !HAS_OWN(result, actualKeys[index])) invalid()
  }
  return result
}

function denseArray(value, minimum, maximum) {
  if (!IS_ARRAY(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = GET_PROTOTYPE_OF(value)
    descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value)
  } catch {
    invalid()
  }
  const length = descriptors.length?.value
  if (prototype !== Array.prototype || !Number.isSafeInteger(length)
    || length < minimum || length > maximum || OWN_KEYS(descriptors).length !== length + 1) invalid()
  const result = []
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    if (!HAS_OWN(descriptors, key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !HAS_OWN(descriptor, 'value')) invalid()
    append(result, descriptor.value)
  }
  return result
}

function uuid(value) {
  if (typeof value !== 'string' || !Reflect.apply(REGEXP_TEST, UUID_V4, [value])) invalid()
  return value
}

function sha256(value) {
  if (typeof value !== 'string' || !Reflect.apply(REGEXP_TEST, SHA256, [value])) invalid()
  return value
}

function safeEpoch(value) {
  if (!Reflect.apply(NUMBER_IS_SAFE_INTEGER, Number, [value])
    || value < 0 || value > 253402300799999) invalid()
  return value
}

function addUnique(set, value) {
  if (Reflect.apply(SET_HAS, set, [value])) invalid()
  Reflect.apply(SET_ADD, set, [value])
  return value
}

function h3Items(value, identities) {
  const source = denseArray(value, 4, 6)
  const result = []
  for (let index = 0; index < source.length; index += 1) {
    const item = exactObject(source[index], H3_KEYS)
    append(result, FREEZE({
      taskUid: addUnique(identities.taskUids, uuid(item.taskUid)),
      intentUid: addUnique(identities.intentUids, uuid(item.intentUid)),
      nodeRunUid: addUnique(identities.nodeRunUids, uuid(item.nodeRunUid)),
      nodeUid: addUnique(identities.nodeUids, uuid(item.nodeUid)),
      assetUid: uuid(item.assetUid),
      manifestUid: uuid(item.manifestUid),
      generationSpecSha256: sha256(item.generationSpecSha256),
      planEvidenceSha256: sha256(item.planEvidenceSha256),
    }))
  }
  return FREEZE(result)
}

function audioItems(value, identities) {
  const source = denseArray(value, 1, 32)
  const result = []
  for (let index = 0; index < source.length; index += 1) {
    const item = exactObject(source[index], AUDIO_KEYS)
    append(result, FREEZE({
      intentUid: addUnique(identities.intentUids, uuid(item.intentUid)),
      nodeRunUid: addUnique(identities.nodeRunUids, uuid(item.nodeRunUid)),
      nodeUid: addUnique(identities.nodeUids, uuid(item.nodeUid)),
      planSha256: sha256(item.planSha256),
    }))
  }
  return FREEZE(result)
}

export function mvpBenchmarkSessionView(value, expected = {}) {
  const input = exactObject(value, ROOT_KEYS)
  if (input.schemaVersion !== 'mvp-benchmark-session-plan.v1') invalid()
  const dramaUid = uuid(input.dramaUid)
  const workflowRunUid = uuid(input.workflowRunUid)
  if (expected.dramaUid !== undefined && dramaUid !== expected.dramaUid) invalid()
  if (expected.workflowRunUid !== undefined && workflowRunUid !== expected.workflowRunUid) invalid()
  const identities = {
    taskUids: new SET_CONSTRUCTOR(), intentUids: new SET_CONSTRUCTOR(),
    nodeRunUids: new SET_CONSTRUCTOR(), nodeUids: new SET_CONSTRUCTOR(),
  }
  const h3Tasks = h3Items(input.h3Tasks, identities)
  const audioIntents = audioItems(input.audioIntents, identities)
  return FREEZE({
    schemaVersion: 'mvp-benchmark-session-plan.v1',
    uid: uuid(input.uid),
    dramaUid,
    workflowRunUid,
    workflowUid: uuid(input.workflowUid),
    graphHash: sha256(input.graphHash),
    graphRevision: safeEpoch(input.graphRevision),
    h3Tasks,
    audioIntents,
    planSha256: sha256(input.planSha256),
    createdAtEpochMs: safeEpoch(input.createdAtEpochMs),
  })
}
