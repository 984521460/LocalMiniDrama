import axios from 'axios'
import { parseStrictJson } from '../../security/strictJson.js'

const workflowRequest = axios.create({
  baseURL: '/api/v1',
  timeout: 600000,
  headers: { 'Content-Type': 'application/json' },
})

const workflowJsonTextTransport = axios.create({
  baseURL: '/api/v1',
  timeout: 600000,
  headers: { 'Content-Type': 'application/json' },
  responseType: 'text',
  transformResponse: [(value) => value],
})

const JSON_STRINGIFY = JSON.stringify

function invalid() {
  throw new Error('Workflow request failed')
}

function hasExpectedKey(expectedKeys, candidate) {
  for (let index = 0; index < expectedKeys.length; index += 1) {
    if (expectedKeys[index] === candidate) return true
  }
  return false
}

function exactEnvelope(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const expectedKeys = ['success', 'data', 'timestamp']
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== expectedKeys.length) invalid()
  const output = Object.create(null)
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index]
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    output[key] = descriptor.value
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] !== 'string' || !hasExpectedKey(expectedKeys, keys[index])) invalid()
  }
  return output
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) invalid()
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) invalid()
}

function inertJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid()
    return value
  }
  if (Array.isArray(value)) {
    const output = new Array(value.length)
    Object.defineProperty(output, 'toJSON', { value: undefined })
    for (let index = 0; index < value.length; index += 1) output[index] = inertJson(value[index])
    return output
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  const output = Object.create(null)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    const descriptor = descriptors[key]
    if (typeof key !== 'string' || !descriptor?.enumerable
      || !Object.hasOwn(descriptor, 'value')) invalid()
    Object.defineProperty(output, key, {
      configurable: true, enumerable: true, writable: true,
      value: inertJson(descriptor.value),
    })
  }
  return output
}

export function workflowSuccessEnvelopeDataJsonText(text) {
  if (typeof text !== 'string' || text.length > 1048576) invalid()
  let parsed
  try {
    parsed = parseStrictJson(text)
  } catch {
    invalid()
  }
  const envelope = exactEnvelope(parsed)
  if (envelope.success !== true) invalid()
  canonicalTimestamp(envelope.timestamp)
  const data = Reflect.apply(JSON_STRINGIFY, JSON, [inertJson(envelope.data)])
  if (typeof data !== 'string' || data.length > 1048576) invalid()
  return data
}

function dataJsonText(response) {
  let descriptor
  try {
    descriptor = response && Object.getOwnPropertyDescriptor(response, 'data')
  } catch {
    invalid()
  }
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
  return workflowSuccessEnvelopeDataJsonText(descriptor.value)
}

export const workflowJsonTextRequest = Object.freeze({
  async get(url) {
    return dataJsonText(await workflowJsonTextTransport.get(url))
  },
  async post(url, input) {
    return dataJsonText(await workflowJsonTextTransport.post(url, input))
  },
  async delete(url) {
    return dataJsonText(await workflowJsonTextTransport.delete(url))
  },
})

workflowRequest.interceptors.response.use((response) => {
  const body = response.data
  if (body?.success === true && Object.hasOwn(body, 'data')) return body.data
  const error = new Error('Workflow request failed')
  error.response = response
  return Promise.reject(error)
}, (error) => Promise.reject(error))

export default workflowRequest
