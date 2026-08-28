'use strict';

const { types: { isProxy } } = require('node:util');

const {
  createComfyUiClientError,
  isComfyUiClientError,
} = require('./errors');
const { normalizeBaseUrl, safeResponseSnapshot } = require('./contracts');
const { snapshotUint8Array } = require('./byteSnapshot');
const { ignoreNativePromise, raceNativePromise } = require('./asyncControl');

const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const responseOkGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'ok').get;
const responseStatusGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'status').get;
const responseBodyGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'body').get;
const responseText = Response.prototype.text;
const responseJson = Response.prototype.json;
const streamGetReader = ReadableStream.prototype.getReader;
const readerRead = ReadableStreamDefaultReader.prototype.read;
const readerCancel = ReadableStreamDefaultReader.prototype.cancel;
const readerReleaseLock = ReadableStreamDefaultReader.prototype.releaseLock;

function invalidResponse() {
  return createComfyUiClientError('COMFY_RESPONSE_INVALID');
}

function adaptResponse(value) {
  if (value === null || typeof value !== 'object' || isProxy(value)) throw invalidResponse();
  let prototype;
  try { prototype = Object.getPrototypeOf(value); } catch { throw invalidResponse(); }
  if (prototype === Response.prototype) {
    try {
      return Object.freeze({
        ok: responseOkGetter.call(value),
        status: responseStatusGetter.call(value),
        body: responseBodyGetter.call(value),
        readText: () => Reflect.apply(responseText, value, []),
        readJson: () => Reflect.apply(responseJson, value, []),
      });
    } catch {
      throw invalidResponse();
    }
  }
  if (prototype !== Object.prototype && prototype !== null) throw invalidResponse();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { throw invalidResponse(); }
  const allowed = new Set(['ok', 'status', 'body', 'text', 'json']);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw invalidResponse();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalidResponse();
  }
  const ok = descriptors.ok?.value;
  const status = descriptors.status?.value;
  const body = descriptors.body?.value;
  const text = descriptors.text?.value;
  const json = descriptors.json?.value;
  if (typeof ok !== 'boolean' || !Number.isInteger(status) || status < 100 || status > 599
    || (text !== undefined && (typeof text !== 'function' || isProxy(text)))
    || (json !== undefined && (typeof json !== 'function' || isProxy(json)))) {
    throw invalidResponse();
  }
  return Object.freeze({
    ok,
    status,
    body,
    readText: text === undefined ? null : () => Reflect.apply(text, value, []),
    readJson: json === undefined ? null : () => Reflect.apply(json, value, []),
  });
}

function openBodyReader(body) {
  if (body === null || typeof body !== 'object' || isProxy(body)) throw invalidResponse();
  let prototype;
  try { prototype = Object.getPrototypeOf(body); } catch { throw invalidResponse(); }
  if (prototype !== ReadableStream.prototype) throw invalidResponse();
  let reader;
  try { reader = Reflect.apply(streamGetReader, body, []); } catch { throw invalidResponse(); }
  if (!reader || typeof reader !== 'object' || isProxy(reader)) throw invalidResponse();
  try {
    if (Object.getPrototypeOf(reader) !== ReadableStreamDefaultReader.prototype) throw invalidResponse();
  } catch {
    throw invalidResponse();
  }
  return Object.freeze({
    read: () => Reflect.apply(readerRead, reader, []),
    cancel: () => Reflect.apply(readerCancel, reader, []),
    releaseLock: () => Reflect.apply(readerReleaseLock, reader, []),
  });
}

async function boundedResponsePayload(response, maxResponseBytes, signal) {
  if (response.body !== null && response.body !== undefined) {
    const reader = openBodyReader(response.body);
    const chunks = [];
    let total = 0;
    let completed = false;
    try {
      while (true) {
        const { done, value } = await raceNativePromise(reader.read(), { signal });
        if (done) {
          completed = true;
          break;
        }
        const remaining = maxResponseBytes - total;
        let chunk;
        try { chunk = snapshotUint8Array(value, remaining, invalidResponse); } catch {
          try { ignoreNativePromise(reader.cancel()); } catch { /* bounded cancellation */ }
          throw invalidResponse();
        }
        total += chunk.length;
        chunks.push(chunk);
      }
    } finally {
      if (!completed) {
        try { ignoreNativePromise(reader.cancel()); } catch { /* bounded cancellation */ }
      }
      try { reader.releaseLock(); } catch { /* pending readers remain observed */ }
    }
    try {
      return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
    } catch {
      throw createComfyUiClientError('COMFY_RESPONSE_INVALID');
    }
  }
  if (response.readText) {
    const text = await raceNativePromise(response.readText(), { signal });
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
      throw createComfyUiClientError('COMFY_RESPONSE_INVALID');
    }
    try { return JSON.parse(text); } catch { throw createComfyUiClientError('COMFY_RESPONSE_INVALID'); }
  }
  if (response.readJson) {
    return raceNativePromise(response.readJson(), { signal });
  }
  throw createComfyUiClientError('COMFY_RESPONSE_INVALID');
}

function createComfyHttpTransport({ baseUrl, fetchImpl, requestTimeoutMs }) {
  const origin = normalizeBaseUrl(baseUrl);
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(requestTimeoutMs)
    || requestTimeoutMs < 1 || requestTimeoutMs > 300000) throw new TypeError('ComfyUI transport input is invalid');

  async function requestJson(pathname, {
    method = 'GET',
    jsonBody,
    formBody,
    signal,
    maxResponseBytes = 16 * 1024 * 1024,
  } = {}) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')
      || pathname.includes('\\') || !Number.isSafeInteger(maxResponseBytes)
      || maxResponseBytes < 1 || maxResponseBytes > 32 * 1024 * 1024
      || (jsonBody !== undefined && formBody !== undefined)) {
      throw new TypeError('ComfyUI transport request is invalid');
    }
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal) {
      if (abortedGetter.call(signal)) controller.abort();
      else addEventListener.call(signal, 'abort', abortFromCaller, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      if (controller.signal.aborted) {
        throw createComfyUiClientError('COMFY_REQUEST_ABORTED');
      }
      const headers = { Accept: 'application/json' };
      if (jsonBody !== undefined) headers['Content-Type'] = 'application/json';
      const fetchPromise = fetchImpl(new URL(pathname, `${origin}/`).toString(), {
        method,
        redirect: 'error',
        headers,
        ...(jsonBody === undefined && formBody === undefined ? {} : {
          body: jsonBody === undefined ? formBody : JSON.stringify(jsonBody),
        }),
        signal: controller.signal,
      });
      const response = adaptResponse(await raceNativePromise(fetchPromise, {
        signal: controller.signal,
      }));
      if (!response.ok) {
        throw createComfyUiClientError('COMFY_HTTP_ERROR', { status: response.status });
      }
      const payload = await boundedResponsePayload(
        response,
        maxResponseBytes,
        controller.signal,
      );
      return safeResponseSnapshot(payload, maxResponseBytes);
    } catch (error) {
      if (isComfyUiClientError(error)) throw error;
      if (controller.signal.aborted) throw createComfyUiClientError('COMFY_REQUEST_ABORTED');
      throw createComfyUiClientError('COMFY_CONNECTION_FAILED');
    } finally {
      clearTimeout(timer);
      if (signal) removeEventListener.call(signal, 'abort', abortFromCaller);
    }
  }

  return Object.freeze({ origin, requestJson });
}

module.exports = { createComfyHttpTransport };
