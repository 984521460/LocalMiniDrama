'use strict';

const { types: { isProxy } } = require('node:util');

const { snapshotJson } = require('../../workflows/jsonSnapshot');
const { snapshotBuffer } = require('./byteSnapshot');
const { createComfyUiClientError } = require('./errors');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]']);
const PROMPT_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/u;
const MEDIA_KEYS = Object.freeze({ images: 'image', gifs: 'video', audio: 'audio' });
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;

function invalidInput() {
  return new TypeError('ComfyUI client input is invalid');
}

function invalidResponse() {
  return createComfyUiClientError('COMFY_RESPONSE_INVALID');
}

function exactObject(value, keys, errorFactory = invalidInput) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw errorFactory();
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw errorFactory();
  }
  if (prototype !== Object.prototype && prototype !== null) throw errorFactory();
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw errorFactory();
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw errorFactory();
    result[key] = descriptor.value;
  }
  return result;
}

function partialObject(value, keys) {
  if (value === undefined) return Object.create(null);
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw invalidInput();
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw invalidInput();
  }
  if (prototype !== Object.prototype && prototype !== null) throw invalidInput();
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) throw invalidInput();
  const result = Object.create(null);
  for (const key of ownKeys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalidInput();
    result[key] = descriptor.value;
  }
  return result;
}

function abortSignal(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || isProxy(value)
    || typeof AbortSignal !== 'function' || Object.getPrototypeOf(value) !== AbortSignal.prototype) {
    throw invalidInput();
  }
  return value;
}

function signalAborted(value) {
  try { return ABORTED_GETTER.call(value); } catch { throw invalidInput(); }
}

function clientConfiguration(value) {
  const input = partialObject(value, [
    'baseUrl', 'fetchImpl', 'requestTimeoutMs', 'sleepImpl', 'maxUploadBytes',
  ]);
  return input;
}

function requestOptions(value) {
  const input = partialObject(value, ['signal']);
  return Object.freeze({ signal: abortSignal(input.signal) });
}

function submissionOptions(value) {
  const input = partialObject(value, ['clientId', 'signal']);
  return Object.freeze({
    clientId: input.clientId === undefined ? undefined : clientId(input.clientId),
    signal: abortSignal(input.signal),
  });
}

function waitOptions(value) {
  const input = partialObject(value, ['timeoutMs', 'pollIntervalMs', 'signal']);
  const timeoutMs = input.timeoutMs === undefined ? 10 * 60_000 : input.timeoutMs;
  const pollIntervalMs = input.pollIntervalMs === undefined ? 1_000 : input.pollIntervalMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60000) {
    throw invalidInput();
  }
  return Object.freeze({ timeoutMs, pollIntervalMs, signal: abortSignal(input.signal) });
}

function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(typeof value === 'string' ? value : '');
  } catch {
    throw invalidInput();
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username || parsed.password
    || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw invalidInput();
  }
  return parsed.origin;
}

function promptId(value) {
  if (typeof value !== 'string' || !PROMPT_ID.test(value)) throw invalidInput();
  return value;
}

function clientId(value) {
  if (typeof value !== 'string' || !CLIENT_ID.test(value)) throw invalidInput();
  return value;
}

function promptGraph(value) {
  const snapshot = snapshotJson(value, {
    maxArrayLength: 5000,
    maxDepth: 30,
    maxEntries: 50000,
    maxStringBytes: 512 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
  });
  if (!snapshot || Array.isArray(snapshot) || Object.keys(snapshot).length < 1) throw invalidInput();
  return snapshot;
}

function safeResponseSnapshot(value, maxTotalBytes = 16 * 1024 * 1024) {
  let snapshot;
  try {
    snapshot = snapshotJson(value, {
      maxArrayLength: 20000,
      maxDepth: 30,
      maxEntries: 100000,
      maxStringBytes: 2 * 1024 * 1024,
      maxTotalBytes,
    });
  } catch {
    throw invalidResponse();
  }
  if (!snapshot || Array.isArray(snapshot)) throw invalidResponse();
  return snapshot;
}

function parseSubmissionResponse(value) {
  const response = safeResponseSnapshot(value, 2 * 1024 * 1024);
  const errors = response.node_errors;
  if (errors !== undefined) {
    if (!errors || Array.isArray(errors) || typeof errors !== 'object') throw invalidResponse();
    if (Object.keys(errors).length > 0) {
      throw createComfyUiClientError('COMFY_SUBMISSION_REJECTED');
    }
  }
  if (typeof response.prompt_id !== 'string' || !PROMPT_ID.test(response.prompt_id)) {
    throw invalidResponse();
  }
  return Object.freeze({ promptId: response.prompt_id });
}

function safeFileName(value) {
  if (typeof value !== 'string' || !FILE_NAME.test(value) || value === '.' || value === '..') {
    throw invalidResponse();
  }
  return value;
}

function safeSubfolder(value, errorFactory = invalidResponse) {
  if (typeof value !== 'string' || value !== value.trim() || value.includes('\\')
    || value.includes(':') || value.startsWith('/') || value.endsWith('/')
    || value.includes('\0') || value.length > 1024) throw errorFactory();
  if (value === '') return value;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) {
    throw errorFactory();
  }
  return value;
}

function collectOutputDescriptors(outputs) {
  if (outputs === undefined) return Object.freeze([]);
  if (!outputs || Array.isArray(outputs) || typeof outputs !== 'object') throw invalidResponse();
  const descriptors = [];
  const identities = new Set();
  for (const nodeId of Object.keys(outputs).sort()) {
    if (!PROMPT_ID.test(nodeId)) throw invalidResponse();
    const nodeOutput = outputs[nodeId];
    if (!nodeOutput || Array.isArray(nodeOutput) || typeof nodeOutput !== 'object') throw invalidResponse();
    for (const [key, mediaKind] of Object.entries(MEDIA_KEYS)) {
      const records = nodeOutput[key];
      if (records === undefined) continue;
      if (!Array.isArray(records) || records.length > 256) throw invalidResponse();
      for (const record of records) {
        const input = exactObject(record, ['filename', 'subfolder', 'type'], invalidResponse);
        const fileName = safeFileName(input.filename);
        const subfolder = safeSubfolder(input.subfolder);
        if (input.type !== 'output') throw invalidResponse();
        const identity = `${input.type}\0${subfolder}\0${fileName}`;
        if (identities.has(identity) || descriptors.length >= 256) throw invalidResponse();
        identities.add(identity);
        descriptors.push(Object.freeze({
          nodeId,
          mediaKind,
          fileName,
          subfolder,
          storageType: input.type,
        }));
      }
    }
  }
  return Object.freeze(descriptors);
}

function parsePromptState(historyResponse, requestedPromptId) {
  const response = safeResponseSnapshot(historyResponse, 16 * 1024 * 1024);
  const normalizedPromptId = promptId(requestedPromptId);
  if (!Object.hasOwn(response, normalizedPromptId)) {
    return Object.freeze({ promptId: normalizedPromptId, state: 'missing', outputs: Object.freeze([]) });
  }
  const record = response[normalizedPromptId];
  if (!record || Array.isArray(record) || typeof record !== 'object') throw invalidResponse();
  const status = record.status;
  if (!status || Array.isArray(status) || typeof status !== 'object'
    || typeof status.completed !== 'boolean' || typeof status.status_str !== 'string') {
    throw invalidResponse();
  }
  const statusText = status.status_str.toLowerCase();
  let state = 'running';
  if (status.completed && statusText === 'success') state = 'succeeded';
  else if (statusText === 'error' || statusText === 'failed'
    || (status.completed && statusText !== 'success')) state = 'failed';
  const outputs = state === 'succeeded'
    ? collectOutputDescriptors(record.outputs)
    : Object.freeze([]);
  return Object.freeze({ promptId: normalizedPromptId, state, outputs });
}

function uploadInput(value, maxUploadBytes) {
  const input = exactObject(value, ['fileName', 'subfolder', 'bytes', 'overwrite']);
  let fileName;
  try { fileName = safeFileName(input.fileName); } catch { throw invalidInput(); }
  const subfolder = safeSubfolder(input.subfolder, invalidInput);
  if (typeof input.overwrite !== 'boolean') throw invalidInput();
  const bytes = snapshotBuffer(input.bytes, maxUploadBytes, invalidInput);
  return Object.freeze({
    fileName,
    subfolder,
    bytes,
    overwrite: input.overwrite,
  });
}

function parseUploadResponse(value) {
  const response = safeResponseSnapshot(value, 1024 * 1024);
  const fileName = safeFileName(response.name);
  const subfolder = safeSubfolder(response.subfolder);
  if (response.type !== 'input') throw invalidResponse();
  return Object.freeze({ fileName, subfolder, storageType: 'input' });
}

function outputDownload(value) {
  const input = exactObject(value, ['fileName', 'subfolder', 'storageType']);
  let fileName;
  try { fileName = safeFileName(input.fileName); } catch { throw invalidInput(); }
  const subfolder = safeSubfolder(input.subfolder, invalidInput);
  if (input.storageType !== 'output') throw invalidInput();
  return Object.freeze({ fileName, subfolder, storageType: 'output' });
}

module.exports = {
  clientConfiguration,
  clientId,
  normalizeBaseUrl,
  outputDownload,
  parsePromptState,
  parseSubmissionResponse,
  parseUploadResponse,
  promptGraph,
  promptId,
  requestOptions,
  safeResponseSnapshot,
  signalAborted,
  submissionOptions,
  uploadInput,
  waitOptions,
};
