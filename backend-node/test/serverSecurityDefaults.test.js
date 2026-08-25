const test = require('node:test');
const assert = require('node:assert/strict');

const { isInsecureTlsEnabled, resolveServerHost } = require('../src/config/serverSecurityDefaults');

test('server binds to loopback when host is absent', () => {
  assert.equal(resolveServerHost({}), '127.0.0.1');
  assert.equal(resolveServerHost({ host: '192.0.2.10' }), '192.0.2.10');
});

test('TLS verification remains enabled unless explicitly disabled', () => {
  assert.equal(isInsecureTlsEnabled({}), false);
  assert.equal(isInsecureTlsEnabled({ insecure_tls: false }), false);
  assert.equal(isInsecureTlsEnabled({ insecure_tls: true }), true);
  assert.equal(isInsecureTlsEnabled({ INSECURE_TLS: '1' }), true);
});
