'use strict';

const { createHash } = require('node:crypto');
const { snapshotJson } = require('../workflows/jsonSnapshot');
const { fail } = require('./errors');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function snapshot(value, code, overrides = {}) {
  try {
    return snapshotJson(value, {
      maxArrayLength: 256,
      maxDepth: 16,
      maxEntries: 4096,
      maxStringBytes: 16 * 1024,
      maxTotalBytes: 256 * 1024,
      ...overrides,
    });
  } catch {
    return fail(code);
  }
}

function exactKeys(value, fields, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])) fail(code);
  return value;
}

function boundedText(value, maximumCodePoints, maximumBytes, code) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]|\p{Cf}/u.test(value)
    || Buffer.byteLength(value, 'utf8') > maximumBytes) fail(code);
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maximumCodePoints) fail(code);
  }
  return value;
}

function uid(value, code) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail(code);
  return value;
}

function sha256(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code);
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function sha256Canonical(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

module.exports = Object.freeze({
  boundedText,
  exactKeys,
  sha256,
  sha256Canonical,
  sha256Text,
  snapshot,
  uid,
});
