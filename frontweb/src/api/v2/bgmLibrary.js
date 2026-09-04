import axios from 'axios'

import {
  parseBgmLibraryTrackJson,
  parseBgmLibraryTrackListJson,
} from '../../audio/bgmLibrary.js'
import { workflowUidPath } from '../../security/workflowBoundary.js'
import {
  workflowJsonTextRequest,
  workflowSuccessEnvelopeDataJsonText,
} from './workflowRequest.js'

const multipartTransport = axios.create({
  baseURL: '/api/v1',
  timeout: 600000,
  responseType: 'text',
  transformResponse: [(value) => value],
  maxBodyLength: 32 * 1024 * 1024 + 4096,
  maxContentLength: 1024 * 1024,
})

function responseText(response) {
  let descriptor
  try {
    descriptor = response && Object.getOwnPropertyDescriptor(response, 'data')
  } catch {
    throw new Error('BGM library request failed')
  }
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
    || typeof descriptor.value !== 'string') throw new Error('BGM library request failed')
  return workflowSuccessEnvelopeDataJsonText(descriptor.value)
}

function dramaPath(value) {
  return encodeURIComponent(workflowUidPath(value))
}

function importInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('BGM import request is invalid')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = ['file', 'title', 'licenseBasis', 'commercialUseAllowed', 'derivativesAllowed']
  if (Reflect.ownKeys(descriptors).length !== keys.length) {
    throw new TypeError('BGM import request is invalid')
  }
  const output = Object.create(null)
  for (let index = 0; index < keys.length; index += 1) {
    if (!Object.hasOwn(descriptors, keys[index])) {
      throw new TypeError('BGM import request is invalid')
    }
    const descriptor = descriptors[keys[index]]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('BGM import request is invalid')
    }
    output[keys[index]] = descriptor.value
  }
  if (!output.file || typeof output.file !== 'object'
    || typeof output.title !== 'string'
    || typeof output.licenseBasis !== 'string'
    || typeof output.commercialUseAllowed !== 'boolean'
    || typeof output.derivativesAllowed !== 'boolean') {
    throw new TypeError('BGM import request is invalid')
  }
  return output
}

export const bgmLibraryAPI = Object.freeze({
  async list(dramaUidValue) {
    const dramaUid = workflowUidPath(dramaUidValue)
    const text = await workflowJsonTextRequest.get(`/v2/dramas/${dramaPath(dramaUid)}/bgm-tracks`)
    return parseBgmLibraryTrackListJson(text, dramaUid)
  },
  async importTrack(dramaUidValue, input) {
    const dramaUid = workflowUidPath(dramaUidValue)
    const request = importInput(input)
    const form = new FormData()
    form.append('title', request.title)
    form.append('license_basis', request.licenseBasis)
    form.append('commercial_use_allowed', request.commercialUseAllowed ? 'true' : 'false')
    form.append('derivatives_allowed', request.derivativesAllowed ? 'true' : 'false')
    form.append('file', request.file)
    const text = responseText(await multipartTransport.post(
      `/v2/dramas/${dramaPath(dramaUid)}/bgm-tracks`, form,
    ))
    return parseBgmLibraryTrackJson(text, dramaUid)
  },
})
