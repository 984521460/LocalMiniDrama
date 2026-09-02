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

function dataJsonText(response) {
  const text = response?.data
  if (typeof text !== 'string' || text.length > 1048576) {
    throw new Error('Workflow request failed')
  }
  let envelope
  try {
    envelope = parseStrictJson(text)
  } catch {
    throw new Error('Workflow request failed')
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.getPrototypeOf(envelope) !== Object.prototype
    || Object.keys(envelope).length !== 2
    || !Object.hasOwn(envelope, 'success') || envelope.success !== true
    || !Object.hasOwn(envelope, 'data')) {
    throw new Error('Workflow request failed')
  }
  const data = JSON.stringify(envelope.data)
  if (typeof data !== 'string' || data.length > 1048576) {
    throw new Error('Workflow request failed')
  }
  return data
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
