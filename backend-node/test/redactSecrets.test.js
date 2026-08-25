'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  isSensitiveLogKey,
  registerLogSecrets,
  redactLogValue,
  redactSecretText,
} = require('../src/utils/redactSecrets');

test('redacts structured headers and secret fields recursively', () => {
  const input = {
    headers: {
      Authorization: 'Bearer fixture-authorization-value',
      'X-Api-Key': 'fixture-header-key',
      'Content-Type': 'application/json',
    },
    credentials: {
      access_key_id: 'fixture-access-key',
      secret_access_key: 'fixture-secret-key',
    },
    nested: [{ password: 'fixture-password' }],
  };

  const serialized = JSON.stringify(redactLogValue(input));

  assert.equal(isSensitiveLogKey('X-Api-Key'), true);
  assert.doesNotMatch(serialized, /fixture-/);
  assert.match(serialized, /application\/json/);
  assert.match(serialized, /\[redacted\]/);
});

test('redacts URL query parameters, authorization headers, and labelled free text', () => {
  const source = [
    'GET https://provider.invalid/v1?q=public&api_key=fixture-query-key&cursor=next',
    'Authorization: Bearer fixture-bearer-token',
    'client_secret="fixture-client-secret" password=fixture-password',
  ].join('\n');

  const redacted = redactSecretText(source);

  assert.doesNotMatch(redacted, /fixture-/);
  assert.match(redacted, /q=public/);
  assert.match(redacted, /cursor=next/);
  assert.ok((redacted.match(/\[redacted\]/g) || []).length >= 4);
});

test('redacts registered credentials when an upstream echoes them without a label', () => {
  registerLogSecrets({
    api_key: 'fixture-unlabelled-provider-secret',
    settings: { private_key: 'fixture-unlabelled-private-secret' },
  });

  const redacted = redactSecretText(
    'provider echoed fixture-unlabelled-provider-secret and fixture-unlabelled-private-secret',
  );

  assert.doesNotMatch(redacted, /fixture-unlabelled/);
  assert.equal((redacted.match(/\[redacted\]/g) || []).length, 2);
});

test('redacts lowercase percent encoding and form encoding of registered credentials', () => {
  const secret = 'fixture space/value+?';
  registerLogSecrets({ api_key: secret });
  const encoded = encodeURIComponent(secret);
  const lowerPercent = encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase());
  const formEncoded = lowerPercent.replace(/%20/g, '+').replace(/%20/gi, '+');

  const redacted = redactSecretText(`percent=${lowerPercent} form=${formEncoded}`);

  assert.doesNotMatch(redacted, /fixture(?:%20|\+)space/i);
  assert.equal((redacted.match(/\[redacted\]/g) || []).length, 2);
});

test('redacts double-encoded credentials and avoids replacing one-character substrings in words', () => {
  const encodedSecret = 'fixture /double?';
  registerLogSecrets({ api_key: encodedSecret });
  const doubleEncoded = encodeURIComponent(encodeURIComponent(encodedSecret));
  registerLogSecrets({ api_key: 'q' });

  const ordinary = redactSecretText('request queue completed');
  const withStandaloneSecret = redactSecretText(`upstream echoed q and ${doubleEncoded}`);

  assert.equal(ordinary, 'request queue completed');
  assert.doesNotMatch(withStandaloneSecret, / echoed q |fixture/i);
  assert.equal((withStandaloneSecret.match(/\[redacted\]/g) || []).length, 2);
});

test('uses Unicode word boundaries for one-character registered credentials', () => {
  registerLogSecrets({ api_key: '密' });

  assert.equal(redactSecretText('密钥配置完成'), '密钥配置完成');
  assert.equal(redactSecretText('上游回显 密 后结束'), '上游回显 [redacted] 后结束');
});

test('handles circular values and Error objects without leaking labelled secrets', () => {
  const circular = { api_key: 'fixture-cycle-key' };
  circular.self = circular;
  const error = new Error('request failed: token=fixture-error-token');
  error.payload = circular;

  const serialized = JSON.stringify(redactLogValue(error));

  assert.doesNotMatch(serialized, /fixture-/);
  assert.match(serialized, /\[redacted\]/);
  assert.match(serialized, /\[circular\]/);
});

test('the shared logger applies redaction before writing to console and file', (t) => {
  const originalConsoleLog = console.log;
  const originalLogFile = process.env.LOG_FILE;
  const tempPrefix = path.join(os.tmpdir(), 'local-mini-drama-log-redaction-');
  const tempRoot = fs.mkdtempSync(tempPrefix);
  const logFile = path.join(tempRoot, 'backend.log');
  const captured = [];
  console.log = (...args) => captured.push(args.join(' '));
  process.env.LOG_FILE = logFile;
  t.after(() => {
    console.log = originalConsoleLog;
    if (originalLogFile == null) delete process.env.LOG_FILE;
    else process.env.LOG_FILE = originalLogFile;
    const resolved = path.resolve(tempRoot);
    assert.equal(resolved.startsWith(path.resolve(tempPrefix)), true);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const logger = require('../src/logger');

  logger.warn(
    'provider rejected api_key=fixture-message-key',
    {
      headers: { authorization: 'Bearer fixture-header-token' },
      url: 'https://provider.invalid/run?access_token=fixture-url-token&mode=test',
    },
  );
  const output = `${captured.join('\n')}\n${fs.readFileSync(logFile, 'utf8')}`;

  assert.doesNotMatch(output, /fixture-(message-key|header-token|url-token)/);
  assert.match(output, /\[redacted\]/);
  assert.match(output, /mode=test/);
});
