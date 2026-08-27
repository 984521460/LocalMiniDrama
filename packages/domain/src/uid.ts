declare const uidBrand: unique symbol

/**
 * A UUID whose type parameter identifies the domain entity it belongs to.
 * The brand is compile-time only; persisted and transported values stay strings.
 */
export type Uid<TKind extends string = string> = string & {
  readonly [uidBrand]: TKind
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UID_ERROR_MESSAGE = 'UID must be a valid RFC UUID string'

/** Returns true only for non-nil RFC UUID strings. */
export function isUid<TKind extends string = string>(value: unknown): value is Uid<TKind> {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/** Validates an external UID and returns its canonical lowercase representation. */
export function parseUid<TKind extends string = string>(value: unknown): Uid<TKind> {
  if (!isUid<TKind>(value)) {
    throw new TypeError(UID_ERROR_MESSAGE)
  }

  return value.toLowerCase() as Uid<TKind>
}

/** Creates a canonical UUID v4 UID using the platform cryptographic generator. */
export function createUid<TKind extends string = string>(): Uid<TKind> {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi || typeof cryptoApi.randomUUID !== 'function') {
    throw new Error('A cryptographic randomUUID implementation is required')
  }

  return parseUid<TKind>(cryptoApi.randomUUID())
}
