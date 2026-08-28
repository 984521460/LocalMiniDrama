'use strict';

const { types: { isProxy } } = require('node:util');

const { ignoreNativePromise, raceNativePromise } = require('../integrations/comfyui/asyncControl');
const { snapshotUint8Array } = require('../integrations/comfyui/byteSnapshot');
const { fail } = require('./errors');

const streamGetReader = ReadableStream.prototype.getReader;
const readerRead = ReadableStreamDefaultReader.prototype.read;
const readerCancel = ReadableStreamDefaultReader.prototype.cancel;
const readerReleaseLock = ReadableStreamDefaultReader.prototype.releaseLock;

function invalid() {
  return fail('H3_API_RESPONSE_INVALID');
}

function openReader(body) {
  if (body === null || typeof body !== 'object' || isProxy(body)) invalid();
  let reader;
  try {
    if (Object.getPrototypeOf(body) !== ReadableStream.prototype) invalid();
    reader = Reflect.apply(streamGetReader, body, []);
    if (!reader || typeof reader !== 'object' || isProxy(reader)
      || Object.getPrototypeOf(reader) !== ReadableStreamDefaultReader.prototype) invalid();
  } catch {
    return invalid();
  }
  return Object.freeze({
    read: () => Reflect.apply(readerRead, reader, []),
    cancel: () => Reflect.apply(readerCancel, reader, []),
    release: () => Reflect.apply(readerReleaseLock, reader, []),
  });
}

async function readBoundedResponseText(body, signal, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) invalid();
  const reader = openReader(body);
  const chunks = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      let item;
      try { item = await raceNativePromise(reader.read(), { signal }); } catch {
        if (signal.aborted) fail('H3_API_REQUEST_ABORTED');
        return invalid();
      }
      if (item.done) {
        complete = true;
        break;
      }
      let chunk;
      try {
        chunk = snapshotUint8Array(item.value, maxBytes - total, invalid);
      } catch {
        return invalid();
      }
      total += chunk.length;
      chunks.push(chunk);
    }
  } finally {
    if (!complete) {
      try { ignoreNativePromise(reader.cancel()); } catch { /* bounded cleanup */ }
    }
    try { reader.release(); } catch { /* reader remains observed */ }
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

module.exports = Object.freeze({ readBoundedResponseText });
