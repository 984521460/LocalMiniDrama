'use strict';

const MASKED_SECRET_VALUES = new Set([
  '<redacted>',
  '[redacted]',
  'redacted',
  '<masked>',
  '[masked]',
  '已配置',
]);

const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PUBLIC_SETTINGS_KEYS = new Set([
  'apiversion',
  'assetgroupid',
  'authmode',
  'billingmodel',
  'deepseek',
  'deepseekreasoningeffort',
  'deepseekthinking',
  'groupid',
  'httpmethod',
  'klingsecretkeybase64',
  'maxtokens',
  'pathmode',
  'projectname',
  'reasoningeffort',
  'signregion',
  'signservice',
  'thinking',
  'timeout',
  'voiceid',
]);
const PUBLIC_DEEPSEEK_KEYS = new Set(['effort', 'reasoningeffort', 'thinking', 'type']);
const SAVED_OPERATION_INPUT_KEYS = new Set(['action', 'cursor', 'limit', 'payload']);

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSecretKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key) {
  const normalized = normalizeSecretKey(key);
  return (
    normalized === 'auth' ||
    normalized === 'authorization' ||
    normalized === 'cookie' ||
    normalized === 'cookies' ||
    normalized === 'credential' ||
    normalized === 'credentials' ||
    normalized === 'password' ||
    normalized === 'apikey' ||
    normalized === 'apikeys' ||
    normalized === 'accesskey' ||
    normalized === 'accesskeys' ||
    normalized === 'accesskeyid' ||
    normalized === 'privatekey' ||
    normalized === 'secretid' ||
    normalized === 'secretkey' ||
    normalized === 'secretaccesskey' ||
    normalized === 'sessiontoken' ||
    normalized === 'sessiontokens' ||
    normalized === 'tokens' ||
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
  );
}

function isBlankOrMaskedSecret(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (MASKED_SECRET_VALUES.has(trimmed.toLowerCase())) return true;
  return /^[*\u2022\u25cf\u00b7xX#_-]{4,}$/.test(trimmed);
}

function isDangerousObjectKey(key) {
  return DANGEROUS_OBJECT_KEYS.has(String(key));
}

function isPublicSettingsKey(key, parentPath = '') {
  const normalized = normalizeSecretKey(key);
  if (parentPath === 'deepseek') return PUBLIC_DEEPSEEK_KEYS.has(normalized);
  return parentPath === '' && PUBLIC_SETTINGS_KEYS.has(normalized);
}

function parseStructuredValue(value) {
  if (typeof value !== 'string') return { value, serialized: false, parsed: true };
  if (!value.trim()) return { value: {}, serialized: true, parsed: true };
  try {
    return { value: JSON.parse(value), serialized: true, parsed: true };
  } catch (_) {
    return { value, serialized: true, parsed: false };
  }
}

function serializeLike(parsed, value) {
  return parsed.serialized ? JSON.stringify(value) : value;
}

function extractPrivateSettingsTree(value, parentPath = '') {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (isDangerousObjectKey(key)) continue;
    const childPath = parentPath ? `${parentPath}.${key}` : key;
    if (isSensitiveKey(key) || !isPublicSettingsKey(key, parentPath)) {
      result[key] = child;
      continue;
    }
    const nested = extractPrivateSettingsTree(child, childPath);
    if (nested !== undefined) result[key] = nested;
  }
  return Object.keys(result).length ? result : undefined;
}

function mergePrivateNodes(existing, incoming) {
  if (Array.isArray(incoming)) {
    if (incoming.length === 0 && existing !== undefined) return existing;
    const oldArray = Array.isArray(existing) ? existing : [];
    return incoming.map((value, index) => mergePrivateNodes(oldArray[index], value));
  }
  if (!isPlainObject(incoming)) {
    return isBlankOrMaskedSecret(incoming) && existing !== undefined ? existing : incoming;
  }
  const oldObject = isPlainObject(existing) ? existing : {};
  const result = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (isDangerousObjectKey(key)) continue;
    result[key] = mergePrivateNodes(oldObject[key], value);
  }
  for (const [key, value] of Object.entries(oldObject)) {
    if (isDangerousObjectKey(key) || Object.hasOwn(result, key)) continue;
    result[key] = value;
  }
  return result;
}

function mergeSettingsNodes(existing, incoming, parentPath = '') {
  if (!isPlainObject(incoming)) return incoming;

  const oldObject = isPlainObject(existing) ? existing : {};
  const result = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (isDangerousObjectKey(key)) continue;
    const childPath = parentPath ? `${parentPath}.${key}` : key;
    const privateField = isSensitiveKey(key) || !isPublicSettingsKey(key, parentPath);
    if (privateField) {
      result[key] = mergePrivateNodes(oldObject[key], value);
      continue;
    }
    result[key] = mergeSettingsNodes(oldObject[key], value, childPath);
  }

  for (const [key, oldValue] of Object.entries(oldObject)) {
    if (isDangerousObjectKey(key) || Object.hasOwn(result, key)) continue;
    const childPath = parentPath ? `${parentPath}.${key}` : key;
    if (isSensitiveKey(key) || !isPublicSettingsKey(key, parentPath)) {
      result[key] = oldValue;
      continue;
    }
    const privateTree = extractPrivateSettingsTree(oldValue, childPath);
    if (privateTree !== undefined) result[key] = privateTree;
  }
  return result;
}

function mergeSettingsSecrets(existingSettings, incomingSettings) {
  const oldParsed = parseStructuredValue(existingSettings);
  const newParsed = parseStructuredValue(incomingSettings);
  if (!newParsed.parsed) {
    return isBlankOrMaskedSecret(newParsed.value) ? existingSettings : incomingSettings;
  }
  if (!isPlainObject(newParsed.value)) {
    return isBlankOrMaskedSecret(newParsed.value) ? existingSettings : incomingSettings;
  }
  const merged = mergeSettingsNodes(oldParsed.parsed ? oldParsed.value : {}, newParsed.value);
  return serializeLike(newParsed, merged);
}

function mergeAiConfigSecrets(existing = {}, incoming = {}) {
  const result = { ...incoming };
  for (const key of Object.keys(result)) {
    if (!isSensitiveKey(key) || !isBlankOrMaskedSecret(result[key])) continue;
    if (!isBlankOrMaskedSecret(existing[key])) result[key] = existing[key];
    else delete result[key];
  }
  if (!Object.prototype.hasOwnProperty.call(incoming, 'api_key') && !isBlankOrMaskedSecret(existing.api_key)) {
    result.api_key = existing.api_key;
  }
  if (Object.prototype.hasOwnProperty.call(incoming, 'settings')) {
    result.settings = mergeSettingsSecrets(existing.settings, incoming.settings);
  }
  return result;
}

function projectPublicNode(value, path, configuredPaths) {
  if (Array.isArray(value)) {
    return value.map((item, index) => projectPublicNode(item, `${path}.${index}`, configuredPaths));
  }
  if (!isPlainObject(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isSensitiveKey(key)) {
      if (!isBlankOrMaskedSecret(child)) configuredPaths.push(childPath);
      continue;
    }
    result[key] = projectPublicNode(child, childPath, configuredPaths);
  }
  return result;
}

function hasConfiguredValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function projectPublicSettingsNode(value, parentPath, configuredPaths) {
  if (!isPlainObject(value)) {
    if (hasConfiguredValue(value)) configuredPaths.push(parentPath || 'settings');
    return undefined;
  }
  const result = {};
  const settingsPath = parentPath === 'settings' ? '' : parentPath.replace(/^settings\.?/, '');
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${parentPath}.${key}`;
    if (
      isDangerousObjectKey(key) ||
      isSensitiveKey(key) ||
      !isPublicSettingsKey(key, settingsPath)
    ) {
      if (hasConfiguredValue(child)) configuredPaths.push(childPath);
      continue;
    }
    if (normalizeSecretKey(key) === 'deepseek') {
      const nested = projectPublicSettingsNode(child, childPath, configuredPaths);
      if (nested !== undefined) result[key] = nested;
      continue;
    }
    if (isPlainObject(child) || Array.isArray(child)) {
      if (hasConfiguredValue(child)) configuredPaths.push(childPath);
      continue;
    }
    result[key] = child;
  }
  return result;
}

function projectPublicAiConfig(config) {
  if (!config) return config;
  const configuredPaths = [];
  const projected = {};

  for (const [key, value] of Object.entries(config)) {
    if (key === 'settings') {
      const parsed = parseStructuredValue(value);
      if (!parsed.parsed || !isPlainObject(parsed.value)) {
        if (hasConfiguredValue(parsed.value)) configuredPaths.push('settings');
        continue;
      }
      projected.settings = serializeLike(
        parsed,
        projectPublicSettingsNode(parsed.value, 'settings', configuredPaths),
      );
      continue;
    }
    if (isSensitiveKey(key)) {
      if (!isBlankOrMaskedSecret(value)) configuredPaths.push(key);
      continue;
    }
    projected[key] = projectPublicNode(value, key, configuredPaths);
  }

  projected.api_key_configured = configuredPaths.includes('api_key');
  projected.configured_secret_fields = [...new Set(configuredPaths)];
  return projected;
}

function resolveAiConfigOperation(existing, overrides = {}) {
  let merged;
  if (existing) {
    merged = { ...existing };
    for (const key of SAVED_OPERATION_INPUT_KEYS) {
      if (Object.hasOwn(overrides, key)) merged[key] = overrides[key];
    }
  } else {
    merged = mergeAiConfigSecrets({}, overrides);
  }
  delete merged.config_id;
  const parsedSettings = parseStructuredValue(merged.settings);
  merged.settings = parsedSettings.parsed && isPlainObject(parsedSettings.value) ? parsedSettings.value : {};
  return merged;
}

function collectAllPrimitiveValues(value, target) {
  if (Array.isArray(value)) {
    for (const child of value) collectAllPrimitiveValues(child, target);
    return;
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) collectAllPrimitiveValues(child, target);
    return;
  }
  if (value != null && String(value).length > 0) target.add(String(value));
}

function collectPrivateSettingsValues(value, parentPath, target) {
  if (!isPlainObject(value)) {
    collectAllPrimitiveValues(value, target);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = parentPath ? `${parentPath}.${key}` : key;
    if (
      isDangerousObjectKey(key) ||
      isSensitiveKey(key) ||
      !isPublicSettingsKey(key, parentPath)
    ) {
      collectAllPrimitiveValues(child, target);
    } else if (normalizeSecretKey(key) === 'deepseek') {
      if (isPlainObject(child)) collectPrivateSettingsValues(child, childPath, target);
      else collectAllPrimitiveValues(child, target);
    } else if (isPlainObject(child) || Array.isArray(child)) {
      collectAllPrimitiveValues(child, target);
    }
  }
}

function collectAiConfigSecretValues(config = {}) {
  const values = new Set();
  for (const [key, value] of Object.entries(config || {})) {
    if (key === 'settings') {
      const parsed = parseStructuredValue(value);
      collectPrivateSettingsValues(parsed.parsed ? parsed.value : value, '', values);
    } else if (isSensitiveKey(key)) {
      collectAllPrimitiveValues(value, values);
    }
  }
  return [...values];
}

function redactAiConfigErrorText(message, config = {}) {
  let output = String(message || '');
  const values = collectAiConfigSecretValues(config);
  for (const secret of values.sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join('[redacted]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) output = output.split(encoded).join('[redacted]');
  }
  return output;
}

module.exports = {
  collectAiConfigSecretValues,
  isSensitiveKey,
  isBlankOrMaskedSecret,
  mergeSettingsSecrets,
  mergeAiConfigSecrets,
  projectPublicAiConfig,
  redactAiConfigErrorText,
  resolveAiConfigOperation,
};
