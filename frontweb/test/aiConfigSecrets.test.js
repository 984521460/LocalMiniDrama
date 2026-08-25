import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAiConfigMutationPayload,
  buildSavedConfigRequest,
  createEditSecretState,
  isSecretConfigured,
} from '../src/security/aiConfigSecrets.js'

test('edit state keeps secret inputs blank and retains configured metadata', () => {
  const row = {
    id: 3,
    api_key_configured: true,
    configured_secret_fields: ['api_key', 'settings.kling_secret_key'],
  }
  assert.deepEqual(createEditSecretState(row), {
    api_key: '',
    api_key_configured: true,
    configured_secret_fields: ['api_key', 'settings.kling_secret_key'],
  })
  assert.equal(isSecretConfigured(row, 'api_key'), true)
  assert.equal(isSecretConfigured(row, 'settings.kling_secret_key'), true)
});

test('mutation payload omits blank and mask placeholder secrets without dropping normal settings', () => {
  const payload = buildAiConfigMutationPayload({
    name: 'updated',
    api_key: '   ',
    settings: JSON.stringify({
      kling_access_key: '********',
      kling_secret_key: '',
      kling_secret_key_base64: true,
      nested: { token: '<redacted>', mode: 'fast' },
    }),
  })
  const settings = JSON.parse(payload.settings)
  assert.equal('api_key' in payload, false)
  assert.equal('kling_access_key' in settings, false)
  assert.equal('kling_secret_key' in settings, false)
  assert.equal('token' in settings.nested, false)
  assert.equal(settings.kling_secret_key_base64, true)
  assert.equal(settings.nested.mode, 'fast')

  const replacement = buildAiConfigMutationPayload({ api_key: 'new-key', settings: { token: 'new-token' } })
  assert.equal(replacement.api_key, 'new-key')
  assert.equal(replacement.settings.token, 'new-token')
});

test('saved test and asset requests use config_id plus operation inputs only', () => {
  const rowRequest = buildSavedConfigRequest(12, {
    base_url: 'https://example.invalid/v1',
    api_key: '',
    provider: 'openai',
    settings: { access_key_id: '', timeout: 15 },
  })
  assert.deepEqual(rowRequest, {
    config_id: 12,
  })

  const override = buildSavedConfigRequest(12, {
    api_key: 'temporary-key',
    secret_access_key: 'temporary-secret',
    action: 'ListAssets',
  })
  assert.equal(override.config_id, 12)
  assert.equal('api_key' in override, false)
  assert.equal('secret_access_key' in override, false)
  assert.equal(override.action, 'ListAssets')

  const temporary = buildSavedConfigRequest(null, {
    base_url: 'https://temporary.invalid/v1',
    api_key: 'temporary-key',
  })
  assert.deepEqual(temporary, {
    base_url: 'https://temporary.invalid/v1',
    api_key: 'temporary-key',
  })
});
