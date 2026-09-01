'use strict';

const https = require('node:https');
const { IncomingMessage } = require('node:http');
const { types: { isProxy } } = require('node:util');

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/u;
const REGEXP_EXEC = RegExp.prototype.exec;
const STRING_REPLACE = String.prototype.replace;
const STRING_SPLIT = String.prototype.split;
const STRING_STARTS_WITH = String.prototype.startsWith;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const STRING_TRIM = String.prototype.trim;
const INCOMING_HEADERS_GET = Object.getOwnPropertyDescriptor(
  IncomingMessage.prototype,
  'headers',
).get;

function safeMethod(value, name) {
  let cursor = value;
  while (cursor !== null) {
    if (!cursor || typeof cursor !== 'object' || isProxy(cursor)) {
      throw new TypeError('Image source is invalid');
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function'
        || isProxy(descriptor.value)) {
        throw new TypeError('Image source is invalid');
      }
      return (...args) => Reflect.apply(descriptor.value, value, args);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  throw new TypeError('Image source is invalid');
}

function hasIncomingMessagePrototype(value) {
  let cursor = Object.getPrototypeOf(value);
  while (cursor !== null) {
    if (isProxy(cursor)) throw new TypeError('Image source is invalid');
    if (cursor === IncomingMessage.prototype) return true;
    cursor = Object.getPrototypeOf(cursor);
  }
  return false;
}

function ownData(value, key, required = false) {
  if (!value || typeof value !== 'object' || isProxy(value)) {
    throw new TypeError('Image source is invalid');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined && !required) return undefined;
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError('Image source is invalid');
  }
  return descriptor.value;
}

function responseMetadata(response) {
  if (!response || typeof response !== 'object' || isProxy(response)) {
    throw new TypeError('Image source is invalid');
  }
  const statusCode = ownData(response, 'statusCode', true);
  const headers = hasIncomingMessagePrototype(response)
    ? Reflect.apply(INCOMING_HEADERS_GET, response, [])
    : ownData(response, 'headers', true);
  return Object.freeze({
    declared: Number(ownData(headers, 'content-length')),
    mediaType: String(ownData(headers, 'content-type') || ''),
    statusCode,
  });
}

function readDataUrl(value, maximumBytes) {
  const match = Reflect.apply(REGEXP_EXEC, DATA_IMAGE, [value]);
  if (!match) throw new TypeError('Image source is invalid');
  if (match[2].length > Math.ceil(maximumBytes / 3) * 4 + 4) {
    throw new TypeError('Image source exceeds the local bound');
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > maximumBytes) {
    bytes.fill(0);
    throw new TypeError('Image source exceeds the local bound');
  }
  if (bytes.length < 1
    || Reflect.apply(STRING_REPLACE, bytes.toString('base64'), [/=+$/u, ''])
      !== Reflect.apply(STRING_REPLACE, match[2], [/=+$/u, ''])) {
    bytes.fill(0);
    throw new TypeError('Image source is invalid');
  }
  return Promise.resolve(Object.freeze({ mediaType: match[1], bytes }));
}

function readHttpsUrl(value, maximumBytes, timeoutMs, requestImpl) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('Image source is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('Image source is invalid');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const finish = (callback, output) => {
      if (settled) return;
      settled = true;
      callback(output);
    };
    try {
      request = requestImpl(parsed, { method: 'GET', headers: { Accept: 'image/png,image/jpeg,image/webp' } }, (response) => {
        let metadata;
        let destroyResponse;
        let onResponse;
        try {
          metadata = responseMetadata(response);
          destroyResponse = safeMethod(response, 'destroy');
          onResponse = safeMethod(response, 'on');
        } catch {
          finish(reject, new TypeError('Image source is invalid'));
          return;
        }
        const mediaTypeParts = Reflect.apply(
          STRING_SPLIT,
          metadata.mediaType,
          [';', 1],
        );
        const mediaType = Reflect.apply(
          STRING_TO_LOWER_CASE,
          Reflect.apply(STRING_TRIM, mediaTypeParts[0], []),
          [],
        );
        if (metadata.statusCode !== 200
          || (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp')
          || (Number.isFinite(metadata.declared) && metadata.declared > maximumBytes)) {
          destroyResponse();
          finish(reject, new TypeError('Image source is invalid'));
          return;
        }
        const chunks = [];
        let total = 0;
        onResponse('data', (chunk) => {
          if (settled) return;
          if (isProxy(chunk) || !Buffer.isBuffer(chunk)
            || Object.getPrototypeOf(chunk) !== Buffer.prototype) {
            destroyResponse();
            finish(reject, new TypeError('Image source is invalid'));
            return;
          }
          total += chunk.length;
          if (total > maximumBytes) {
            destroyResponse();
            finish(reject, new TypeError('Image source exceeds the local bound'));
            return;
          }
          chunks[chunks.length] = chunk;
        });
        onResponse('end', () => {
          if (settled || total < 1) return finish(reject, new TypeError('Image source is invalid'));
          finish(resolve, Object.freeze({ mediaType, bytes: Buffer.concat(chunks, total) }));
        });
        onResponse('error', () => finish(reject, new TypeError('Image source is invalid')));
      });
      const destroyRequest = safeMethod(request, 'destroy');
      const onRequest = safeMethod(request, 'on');
      const setRequestTimeout = safeMethod(request, 'setTimeout');
      const endRequest = safeMethod(request, 'end');
      setRequestTimeout(timeoutMs, () => {
        destroyRequest();
        finish(reject, new TypeError('Image source timed out'));
      });
      onRequest('error', () => finish(reject, new TypeError('Image source is invalid')));
      endRequest();
    } catch {
      if (request) {
        try { safeMethod(request, 'destroy')(); } catch {}
      }
      finish(reject, new TypeError('Image source is invalid'));
    }
  });
}

function createBoundedImageSourceReader({
  maximumBytes = MAX_IMAGE_BYTES,
  timeoutMs = 120000,
  requestImpl = https.request,
} = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_IMAGE_BYTES
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000
    || typeof requestImpl !== 'function') {
    throw new TypeError('Image source reader configuration is invalid');
  }
  return function readImageSource(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 32 * 1024 * 1024) {
      return Promise.reject(new TypeError('Image source is invalid'));
    }
    if (Reflect.apply(STRING_STARTS_WITH, value, ['data:'])) {
      try { return readDataUrl(value, maximumBytes); } catch (error) {
        return Promise.reject(error);
      }
    }
    try { return readHttpsUrl(value, maximumBytes, timeoutMs, requestImpl); } catch (error) {
      return Promise.reject(error);
    }
  };
}

module.exports = Object.freeze({ MAX_IMAGE_BYTES, createBoundedImageSourceReader });
