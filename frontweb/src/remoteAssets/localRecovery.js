const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA = /^[0-9a-f]{64}$/u
const RECORD_KEYS = Object.freeze([
  'uid', 'dramaUid', 'characterUid', 'packageSha256', 'sourceManifestSha256',
  'remoteTaskUid', 'characterName', 'quarantineStatus', 'sourceCurrent', 'createdAt', 'items',
])
const ITEM_KEYS = Object.freeze([
  'ordinal', 'assetUid', 'assetVersionUid', 'logicalUri', 'relativePath', 'sha256',
  'byteLength', 'width', 'height', 'originalName', 'originalSha256',
])

function invalid() {
  throw new TypeError('Local recovery package response is invalid')
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Reflect.ownKeys(descriptors)
  if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid()
  const output = Object.create(null)
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    output[key] = descriptor.value
  }
  return output
}

function dense(value, maximum) {
  if (!Array.isArray(value)) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum
    || Reflect.ownKeys(descriptors).length !== length + 1) invalid()
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    return descriptor.value
  })
}

function uid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid()
  return value
}

function sha(value) {
  if (typeof value !== 'string' || !SHA.test(value)) invalid()
  return value
}

export function localRecoveryPackageRecordView(value, expectedCharacterUid) {
  const input = exact(value, RECORD_KEYS)
  const recordUid = uid(input.uid)
  const dramaUid = uid(input.dramaUid)
  const characterUid = uid(input.characterUid)
  if (expectedCharacterUid !== undefined && characterUid !== uid(expectedCharacterUid)) invalid()
  if (input.quarantineStatus !== 'unapproved' || typeof input.sourceCurrent !== 'boolean'
    || typeof input.characterName !== 'string' || input.characterName.length < 1
    || input.characterName.length > 1024
    || typeof input.createdAt !== 'string' || input.createdAt.length < 20
    || input.createdAt.length > 40) invalid()
  const packageSha256 = sha(input.packageSha256)
  const sourceManifestSha256 = sha(input.sourceManifestSha256)
  const remoteTaskUid = uid(input.remoteTaskUid)
  const rawItems = dense(input.items, 16)
  if (rawItems.length < 1) invalid()
  const items = rawItems.map((value, ordinal) => {
    const item = exact(value, ITEM_KEYS)
    const relativePath = `characters/${characterUid}/local-recoveries/${recordUid}/${ordinal}.png`
    if (item.ordinal !== ordinal || item.relativePath !== relativePath
      || item.logicalUri !== `asset://${relativePath}`
      || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1
      || item.byteLength > 16 * 1024 * 1024
      || !Number.isSafeInteger(item.width) || item.width < 1 || item.width > 2048
      || !Number.isSafeInteger(item.height) || item.height < 1 || item.height > 2048
      || typeof item.originalName !== 'string' || item.originalName.length < 1
      || item.originalName.length > 128) invalid()
    uid(item.assetUid); uid(item.assetVersionUid); sha(item.sha256); sha(item.originalSha256)
    return Object.freeze({ ...item })
  })
  return Object.freeze({
    ...input,
    uid: recordUid,
    dramaUid,
    characterUid,
    packageSha256,
    sourceManifestSha256,
    remoteTaskUid,
    items: Object.freeze(items),
  })
}

export function localRecoveryPackageResponseView(value, expectedCharacterUid) {
  const input = exact(value, ['record'])
  return Object.freeze({
    record: localRecoveryPackageRecordView(input.record, expectedCharacterUid),
  })
}

export function localRecoveryPackageListView(value, expectedCharacterUid) {
  const input = exact(value, ['records'])
  const records = dense(input.records, 50).map((record) => (
    localRecoveryPackageRecordView(record, expectedCharacterUid)
  ))
  return Object.freeze({ records: Object.freeze(records) })
}
