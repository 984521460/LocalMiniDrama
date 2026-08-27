const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CREDENTIAL_KINDS,
  CredentialContractError,
  createCredentialRef,
  parseCredentialDescriptor,
  parseCredentialKind,
  parseCredentialRef,
} = require('../dist');

const UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REF = `credential:v1:${UUID}`;

test('credential references are canonical opaque UUIDv4 values', () => {
  assert.equal(createCredentialRef(UUID), REF);
  assert.equal(parseCredentialRef(REF), REF);
  assert.deepEqual(CREDENTIAL_KINDS, ['api_key', 'provider_token', 'ssh_password', 'ssh_key_passphrase']);
  assert.equal(parseCredentialKind('ssh_password'), 'ssh_password');

  const invalid = [
    '', UUID, `credential:v2:${UUID}`, `credential:v1:${UUID.toUpperCase()}`,
    'credential:v1:11111111-1111-1111-8111-111111111111',
    'credential:v1:00000000-0000-0000-0000-000000000000',
    `${REF}\0tail`, { ref: REF }, null,
  ];
  for (const value of invalid) {
    assert.throws(() => parseCredentialRef(value), CredentialContractError);
  }
  assert.throws(() => parseCredentialKind('password'), CredentialContractError);
});

test('credential descriptors are exact frozen public snapshots without secret fields', () => {
  const descriptor = parseCredentialDescriptor({ ref: REF, kind: 'ssh_password', configured: true });
  assert.deepEqual(descriptor, { ref: REF, kind: 'ssh_password', configured: true });
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(JSON.stringify(descriptor).includes('secret'), false);
  assert.throws(
    () => parseCredentialDescriptor({ ...descriptor, secret: 'fixture-must-not-pass' }),
    /unsupported field/i,
  );

  let getterReads = 0;
  const hostile = { ref: REF, configured: true };
  Object.defineProperty(hostile, 'kind', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'ssh_password';
    },
  });
  assert.throws(() => parseCredentialDescriptor(hostile), CredentialContractError);
  assert.equal(getterReads, 0);
});

test('package consumers load CommonJS, ESM names, and declarations', async () => {
  const packageRoot = path.resolve(__dirname, '..');
  assert.equal(require.resolve('@local-mini-drama/credential-vault'), path.join(packageRoot, 'dist', 'index.js'));
  assert.equal(fs.existsSync(path.join(packageRoot, 'dist', 'index.d.ts')), true);
  const module = await import('@local-mini-drama/credential-vault');
  assert.equal(typeof module.parseCredentialRef, 'function');
  assert.equal(typeof module.CredentialContractError, 'function');
});
