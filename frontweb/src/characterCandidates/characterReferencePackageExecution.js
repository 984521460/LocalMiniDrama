import { characterReferencePackageView } from '../assets/characterReferencePackage.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const HISTORY_CURSOR = /^[0-9]{1,15}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const STATES = Object.freeze(['reserved', 'succeeded', 'failed', 'submission_unknown'])
const FAILURE_CODES = Object.freeze([
  'CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID',
  'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE',
  'CHARACTER_REFERENCE_PACKAGE_EXECUTION_CONFLICT',
  'CHARACTER_REFERENCE_PACKAGE_EXECUTION_DATA_INVALID',
])
const KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'dramaUid', 'characterUid',
  'candidateExecutionUid', 'candidateUid', 'width', 'height', 'seed',
])
const HISTORY_PAGE_KEYS = Object.freeze([
  'schemaVersion', 'dramaUid', 'characterUid', 'entries', 'nextCursor',
])
const HISTORY_ENTRY_KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'request', 'requestSha256',
  'candidateExecutionRequestSha256', 'candidateExecutionSourceSha256',
  'candidateContentSha256', 'state', 'packageUid', 'errorCode',
  'createdAtEpochMs', 'updatedAtEpochMs', 'candidateSourceCurrent',
  'packageCurrent', 'package',
])

function invalid(message) {
  throw new TypeError(message)
}

function exact(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(message)
  let prototype
  let descriptors
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    invalid(message)
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) invalid(message)
  const output = Object.create(null)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (!Object.hasOwn(descriptors, key)) invalid(message)
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(message)
    output[key] = descriptor.value
  }
  return output
}

function uid(value, message) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(message)
  return value
}

function hash(value, message) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(message)
  return value
}

function dense(value, maximum, message) {
  if (!Array.isArray(value)) invalid(message)
  let descriptors
  try { descriptors = Object.getOwnPropertyDescriptors(value) } catch { invalid(message) }
  if (!Object.hasOwn(descriptors, 'length')
    || !Object.hasOwn(descriptors.length, 'value')
    || !Number.isSafeInteger(descriptors.length.value)
    || descriptors.length.value < 0 || descriptors.length.value > maximum
    || Reflect.ownKeys(descriptors).length !== descriptors.length.value + 1) invalid(message)
  const output = []
  for (let index = 0; index < descriptors.length.value; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(message)
    output[index] = descriptor.value
  }
  return output
}

export function characterReferencePackageExecutionRequestView(value) {
  const message = 'Character reference package execution request is invalid'
  const input = exact(value, KEYS, message)
  if (input.schemaVersion !== 'character-reference-package-execution-request.v1'
    || !Number.isSafeInteger(input.width) || input.width < 256 || input.width > 2048
    || !Number.isSafeInteger(input.height) || input.height < 256 || input.height > 2048
    || input.width * input.height > 4_194_304
    || !Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 4_294_967_295) {
    invalid(message)
  }
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    operationUid: uid(input.operationUid, message),
    dramaUid: uid(input.dramaUid, message),
    characterUid: uid(input.characterUid, message),
    candidateExecutionUid: uid(input.candidateExecutionUid, message),
    candidateUid: uid(input.candidateUid, message),
    width: input.width,
    height: input.height,
    seed: input.seed,
  })
}

export function characterReferencePackageExecutionResponseView(value, expectedRequest) {
  const message = 'Character reference package execution response is invalid'
  const input = exact(value, ['package'], message)
  const view = characterReferencePackageView(input.package)
  if (expectedRequest !== undefined) {
    const request = characterReferencePackageExecutionRequestView(expectedRequest)
    if (view.packageUid !== request.operationUid
      || view.characterUid !== request.characterUid
      || view.candidateUid !== request.candidateUid) invalid(message)
  }
  return Object.freeze({ package: input.package, view })
}

export function characterReferencePackageExecutionHistoryPageView(value) {
  const message = 'Character reference package history response is invalid'
  const page = exact(value, HISTORY_PAGE_KEYS, message)
  if (page.schemaVersion !== 'character-reference-package-execution-history-page.v1') {
    invalid(message)
  }
  const dramaUid = uid(page.dramaUid, message)
  const characterUid = uid(page.characterUid, message)
  const rawEntries = dense(page.entries, 16, message)
  const entries = []
  let previous = null
  for (let index = 0; index < rawEntries.length; index += 1) {
    const raw = exact(rawEntries[index], HISTORY_ENTRY_KEYS, message)
    const request = characterReferencePackageExecutionRequestView(raw.request)
    if (raw.schemaVersion !== 'character-reference-package-execution-history-entry.v1'
      || raw.operationUid !== request.operationUid || request.dramaUid !== dramaUid
      || request.characterUid !== characterUid || !STATES.includes(raw.state)
      || typeof raw.candidateSourceCurrent !== 'boolean') invalid(message)
    const operationUid = uid(raw.operationUid, message)
    hash(raw.requestSha256, message)
    hash(raw.candidateExecutionRequestSha256, message)
    hash(raw.candidateExecutionSourceSha256, message)
    hash(raw.candidateContentSha256, message)
    if (!Number.isSafeInteger(raw.createdAtEpochMs) || raw.createdAtEpochMs < 0
      || raw.createdAtEpochMs > 253402300799999
      || !Number.isSafeInteger(raw.updatedAtEpochMs)
      || raw.updatedAtEpochMs < raw.createdAtEpochMs
      || raw.updatedAtEpochMs > 253402300799999) invalid(message)
    if (previous && (previous.createdAtEpochMs < raw.createdAtEpochMs
      || (previous.createdAtEpochMs === raw.createdAtEpochMs
        && previous.operationUid <= operationUid))) invalid(message)
    let packageView = null
    if (raw.state === 'succeeded') {
      if (raw.packageUid !== operationUid || raw.errorCode !== null
        || typeof raw.packageCurrent !== 'boolean' || raw.package === null) invalid(message)
      packageView = characterReferencePackageView(raw.package)
      if (packageView.packageUid !== operationUid
        || packageView.characterUid !== characterUid
        || packageView.candidateUid !== request.candidateUid
        || packageView.items.length !== 10) invalid(message)
    } else {
      if (raw.packageUid !== null || raw.packageCurrent !== null || raw.package !== null) invalid(message)
      if (raw.state === 'reserved' && raw.errorCode !== null) invalid(message)
      if (raw.state === 'failed' && !FAILURE_CODES.includes(raw.errorCode)) invalid(message)
      if (raw.state === 'submission_unknown'
        && raw.errorCode !== 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN') {
        invalid(message)
      }
    }
    const entry = Object.freeze({
      ...raw,
      operationUid,
      request,
      package: packageView,
      packageView,
    })
    entries[index] = entry
    previous = entry
  }
  if (page.nextCursor !== null) {
    if (typeof page.nextCursor !== 'string' || !HISTORY_CURSOR.test(page.nextCursor)
      || entries.length !== 16) invalid(message)
    const last = entries[entries.length - 1]
    if (page.nextCursor !== `${last.createdAtEpochMs}:${last.operationUid}`) invalid(message)
  }
  return Object.freeze({
    schemaVersion: page.schemaVersion,
    dramaUid,
    characterUid,
    entries: Object.freeze(entries),
    nextCursor: page.nextCursor,
  })
}

export function createCharacterReferencePackageExecutionRequest(value) {
  return characterReferencePackageExecutionRequestView({
    schemaVersion: 'character-reference-package-execution-request.v1',
    ...value,
  })
}
