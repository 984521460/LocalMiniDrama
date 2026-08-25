'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { logKlingOmniAuthDebug } = require('../src/services/videoClient');

test('Kling authentication diagnostics never include access key fragments or JWT issuer', () => {
  const accessKey = 'fixture-kling-access-key-12345678';
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iss: accessKey, nbf: now - 1, exp: now + 60 })).toString('base64url');
  const bearer = `header.${payload}.signature`;
  const captured = [];
  const log = { info(message, fields) { captured.push([message, fields]); } };

  logKlingOmniAuthDebug({
    settings: JSON.stringify({
      kling_access_key: accessKey,
      kling_secret_key: 'fixture-kling-secret-key',
    }),
  }, bearer, log);

  const serialized = JSON.stringify(captured);
  assert.doesNotMatch(serialized, /fixt|5678|fixture-kling-access-key/);
  assert.match(serialized, /access_key_len/);
});
