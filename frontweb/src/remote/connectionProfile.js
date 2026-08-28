const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u
const USERNAME = /^[A-Za-z0-9._-]{1,64}$/u
const WORK_DIR = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u
const HOST_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const TIMESTAMP = /^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u
const STATUSES = new Set(['unverified', 'ready', 'changed', 'disabled', 'error'])
const MESSAGE = 'Remote connection value is invalid'

function fail() {
  throw new TypeError(MESSAGE)
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
    if (error instanceof TypeError && error.message === MESSAGE) throw error
    return fail()
  }
}

function denseArray(value, maximum, mapper) {
  let descriptors
  try {
    if (!Array.isArray(value)) fail()
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    return fail()
  }
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) fail()
  if (Reflect.ownKeys(descriptors).filter((key) => key !== 'length').length !== length) fail()
  return Object.freeze(Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    return mapper(descriptor.value)
  }))
}

function text(value, maximum) {
  if (typeof value !== 'string' || value !== value.trim() || value.includes('\0')) fail()
  let length = 0
  for (const _character of value) {
    length += 1
    if (length > maximum) fail()
  }
  if (length < 1) fail()
  return value
}

function uid(value) {
  if (typeof value !== 'string' || !UID.test(value)) fail()
  return value
}

function port(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) fail()
  return value
}

function host(value) {
  const candidate = text(value, 253).toLowerCase()
  if (/[\s\0/@\\?#\[\]]/u.test(candidate) || candidate.includes('://')) fail()
  if (/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/u.test(candidate)) return candidate
  const labels = candidate.split('.')
  if (labels.length < 2 || labels.some((label) => !HOST_LABEL.test(label))) fail()
  return candidate
}

function username(value) {
  if (typeof value !== 'string' || !USERNAME.test(value)) fail()
  return value
}

function workDir(value) {
  const candidate = text(value, 256)
  if (!WORK_DIR.test(candidate)
    || candidate.split('/').some((segment) => segment === '.' || segment === '..')) fail()
  return candidate
}

function stateVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) fail()
  return value
}

function environmentReport(value) {
  if (value === null) return null
  fail()
}

export function remoteConnectionView(value) {
  const input = exactObject(value, [
    'uid', 'name', 'host', 'port', 'username', 'hostFingerprint', 'status', 'createdAt',
    'updatedAt', 'authMethod', 'comfyHost', 'comfyPort', 'remoteWorkDir', 'environmentReport',
    'environmentCheckedAtEpochMs', 'stateVersion', 'connectionEvidenceSha256', 'credentialKind',
    'credentialConfigured',
  ])
  if (input.hostFingerprint !== null
    && (typeof input.hostFingerprint !== 'string' || !HOST_FINGERPRINT.test(input.hostFingerprint))) fail()
  if (!STATUSES.has(input.status)
    || typeof input.createdAt !== 'string' || !TIMESTAMP.test(input.createdAt)
    || typeof input.updatedAt !== 'string' || !TIMESTAMP.test(input.updatedAt)
    || input.authMethod !== 'password'
    || input.comfyHost !== '127.0.0.1'
    || typeof input.connectionEvidenceSha256 !== 'string'
    || !SHA256.test(input.connectionEvidenceSha256)
    || input.credentialKind !== 'ssh_password'
    || typeof input.credentialConfigured !== 'boolean') fail()
  return Object.freeze({
    uid: uid(input.uid),
    name: text(input.name, 120),
    host: host(input.host),
    port: port(input.port),
    username: username(input.username),
    hostFingerprint: input.hostFingerprint,
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    authMethod: input.authMethod,
    comfyHost: input.comfyHost,
    comfyPort: port(input.comfyPort),
    remoteWorkDir: workDir(input.remoteWorkDir),
    environmentReport: environmentReport(input.environmentReport),
    environmentCheckedAtEpochMs: input.environmentCheckedAtEpochMs === null
      ? null
      : fail(),
    stateVersion: stateVersion(input.stateVersion),
    connectionEvidenceSha256: input.connectionEvidenceSha256,
    credentialKind: input.credentialKind,
    credentialConfigured: input.credentialConfigured,
  })
}

export function remoteConnectionListView(value) {
  return denseArray(value, 100, remoteConnectionView)
}

export function remoteConnectionUidPath(value) {
  return uid(value)
}

export function remoteConnectionCreatePayload(value) {
  const input = exactObject(value, [
    'name', 'host', 'port', 'username', 'password', 'comfyPort', 'remoteWorkDir',
  ])
  const password = input.password
  if (typeof password !== 'string' || password.includes('\0') || password.length < 1 || password.length > 1024) fail()
  return Object.freeze({
    name: text(input.name, 120),
    host: host(input.host),
    port: port(input.port),
    username: username(input.username),
    authMethod: 'password',
    secret: password,
    comfyHost: '127.0.0.1',
    comfyPort: port(input.comfyPort),
    remoteWorkDir: workDir(input.remoteWorkDir),
  })
}

export function remoteConnectionUpdatePayload(record, value) {
  const current = remoteConnectionView(record)
  const input = exactObject(value, [
    'name', 'host', 'port', 'username', 'comfyPort', 'remoteWorkDir',
  ])
  return Object.freeze({
    expectedStateVersion: current.stateVersion,
    name: text(input.name, 120),
    host: host(input.host),
    port: port(input.port),
    username: username(input.username),
    comfyHost: '127.0.0.1',
    comfyPort: port(input.comfyPort),
    remoteWorkDir: workDir(input.remoteWorkDir),
  })
}

export function remoteCredentialReplacementPayload(record, password) {
  const current = remoteConnectionView(record)
  if (typeof password !== 'string' || password.includes('\0')) fail()
  let length = 0
  for (const _character of password) {
    length += 1
    if (length > 1024) fail()
  }
  if (length < 1) fail()
  return Object.freeze({
    expectedStateVersion: current.stateVersion,
    secret: password,
  })
}
