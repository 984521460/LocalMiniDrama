'use strict';

const { types: { isProxy } } = require('node:util');

const {
  parseCredentialKind,
  parseCredentialRef,
} = require('@local-mini-drama/credential-vault');

const MAX_SECRET_UTF16_UNITS = 2560;
const PROVIDER_KINDS = Object.freeze(['api_key', 'provider_token']);

function invalid() {
  throw new TypeError('Provider credential request is invalid');
}

function includes(values, expected) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function exactObject(value, expectedKeys) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) invalid();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    invalid();
  }
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expectedKeys.length) invalid();
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string' || !includes(expectedKeys, key)) invalid();
  }
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index];
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    output[key] = descriptor.value;
  }
  return output;
}

function providerKind(value) {
  let kind;
  try { kind = parseCredentialKind(value); } catch { invalid(); }
  if (!includes(PROVIDER_KINDS, kind)) invalid();
  return kind;
}

function parseProviderCredentialRef(value) {
  try { return parseCredentialRef(value); } catch { invalid(); }
  return undefined;
}

function utf8Bytes(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return -1;
      bytes += 4;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return -1;
    } else if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > MAX_SECRET_UTF16_UNITS) return bytes;
  }
  return bytes;
}

function createProviderCredentialStoreRequest(value) {
  const input = exactObject(value, ['kind', 'secret']);
  const secret = input.secret;
  if (typeof secret !== 'string' || secret.length < 1
    || secret.length > MAX_SECRET_UTF16_UNITS || secret.includes('\0')
    || secret.trim().length === 0 || utf8Bytes(secret) < 1
    || utf8Bytes(secret) > MAX_SECRET_UTF16_UNITS) invalid();
  return Object.freeze({ kind: providerKind(input.kind), secret });
}

function createProviderCredentialView(value) {
  const input = exactObject(value, ['ref', 'kind', 'configured']);
  if (input.configured !== true) invalid();
  return Object.freeze({
    schemaVersion: 'provider-credential.v1',
    ref: parseProviderCredentialRef(input.ref),
    kind: providerKind(input.kind),
    configured: true,
  });
}

function createProviderCredentialRemovedView(value) {
  const input = exactObject(value, ['ref', 'removed']);
  if (input.removed !== true) invalid();
  return Object.freeze({
    schemaVersion: 'provider-credential-removal.v1',
    ref: parseProviderCredentialRef(input.ref),
    removed: true,
  });
}

function createProviderCredentialCleanupView(value) {
  const input = exactObject(value, ['ref', 'cleanupRequired']);
  if (input.cleanupRequired !== true) invalid();
  return Object.freeze({
    schemaVersion: 'provider-credential-cleanup.v1',
    ref: parseProviderCredentialRef(input.ref),
    cleanupRequired: true,
  });
}

module.exports = Object.freeze({
  PROVIDER_KINDS,
  createProviderCredentialCleanupView,
  createProviderCredentialRemovedView,
  createProviderCredentialStoreRequest,
  createProviderCredentialView,
  parseProviderCredentialRef,
});
