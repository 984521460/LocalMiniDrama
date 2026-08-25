const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeAiConfigSecrets,
  projectPublicAiConfig,
  redactAiConfigErrorText,
  resolveAiConfigOperation,
} = require('../src/security/aiConfigSecrets');

test('public AI config projection exposes only allow-listed settings and removes reusable secrets recursively', () => {
  const config = {
    id: 7,
    name: 'fixture',
    api_key: 'fixture-api-key-value',
    settings: JSON.stringify({
      timeout: 10,
      access_key_id: 'fixture-access-key-value',
      private_key: 'fixture-private-key-value',
      credential: 'fixture-credential-value',
      custom_blob: 'fixture-opaque-value',
      nested: {
        password: 'fixture-password-value',
      },
      session_token: 'fixture-session-token-value',
    }),
  };

  const projected = projectPublicAiConfig(config);
  const serialized = JSON.stringify(projected);

  assert.equal('api_key' in projected, false);
  assert.equal(projected.api_key_configured, true);
  assert.deepEqual(projected.configured_secret_fields.sort(), [
    'api_key',
    'settings.access_key_id',
    'settings.credential',
    'settings.custom_blob',
    'settings.nested',
    'settings.private_key',
    'settings.session_token',
  ]);
  assert.deepEqual(JSON.parse(projected.settings), { timeout: 10 });
  assert.doesNotMatch(serialized, /fixture-(api-key|access-key|private-key|credential|opaque|password|session-token)-value/);
});

test('public projection never returns scalar or array settings with unknown secret semantics', () => {
  const scalar = projectPublicAiConfig({ id: 1, settings: JSON.stringify('fixture-bare-secret') });
  const array = projectPublicAiConfig({ id: 2, settings: JSON.stringify(['fixture-array-secret']) });

  assert.equal('settings' in scalar, false);
  assert.equal('settings' in array, false);
  assert.deepEqual(scalar.configured_secret_fields, ['settings']);
  assert.deepEqual(array.configured_secret_fields, ['settings']);
  assert.doesNotMatch(JSON.stringify([scalar, array]), /fixture-(bare|array)-secret/);
});

test('blank, omitted, and mask placeholder secrets preserve stored values while nonblank secrets replace them', () => {
  const existing = {
    api_key: 'stored-api-key',
    settings: JSON.stringify({
      access_key_id: 'stored-ak',
      secret_access_key: 'stored-sk',
      nested: { token: 'stored-token', mode: 'old' },
      obsolete_flag: true,
    }),
  };

  const preserved = mergeAiConfigSecrets(existing, {
    api_key: '   ',
    settings: JSON.stringify({
      access_key_id: '********',
      nested: { token: '', mode: 'new' },
      enabled: true,
    }),
  });
  const preservedSettings = JSON.parse(preserved.settings);
  assert.equal(preserved.api_key, 'stored-api-key');
  assert.equal(preservedSettings.access_key_id, 'stored-ak');
  assert.equal(preservedSettings.secret_access_key, 'stored-sk');
  assert.equal(preservedSettings.nested.token, 'stored-token');
  assert.equal(preservedSettings.nested.mode, 'new');
  assert.equal(preservedSettings.enabled, true);
  assert.equal(preservedSettings.obsolete_flag, true);

  const replaced = mergeAiConfigSecrets(existing, {
    api_key: 'replacement-api-key',
    settings: JSON.stringify({
      access_key_id: 'replacement-ak',
      secret_access_key: 'replacement-sk',
      nested: { token: 'replacement-token' },
    }),
  });
  assert.equal(replaced.api_key, 'replacement-api-key');
  assert.equal(JSON.parse(replaced.settings).secret_access_key, 'replacement-sk');
  assert.equal(JSON.parse(replaced.settings).nested.token, 'replacement-token');
});

test('settings merge rejects prototype keys and preserves stored private fields', () => {
  const existing = {
    settings: JSON.stringify({ api_key: 'fixture-stored-secret', timeout: 30 }),
  };
  const incoming = JSON.parse('{"__proto__":{"api_key":"fixture-attacker"},"timeout":60}');
  const merged = mergeAiConfigSecrets(existing, { settings: incoming });

  assert.equal(merged.settings.api_key, 'fixture-stored-secret');
  assert.equal(merged.settings.timeout, 60);
  assert.equal(Object.hasOwn(merged.settings, '__proto__'), false);
  assert.equal(Object.prototype.api_key, undefined);
});

test('blank scalar and array settings preserve stored private fields', () => {
  const existing = {
    settings: JSON.stringify({ credential: 'fixture-stored-secret', timeout: 30 }),
  };
  const emptyArray = mergeAiConfigSecrets(existing, { settings: JSON.stringify([]) });
  const emptyString = mergeAiConfigSecrets(existing, { settings: JSON.stringify('') });

  assert.deepEqual(JSON.parse(emptyArray.settings), JSON.parse(existing.settings));
  assert.deepEqual(JSON.parse(emptyString.settings), JSON.parse(existing.settings));
});

test('error redaction uses the same private settings boundary as public projection', () => {
  const config = {
    settings: JSON.stringify({
      deepseek: 'fixture-deepseek-secret',
      timeout: ['fixture-timeout-secret'],
      credential: 'xy',
    }),
  };
  const message = 'fixture-deepseek-secret fixture-timeout-secret xy';
  const redacted = redactAiConfigErrorText(message, config);

  assert.equal(redacted.includes('fixture-deepseek-secret'), false);
  assert.equal(redacted.includes('fixture-timeout-secret'), false);
  assert.equal(redacted.includes('xy'), false);
  assert.match(redacted, /\[redacted\]/);
});

test('saved operation fixes destination and credentials while allowing operation-only inputs', () => {
  const stored = {
    id: 9,
    base_url: 'https://stored.invalid/v1',
    api_key: 'stored-api-key',
    provider: 'openai',
    settings: JSON.stringify({ access_key_id: 'stored-ak', secret_access_key: 'stored-sk', timeout: 30 }),
  };

  const resolved = resolveAiConfigOperation(stored, {
    config_id: 9,
    base_url: 'https://override.invalid/v1',
    api_key: 'temporary-api-key',
    settings: { secret_access_key: 'temporary-sk', timeout: 60 },
    action: 'ListAssets',
    payload: { PageSize: 20 },
  });
  assert.equal(resolved.config_id, undefined);
  assert.equal(resolved.base_url, 'https://stored.invalid/v1');
  assert.equal(resolved.api_key, 'stored-api-key');
  assert.equal(resolved.settings.access_key_id, 'stored-ak');
  assert.equal(resolved.settings.secret_access_key, 'stored-sk');
  assert.equal(resolved.settings.timeout, 30);
  assert.equal(resolved.action, 'ListAssets');
  assert.deepEqual(resolved.payload, { PageSize: 20 });

  const temporary = resolveAiConfigOperation(null, {
    api_key: 'temporary-api-key',
    base_url: 'https://temporary.invalid/v1',
    settings: { secret_access_key: 'temporary-sk' },
  });
  assert.equal(temporary.api_key, 'temporary-api-key');
  assert.equal(temporary.base_url, 'https://temporary.invalid/v1');
  assert.equal(temporary.settings.secret_access_key, 'temporary-sk');
});
