'use strict';

const crypto = require('node:crypto');
const { types: { isProxy } } = require('node:util');
const { snapshotJson } = require('../workflows/jsonSnapshot');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDEMPOTENCY_KEY = /^remote-task:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROMPT_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const ERROR_CODE = /^ERR_[A-Z0-9_]{1,60}$/u;
const ERROR_DETAIL_REF = /^error-detail:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._-]{1,96}$/u;
const DEFAULT_MAX_RETRIES = 3;
const MAX_CONFIGURED_RETRIES = 10;

const STAGE_STATUS = Object.freeze({
  prepared: 'queued',
  uploading: 'running',
  submitted: 'running',
  executing: 'running',
  downloading: 'running',
  verifying: 'running',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
});
const ERROR_PHASES = new Set([
  'connection', 'dependency', 'upload', 'submission', 'execution',
  'download', 'verification', 'recovery',
]);
const RECOVERY_STATES = new Set(['none', 'completed', 'retryable', 'orphaned']);
const MESSAGES = Object.freeze({
  REMOTE_TASK_INPUT_INVALID: 'Remote task input is invalid',
  REMOTE_TASK_DATA_INVALID: 'Remote task data is invalid',
  REMOTE_TASK_NOT_FOUND: 'Remote task was not found',
  REMOTE_TASK_CONFLICT: 'Remote task state changed before the operation completed',
  REMOTE_TASK_DEPENDENCY_NOT_READY: 'Remote task dependencies are not ready',
  REMOTE_TASK_SUBMISSION_FAILED: 'Remote task submission failed',
  REMOTE_TASK_RECOVERY_FAILED: 'Remote task recovery failed',
  REMOTE_TASK_UNEXPECTED: 'Remote task operation failed',
});
const TRUSTED_ERRORS = new WeakSet();

class RemoteTaskError extends Error {
  constructor(code) {
    if (!Object.hasOwn(MESSAGES, code)) throw new TypeError('Unknown remote task error code');
    super(MESSAGES[code]);
    this.name = 'RemoteTaskError';
    Object.defineProperty(this, 'code', {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    });
    TRUSTED_ERRORS.add(this);
    Object.freeze(this);
  }
}

function createRemoteTaskError(code) {
  return new RemoteTaskError(code);
}

function isRemoteTaskError(value) {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && TRUSTED_ERRORS.has(value);
}

function fail(code = 'REMOTE_TASK_INPUT_INVALID') {
  throw createRemoteTaskError(code);
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

function uid(value, code) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail(code);
  return value;
}

function nullableUid(value, code) {
  return value === null ? null : uid(value, code);
}

function remoteRelativeDir(value, code) {
  if (typeof value !== 'string' || value !== value.trim() || value.includes('\0')
    || value.includes('\\') || value.includes(':') || value.startsWith('/') || value.endsWith('/')
    || Buffer.byteLength(value, 'utf8') > 1024) fail(code);
  const segments = value.split('/');
  if (segments.length < 1 || segments.length > 32
    || segments.some((segment) => segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) fail(code);
  return value;
}

function canonicalTimestamp(value, nullable, code) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') fail(code);
  let normalized;
  try { normalized = new Date(value).toISOString(); } catch { fail(code); }
  if (normalized !== value) fail(code);
  return value;
}

function integer(value, min, max, code) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

function nullablePattern(value, pattern, code) {
  if (value === null) return null;
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
  return value;
}

function createRemoteTaskRequest(value) {
  const input = exactObject(value, [
    'connectionUid', 'connectionEvidenceSha256', 'workflowRunUid', 'workflowManifestUid',
    'idempotencyKey', 'promptSha256', 'remoteRelativeDir',
  ], ['maxRetries'], 'REMOTE_TASK_INPUT_INVALID');
  if (typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
    || typeof input.connectionEvidenceSha256 !== 'string'
    || !SHA256.test(input.connectionEvidenceSha256)
    || typeof input.promptSha256 !== 'string' || !SHA256.test(input.promptSha256)) fail();
  return Object.freeze({
    connectionUid: uid(input.connectionUid),
    connectionEvidenceSha256: input.connectionEvidenceSha256,
    workflowRunUid: nullableUid(input.workflowRunUid),
    workflowManifestUid: uid(input.workflowManifestUid),
    idempotencyKey: input.idempotencyKey,
    promptSha256: input.promptSha256,
    remoteRelativeDir: remoteRelativeDir(input.remoteRelativeDir),
    maxRetries: integer(
      input.maxRetries === undefined ? DEFAULT_MAX_RETRIES : input.maxRetries,
      0,
      MAX_CONFIGURED_RETRIES,
      'REMOTE_TASK_INPUT_INVALID',
    ),
  });
}

function hashRemoteTaskRequest(request) {
  const normalized = createRemoteTaskRequest(request);
  const legacyIdentity = {
    connectionUid: normalized.connectionUid,
    connectionEvidenceSha256: normalized.connectionEvidenceSha256,
    workflowRunUid: normalized.workflowRunUid,
    workflowManifestUid: normalized.workflowManifestUid,
    idempotencyKey: normalized.idempotencyKey,
    promptSha256: normalized.promptSha256,
    remoteRelativeDir: normalized.remoteRelativeDir,
  };
  return crypto.createHash('sha256').update(JSON.stringify(legacyIdentity)).digest('hex');
}

function hashRemoteTaskPrompt(prompt) {
  let snapshot;
  try {
    snapshot = snapshotJson(prompt, {
      maxArrayLength: 100_000,
      maxDepth: 64,
      maxEntries: 250_000,
      maxStringBytes: 4 * 1024 * 1024,
      maxTotalBytes: 16 * 1024 * 1024,
    });
  } catch {
    fail('REMOTE_TASK_INPUT_INVALID');
  }
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== 'object') fail();
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function createRemoteTaskRecord(value) {
  const code = 'REMOTE_TASK_DATA_INVALID';
  const input = exactObject(value, [
    'uid', 'connectionUid', 'connectionEvidenceSha256', 'workflowRunUid',
    'workflowManifestUid', 'contractVersion',
    'idempotencyKey', 'requestSha256', 'promptSha256', 'provider', 'promptId', 'remoteRelativeDir',
    'stage', 'status', 'heartbeatAt', 'retryCount', 'outputAssetVersionUid',
    'maxRetries',
    'errorCode', 'errorDetailRef', 'errorPhase', 'errorRetryable', 'recoveryState',
    'stateVersion', 'submissionLeaseExpiresAtEpochMs',
    'createdAt', 'startedAt', 'completedAt', 'updatedAt',
  ], [], code);
  if (input.contractVersion !== 'remote-task.v1' || input.provider !== 'comfyui'
    || typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
    || typeof input.connectionEvidenceSha256 !== 'string'
    || !SHA256.test(input.connectionEvidenceSha256)
    || typeof input.requestSha256 !== 'string' || !SHA256.test(input.requestSha256)
    || typeof input.promptSha256 !== 'string' || !SHA256.test(input.promptSha256)
    || !Object.hasOwn(STAGE_STATUS, input.stage) || STAGE_STATUS[input.stage] !== input.status
    || !RECOVERY_STATES.has(input.recoveryState)) fail(code);
  let expectedRequestSha256;
  try {
    expectedRequestSha256 = hashRemoteTaskRequest({
      connectionUid: input.connectionUid,
      connectionEvidenceSha256: input.connectionEvidenceSha256,
      workflowRunUid: input.workflowRunUid,
      workflowManifestUid: input.workflowManifestUid,
      idempotencyKey: input.idempotencyKey,
      promptSha256: input.promptSha256,
      remoteRelativeDir: input.remoteRelativeDir,
    });
  } catch {
    fail(code);
  }
  if (input.requestSha256 !== expectedRequestSha256) fail(code);
  const errorCode = nullablePattern(input.errorCode, ERROR_CODE, code);
  const maxRetries = integer(input.maxRetries, 0, MAX_CONFIGURED_RETRIES, code);
  const errorDetailRef = nullablePattern(input.errorDetailRef, ERROR_DETAIL_REF, code);
  const errorPhase = input.errorPhase === null ? null : input.errorPhase;
  if (errorPhase !== null && !ERROR_PHASES.has(errorPhase)) fail(code);
  const errorRetryable = input.errorRetryable;
  if (errorRetryable !== null && errorRetryable !== 0 && errorRetryable !== 1
    && errorRetryable !== false && errorRetryable !== true) fail(code);
  if (input.stage === 'failed') {
    if (errorCode === null || errorPhase === null || errorRetryable === null
      || !['retryable', 'orphaned'].includes(input.recoveryState)) fail(code);
    if ((input.recoveryState === 'retryable' && !Boolean(errorRetryable))
      || (input.recoveryState === 'orphaned' && Boolean(errorRetryable))) fail(code);
  } else if (errorCode !== null || errorDetailRef !== null || errorPhase !== null
    || errorRetryable !== null) fail(code);
  if (input.recoveryState === 'completed'
    && !['downloading', 'verifying', 'completed'].includes(input.stage)) fail(code);
  if (['retryable', 'orphaned'].includes(input.recoveryState) && input.stage !== 'failed') fail(code);
  if (['executing', 'downloading', 'verifying', 'completed'].includes(input.stage)
    && nullablePattern(input.promptId, PROMPT_ID, code) === null) fail(code);
  if (['prepared', 'uploading'].includes(input.stage) && input.promptId !== null) fail(code);
  const submissionLeaseExpiresAtEpochMs = input.submissionLeaseExpiresAtEpochMs === null
    ? null : integer(input.submissionLeaseExpiresAtEpochMs, 0, 8_640_000_000_000_000, code);
  if (input.stage === 'submitted' && input.promptId === null) {
    if (submissionLeaseExpiresAtEpochMs === null) fail(code);
  } else if (submissionLeaseExpiresAtEpochMs !== null) {
    fail(code);
  }
  if (input.stage === 'prepared' && input.startedAt !== null) fail(code);
  if (input.status === 'running' && input.startedAt === null) fail(code);
  if (input.status !== 'running' && input.heartbeatAt !== null) fail(code);
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(input.status);
  if ((terminal && input.completedAt === null) || (!terminal && input.completedAt !== null)) fail(code);
  if (input.outputAssetVersionUid !== null && input.stage !== 'completed') fail(code);
  if (input.updatedAt < input.createdAt
    || (input.startedAt !== null && input.startedAt < input.createdAt)
    || (input.completedAt !== null && input.completedAt < input.createdAt)) fail(code);
  return Object.freeze({
    uid: uid(input.uid, code),
    connectionUid: uid(input.connectionUid, code),
    connectionEvidenceSha256: input.connectionEvidenceSha256,
    workflowRunUid: nullableUid(input.workflowRunUid, code),
    workflowManifestUid: uid(input.workflowManifestUid, code),
    contractVersion: input.contractVersion,
    idempotencyKey: input.idempotencyKey,
    requestSha256: input.requestSha256,
    promptSha256: input.promptSha256,
    provider: input.provider,
    promptId: nullablePattern(input.promptId, PROMPT_ID, code),
    remoteRelativeDir: remoteRelativeDir(input.remoteRelativeDir, code),
    stage: input.stage,
    status: input.status,
    heartbeatAt: canonicalTimestamp(input.heartbeatAt, true, code),
    retryCount: integer(input.retryCount, 0, maxRetries, code),
    maxRetries,
    outputAssetVersionUid: nullableUid(input.outputAssetVersionUid, code),
    errorCode,
    errorDetailRef,
    errorPhase,
    errorRetryable: errorRetryable === null ? null : Boolean(errorRetryable),
    recoveryState: input.recoveryState,
    stateVersion: integer(input.stateVersion, 0, 2_147_483_647, code),
    submissionLeaseExpiresAtEpochMs,
    createdAt: canonicalTimestamp(input.createdAt, false, code),
    startedAt: canonicalTimestamp(input.startedAt, true, code),
    completedAt: canonicalTimestamp(input.completedAt, true, code),
    updatedAt: canonicalTimestamp(input.updatedAt, false, code),
  });
}

module.exports = Object.freeze({
  RemoteTaskError,
  createRemoteTaskError,
  createRemoteTaskRecord,
  createRemoteTaskRequest,
  DEFAULT_MAX_RETRIES,
  hashRemoteTaskRequest,
  hashRemoteTaskPrompt,
  isRemoteTaskError,
});
