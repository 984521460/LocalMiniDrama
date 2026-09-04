import { mvpBenchmarkAuthorizationView } from './mvpAuthorization.js'
import { mvpBenchmarkPreflightBatchView } from './mvpPreflight.js'
import { mvpBenchmarkSessionView } from './mvpSession.js'
import { mediaExportRunView } from '../media/mediaExportRun.js'
import { parseStrictJson } from '../security/strictJson.js'

const {
  create: CREATE,
  freeze: FREEZE,
  getOwnPropertyDescriptors: GET_OWN_PROPERTY_DESCRIPTORS,
  getPrototypeOf: GET_PROTOTYPE_OF,
  hasOwn: HAS_OWN,
} = Object
const { isArray: IS_ARRAY } = Array
const { isSafeInteger: IS_SAFE_INTEGER } = Number
const { ownKeys: OWN_KEYS } = Reflect
const REFLECT_APPLY = Reflect.apply
const REGEXP_TEST = RegExp.prototype.test
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt
const STRING_TRIM = String.prototype.trim
const TEXT_ENCODER_ENCODE = TextEncoder.prototype.encode
const WEAK_SET_ADD = WeakSet.prototype.add
const WEAK_SET_HAS = WeakSet.prototype.has
const TRUSTED = new WeakSet()
const UTF8_ENCODER = new TextEncoder()
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const INVALID_NOTE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const REQUEST_KEYS = FREEZE([
  'videoPlaybackAccepted', 'subtitleSyncAccepted', 'bgmBalanceAccepted', 'reviewNote',
])
const KEYS = FREEZE([
  'schemaVersion', 'uid', 'sessionUid', 'authorizationUid', 'batchSha256',
  'dramaUid', 'workflowRunUid', 'exportRunUid', 'exportExecutionPlanSha256',
  'outputAssetUid', 'outputAssetVersionUid', 'outputSha256', 'outputBytes',
  'outputDurationMs', 'outputWidth', 'outputHeight', 'exportCompletedAtEpochMs',
  'videoPlaybackAccepted', 'subtitleSyncAccepted', 'bgmBalanceAccepted',
  'reviewNote', 'reviewedAtEpochMs', 'reviewSha256',
])

function invalid() {
  throw new TypeError('MVP benchmark human audiovisual review data is invalid')
}

function exactObject(value, keys = KEYS) {
  if (!value || typeof value !== 'object' || IS_ARRAY(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = GET_PROTOTYPE_OF(value)
    descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value)
  } catch {
    invalid()
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || OWN_KEYS(descriptors).length !== keys.length) invalid()
  const output = CREATE(null)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (!HAS_OWN(descriptors, key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !HAS_OWN(descriptor, 'value')) invalid()
    output[key] = descriptor.value
  }
  return output
}

function note(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048
    || REFLECT_APPLY(TEXT_ENCODER_ENCODE, UTF8_ENCODER, [value]).byteLength > 2048
    || REFLECT_APPLY(STRING_TRIM, value, []) !== value
    || !wellFormed(value)
    || REFLECT_APPLY(REGEXP_TEST, INVALID_NOTE, [value])) invalid()
  return value
}

function wellFormed(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index])
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const following = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index + 1])
      if (following < 0xdc00 || following > 0xdfff) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
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

function project(value, sessionValue, authorizationValue, batchValue, exportRunValue) {
  const session = mvpBenchmarkSessionView(sessionValue)
  const authorization = mvpBenchmarkAuthorizationView(authorizationValue, {
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    sessionPlanSha256: session.planSha256,
  })
  const batch = mvpBenchmarkPreflightBatchView(batchValue, session, authorization)
  const exportRun = mediaExportRunView(exportRunValue)
  const input = exactObject(value)
  const completedAtEpochMs = Date.parse(exportRun.completedAt)
  if (input.schemaVersion !== 'mvp-benchmark-human-av-review.v1'
    || uid(input.sessionUid) !== session.uid
    || uid(input.authorizationUid) !== authorization.uid
    || sha256(input.batchSha256) !== batch.batchSha256
    || uid(input.dramaUid) !== session.dramaUid
    || uid(input.workflowRunUid) !== session.workflowRunUid
    || uid(input.exportRunUid) !== exportRun.uid
    || sha256(input.exportExecutionPlanSha256) !== exportRun.executionPlanSha256
    || uid(input.outputAssetUid) !== exportRun.outputAssetUid
    || uid(input.outputAssetVersionUid) !== exportRun.outputAssetVersionUid
    || sha256(input.outputSha256) !== exportRun.output.sha256
    || integer(input.outputBytes, 1, 68719476736) !== exportRun.output.bytes
    || integer(input.outputDurationMs, 1, 3600100) !== exportRun.output.durationMs
    || input.outputWidth !== 1920 || input.outputWidth !== exportRun.output.width
    || input.outputHeight !== 1080 || input.outputHeight !== exportRun.output.height
    || integer(input.exportCompletedAtEpochMs, 0, 253402300799999) !== completedAtEpochMs
    || input.videoPlaybackAccepted !== true
    || input.subtitleSyncAccepted !== true
    || input.bgmBalanceAccepted !== true
    || note(input.reviewNote) !== input.reviewNote
    || integer(input.reviewedAtEpochMs, completedAtEpochMs, 253402300799999)
      < completedAtEpochMs) invalid()
  const result = FREEZE({
    schemaVersion: input.schemaVersion,
    uid: uid(input.uid),
    sessionUid: input.sessionUid,
    authorizationUid: input.authorizationUid,
    batchSha256: input.batchSha256,
    dramaUid: input.dramaUid,
    workflowRunUid: input.workflowRunUid,
    exportRunUid: input.exportRunUid,
    exportExecutionPlanSha256: input.exportExecutionPlanSha256,
    outputAssetUid: input.outputAssetUid,
    outputAssetVersionUid: input.outputAssetVersionUid,
    outputSha256: input.outputSha256,
    outputBytes: input.outputBytes,
    outputDurationMs: input.outputDurationMs,
    outputWidth: input.outputWidth,
    outputHeight: input.outputHeight,
    exportCompletedAtEpochMs: input.exportCompletedAtEpochMs,
    videoPlaybackAccepted: true,
    subtitleSyncAccepted: true,
    bgmBalanceAccepted: true,
    reviewNote: input.reviewNote,
    reviewedAtEpochMs: input.reviewedAtEpochMs,
    reviewSha256: sha256(input.reviewSha256),
  })
  REFLECT_APPLY(WEAK_SET_ADD, TRUSTED, [result])
  return result
}

export function parseMvpBenchmarkHumanAvReviewJson(
  text, session, authorization, batch, exportRun,
) {
  return project(parseStrictJson(text), session, authorization, batch, exportRun)
}

export function mvpBenchmarkHumanAvReviewSeed(value) {
  const input = exactObject(value, REQUEST_KEYS)
  if (input.videoPlaybackAccepted !== true
    || input.subtitleSyncAccepted !== true
    || input.bgmBalanceAccepted !== true) invalid()
  return FREEZE({
    videoPlaybackAccepted: true,
    subtitleSyncAccepted: true,
    bgmBalanceAccepted: true,
    reviewNote: note(input.reviewNote),
  })
}

export function mvpBenchmarkHumanAvReviewView(
  value, session, authorization, batch, exportRun,
) {
  if (!value || typeof value !== 'object'
    || !REFLECT_APPLY(WEAK_SET_HAS, TRUSTED, [value])) invalid()
  const expected = project(value, session, authorization, batch, exportRun)
  return expected
}
