const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { utils } = require('ssh2');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SSH_PUBLIC_KEY = /^ssh-ed25519 ([A-Za-z0-9+/]{68}) local-mini-drama$/u;
const PRIVATE_KEY_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';
const PRIVATE_KEY_FOOTER = '-----END OPENSSH PRIVATE KEY-----';
const MAX_PRIVATE_KEY_BYTES = 2560;
const MAX_GENERATION_ATTEMPTS = 16;

function fail() {
  throw new TypeError('SSH key pair value is invalid');
}

function exactObject(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail();
  }
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) fail();
  const output = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    output[key] = descriptor.value;
  }
  return output;
}

function parsePublicKey(value) {
  if (typeof value !== 'string' || value.includes('\0')) fail();
  const match = SSH_PUBLIC_KEY.exec(value);
  if (!match) fail();
  const blob = Buffer.from(match[1], 'base64');
  if (blob.length !== 51 || blob.toString('base64') !== match[1]) fail();
  let parsedKey;
  try {
    parsedKey = utils.parseKey(value);
  } catch {
    blob.fill(0);
    fail();
  }
  if (!parsedKey || parsedKey instanceof Error || Array.isArray(parsedKey)
    || parsedKey.type !== 'ssh-ed25519'
    || typeof parsedKey.getPublicSSH !== 'function'
    || !parsedKey.getPublicSSH().equals(blob)) {
    blob.fill(0);
    fail();
  }
  return Object.freeze({ publicKey: value, blob });
}

function parseGeneratedSshKeyPair(value) {
  const input = exactObject(value, ['privateKey', 'publicKey']);
  const parsedPublic = parsePublicKey(input.publicKey);
  if (typeof input.privateKey !== 'string' || input.privateKey.includes('\0')
    || !input.privateKey.startsWith(`${PRIVATE_KEY_HEADER}\n`)
    || !input.privateKey.endsWith(`${PRIVATE_KEY_FOOTER}\n`)
    || Buffer.byteLength(input.privateKey, 'utf8') > MAX_PRIVATE_KEY_BYTES) fail();
  let privateKey;
  let publicKey;
  try {
    privateKey = utils.parseKey(input.privateKey);
    publicKey = utils.parseKey(input.publicKey);
  } catch {
    fail();
  }
  if (!privateKey || privateKey instanceof Error || Array.isArray(privateKey)
    || !publicKey || publicKey instanceof Error || Array.isArray(publicKey)
    || privateKey.type !== 'ssh-ed25519' || publicKey.type !== 'ssh-ed25519'
    || typeof privateKey.getPublicSSH !== 'function' || typeof publicKey.getPublicSSH !== 'function'
    || !privateKey.getPublicSSH().equals(publicKey.getPublicSSH())) fail();
  parsedPublic.blob.fill(0);
  return Object.freeze({ privateKey: input.privateKey, publicKey: input.publicKey });
}

function generateSshKeyPair(generateKeyPairSync = utils.generateKeyPairSync) {
  if (typeof generateKeyPairSync !== 'function') fail();
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    let generated;
    try {
      generated = generateKeyPairSync('ed25519', { comment: 'local-mini-drama' });
    } catch {
      fail();
    }
    try {
      return parseGeneratedSshKeyPair({
        privateKey: generated?.private,
        publicKey: generated?.public,
      });
    } catch {
      // ssh2 can occasionally omit a leading zero byte from an Ed25519 public blob.
      // Retry so persisted keys always use the canonical 32-byte RFC 8709 wire form.
    }
  }
  return fail();
}

function createSshPublicKeyView(connectionUid, value) {
  if (typeof connectionUid !== 'string' || !UUID_V4.test(connectionUid)) fail();
  const parsed = parsePublicKey(value);
  try {
    const digest = createHash('sha256').update(parsed.blob).digest('base64').replace(/=+$/u, '');
    return Object.freeze({
      contractVersion: 'ssh-public-key.v1',
      connectionUid,
      algorithm: 'ssh-ed25519',
      publicKey: parsed.publicKey,
      fingerprint: `SHA256:${digest}`,
    });
  } finally {
    parsed.blob.fill(0);
  }
}

module.exports = {
  createSshPublicKeyView,
  generateSshKeyPair,
  parseGeneratedSshKeyPair,
};
