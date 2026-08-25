const MASKED_SECRET_VALUES = new Set([
  '<redacted>',
  '[redacted]',
  'redacted',
  '<masked>',
  '[masked]',
  '已配置',
])

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isSensitiveKey(key) {
  const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return (
    normalized === 'auth' ||
    normalized === 'authorization' ||
    normalized === 'cookie' ||
    normalized === 'cookies' ||
    normalized === 'credential' ||
    normalized === 'credentials' ||
    normalized === 'password' ||
    normalized === 'apikey' ||
    normalized === 'accesskey' ||
    normalized === 'accesskeyid' ||
    normalized === 'privatekey' ||
    normalized === 'secretid' ||
    normalized === 'secretkey' ||
    normalized === 'secretaccesskey' ||
    normalized === 'sessiontoken' ||
    normalized.endsWith('password') ||
    normalized.endsWith('token') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('accesskey') ||
    normalized.endsWith('secretkey') ||
    normalized.endsWith('privatekey') ||
    normalized.endsWith('credential') ||
    normalized.endsWith('credentials') ||
    normalized.endsWith('cookie') ||
    normalized.endsWith('cookies') ||
    normalized.endsWith('secretid')
  )
}

function isBlankOrMaskedSecret(value) {
  if (value == null) return true
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed || MASKED_SECRET_VALUES.has(trimmed.toLowerCase())) return true
  return /^[*\u2022\u25cf\u00b7xX#_-]{4,}$/.test(trimmed)
}

function omitBlankSecrets(value) {
  if (Array.isArray(value)) return value.map(omitBlankSecrets)
  if (!isPlainObject(value)) return value
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key) && isBlankOrMaskedSecret(child)) continue
    result[key] = omitBlankSecrets(child)
  }
  return result
}

function mapSettings(settings) {
  if (typeof settings !== 'string') return omitBlankSecrets(settings)
  try {
    return JSON.stringify(omitBlankSecrets(JSON.parse(settings)))
  } catch (_) {
    return settings
  }
}

export function buildAiConfigMutationPayload(source) {
  const payload = omitBlankSecrets(source || {})
  if (Object.prototype.hasOwnProperty.call(payload, 'settings')) payload.settings = mapSettings(payload.settings)
  return payload
}

export function buildSavedConfigRequest(configId, overrides = {}) {
  if (configId == null) return buildAiConfigMutationPayload(overrides)
  const payload = { config_id: configId }
  for (const key of ['action', 'cursor', 'limit', 'payload']) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) payload[key] = overrides[key]
  }
  return payload
}

export function isSecretConfigured(config, path) {
  return Array.isArray(config?.configured_secret_fields) && config.configured_secret_fields.includes(path)
}

export function createEditSecretState(config) {
  return {
    api_key: '',
    api_key_configured: !!config?.api_key_configured,
    configured_secret_fields: Array.isArray(config?.configured_secret_fields)
      ? [...config.configured_secret_fields]
      : [],
  }
}

export { isBlankOrMaskedSecret, isSensitiveKey }
