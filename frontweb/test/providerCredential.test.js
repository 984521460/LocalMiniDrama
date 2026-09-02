import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createProviderCredentialStoreRequest,
  providerCredentialCleanupErrorView,
  providerCredentialCleanupView,
  providerCredentialRefPath,
  providerCredentialRemovalView,
  providerCredentialView,
} from '../src/security/providerCredential.js'

const directory = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(directory, '../src')
const ref = 'credential:v1:00000000-0000-4000-8000-000000000901'
const secret = 'synthetic-provider-secret-value'

test('provider credential frontend contract is exact and secret-free', () => {
  assert.deepEqual(createProviderCredentialStoreRequest({ kind: 'api_key', secret }), {
    kind: 'api_key', secret,
  })
  assert.deepEqual(createProviderCredentialStoreRequest({ kind: 'provider_token', secret }), {
    kind: 'provider_token', secret,
  })
  assert.throws(() => createProviderCredentialStoreRequest({ kind: 'ssh_password', secret }))
  assert.throws(() => createProviderCredentialStoreRequest({ kind: 'api_key', secret, extra: true }))
  assert.equal(createProviderCredentialStoreRequest({
    kind: 'api_key', secret: '😀'.repeat(640),
  }).secret.length, 1280)
  assert.throws(() => createProviderCredentialStoreRequest({
    kind: 'api_key', secret: '😀'.repeat(641),
  }))

  const view = providerCredentialView({
    schemaVersion: 'provider-credential.v1', ref, kind: 'api_key', configured: true,
  })
  assert.equal(view.ref, ref)
  assert.equal(view.configured, true)
  assert.equal('secret' in view, false)
  assert.throws(() => providerCredentialView({ ...view, secret }))
  assert.deepEqual(providerCredentialRemovalView({
    schemaVersion: 'provider-credential-removal.v1', ref, removed: true,
  }), { schemaVersion: 'provider-credential-removal.v1', ref, removed: true })
  assert.deepEqual(providerCredentialCleanupView({
    schemaVersion: 'provider-credential-cleanup.v1', ref, cleanupRequired: true,
  }), { schemaVersion: 'provider-credential-cleanup.v1', ref, cleanupRequired: true })
  assert.deepEqual(providerCredentialCleanupErrorView({
    success: false,
    error: {
      code: 'PROVIDER_CREDENTIAL_CLEANUP_REQUIRED',
      message: 'Provider credential storage outcome requires cleanup',
      details: { schemaVersion: 'provider-credential-cleanup.v1', ref, cleanupRequired: true },
    },
    timestamp: '2026-09-02T00:00:00.000Z',
  }), { schemaVersion: 'provider-credential-cleanup.v1', ref, cleanupRequired: true })
  assert.equal(providerCredentialRefPath(ref), encodeURIComponent(ref))
})

test('provider credential frontend rejects accessors without reading them', () => {
  let reads = 0
  const hostile = {}
  Object.defineProperty(hostile, 'kind', {
    enumerable: true,
    get() { reads += 1; return 'api_key' },
  })
  Object.defineProperty(hostile, 'secret', {
    enumerable: true,
    get() { reads += 1; return secret },
  })
  assert.throws(() => createProviderCredentialStoreRequest(hostile))
  assert.equal(reads, 0)
})

test('AI configuration page exposes a dedicated provider credential panel', () => {
  const page = fs.readFileSync(path.join(sourceRoot, 'views/AiConfig.vue'), 'utf8')
  const panel = fs.readFileSync(path.join(
    sourceRoot, 'components/ProviderCredentialPanel.vue',
  ), 'utf8')
  const api = fs.readFileSync(path.join(sourceRoot, 'api/v2/providerCredentials.js'), 'utf8')
  assert.match(page, /ProviderCredentialPanel/u)
  assert.match(panel, /Provider 凭据/u)
  assert.match(panel, /type="password"/u)
  assert.match(panel, /credentialRef/u)
  assert.match(panel, /确认移除/u)
  assert.match(panel, /cleanupRequiredFromError/u)
  assert.match(panel, /存储结果无法确认/u)
  assert.doesNotMatch(panel, /localStorage|sessionStorage/u)
  assert.match(api, /workflowJsonTextRequest/u)
  assert.match(api, /providerCredentialView/u)
})
