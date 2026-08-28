'use strict';

const { types: { isProxy } } = require('node:util');

const { snapshotJson } = require('../workflows/jsonSnapshot');
const { createRemoteTaskError } = require('./remoteTask');

const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const LOGICAL_NAME = /^[a-z][A-Za-z0-9]{0,63}$/u;
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_WORKFLOW_BASE64 = 6 * 1024 * 1024;

function fail() {
  throw createRemoteTaskError('REMOTE_TASK_INPUT_INVALID');
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail();
  }
  if (prototype !== Object.prototype && prototype !== null) fail();
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) fail();
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    result[key] = descriptor.value;
  }
  return result;
}

function relativePath(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1
    || value.length > 1024 || value.includes('\0') || value.includes('\\')
    || value.includes(':') || value.startsWith('/') || value.endsWith('/')) fail();
  const segments = value.split('/');
  if (segments.length > 32
    || segments.some((segment) => segment === '.' || segment === '..' || !SEGMENT.test(segment))) fail();
  return value;
}

function workflowBytes(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > MAX_WORKFLOW_BASE64
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 2 || bytes.toString('base64') !== value) fail();
  return bytes;
}

function denseUploads(value) {
  if (isProxy(value) || !Array.isArray(value)) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 32
    || Reflect.ownKeys(descriptors).length !== length + 1) fail();
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    const entry = descriptor.value;
    const input = exactObject(entry, [
      'localRelativePath', 'remoteRelativePath', 'sha256',
    ]);
    if (typeof input.sha256 !== 'string' || !SHA256.test(input.sha256)) fail();
    result.push(Object.freeze({
      localRelativePath: relativePath(input.localRelativePath),
      remoteRelativePath: relativePath(input.remoteRelativePath),
      sha256: input.sha256,
    }));
  }
  return Object.freeze(result);
}

function remoteExecutionRequest(value) {
  const input = exactObject(value, [
    'expectedStateVersion', 'workflowBase64', 'values', 'uploads', 'output',
  ]);
  if (!Number.isSafeInteger(input.expectedStateVersion)
    || input.expectedStateVersion < 0 || input.expectedStateVersion > 2_147_483_647) fail();
  const output = exactObject(input.output, ['logicalName', 'assetUid']);
  if (typeof output.logicalName !== 'string' || !LOGICAL_NAME.test(output.logicalName)
    || typeof output.assetUid !== 'string' || !UID.test(output.assetUid)) fail();
  let values;
  try {
    values = snapshotJson(input.values, {
      maxArrayLength: 64,
      maxDepth: 16,
      maxEntries: 2048,
      maxStringBytes: 512 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    });
  } catch {
    fail();
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) fail();
  return Object.freeze({
    expectedStateVersion: input.expectedStateVersion,
    workflowBytes: workflowBytes(input.workflowBase64),
    values,
    uploads: denseUploads(input.uploads),
    output: Object.freeze({ logicalName: output.logicalName, assetUid: output.assetUid }),
  });
}

module.exports = Object.freeze({ remoteExecutionRequest });
