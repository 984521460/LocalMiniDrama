const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u
const ALGORITHMS = new Set([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'rsa-sha2-256',
  'rsa-sha2-512',
  'ssh-rsa',
])
const STATUSES = new Set(['pending', 'confirmed'])

function fail() {
  throw new TypeError('Remote host identity value is invalid')
}

function exactObject(value, expectedKeys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) fail()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) fail()
    const output = Object.create(null)
    for (const key of expectedKeys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
      output[key] = descriptor.value
    }
    return output
  } catch (error) {
    if (error instanceof TypeError && error.message === 'Remote host identity value is invalid') throw error
    return fail()
  }
}

function stateVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) fail()
  return value
}

function fingerprint(value) {
  if (typeof value !== 'string' || !FINGERPRINT.test(value)) fail()
  return value
}

export function hostIdentityProbeView(value) {
  const input = exactObject(value, [
    'connectionUid',
    'algorithm',
    'fingerprint',
    'stateVersion',
    'requiresConfirmation',
    'status',
  ])
  if (typeof input.connectionUid !== 'string' || !UID.test(input.connectionUid)
    || typeof input.algorithm !== 'string' || !ALGORITHMS.has(input.algorithm)
    || typeof input.requiresConfirmation !== 'boolean' || !STATUSES.has(input.status)
    || input.requiresConfirmation !== (input.status === 'pending')) fail()
  return Object.freeze({
    connectionUid: input.connectionUid,
    algorithm: input.algorithm,
    fingerprint: fingerprint(input.fingerprint),
    stateVersion: stateVersion(input.stateVersion),
    requiresConfirmation: input.requiresConfirmation,
    status: input.status,
  })
}

export function hostIdentityConfirmationPayload(candidate) {
  const input = hostIdentityProbeView(candidate)
  return Object.freeze({
    expectedStateVersion: input.stateVersion,
    fingerprint: input.fingerprint,
  })
}
