import { StorageContractError } from './errors.js'

const MAX_SEGMENTS = 64
const MAX_SEGMENT_LENGTH = 128
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

function invalid(field: string): never {
  throw new StorageContractError('STORAGE_VALUE_INVALID', field)
}

export function validateProviderId(value: unknown, field = 'storageProvider'): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) invalid(field)
  return value
}

function validateSegment(value: unknown, field: string, filesystem: boolean): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_SEGMENT_LENGTH
    || value === '.'
    || value === '..'
    || !SAFE_SEGMENT.test(value)
    || value.endsWith('.')
    || value.endsWith(' ')
  ) invalid(field)

  if (filesystem) {
    const baseName = value.split('.')[0]
    if (baseName && WINDOWS_RESERVED_NAME.test(baseName)) invalid(field)
  }
  return value
}

export function readSegmentArray(value: unknown, field: string, filesystem: boolean): readonly string[] {
  if (!Array.isArray(value)) invalid(field)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  const length = lengthDescriptor?.value
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_SEGMENTS) invalid(field)

  const allowedKeys = new Set<PropertyKey>(['length'])
  const snapshot: string[] = []
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    allowedKeys.add(key)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) invalid(field)
    snapshot.push(validateSegment(descriptor.value, `${field}[${index}]`, filesystem))
  }
  for (const key of Reflect.ownKeys(value)) {
    if (!allowedKeys.has(key)) invalid(field)
  }
  return Object.freeze(snapshot)
}

export function readExactDataObject(
  value: unknown,
  requiredFields: readonly string[],
  optionalFields: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(field)

  const allowed = new Set([...requiredFields, ...optionalFields])
  const snapshot: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new StorageContractError('STORAGE_FIELD_UNSUPPORTED', field)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) invalid(`${field}.${key}`)
    snapshot[key] = descriptor.value
  }
  for (const key of requiredFields) {
    if (!Object.hasOwn(snapshot, key)) invalid(`${field}.${key}`)
  }
  return Object.freeze(snapshot)
}

export function validateLogicalSegments(value: unknown, field: string): readonly string[] {
  return readSegmentArray(value, field, false)
}

export function validateFilesystemSegments(value: unknown, field: string): readonly string[] {
  return readSegmentArray(value, field, true)
}
