'use strict';

const { types: { isProxy } } = require('node:util');

const { snapshotUint8Array } = require('../integrations/comfyui/byteSnapshot');
const { fail } = require('./audioContract');
const { ignoreTtsPromise, settleTtsPromise } = require('./ttsAsyncControl');

const STREAM_GET_READER = ReadableStream.prototype.getReader;
const READER_READ = ReadableStreamDefaultReader.prototype.read;
const READER_CANCEL = ReadableStreamDefaultReader.prototype.cancel;
const READER_RELEASE_LOCK = ReadableStreamDefaultReader.prototype.releaseLock;
const DEFINE_PROPERTY = Object.defineProperty;

function append(target, value) {
  DEFINE_PROPERTY(target, String(target.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function invalid() {
  fail('AUDIO_TTS_RESPONSE_INVALID');
}

function openReader(body) {
  if (!body || typeof body !== 'object' || isProxy(body)) invalid();
  try {
    if (Object.getPrototypeOf(body) !== ReadableStream.prototype) invalid();
    const reader = Reflect.apply(STREAM_GET_READER, body, []);
    if (!reader || typeof reader !== 'object' || isProxy(reader)
      || Object.getPrototypeOf(reader) !== ReadableStreamDefaultReader.prototype) invalid();
    return Object.freeze({
      read: () => Reflect.apply(READER_READ, reader, []),
      cancel: () => Reflect.apply(READER_CANCEL, reader, []),
      release: () => Reflect.apply(READER_RELEASE_LOCK, reader, []),
    });
  } catch {
    return invalid();
  }
}

function readBoundedTtsResponse(body, signal, maxBytes) {
  const pending = (async () => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) {
      invalid();
    }
    const reader = openReader(body);
    const chunks = [];
    let total = 0;
    let complete = false;
    try {
      while (true) {
        let item;
        try { item = await settleTtsPromise(reader.read(), { signal }); } catch {
          if (signal.aborted) fail('AUDIO_TTS_REQUEST_ABORTED');
          return invalid();
        }
        if (!item || typeof item !== 'object' || isProxy(item)) invalid();
        const descriptors = Object.getOwnPropertyDescriptors(item);
        const done = descriptors.done;
        const value = descriptors.value;
        if (!done || !Object.hasOwn(done, 'value') || typeof done.value !== 'boolean'
          || !value || !Object.hasOwn(value, 'value')) invalid();
        if (done.value) {
          if (value.value !== undefined) invalid();
          complete = true;
          break;
        }
        const remaining = maxBytes - total;
        if (remaining < 1) invalid();
        const chunk = snapshotUint8Array(value.value, remaining, invalid);
        total += chunk.length;
        append(chunks, chunk);
      }
    } finally {
      if (!complete) {
        try { ignoreTtsPromise(reader.cancel()); } catch { /* bounded cleanup */ }
      }
      try { reader.release(); } catch { /* reader remains observed */ }
    }
    if (total < 1) invalid();
    return Buffer.concat(chunks, total);
  })();
  return settleTtsPromise(pending);
}

module.exports = Object.freeze({ readBoundedTtsResponse });
