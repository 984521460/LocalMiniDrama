export const CHARACTER_REFERENCE_ITEM_KINDS = Object.freeze([
  'front_half_body',
  'three_quarter_face',
  'left_profile',
  'right_profile',
  'front_full_body',
  'expression_neutral',
  'expression_joy',
  'expression_anger',
  'expression_sadness',
  'expression_fear',
])

const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const COLOR = /^#[0-9a-f]{6}$/u
const LABELS = Object.freeze({
  front_half_body: '正面半身',
  three_quarter_face: '脸部四分之三侧',
  left_profile: '左侧面',
  right_profile: '右侧面',
  front_full_body: '正面全身',
  expression_neutral: '中性表情',
  expression_joy: '喜悦',
  expression_anger: '愤怒',
  expression_sadness: '悲伤',
  expression_fear: '恐惧',
})

function fail(message) {
  throw new TypeError(message)
}

function exactObject(value, expectedKeys, message) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(message)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) fail(message)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (
      keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    ) fail(message)
    const result = Object.create(null)
    for (const key of expectedKeys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(message)
      result[key] = descriptor.value
    }
    return result
  } catch (error) {
    if (error instanceof TypeError && error.message === message) throw error
    fail(message)
  }
}

function denseArray(value, expectedLength, mapper, message) {
  let descriptors
  try {
    if (!Array.isArray(value)) fail(message)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail(message)
  }
  if (descriptors.length?.value !== expectedLength) fail(message)
  if (Reflect.ownKeys(descriptors).filter((key) => key !== 'length').length !== expectedLength) {
    fail(message)
  }
  return Object.freeze(Array.from({ length: expectedLength }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(message)
    return mapper(descriptor.value, index)
  }))
}

function canonicalUid(value, message) {
  if (typeof value !== 'string' || !UID.test(value)) fail(message)
  return value
}

function boundedText(value, maxLength, message) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.includes('\0')
  ) fail(message)
  let length = 0
  for (const _character of value) {
    length += 1
    if (length > maxLength) fail(message)
  }
  if (length < 1) fail(message)
  return value
}

function colors(value, message) {
  let descriptors
  try {
    if (!Array.isArray(value)) fail(message)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail(message)
  }
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > 16) fail(message)
  if (Reflect.ownKeys(descriptors).filter((key) => key !== 'length').length !== length) fail(message)
  return Object.freeze(Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(message)
    const entry = descriptor.value
    if (typeof entry !== 'string' || !COLOR.test(entry)) fail(message)
    return entry
  }))
}

function visualVersion(value, message) {
  const input = exactObject(value, ['uid', 'name', 'description', 'colorAnchors'], message)
  const colorAnchors = colors(input.colorAnchors, message)
  if (colorAnchors.length > 16 || new Set(colorAnchors).size !== colorAnchors.length) fail(message)
  return Object.freeze({
    uid: canonicalUid(input.uid, message),
    name: boundedText(input.name, 120, message),
    description: boundedText(input.description, 4000, message),
    colorAnchors,
  })
}

export function characterUidPath(value) {
  return canonicalUid(value, 'Character uid is invalid')
}

export function characterReferencePackageRequest(value) {
  const message = 'Character reference package request is invalid'
  const input = exactObject(value, [
    'appearanceVersionUid',
    'costumeVersionUid',
    'expectedLockStateVersion',
    'items',
  ], message)
  if (!Number.isSafeInteger(input.expectedLockStateVersion) || input.expectedLockStateVersion < 1) {
    fail(message)
  }
  const items = denseArray(input.items, CHARACTER_REFERENCE_ITEM_KINDS.length, (item, ordinal) => {
    const entry = exactObject(item, ['kind', 'assetVersionUid'], message)
    if (entry.kind !== CHARACTER_REFERENCE_ITEM_KINDS[ordinal]) fail(message)
    return Object.freeze({
      kind: entry.kind,
      asset_version_uid: canonicalUid(entry.assetVersionUid, message),
    })
  }, message)
  if (new Set(items.map((item) => item.asset_version_uid)).size !== items.length) fail(message)
  return Object.freeze({
    appearance_version_uid: canonicalUid(input.appearanceVersionUid, message),
    costume_version_uid: canonicalUid(input.costumeVersionUid, message),
    expected_lock_state_version: input.expectedLockStateVersion,
    items,
  })
}

export function characterReferencePackageView(value) {
  const message = 'Character reference package response is invalid'
  const input = exactObject(value, [
    'schemaVersion',
    'packageUid',
    'characterUid',
    'identityVersionUid',
    'candidateUid',
    'lockEventUid',
    'lockStateVersion',
    'appearanceVersion',
    'defaultCostumeVersion',
    'items',
    'createdAtEpochMs',
  ], message)
  if (
    input.schemaVersion !== '5.0'
    || !Number.isSafeInteger(input.lockStateVersion)
    || input.lockStateVersion < 1
    || !Number.isSafeInteger(input.createdAtEpochMs)
    || input.createdAtEpochMs < 0
    || input.createdAtEpochMs > 253402300799999
  ) fail(message)
  const packageUid = canonicalUid(input.packageUid, message)
  const characterUid = canonicalUid(input.characterUid, message)
  const items = denseArray(input.items, CHARACTER_REFERENCE_ITEM_KINDS.length, (item, ordinal) => {
    const entry = exactObject(item, [
      'uid', 'ordinal', 'kind', 'assetVersionUid', 'logicalUri',
      'mediaType', 'width', 'height', 'contentSha256',
    ], message)
    const kind = CHARACTER_REFERENCE_ITEM_KINDS[ordinal]
    if (
      entry.ordinal !== ordinal
      || entry.kind !== kind
      || entry.logicalUri !== `asset://characters/${characterUid}/reference-packages/${packageUid}/${kind}`
      || !['image/png', 'image/jpeg', 'image/webp'].includes(entry.mediaType)
      || !Number.isSafeInteger(entry.width)
      || entry.width < 64
      || entry.width > 8192
      || !Number.isSafeInteger(entry.height)
      || entry.height < 64
      || entry.height > 8192
      || typeof entry.contentSha256 !== 'string'
      || !SHA256.test(entry.contentSha256)
    ) fail(message)
    return Object.freeze({
      uid: canonicalUid(entry.uid, message),
      ordinal,
      kind,
      label: LABELS[kind],
      assetVersionUid: canonicalUid(entry.assetVersionUid, message),
      logicalUri: entry.logicalUri,
      mediaType: entry.mediaType,
      dimensions: `${entry.width} × ${entry.height}`,
      contentSha256: entry.contentSha256,
    })
  }, message)
  if (
    new Set(items.map((item) => item.uid)).size !== items.length
    || new Set(items.map((item) => item.assetVersionUid)).size !== items.length
    || new Set(items.map((item) => item.contentSha256)).size !== items.length
  ) fail(message)
  return Object.freeze({
    title: `角色参考包 #${input.lockStateVersion}`,
    packageUid,
    characterUid,
    identityVersionUid: canonicalUid(input.identityVersionUid, message),
    candidateUid: canonicalUid(input.candidateUid, message),
    lockEventUid: canonicalUid(input.lockEventUid, message),
    lockStateVersion: input.lockStateVersion,
    appearance: visualVersion(input.appearanceVersion, message),
    defaultCostume: visualVersion(input.defaultCostumeVersion, message),
    items,
    createdAtEpochMs: input.createdAtEpochMs,
  })
}
