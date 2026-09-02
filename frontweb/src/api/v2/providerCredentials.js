import { parseStrictJson } from '../../security/strictJson.js'
import {
  createProviderCredentialStoreRequest,
  providerCredentialCleanupErrorView,
  providerCredentialRefPath,
  providerCredentialRemovalView,
  providerCredentialView,
} from '../../security/providerCredential.js'
import { workflowJsonTextRequest } from './workflowRequest.js'

const trustedCleanupErrors = new WeakMap()

function dataProperty(value, name) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function cleanupViewFromTransportError(error) {
  const response = dataProperty(error, 'response')
  const text = dataProperty(response, 'data')
  if (typeof text !== 'string' || text.length < 1 || text.length > 4096) return null
  try {
    return providerCredentialCleanupErrorView(parseStrictJson(text))
  } catch {
    return null
  }
}

function cleanupError(view) {
  const error = new Error('Provider credential cleanup is required')
  trustedCleanupErrors.set(error, view)
  return error
}

export function cleanupRequiredFromError(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null
  return trustedCleanupErrors.get(error) ?? null
}

function parsed(operation, view) {
  return operation.then((text) => view(parseStrictJson(text)))
}

export const providerCredentialAPI = Object.freeze({
  async store(input) {
    try {
      return await parsed(
        workflowJsonTextRequest.post(
        '/v2/provider-credentials',
        createProviderCredentialStoreRequest(input),
      ),
        providerCredentialView,
      )
    } catch (error) {
      const cleanup = cleanupViewFromTransportError(error)
      if (cleanup !== null) throw cleanupError(cleanup)
      throw error
    }
  },

  inspect(ref) {
    return parsed(
      workflowJsonTextRequest.get(`/v2/provider-credentials/${providerCredentialRefPath(ref)}`),
      providerCredentialView,
    )
  },

  remove(ref) {
    return parsed(
      workflowJsonTextRequest.delete(`/v2/provider-credentials/${providerCredentialRefPath(ref)}`),
      providerCredentialRemovalView,
    )
  },
})
