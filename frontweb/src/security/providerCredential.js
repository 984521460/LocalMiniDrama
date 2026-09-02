const CREDENTIAL_REF = /^credential:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_SECRET_UTF16_UNITS = 2560

function invalid() {
  throw new TypeError('Provider credential data is invalid')
}

function includes(values, expected) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true
  }
  return false
}

function exactObject(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    invalid()
  }
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== expectedKeys.length) invalid()
  const output = Object.create(null)
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] !== 'string' || !includes(expectedKeys, keys[index])) invalid()
  }
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index]
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    output[key] = descriptor.value
  }
  return output
}

function providerKind(value) {
  if (value !== 'api_key' && value !== 'provider_token') invalid()
  return value
}

function credentialRef(value) {
  if (typeof value !== 'string' || value.length !== 50 || !CREDENTIAL_REF.test(value)) invalid()
  return value
}

function utf8Bytes(value) {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return -1
      bytes += 4
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return -1
    } else if (unit <= 0x7f) {
      bytes += 1
    } else if (unit <= 0x7ff) {
      bytes += 2
    } else {
      bytes += 3
    }
    if (bytes > MAX_SECRET_UTF16_UNITS) return bytes
  }
  return bytes
}

export function createProviderCredentialStoreRequest(value) {
  const input = exactObject(value, ['kind', 'secret'])
  if (typeof input.secret !== 'string' || input.secret.length < 1
    || input.secret.length > MAX_SECRET_UTF16_UNITS || input.secret.includes('\0')
    || input.secret.trim().length === 0 || utf8Bytes(input.secret) < 1
    || utf8Bytes(input.secret) > MAX_SECRET_UTF16_UNITS) invalid()
  return Object.freeze({ kind: providerKind(input.kind), secret: input.secret })
}

export function providerCredentialView(value) {
  const input = exactObject(value, ['schemaVersion', 'ref', 'kind', 'configured'])
  if (input.schemaVersion !== 'provider-credential.v1' || input.configured !== true) invalid()
  return Object.freeze({
    schemaVersion: 'provider-credential.v1',
    ref: credentialRef(input.ref),
    kind: providerKind(input.kind),
    configured: true,
  })
}

export function providerCredentialRemovalView(value) {
  const input = exactObject(value, ['schemaVersion', 'ref', 'removed'])
  if (input.schemaVersion !== 'provider-credential-removal.v1' || input.removed !== true) invalid()
  return Object.freeze({
    schemaVersion: 'provider-credential-removal.v1',
    ref: credentialRef(input.ref),
    removed: true,
  })
}

export function providerCredentialCleanupView(value) {
  const input = exactObject(value, ['schemaVersion', 'ref', 'cleanupRequired'])
  if (input.schemaVersion !== 'provider-credential-cleanup.v1' || input.cleanupRequired !== true) {
    invalid()
  }
  return Object.freeze({
    schemaVersion: 'provider-credential-cleanup.v1',
    ref: credentialRef(input.ref),
    cleanupRequired: true,
  })
}

export function providerCredentialCleanupErrorView(value) {
  const envelope = exactObject(value, ['success', 'error', 'timestamp'])
  if (envelope.success !== false || typeof envelope.timestamp !== 'string'
    || envelope.timestamp.length < 20 || envelope.timestamp.length > 32) invalid()
  const error = exactObject(envelope.error, ['code', 'message', 'details'])
  if (error.code !== 'PROVIDER_CREDENTIAL_CLEANUP_REQUIRED'
    || error.message !== 'Provider credential storage outcome requires cleanup') invalid()
  return providerCredentialCleanupView(error.details)
}

export function providerCredentialRefPath(value) {
  return encodeURIComponent(credentialRef(value))
}
