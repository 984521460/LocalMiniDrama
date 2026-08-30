'use strict';

const fs = require('node:fs');

const DOWNLOAD_LIMIT_EXCEEDED = 'DOWNLOAD_LIMIT_EXCEEDED';

class DownloadLimitError extends Error {
  constructor() {
    super('Remote download exceeded the resource limit');
    this.name = 'DownloadLimitError';
    this.code = DOWNLOAD_LIMIT_EXCEEDED;
  }
}

function limitExceeded() {
  throw new DownloadLimitError();
}

function contentLength(response) {
  const value = response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length')
    : null;
  if (value === null || value === undefined || value === '') return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) limitExceeded();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) limitExceeded();
  return parsed;
}

async function downloadResponseBodyToFile(response, targetPath, {
  maxBytes,
  fsImpl = fs,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0
    || typeof targetPath !== 'string' || targetPath.length === 0) {
    throw new TypeError('bounded response download input invalid');
  }
  const declaredBytes = contentLength(response);
  if (declaredBytes !== null && declaredBytes > maxBytes) limitExceeded();
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    throw new TypeError('bounded response body unavailable');
  }

  const reader = response.body.getReader();
  const fd = fsImpl.openSync(targetPath, 'wx', 0o600);
  let totalBytes = 0;
  let completed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (!result || typeof result !== 'object') throw new TypeError('bounded response chunk invalid');
      if (result.done === true) break;
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
        throw new TypeError('bounded response chunk invalid');
      }
      if (totalBytes > maxBytes - chunk.byteLength) limitExceeded();
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let offset = 0;
      while (offset < buffer.length) {
        const written = fsImpl.writeSync(fd, buffer, offset, buffer.length - offset, null);
        if (!Number.isSafeInteger(written) || written <= 0) {
          throw new Error('bounded response write failed');
        }
        offset += written;
      }
      totalBytes += buffer.length;
    }
    if (declaredBytes !== null && totalBytes !== declaredBytes) {
      throw new Error('bounded response length mismatch');
    }
    fsImpl.fsyncSync(fd);
    completed = true;
    return Object.freeze({ bytes: totalBytes });
  } finally {
    try {
      fsImpl.closeSync(fd);
    } catch (_) {}
    if (!completed) {
      try {
        await reader.cancel();
      } catch (_) {}
      try {
        fsImpl.unlinkSync(targetPath);
      } catch (_) {}
    }
  }
}

module.exports = Object.freeze({
  DOWNLOAD_LIMIT_EXCEEDED,
  DownloadLimitError,
  downloadResponseBodyToFile,
});
