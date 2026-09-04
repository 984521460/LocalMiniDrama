import { parseStrictJson } from '../security/strictJson.js'

const {
  create: CREATE,
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
const STRING_NORMALIZE = String.prototype.normalize
const STRING_TRIM = String.prototype.trim
const WEAK_SET_ADD = WeakSet.prototype.add
const WEAK_SET_HAS = WeakSet.prototype.has
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger
const ARRAY_PROTOTYPE = Array.prototype
const OBJECT_PROTOTYPE = Object.prototype
const SET_ADD = Set.prototype.add
const SET_HAS = Set.prototype.has
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const TITLE = /^(?:[\p{L}\p{N}]|[\p{L}\p{N}](?:[\p{L}\p{N} ._()'&-]{0,254}[\p{L}\p{N}._()'&-]))$/u
const MIME_TYPES = FREEZE(['audio/aac', 'audio/flac', 'audio/mpeg', 'audio/wav', 'audio/x-wav'])
const LICENSE_BASES = FREEZE(['user-owned', 'licensed', 'public-domain', 'provider-grant'])
const TRACK_KEYS = FREEZE([
  'schemaVersion', 'uid', 'dramaUid', 'title', 'mimeType', 'durationMs',
  'license', 'exportEligible', 'createdAtEpochMs',
])
const LICENSE_KEYS = FREEZE(['basis', 'commercialUseAllowed', 'derivativesAllowed'])
const TRUSTED_TRACKS = new WeakSet()
const TRUSTED_LISTS = new WeakSet()
const ERROR_MESSAGE = 'BGM library data is invalid'

function invalid() {
  throw new TypeError(ERROR_MESSAGE)
}

function includes(values, expected) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true
  }
  return false
}

function append(target, value) {
  REFLECT_APPLY(DEFINE_PROPERTY, Object, [target, String(target.length), {
    configurable: true, enumerable: true, writable: true, value,
  }])
}

function exactObject(value, expectedKeys) {
  if (!value || typeof value !== 'object' || IS_ARRAY(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = REFLECT_APPLY(GET_PROTOTYPE_OF, Object, [value])
    descriptors = REFLECT_APPLY(GET_OWN_PROPERTY_DESCRIPTORS, Object, [value])
  } catch {
    invalid()
  }
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) invalid()
  const actualKeys = REFLECT_APPLY(OWN_KEYS, Reflect, [descriptors])
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

function denseArray(value, maximum) {
  if (!IS_ARRAY(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = REFLECT_APPLY(GET_PROTOTYPE_OF, Object, [value])
    descriptors = REFLECT_APPLY(GET_OWN_PROPERTY_DESCRIPTORS, Object, [value])
  } catch {
    invalid()
  }
  if (!HAS_OWN(descriptors, 'length')) invalid()
  const lengthDescriptor = descriptors.length
  if (!HAS_OWN(lengthDescriptor, 'value')) invalid()
  const length = lengthDescriptor.value
  if (prototype !== ARRAY_PROTOTYPE
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [length])
    || length < 0 || length > maximum
    || REFLECT_APPLY(OWN_KEYS, Reflect, [descriptors]).length !== length + 1) invalid()
  const output = []
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    if (!HAS_OWN(descriptors, key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !HAS_OWN(descriptor, 'value')) invalid()
    append(output, descriptor.value)
  }
  return output
}

function uid(value) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, UUID, [value])) invalid()
  return value
}

function integer(value, minimum, maximum) {
  if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [value])
    || value < minimum || value > maximum) invalid()
  return value
}

function projectTrack(value, expectedDramaUid) {
  const expectedDrama = uid(expectedDramaUid)
  const input = exactObject(value, TRACK_KEYS)
  const licenseInput = exactObject(input.license, LICENSE_KEYS)
  if (input.schemaVersion !== 'bgm-library-track.v1'
    || uid(input.dramaUid) !== expectedDrama
    || !includes(MIME_TYPES, input.mimeType)
    || !includes(LICENSE_BASES, licenseInput.basis)
    || typeof input.exportEligible !== 'boolean'
    || typeof licenseInput.commercialUseAllowed !== 'boolean'
    || typeof licenseInput.derivativesAllowed !== 'boolean'
    || input.exportEligible !== (
      licenseInput.commercialUseAllowed && licenseInput.derivativesAllowed
    )
    || typeof input.title !== 'string' || input.title.length < 1 || input.title.length > 256
    || input.title !== REFLECT_APPLY(STRING_TRIM, input.title, [])
    || input.title !== REFLECT_APPLY(STRING_NORMALIZE, input.title, ['NFC'])
    || !REFLECT_APPLY(REGEXP_TEST, TITLE, [input.title])) invalid()
  const result = FREEZE({
    schemaVersion: input.schemaVersion,
    uid: uid(input.uid),
    dramaUid: expectedDrama,
    title: input.title,
    mimeType: input.mimeType,
    durationMs: integer(input.durationMs, 1, 3_600_000),
    license: FREEZE({
      basis: licenseInput.basis,
      commercialUseAllowed: licenseInput.commercialUseAllowed,
      derivativesAllowed: licenseInput.derivativesAllowed,
    }),
    exportEligible: input.exportEligible,
    createdAtEpochMs: integer(input.createdAtEpochMs, 0, 253_402_300_799_999),
  })
  REFLECT_APPLY(WEAK_SET_ADD, TRUSTED_TRACKS, [result])
  return result
}

export function parseBgmLibraryTrackJson(text, expectedDramaUid) {
  return projectTrack(parseStrictJson(text, 1_048_576), expectedDramaUid)
}

export function parseBgmLibraryTrackListJson(text, expectedDramaUid) {
  const input = denseArray(parseStrictJson(text, 1_048_576), 2048)
  const output = []
  const seen = new Set()
  for (let index = 0; index < input.length; index += 1) {
    const track = projectTrack(input[index], expectedDramaUid)
    if (REFLECT_APPLY(SET_HAS, seen, [track.uid])) invalid()
    REFLECT_APPLY(SET_ADD, seen, [track.uid])
    append(output, track)
  }
  FREEZE(output)
  REFLECT_APPLY(WEAK_SET_ADD, TRUSTED_LISTS, [output])
  return output
}

export function bgmLibraryTrackView(value, expectedDramaUid) {
  if (!value || typeof value !== 'object'
    || !REFLECT_APPLY(WEAK_SET_HAS, TRUSTED_TRACKS, [value])
    || value.dramaUid !== uid(expectedDramaUid)) invalid()
  return value
}

export function bgmLibraryTrackListView(value, expectedDramaUid) {
  if (!value || typeof value !== 'object'
    || !REFLECT_APPLY(WEAK_SET_HAS, TRUSTED_LISTS, [value])) invalid()
  const dramaUid = uid(expectedDramaUid)
  for (let index = 0; index < value.length; index += 1) {
    if (value[index].dramaUid !== dramaUid) invalid()
  }
  return value
}
