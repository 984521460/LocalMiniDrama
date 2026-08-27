import {
  CONTRACT_ERROR_CODES,
  createContractError,
  isCanonicalContractError,
  toContractError,
  type ContractError,
  type ContractErrorCode,
} from './contract-errors.js'

export const CONTRACT_SCHEMA_VERSION = '1.0.0' as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface SuccessResult<TValue extends JsonValue = JsonValue> {
  readonly schema_version: typeof CONTRACT_SCHEMA_VERSION
  readonly ok: true
  readonly value: TValue
}

export interface FailureResult {
  readonly schema_version: typeof CONTRACT_SCHEMA_VERSION
  readonly ok: false
  readonly error: ContractError
}

export type ResultEnvelope<TValue extends JsonValue = JsonValue> = SuccessResult<TValue> | FailureResult

export type ResultParseOutcome =
  | { readonly ok: true; readonly value: ResultEnvelope }
  | { readonly ok: false; readonly error: ContractError }

const INVALID_JSON_VALUE = Symbol('INVALID_JSON_VALUE')

function createJsonSnapshotInternal(
  value: unknown,
  ancestors: Set<object>,
): JsonValue | typeof INVALID_JSON_VALUE {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : INVALID_JSON_VALUE
  }
  if (typeof value !== 'object') {
    return INVALID_JSON_VALUE
  }
  if (ancestors.has(value)) {
    return INVALID_JSON_VALUE
  }

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return INVALID_JSON_VALUE
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
      if (
        !lengthDescriptor
        || lengthDescriptor.enumerable
        || lengthDescriptor.configurable
        || !('value' in lengthDescriptor)
        || !Number.isInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > 0xffff_ffff
      ) {
        return INVALID_JSON_VALUE
      }
      const arrayLength = lengthDescriptor.value as number
      const keys = Reflect.ownKeys(value)
      if (
        keys.length !== arrayLength + 1
        || !keys.every((key) => key === 'length' || (
          typeof key === 'string'
          && /^(0|[1-9][0-9]*)$/.test(key)
          && Number(key) < arrayLength
        ))
      ) {
        return INVALID_JSON_VALUE
      }

      const snapshot: JsonValue[] = []
      for (let index = 0; index < arrayLength; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          return INVALID_JSON_VALUE
        }
        const itemSnapshot = createJsonSnapshotInternal(descriptor.value, ancestors)
        if (itemSnapshot === INVALID_JSON_VALUE) {
          return INVALID_JSON_VALUE
        }
        snapshot.push(itemSnapshot)
      }
      return Object.freeze(snapshot)
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return INVALID_JSON_VALUE
    }

    const keys = Reflect.ownKeys(value)
    if (!keys.every((key): key is string => typeof key === 'string')) {
      return INVALID_JSON_VALUE
    }

    const snapshot = Object.create(prototype) as Record<string, JsonValue>
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        return INVALID_JSON_VALUE
      }
      const propertySnapshot = createJsonSnapshotInternal(descriptor.value, ancestors)
      if (propertySnapshot === INVALID_JSON_VALUE) {
        return INVALID_JSON_VALUE
      }
      Object.defineProperty(snapshot, key, {
        value: propertySnapshot,
        enumerable: true,
        writable: false,
        configurable: false,
      })
    }
    return Object.freeze(snapshot)
  } catch {
    return INVALID_JSON_VALUE
  } finally {
    ancestors.delete(value)
  }
}

export function isJsonValue(value: unknown): value is JsonValue {
  return createJsonSnapshotInternal(value, new Set<object>()) !== INVALID_JSON_VALUE
}

export function isCompatibleResultSchemaVersion(
  value: unknown,
): value is typeof CONTRACT_SCHEMA_VERSION {
  return value === CONTRACT_SCHEMA_VERSION
}

export function createSuccessResult<TValue extends JsonValue>(value: TValue): SuccessResult<TValue> {
  const snapshot = createJsonSnapshotInternal(value, new Set<object>())
  if (snapshot === INVALID_JSON_VALUE) {
    throw new TypeError('Result value must be JSON-compatible')
  }

  return Object.freeze({
    schema_version: CONTRACT_SCHEMA_VERSION,
    ok: true,
    value: snapshot as TValue,
  })
}

export function createFailureResult(code: ContractErrorCode): FailureResult {
  return Object.freeze({
    schema_version: CONTRACT_SCHEMA_VERSION,
    ok: false,
    error: createContractError(code),
  })
}

export function createFailureResultFromUnknown(
  error: unknown,
  fallbackCode: ContractErrorCode = CONTRACT_ERROR_CODES.INTERNAL_ERROR,
): FailureResult {
  return Object.freeze({
    schema_version: CONTRACT_SCHEMA_VERSION,
    ok: false,
    error: toContractError(error, fallbackCode),
  })
}

function getExactDataValues(
  value: object,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length
    || !keys.every((key) => typeof key === 'string' && expectedKeys.includes(key))
  ) {
    return null
  }

  const descriptors = Object.getOwnPropertyDescriptors(value)
  const values: Record<string, unknown> = Object.create(null)
  for (const key of expectedKeys) {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      return null
    }
    values[key] = descriptor.value
  }
  return values
}

function getOwnDataValue(value: object, key: string): unknown | typeof INVALID_JSON_VALUE {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor?.enumerable && 'value' in descriptor
    ? descriptor.value
    : INVALID_JSON_VALUE
}

function parseFailure(code: ContractErrorCode): ResultParseOutcome {
  return { ok: false, error: createContractError(code) }
}

/**
 * Parses an untrusted transport value without throwing or accepting forward versions.
 * Payload-specific validation remains the responsibility of the versioned task Schema.
 */
export function parseResultEnvelope(value: unknown): ResultParseOutcome {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return parseFailure(CONTRACT_ERROR_CODES.SCHEMA_VALIDATION_FAILED)
    }

    const record = value as Record<string, unknown>
    const schemaVersion = getOwnDataValue(record, 'schema_version')
    if (typeof schemaVersion !== 'string') {
      return parseFailure(CONTRACT_ERROR_CODES.SCHEMA_VALIDATION_FAILED)
    }
    if (!isCompatibleResultSchemaVersion(schemaVersion)) {
      return parseFailure(CONTRACT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION)
    }

    const okValue = getOwnDataValue(record, 'ok')
    if (okValue === true) {
      const values = getExactDataValues(record, ['schema_version', 'ok', 'value'])
      if (values?.schema_version !== CONTRACT_SCHEMA_VERSION || values.ok !== true) {
        return parseFailure(CONTRACT_ERROR_CODES.SCHEMA_VALIDATION_FAILED)
      }
      return { ok: true, value: createSuccessResult(values.value as JsonValue) }
    }

    if (okValue === false) {
      const values = getExactDataValues(record, ['schema_version', 'ok', 'error'])
      if (
        values?.schema_version !== CONTRACT_SCHEMA_VERSION
        || values.ok !== false
        || !isCanonicalContractError(values.error)
      ) {
        return parseFailure(CONTRACT_ERROR_CODES.SCHEMA_VALIDATION_FAILED)
      }
      return { ok: true, value: createFailureResult(values.error.code) }
    }

    return parseFailure(CONTRACT_ERROR_CODES.SCHEMA_VALIDATION_FAILED)
  } catch {
    return parseFailure(CONTRACT_ERROR_CODES.SCHEMA_VALIDATION_FAILED)
  }
}
