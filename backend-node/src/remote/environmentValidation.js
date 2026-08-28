'use strict';

const { types: { isProxy } } = require('node:util');

const { createRemoteEnvironmentError } = require('./remoteEnvironmentErrors');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TOKEN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;

function fail(code = 'REMOTE_ENVIRONMENT_INPUT_INVALID') {
  throw createRemoteEnvironmentError(code);
}

function exactObject(value, required, optional = [], code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail(code);
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code);
  }
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const allowed = new Set([...required, ...optional]);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !allowed.has(key) || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')) fail(code);
    output[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(output, key))) fail(code);
  return output;
}

function denseArray(value, maxLength, code) {
  if (!Array.isArray(value) || isProxy(value)) fail(code);
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code);
  }
  if (prototype !== Array.prototype) fail(code);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0 || lengthDescriptor.value > maxLength) fail(code);
  const length = lengthDescriptor.value;
  if (Reflect.ownKeys(descriptors).length !== length + 1) fail(code);
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    output.push(descriptor.value);
  }
  return output;
}

function canonicalUid(value, code) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail(code);
  return value;
}

function safeInteger(value, min, max, code) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

function safeToken(value, nullable, code) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !TOKEN.test(value)) fail(code);
  return value;
}

function sha256(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code);
  return value;
}

module.exports = Object.freeze({
  canonicalUid,
  denseArray,
  exactObject,
  fail,
  safeInteger,
  safeToken,
  sha256,
});
