const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u

function fail() {
  throw new TypeError('Remote expert tunnel data is invalid')
}

function exactObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  let descriptors
  let prototype
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
    prototype = Object.getPrototypeOf(value)
  } catch {
    fail()
  }
  if (prototype !== Object.prototype && prototype !== null) fail()
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) fail()
  const output = Object.create(null)
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    output[key] = descriptor.value
  }
  return output
}

function uid(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail()
  return value
}

function loopbackOrigin(value) {
  if (typeof value !== 'string') fail()
  const match = LOOPBACK_ORIGIN.exec(value)
  const port = match ? Number(match[1]) : NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail()
  return value
}

export function expertTunnelView(value, expectedConnectionUid = undefined) {
  const input = exactObject(value, [
    'contractVersion', 'connectionUid', 'status', 'origin',
  ])
  if (input.contractVersion !== 'remote-expert-tunnel.v1' || input.status !== 'ready') fail()
  const connectionUid = uid(input.connectionUid)
  if (expectedConnectionUid !== undefined && connectionUid !== uid(expectedConnectionUid)) fail()
  return Object.freeze({
    contractVersion: input.contractVersion,
    connectionUid,
    status: input.status,
    origin: loopbackOrigin(input.origin),
  })
}

export function expertTunnelRequestPayload(value) {
  exactObject(value, [])
  return Object.freeze({})
}

export function expertTunnelClosedView(value, expectedConnectionUid = undefined) {
  const input = exactObject(value, ['contractVersion', 'connectionUid', 'status'])
  if (input.contractVersion !== 'remote-expert-tunnel.v1' || input.status !== 'closed') fail()
  const connectionUid = uid(input.connectionUid)
  if (expectedConnectionUid !== undefined && connectionUid !== uid(expectedConnectionUid)) fail()
  return Object.freeze({
    contractVersion: input.contractVersion,
    connectionUid,
    status: input.status,
  })
}
