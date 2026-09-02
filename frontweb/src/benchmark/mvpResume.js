import { mvpBenchmarkAuthorizationView } from './mvpAuthorization.js'
import {
  parseMvpBenchmarkProductionExecutionProgressJson,
} from './mvpExecution.js'
import { parseMvpBenchmarkPreflightBatchJson } from './mvpPreflight.js'
import { mvpBenchmarkSessionView } from './mvpSession.js'
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
const REGEXP_TEST = RegExp.prototype.test
const WEAK_SET_ADD = WeakSet.prototype.add
const WEAK_SET_HAS = WeakSet.prototype.has
const TRUSTED_SNAPSHOTS = new WeakSet()
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const ROOT_KEYS = FREEZE([
  'schemaVersion', 'dramaUid', 'workflowRunUid', 'state',
  'sessionJson', 'authorizationJson', 'batchJson', 'progressJson',
])
const MAX_JSON_LENGTH = 1048576
const ERROR_MESSAGE = 'MVP benchmark resume data is invalid'

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

function uid(value) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, UUID_V4, [value])) invalid()
  return value
}

function nestedJson(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > MAX_JSON_LENGTH) invalid()
  return value
}

function project(value, expected = {}) {
  const input = exactObject(value, ROOT_KEYS)
  const dramaUid = uid(input.dramaUid)
  const workflowRunUid = uid(input.workflowRunUid)
  if (input.schemaVersion !== 'mvp-benchmark-resume-snapshot.v1'
    || expected.dramaUid !== undefined && expected.dramaUid !== dramaUid
    || expected.workflowRunUid !== undefined && expected.workflowRunUid !== workflowRunUid) invalid()

  let session = null
  let authorization = null
  let batch = null
  let progress = null
  if (input.state === 'empty') {
    if (input.sessionJson !== null || input.authorizationJson !== null
      || input.batchJson !== null || input.progressJson !== null) invalid()
  } else {
    session = mvpBenchmarkSessionView(parseStrictJson(nestedJson(input.sessionJson)), {
      dramaUid,
      workflowRunUid,
    })
    if (input.state === 'session') {
      if (input.authorizationJson !== null || input.batchJson !== null
        || input.progressJson !== null) invalid()
    } else {
      authorization = mvpBenchmarkAuthorizationView(
        parseStrictJson(nestedJson(input.authorizationJson)),
        {
          dramaUid,
          sessionUid: session.uid,
          sessionPlanSha256: session.planSha256,
        },
      )
      if (input.state === 'authorization') {
        if (input.batchJson !== null || input.progressJson !== null) invalid()
      } else if (input.state === 'execution') {
        batch = parseMvpBenchmarkPreflightBatchJson(
          nestedJson(input.batchJson), session, authorization,
        )
        progress = parseMvpBenchmarkProductionExecutionProgressJson(
          nestedJson(input.progressJson), session, authorization, batch,
        )
      } else {
        invalid()
      }
    }
  }

  const output = FREEZE({
    schemaVersion: 'mvp-benchmark-resume-snapshot.v1',
    dramaUid,
    workflowRunUid,
    state: input.state,
    session,
    authorization,
    batch,
    progress,
  })
  REFLECT_APPLY(WEAK_SET_ADD, TRUSTED_SNAPSHOTS, [output])
  return output
}

export function parseMvpBenchmarkResumeSnapshotJson(text, expected = {}) {
  return project(parseStrictJson(text), expected)
}

export function mvpBenchmarkResumeSnapshotView(value, expected = {}) {
  if (!value || typeof value !== 'object'
    || !REFLECT_APPLY(WEAK_SET_HAS, TRUSTED_SNAPSHOTS, [value])) invalid()
  if (expected.dramaUid !== undefined && value.dramaUid !== expected.dramaUid) invalid()
  if (expected.workflowRunUid !== undefined
    && value.workflowRunUid !== expected.workflowRunUid) invalid()
  return value
}
