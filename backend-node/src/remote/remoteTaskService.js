'use strict';

const crypto = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { raceNativePromise } = require('../integrations/comfyui/asyncControl');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../repositories/v2/errors');
const { snapshotJson } = require('../workflows/jsonSnapshot');
const {
  createRemoteTaskError,
  createRemoteTaskRequest,
  hashRemoteTaskPrompt,
  hashRemoteTaskRequest,
  isRemoteTaskError,
} = require('./remoteTask');
const { createRemoteTaskRetryClassification } = require('./remoteRetryPolicy');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROMPT_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const ERROR_CODE = /^ERR_[A-Z0-9_]{1,60}$/u;
const DEFAULT_TIMEOUT_MS = 30_000;
const SUBMISSION_LEASE_GRACE_MS = 5_000;
const RECOVERY_PAGE_LIMIT = 100;
const FAILURE_PHASES = new Set([
  'connection', 'dependency', 'upload', 'submission', 'execution',
  'download', 'verification', 'recovery',
]);

function fail(code) {
  throw createRemoteTaskError(code);
}

function exactObject(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('REMOTE_TASK_INPUT_INVALID');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail('REMOTE_TASK_INPUT_INVALID');
  }
  if (prototype !== Object.prototype && prototype !== null) fail('REMOTE_TASK_INPUT_INVALID');
  const allowed = new Set([...required, ...optional]);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !allowed.has(key) || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')) fail('REMOTE_TASK_INPUT_INVALID');
    output[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(output, key))) fail('REMOTE_TASK_INPUT_INVALID');
  return output;
}

function configuration(value) {
  const input = exactObject(value, [
    'repository', 'manifestRepository',
  ], ['client', 'dependencyChecker', 'remoteClient', 'createUid', 'now', 'timeoutMs']);
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new TypeError('Remote task service configuration is invalid');
  }
  const methods = [
    [input.repository, [
      'createFormalTaskIdempotent', 'getFormalTask', 'transitionFormalTask',
      'assignFormalPrompt', 'heartbeatFormalTask', 'listRecoverableFormalTasks',
      'renewFormalSubmissionLease',
    ]],
    [input.manifestRepository, ['get']],
  ];
  const connectionAware = input.remoteClient !== undefined;
  if (connectionAware) {
    if (input.client !== undefined || input.dependencyChecker !== undefined) {
      throw new TypeError('Remote task service configuration is invalid');
    }
    methods.push([input.remoteClient, [
      'requireReady', 'submitPrompt', 'getPromptState', 'queueSnapshot',
    ]]);
  } else {
    if (input.client === undefined || input.dependencyChecker === undefined) {
      throw new TypeError('Remote task service configuration is invalid');
    }
    methods.push(
      [input.client, ['submitPrompt', 'getPromptState', 'queueSnapshot']],
      [input.dependencyChecker, ['requireReady']],
    );
  }
  const captured = [];
  for (const [target, names] of methods) {
    if (!target || typeof target !== 'object' || isProxy(target)) {
      throw new TypeError('Remote task service configuration is invalid');
    }
    let descriptors;
    try { descriptors = Object.getOwnPropertyDescriptors(target); } catch {
      throw new TypeError('Remote task service configuration is invalid');
    }
    const targetMethods = Object.create(null);
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function'
        || isProxy(descriptor.value)) throw new TypeError('Remote task service configuration is invalid');
      targetMethods[name] = descriptor.value;
    }
    captured.push(Object.freeze({ target, methods: Object.freeze(targetMethods) }));
  }
  const createUid = input.createUid === undefined ? () => crypto.randomUUID() : input.createUid;
  const now = input.now === undefined ? () => new Date().toISOString() : input.now;
  if (typeof createUid !== 'function' || typeof now !== 'function' || isProxy(createUid) || isProxy(now)) {
    throw new TypeError('Remote task service configuration is invalid');
  }
  return Object.freeze({
    repository: captured[0],
    manifestRepository: captured[1],
    client: connectionAware ? null : captured[2],
    dependencyChecker: connectionAware ? null : captured[3],
    remoteClient: connectionAware ? captured[2] : null,
    createUid,
    now,
    timeoutMs,
  });
}

function callSync(binding, name, argumentsList) {
  try { return Reflect.apply(binding.methods[name], binding.target, argumentsList); } catch (error) {
    if (error instanceof V2RepositoryNotFoundError) fail('REMOTE_TASK_NOT_FOUND');
    if (error instanceof V2RepositoryConflictError) fail('REMOTE_TASK_CONFLICT');
    if (error instanceof V2RepositoryDataError) fail('REMOTE_TASK_DATA_INVALID');
    throw error;
  }
}

async function callAsync(binding, name, argumentsList, timeoutMs, errorCode) {
  let pending;
  try { pending = Reflect.apply(binding.methods[name], binding.target, argumentsList); } catch {
    fail(errorCode);
  }
  try { return await raceNativePromise(pending, { timeoutMs }); } catch {
    fail(errorCode);
  }
}

function taskUid(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail('REMOTE_TASK_INPUT_INVALID');
  return value;
}

function preparationRequest(value) {
  const input = exactObject(value, [
    'connectionUid', 'connectionEvidenceSha256', 'workflowRunUid', 'workflowManifestUid',
    'idempotencyKey', 'promptSha256', 'remoteRelativeDir',
  ], ['taskUid', 'maxRetries']);
  return Object.freeze({
    requestedTaskUid: input.taskUid === undefined ? null : taskUid(input.taskUid),
    request: createRemoteTaskRequest({
      connectionUid: input.connectionUid,
      connectionEvidenceSha256: input.connectionEvidenceSha256,
      workflowRunUid: input.workflowRunUid,
      workflowManifestUid: input.workflowManifestUid,
      idempotencyKey: input.idempotencyKey,
      promptSha256: input.promptSha256,
      remoteRelativeDir: input.remoteRelativeDir,
      ...(input.maxRetries === undefined ? {} : { maxRetries: input.maxRetries }),
    }),
  });
}

function stateVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    fail('REMOTE_TASK_INPUT_INVALID');
  }
  return value;
}

function expectedVersionRequest(value) {
  const input = exactObject(value, ['expectedStateVersion']);
  return Object.freeze({ expectedStateVersion: stateVersion(input.expectedStateVersion) });
}

function outputCompletionRequest(value) {
  const input = exactObject(value, ['expectedStateVersion', 'outputAssetVersionUid']);
  return Object.freeze({
    expectedStateVersion: stateVersion(input.expectedStateVersion),
    outputAssetVersionUid: taskUid(input.outputAssetVersionUid),
  });
}

function failureRequest(value) {
  const input = exactObject(value, [
    'expectedStateVersion', 'phase', 'errorCode', 'retryable',
  ]);
  if (!FAILURE_PHASES.has(input.phase) || typeof input.errorCode !== 'string'
    || !ERROR_CODE.test(input.errorCode) || typeof input.retryable !== 'boolean') {
    fail('REMOTE_TASK_INPUT_INVALID');
  }
  return Object.freeze({
    expectedStateVersion: stateVersion(input.expectedStateVersion),
    phase: input.phase,
    errorCode: input.errorCode,
    retryable: input.retryable,
  });
}

function currentEpochMs(now) {
  let timestamp;
  try { timestamp = now(); } catch { fail('REMOTE_TASK_UNEXPECTED'); }
  if (typeof timestamp !== 'string') fail('REMOTE_TASK_UNEXPECTED');
  let epochMs;
  try { epochMs = new Date(timestamp).getTime(); } catch { fail('REMOTE_TASK_UNEXPECTED'); }
  if (!Number.isSafeInteger(epochMs)) fail('REMOTE_TASK_UNEXPECTED');
  try {
    if (new Date(epochMs).toISOString() !== timestamp) fail('REMOTE_TASK_UNEXPECTED');
  } catch {
    fail('REMOTE_TASK_UNEXPECTED');
  }
  return epochMs;
}

function recoveryPage(value, afterCreatedAt, afterUid) {
  if (isProxy(value) || !Array.isArray(value)) fail('REMOTE_TASK_DATA_INVALID');
  let prototype;
  let lengthDescriptor;
  try {
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    fail('REMOTE_TASK_DATA_INVALID');
  }
  if (prototype !== Array.prototype || !lengthDescriptor
    || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0 || lengthDescriptor.value > RECOVERY_PAGE_LIMIT) {
    fail('REMOTE_TASK_DATA_INVALID');
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch {
    fail('REMOTE_TASK_DATA_INVALID');
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')
    || keys.length !== lengthDescriptor.value + 1) fail('REMOTE_TASK_DATA_INVALID');
  const tasks = [];
  let previousCreatedAt = afterCreatedAt;
  let previousUid = afterUid;
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const itemDescriptor = descriptors[String(index)];
    if (!itemDescriptor?.enumerable || !Object.hasOwn(itemDescriptor, 'value')) {
      fail('REMOTE_TASK_DATA_INVALID');
    }
    const item = itemDescriptor.value;
    if (!item || typeof item !== 'object' || Array.isArray(item) || isProxy(item)) {
      fail('REMOTE_TASK_DATA_INVALID');
    }
    let itemPrototype;
    let uidDescriptor;
    let createdAtDescriptor;
    try {
      itemPrototype = Object.getPrototypeOf(item);
      uidDescriptor = Object.getOwnPropertyDescriptor(item, 'uid');
      createdAtDescriptor = Object.getOwnPropertyDescriptor(item, 'createdAt');
    } catch {
      fail('REMOTE_TASK_DATA_INVALID');
    }
    if ((itemPrototype !== Object.prototype && itemPrototype !== null)
      || !uidDescriptor?.enumerable || !Object.hasOwn(uidDescriptor, 'value')
      || !createdAtDescriptor?.enumerable || !Object.hasOwn(createdAtDescriptor, 'value')
      || typeof uidDescriptor.value !== 'string' || !UUID_V4.test(uidDescriptor.value)
      || typeof createdAtDescriptor.value !== 'string') fail('REMOTE_TASK_DATA_INVALID');
    let canonical = false;
    try {
      canonical = new Date(createdAtDescriptor.value).toISOString() === createdAtDescriptor.value;
    } catch { /* invalid */ }
    const strictlyAfter = previousCreatedAt === null
      || createdAtDescriptor.value > previousCreatedAt
      || (createdAtDescriptor.value === previousCreatedAt && uidDescriptor.value > previousUid);
    if (!canonical || !strictlyAfter) fail('REMOTE_TASK_DATA_INVALID');
    previousCreatedAt = createdAtDescriptor.value;
    previousUid = uidDescriptor.value;
    tasks.push(Object.freeze({ uid: uidDescriptor.value, createdAt: createdAtDescriptor.value }));
  }
  return Object.freeze(tasks);
}

function submissionLeaseExpiry(now, timeoutMs) {
  const expiresAt = currentEpochMs(now) + timeoutMs + SUBMISSION_LEASE_GRACE_MS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt > 8_640_000_000_000_000) {
    fail('REMOTE_TASK_UNEXPECTED');
  }
  return expiresAt;
}

function promptSubmission(value) {
  const input = exactObject(value, ['expectedStateVersion', 'prompt']);
  if (input.prompt === null || typeof input.prompt !== 'object' || Array.isArray(input.prompt)
    || isProxy(input.prompt)) fail('REMOTE_TASK_INPUT_INVALID');
  return Object.freeze({
    expectedStateVersion: stateVersion(input.expectedStateVersion),
    prompt: input.prompt,
  });
}

function safePromptId(value, errorCode) {
  let snapshot;
  try { snapshot = snapshotJson(value, { maxDepth: 4, maxEntries: 8, maxStringBytes: 256 }); } catch {
    fail(errorCode);
  }
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== 'object'
    || Reflect.ownKeys(snapshot).length !== 1 || !Object.hasOwn(snapshot, 'promptId')
    || typeof snapshot.promptId !== 'string' || !PROMPT_ID.test(snapshot.promptId)) fail(errorCode);
  return snapshot.promptId;
}

function safePromptState(value, expectedPromptId) {
  let snapshot;
  try { snapshot = snapshotJson(value, { maxDepth: 12, maxEntries: 10_000, maxStringBytes: 4096 }); } catch {
    fail('REMOTE_TASK_RECOVERY_FAILED');
  }
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== 'object'
    || !Object.hasOwn(snapshot, 'promptId') || snapshot.promptId !== expectedPromptId
    || !['missing', 'running', 'succeeded', 'failed'].includes(snapshot.state)
    || !Array.isArray(snapshot.outputs)) fail('REMOTE_TASK_RECOVERY_FAILED');
  return snapshot;
}

function queueContainsPrompt(value, promptId) {
  let snapshot;
  try { snapshot = snapshotJson(value, { maxDepth: 16, maxEntries: 50_000, maxStringBytes: 4096 }); } catch {
    fail('REMOTE_TASK_RECOVERY_FAILED');
  }
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== 'object') {
    fail('REMOTE_TASK_RECOVERY_FAILED');
  }
  const allowed = new Set(['queue_running', 'queue_pending']);
  if (Reflect.ownKeys(snapshot).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    fail('REMOTE_TASK_RECOVERY_FAILED');
  }
  for (const key of allowed) {
    const queue = snapshot[key];
    if (!Array.isArray(queue)) fail('REMOTE_TASK_RECOVERY_FAILED');
    for (const entry of queue) {
      if (!Array.isArray(entry) || entry.length < 2 || entry.length > 8
        || typeof entry[1] !== 'string' || !PROMPT_ID.test(entry[1])) {
        fail('REMOTE_TASK_RECOVERY_FAILED');
      }
      if (entry[1] === promptId) return true;
    }
  }
  return false;
}

function createRemoteTaskService(options) {
  const configured = configuration(options);
  const {
    repository, manifestRepository, client, dependencyChecker, remoteClient,
    createUid, now, timeoutMs,
  } = configured;
  const activeSubmissions = new Set();

  function callRemote(name, task, argumentsList, errorCode) {
    if (remoteClient) {
      return callAsync(
        remoteClient,
        name,
        [task.connectionUid, task.connectionEvidenceSha256, ...argumentsList],
        timeoutMs,
        errorCode,
      );
    }
    const binding = name === 'requireReady' ? dependencyChecker : client;
    return callAsync(binding, name, argumentsList, timeoutMs, errorCode);
  }

  function get(uid) {
    return callSync(repository, 'getFormalTask', [taskUid(uid)]);
  }

  function transition(uidValue, value, allowedStages, nextStage, nextStatus, extra = {}) {
    const uid = taskUid(uidValue);
    const request = expectedVersionRequest(value);
    const current = get(uid);
    if (current.stateVersion !== request.expectedStateVersion
      || !allowedStages.includes(current.stage)) fail('REMOTE_TASK_CONFLICT');
    return callSync(repository, 'transitionFormalTask', [{
      uid,
      expectedStateVersion: request.expectedStateVersion,
      nextStage,
      nextStatus,
      recoveryState: 'none',
      ...extra,
    }]);
  }

  function beginUpload(uid, value) {
    return transition(uid, value, ['prepared'], 'uploading', 'running');
  }

  function markExecuting(uid, value) {
    return transition(uid, value, ['submitted'], 'executing', 'running');
  }

  function markDownloading(uid, value) {
    return transition(uid, value, ['submitted', 'executing'], 'downloading', 'running');
  }

  function markVerifying(uid, value) {
    return transition(uid, value, ['downloading'], 'verifying', 'running');
  }

  function complete(uidValue, value) {
    const uid = taskUid(uidValue);
    const request = outputCompletionRequest(value);
    const current = get(uid);
    if (current.stateVersion !== request.expectedStateVersion || current.stage !== 'verifying') {
      fail('REMOTE_TASK_CONFLICT');
    }
    return callSync(repository, 'transitionFormalTask', [{
      uid,
      expectedStateVersion: request.expectedStateVersion,
      nextStage: 'completed',
      nextStatus: 'succeeded',
      recoveryState: 'completed',
      outputAssetVersionUid: request.outputAssetVersionUid,
    }]);
  }

  function failTask(uidValue, value) {
    const uid = taskUid(uidValue);
    const request = failureRequest(value);
    const current = get(uid);
    if (current.stateVersion !== request.expectedStateVersion
      || ['completed', 'failed', 'cancelled'].includes(current.stage)) {
      fail('REMOTE_TASK_CONFLICT');
    }
    return callSync(repository, 'transitionFormalTask', [{
      uid,
      expectedStateVersion: request.expectedStateVersion,
      nextStage: 'failed',
      nextStatus: 'failed',
      recoveryState: request.retryable ? 'retryable' : 'orphaned',
      errorPhase: request.phase,
      errorCode: request.errorCode,
      errorRetryable: request.retryable,
    }]);
  }

  async function prepare(value) {
    const prepared = preparationRequest(value);
    const request = prepared.request;
    let generatedUid;
    try { generatedUid = prepared.requestedTaskUid || createUid(); } catch {
      fail('REMOTE_TASK_UNEXPECTED');
    }
    return callSync(repository, 'createFormalTaskIdempotent', [{
      uid: taskUid(generatedUid),
      ...request,
      requestSha256: hashRemoteTaskRequest(request),
    }]);
  }

  async function submit(uidValue, value) {
    const uid = taskUid(uidValue);
    const submission = promptSubmission(value);
    const current = get(uid);
    if (hashRemoteTaskPrompt(submission.prompt) !== current.promptSha256) {
      fail('REMOTE_TASK_INPUT_INVALID');
    }
    if (current.promptId !== null) return current;
    if (activeSubmissions.has(uid)) return current;
    if (!['prepared', 'uploading'].includes(current.stage)) return current;
    if (current.stateVersion !== submission.expectedStateVersion) fail('REMOTE_TASK_CONFLICT');

    activeSubmissions.add(uid);
    try {
      let reserved = callSync(repository, 'transitionFormalTask', [{
        uid,
        expectedStateVersion: current.stateVersion,
        nextStage: 'submitted',
        nextStatus: 'running',
        recoveryState: 'none',
        submissionLeaseExpiresAtEpochMs: submissionLeaseExpiry(now, timeoutMs),
      }]);
      let manifest;
      try { manifest = callSync(manifestRepository, 'get', [reserved.workflowManifestUid]); } catch {
        callSync(repository, 'transitionFormalTask', [{
          uid,
          expectedStateVersion: reserved.stateVersion,
          nextStage: 'failed',
          nextStatus: 'failed',
          recoveryState: 'retryable',
          errorPhase: 'dependency',
          errorCode: 'ERR_REMOTE_DEPENDENCY_FAILED',
          errorRetryable: true,
        }]);
        fail('REMOTE_TASK_DEPENDENCY_NOT_READY');
      }
      try {
        await callRemote(
          'requireReady',
          reserved,
          [manifest],
          'REMOTE_TASK_DEPENDENCY_NOT_READY',
        );
      } catch (error) {
        if (error.code !== 'REMOTE_TASK_DEPENDENCY_NOT_READY') throw error;
        callSync(repository, 'transitionFormalTask', [{
          uid,
          expectedStateVersion: reserved.stateVersion,
          nextStage: 'failed',
          nextStatus: 'failed',
          recoveryState: 'retryable',
          errorPhase: 'dependency',
          errorCode: 'ERR_REMOTE_DEPENDENCY_FAILED',
          errorRetryable: true,
        }]);
        throw error;
      }

      reserved = callSync(repository, 'renewFormalSubmissionLease', [{
        uid,
        expectedStateVersion: reserved.stateVersion,
        submissionLeaseExpiresAtEpochMs: submissionLeaseExpiry(now, timeoutMs),
      }]);

      let promptId;
      try {
        const submitted = await callRemote(
          'submitPrompt',
          reserved,
          [submission.prompt, { clientId: uid }],
          'REMOTE_TASK_SUBMISSION_FAILED',
        );
        promptId = safePromptId(submitted, 'REMOTE_TASK_SUBMISSION_FAILED');
      } catch (error) {
        if (error.code !== 'REMOTE_TASK_SUBMISSION_FAILED') throw error;
        callSync(repository, 'transitionFormalTask', [{
          uid,
          expectedStateVersion: reserved.stateVersion,
          nextStage: 'failed',
          nextStatus: 'failed',
          recoveryState: 'orphaned',
          errorPhase: 'submission',
          errorCode: 'ERR_REMOTE_SUBMISSION_INDETERMINATE',
          errorRetryable: false,
        }]);
        throw error;
      }
      return callSync(repository, 'assignFormalPrompt', [{
        uid,
        expectedStateVersion: reserved.stateVersion,
        promptId,
      }]);
    } finally {
      activeSubmissions.delete(uid);
    }
  }

  function heartbeat(uidValue, value) {
    const input = exactObject(value, ['expectedStateVersion']);
    let heartbeatAt;
    try { heartbeatAt = now(); } catch { fail('REMOTE_TASK_UNEXPECTED'); }
    return callSync(repository, 'heartbeatFormalTask', [{
      uid: taskUid(uidValue),
      expectedStateVersion: stateVersion(input.expectedStateVersion),
      heartbeatAt,
    }]);
  }

  function retryClassification(uidValue) {
    return createRemoteTaskRetryClassification(get(uidValue));
  }

  function failRecovery(task, recoveryState, errorCode) {
    return callSync(repository, 'transitionFormalTask', [{
      uid: task.uid,
      expectedStateVersion: task.stateVersion,
      nextStage: 'failed',
      nextStatus: 'failed',
      recoveryState,
      errorPhase: 'recovery',
      errorCode,
      errorRetryable: recoveryState === 'retryable',
    }]);
  }

  async function recover(uidValue) {
    const task = get(uidValue);
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return task;
    if (activeSubmissions.has(task.uid)) return task;
    if (['prepared', 'uploading'].includes(task.stage)) {
      return failRecovery(task, 'retryable', 'ERR_REMOTE_RECOVERY_RETRYABLE');
    }
    if (task.promptId === null) {
      if (task.stage === 'submitted'
        && task.submissionLeaseExpiresAtEpochMs > currentEpochMs(now)) return task;
      return failRecovery(task, 'orphaned', 'ERR_REMOTE_RECOVERY_ORPHANED');
    }
    let state;
    try {
      state = safePromptState(await callRemote(
        'getPromptState',
        task,
        [task.promptId],
        'REMOTE_TASK_RECOVERY_FAILED',
      ), task.promptId);
    } catch (error) {
      if (error.code !== 'REMOTE_TASK_RECOVERY_FAILED') throw error;
      return failRecovery(task, 'orphaned', 'ERR_REMOTE_RECOVERY_UNCERTAIN');
    }
    if (state.state === 'succeeded') {
      return callSync(repository, 'transitionFormalTask', [{
        uid: task.uid,
        expectedStateVersion: task.stateVersion,
        nextStage: task.stage === 'verifying' ? 'verifying' : 'downloading',
        nextStatus: 'running',
        recoveryState: 'completed',
      }]);
    }
    if (state.state === 'failed') {
      return failRecovery(task, 'retryable', 'ERR_REMOTE_EXECUTION_FAILED');
    }
    if (state.state === 'running') {
      return heartbeat(task.uid, { expectedStateVersion: task.stateVersion });
    }
    let queued;
    try {
      const queue = await callRemote(
        'queueSnapshot',
        task,
        [],
        'REMOTE_TASK_RECOVERY_FAILED',
      );
      queued = queueContainsPrompt(queue, task.promptId);
    } catch (error) {
      if (error.code !== 'REMOTE_TASK_RECOVERY_FAILED') throw error;
      return failRecovery(task, 'orphaned', 'ERR_REMOTE_RECOVERY_UNCERTAIN');
    }
    if (queued) {
      return heartbeat(task.uid, { expectedStateVersion: task.stateVersion });
    }
    return failRecovery(task, 'orphaned', 'ERR_REMOTE_RECOVERY_ORPHANED');
  }

  async function recoverAll() {
    let afterCreatedAt = null;
    let afterUid = null;
    let recoveredCount = 0;
    let failedCount = 0;
    while (true) {
      const page = recoveryPage(callSync(repository, 'listRecoverableFormalTasks', [{
        afterCreatedAt,
        afterUid,
        limit: RECOVERY_PAGE_LIMIT,
      }]), afterCreatedAt, afterUid);
      for (let index = 0; index < page.length; index += 1) {
        const task = page[index];
        try {
          await recover(task.uid);
          recoveredCount += 1;
        } catch (error) {
          if (!isRemoteTaskError(error)) throw error;
          failedCount += 1;
        }
        if (!Number.isSafeInteger(recoveredCount + failedCount)) {
          fail('REMOTE_TASK_DATA_INVALID');
        }
      }
      if (page.length < RECOVERY_PAGE_LIMIT) break;
      const last = page[page.length - 1];
      afterCreatedAt = last.createdAt;
      afterUid = last.uid;
    }
    return Object.freeze({ recoveredCount, failedCount });
  }

  return Object.freeze({
    beginUpload,
    complete,
    fail: failTask,
    get,
    heartbeat,
    markDownloading,
    markExecuting,
    markVerifying,
    prepare,
    recover,
    recoverAll,
    retryClassification,
    submit,
  });
}

module.exports = Object.freeze({ createRemoteTaskService });
