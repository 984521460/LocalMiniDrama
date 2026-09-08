const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const FACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u
const STATES = new Set(['reserved', 'succeeded', 'failed', 'submission_unknown'])
const FAILURE_CODES = new Set([
  'REMOTE_ASSET_RECOVERY_SOURCE_STALE',
  'REMOTE_ASSET_RECOVERY_MANIFEST_INVALID',
  'REMOTE_ASSET_RECOVERY_OUTPUT_INVALID',
  'REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE',
])
const REQUEST_KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'dramaUid', 'characterUid', 'extractionResultUid',
  'characterFactId', 'connectionUid', 'connectionEvidenceSha256', 'remoteTaskUid',
])
const SOURCE_KEYS = Object.freeze([
  'schemaVersion', 'dramaUid', 'characterUid', 'characterName', 'characterDescription',
  'characterPersonality', 'characterAppearance', 'sourceSelectionUid',
  'extractionResultUid', 'extractionResultHash', 'extractionEnvelopeHash',
  'extractionApprovalRef', 'characterFactId', 'characterFactName',
  'characterFactDescription',
])
const MANIFEST_KEYS = Object.freeze([
  'schemaVersion', 'remoteTaskUid', 'sourceFormat', 'sourceManifestSha256', 'items',
])
const MANIFEST_ITEM_KEYS = Object.freeze([
  'ordinal', 'remoteRelativePath', 'remoteSha256', 'width', 'height',
])
const ITEM_KEYS = Object.freeze([
  'ordinal', 'remoteRelativePath', 'remoteSha256', 'remoteByteLength', 'assetUid',
  'assetVersionUid', 'logicalUri', 'relativePath', 'contentSha256', 'byteLength',
  'width', 'height', 'createdAtEpochMs',
])
const RECOVERY_KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'requestSha256', 'request', 'sourceSha256', 'source',
  'state', 'quarantineStatus', 'manifestSha256', 'manifest', 'itemCount', 'errorCode',
  'createdAtEpochMs', 'updatedAtEpochMs', 'items',
])

function invalid(message = 'Remote asset recovery data is invalid') {
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
  const ownKeys = Reflect.ownKeys(descriptors)
  if ((prototype !== Object.prototype && prototype !== null)
    || ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid(message)
  const output = Object.create(null)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(message)
    output[key] = descriptor.value
  }
  return output
}

function dense(value, maximum, message) {
  if (!Array.isArray(value)) invalid(message)
  let descriptors
  try { descriptors = Object.getOwnPropertyDescriptors(value) } catch { invalid(message) }
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum
    || Reflect.ownKeys(descriptors).length !== length + 1) invalid(message)
  const result = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(message)
    result[index] = descriptor.value
  }
  return result
}

function uid(value, message) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(message)
  return value
}

function hash(value, message) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(message)
  return value
}

function integer(value, minimum, maximum, message) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(message)
  return value
}

export function remoteAssetRecoveryRequestView(value) {
  const message = 'Remote asset recovery request is invalid'
  const input = exact(value, REQUEST_KEYS, message)
  if (input.schemaVersion !== 'remote-asset-recovery-request.v1'
    || typeof input.characterFactId !== 'string' || !FACT_ID.test(input.characterFactId)) {
    invalid(message)
  }
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    operationUid: uid(input.operationUid, message),
    dramaUid: uid(input.dramaUid, message),
    characterUid: uid(input.characterUid, message),
    extractionResultUid: uid(input.extractionResultUid, message),
    characterFactId: input.characterFactId,
    connectionUid: uid(input.connectionUid, message),
    connectionEvidenceSha256: hash(input.connectionEvidenceSha256, message),
    remoteTaskUid: uid(input.remoteTaskUid, message),
  })
}

function sourceView(value, request) {
  const input = exact(value, SOURCE_KEYS)
  if (input.schemaVersion !== 'character-candidate-source.v1'
    || input.dramaUid !== request.dramaUid || input.characterUid !== request.characterUid
    || input.extractionResultUid !== request.extractionResultUid
    || input.characterFactId !== request.characterFactId
    || typeof input.characterName !== 'string' || input.characterName.length < 1
    || typeof input.characterFactName !== 'string'
    || typeof input.characterFactDescription !== 'string'
    || !/^review:v1:[0-9a-f-]{36}$/u.test(input.extractionApprovalRef)) invalid()
  uid(input.sourceSelectionUid); hash(input.extractionResultHash); hash(input.extractionEnvelopeHash)
  for (const key of ['characterDescription', 'characterPersonality', 'characterAppearance']) {
    if (input[key] !== null && typeof input[key] !== 'string') invalid()
  }
  return Object.freeze({ ...input })
}

function manifestView(value, request) {
  const input = exact(value, MANIFEST_KEYS)
  if (input.schemaVersion !== 'remote-asset-recovery-manifest.v1'
    || input.remoteTaskUid !== request.remoteTaskUid
    || !['standard.v1', 'legacy.character-candidates.v1'].includes(input.sourceFormat)) invalid()
  hash(input.sourceManifestSha256)
  const raw = dense(input.items, 16)
  if (raw.length < 1) invalid()
  const items = raw.map((value, ordinal) => {
    const item = exact(value, MANIFEST_ITEM_KEYS)
    if (item.ordinal !== ordinal || typeof item.remoteRelativePath !== 'string'
      || item.remoteRelativePath.length < 1 || item.remoteRelativePath.length > 1024) invalid()
    hash(item.remoteSha256)
    integer(item.width, 256, 2048); integer(item.height, 256, 2048)
    return Object.freeze({ ...item })
  })
  return Object.freeze({ ...input, items: Object.freeze(items) })
}

function recoveryView(value) {
  const input = exact(value, RECOVERY_KEYS)
  const request = remoteAssetRecoveryRequestView(input.request)
  if (input.schemaVersion !== 'remote-asset-recovery.v1'
    || input.operationUid !== request.operationUid || !STATES.has(input.state)
    || input.quarantineStatus !== 'unapproved') invalid()
  hash(input.requestSha256); hash(input.sourceSha256)
  const source = sourceView(input.source, request)
  const createdAtEpochMs = integer(input.createdAtEpochMs, 0, 253402300799999)
  const updatedAtEpochMs = integer(input.updatedAtEpochMs, createdAtEpochMs, 253402300799999)
  const rawItems = dense(input.items, 16)
  let manifest = null
  const items = []
  if (input.state === 'succeeded') {
    hash(input.manifestSha256)
    manifest = manifestView(input.manifest, request)
    if (input.itemCount !== rawItems.length || input.itemCount !== manifest.items.length
      || input.errorCode !== null || input.itemCount < 1) invalid()
    for (let ordinal = 0; ordinal < rawItems.length; ordinal += 1) {
      const item = exact(rawItems[ordinal], ITEM_KEYS)
      const expected = manifest.items[ordinal]
      const expectedUri = `asset://characters/${request.characterUid}/remote-recoveries/${request.operationUid}/${ordinal}`
      const expectedPath = `characters/${request.characterUid}/remote-recoveries/${request.operationUid}/${ordinal}.png`
      if (item.ordinal !== ordinal || item.remoteRelativePath !== expected.remoteRelativePath
        || item.remoteSha256 !== expected.remoteSha256 || item.width !== expected.width
        || item.height !== expected.height || item.logicalUri !== expectedUri
        || item.relativePath !== expectedPath) invalid()
      uid(item.assetUid); uid(item.assetVersionUid); hash(item.contentSha256)
      integer(item.remoteByteLength, 1, 16 * 1024 * 1024)
      integer(item.byteLength, 1, 16 * 1024 * 1024)
      integer(item.createdAtEpochMs, 0, 253402300799999)
      items[ordinal] = Object.freeze({ ...item })
    }
  } else if (input.manifestSha256 !== null || input.manifest !== null
    || input.itemCount !== null || rawItems.length !== 0) invalid()
  if (input.state === 'reserved' && input.errorCode !== null) invalid()
  if (input.state === 'failed' && !FAILURE_CODES.has(input.errorCode)) invalid()
  if (input.state === 'submission_unknown'
    && input.errorCode !== 'REMOTE_ASSET_RECOVERY_SUBMISSION_UNKNOWN') invalid()
  return Object.freeze({
    ...input,
    request,
    source,
    manifest,
    items: Object.freeze(items),
    createdAtEpochMs,
    updatedAtEpochMs,
  })
}

export function remoteAssetRecoveryResponseView(value) {
  const input = exact(value, ['recovery'])
  return Object.freeze({ recovery: recoveryView(input.recovery) })
}

export function remoteAssetRecoveryListView(value) {
  const input = exact(value, ['schemaVersion', 'dramaUid', 'characterUid', 'recoveries'])
  if (input.schemaVersion !== 'remote-asset-recovery-list.v1') invalid()
  const dramaUid = uid(input.dramaUid)
  const characterUid = uid(input.characterUid)
  const raw = dense(input.recoveries, 50)
  const recoveries = raw.map((item) => recoveryView(item))
  if (recoveries.some((item) => (
    item.request.dramaUid !== dramaUid || item.request.characterUid !== characterUid
  ))) invalid()
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    dramaUid,
    characterUid,
    recoveries: Object.freeze(recoveries),
  })
}

export function createRemoteAssetRecoveryRequest(value) {
  return remoteAssetRecoveryRequestView({
    schemaVersion: 'remote-asset-recovery-request.v1',
    ...value,
  })
}
