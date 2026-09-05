'use strict';

const { types: { isProxy } } = require('node:util');

const { raceNativePromise } = require('../integrations/comfyui/asyncControl');
const { createEnvironmentReport } = require('./environmentReport');
const {
  INITIALIZATION_ACTION_METHODS,
  createInitializationPlan,
  createInitializationRequest,
  createModelVerificationRequest,
} = require('./initializationPlan');
const {
  canonicalUid,
  exactObject,
  fail,
  safeInteger,
} = require('./environmentValidation');
const {
  createRemoteEnvironmentError,
  isRemoteEnvironmentError,
} = require('./remoteEnvironmentErrors');

const DEFAULT_TIMEOUT_MS = 120_000;
const CATALOG_SNAPSHOT_UID = '00000000-0000-4000-8000-000000000001';

function configuration(value) {
  const input = exactObject(value, [
    'sessionService', 'probe', 'initializer', 'nowEpochMs', 'modelCatalog',
  ], ['timeoutMs']);
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || typeof input.nowEpochMs !== 'function' || isProxy(input.nowEpochMs)) {
    throw new TypeError('Remote environment service configuration is invalid');
  }
  const bindings = [
    capture(input.sessionService, ['openSession']),
    capture(input.probe, ['inspect']),
    capture(input.initializer, [
      ...Object.values(INITIALIZATION_ACTION_METHODS),
      'verifyModel',
    ]),
  ];
  let modelCatalog;
  try {
    modelCatalog = createInitializationPlan({
      connectionUid: CATALOG_SNAPSHOT_UID,
      modelCatalog: input.modelCatalog,
    }).modelFiles;
  } catch {
    throw new TypeError('Remote environment service configuration is invalid');
  }
  return Object.freeze({
    sessionService: bindings[0],
    probe: bindings[1],
    initializer: bindings[2],
    nowEpochMs: input.nowEpochMs,
    modelCatalog,
    timeoutMs,
  });
}

function capture(target, names) {
  if (!target || typeof target !== 'object' || isProxy(target)) {
    throw new TypeError('Remote environment service configuration is invalid');
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(target); } catch {
    throw new TypeError('Remote environment service configuration is invalid');
  }
  const methods = Object.create(null);
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function'
      || isProxy(descriptor.value)) {
      throw new TypeError('Remote environment service configuration is invalid');
    }
    methods[name] = descriptor.value;
  }
  return Object.freeze({ target, methods: Object.freeze(methods) });
}

async function boundedCall(binding, name, argumentsList, timeoutMs, errorCode) {
  let pending;
  try { pending = Reflect.apply(binding.methods[name], binding.target, argumentsList); } catch {
    throw createRemoteEnvironmentError(errorCode);
  }
  try {
    return await raceNativePromise(pending, { timeoutMs });
  } catch {
    throw createRemoteEnvironmentError(errorCode);
  }
}

function sessionHandle(opened) {
  const result = exactObject(
    opened,
    ['session'],
    ['connection'],
    'REMOTE_ENVIRONMENT_SESSION_FAILED',
  );
  if (!result.session || typeof result.session !== 'object' || isProxy(result.session)) {
    throw createRemoteEnvironmentError('REMOTE_ENVIRONMENT_SESSION_FAILED');
  }
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(result.session, 'close'); } catch {
    throw createRemoteEnvironmentError('REMOTE_ENVIRONMENT_SESSION_FAILED');
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function'
    || isProxy(descriptor.value)) {
    throw createRemoteEnvironmentError('REMOTE_ENVIRONMENT_SESSION_FAILED');
  }
  return Object.freeze({ session: result.session, close: descriptor.value });
}

function actionResult(value) {
  const input = exactObject(
    value,
    ['changed'],
    [],
    'REMOTE_ENVIRONMENT_INITIALIZATION_FAILED',
  );
  if (typeof input.changed !== 'boolean') {
    throw createRemoteEnvironmentError('REMOTE_ENVIRONMENT_INITIALIZATION_FAILED');
  }
  return input.changed;
}

function createRemoteEnvironmentService(options) {
  const configured = configuration(options);
  const {
    sessionService, probe, initializer, nowEpochMs, modelCatalog, timeoutMs,
  } = configured;
  const activeCoreInitializations = new Map();
  const activeModelVerifications = new Map();

  function getInitializationPlan(connectionUid) {
    return createInitializationPlan({
      connectionUid: canonicalUid(connectionUid),
      modelCatalog,
    });
  }

  function collectedAtEpochMs() {
    let value;
    try { value = nowEpochMs(); } catch { fail('REMOTE_ENVIRONMENT_UNEXPECTED'); }
    return safeInteger(value, 0, 8_640_000_000_000_000, 'REMOTE_ENVIRONMENT_UNEXPECTED');
  }

  async function withSession(connectionUid, operation) {
    let opened;
    try {
      opened = sessionHandle(await boundedCall(
        sessionService,
        'openSession',
        [canonicalUid(connectionUid)],
        timeoutMs,
        'REMOTE_ENVIRONMENT_SESSION_FAILED',
      ));
    } catch (error) {
      if (isRemoteEnvironmentError(error)) throw error;
      throw createRemoteEnvironmentError('REMOTE_ENVIRONMENT_SESSION_FAILED');
    }
    let failed = false;
    try {
      return await operation(opened.session);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await raceNativePromise(Reflect.apply(opened.close, opened.session, []), { timeoutMs });
      } catch {
        if (!failed) throw createRemoteEnvironmentError('REMOTE_ENVIRONMENT_SESSION_FAILED');
      }
    }
  }

  async function reportForSession(connectionUid, session) {
    let summary;
    try {
      summary = await boundedCall(
        probe,
        'inspect',
        [session],
        timeoutMs,
        'REMOTE_ENVIRONMENT_PROBE_FAILED',
      );
      return createEnvironmentReport({
        connectionUid,
        collectedAtEpochMs: collectedAtEpochMs(),
        summary,
      });
    } catch (error) {
      if (isRemoteEnvironmentError(error)
        && error.code === 'REMOTE_ENVIRONMENT_PROBE_FAILED') throw error;
      throw createRemoteEnvironmentError('REMOTE_ENVIRONMENT_PROBE_FAILED');
    }
  }

  async function inspect(connectionUid) {
    const uid = canonicalUid(connectionUid);
    return withSession(uid, (session) => reportForSession(uid, session));
  }

  async function runCoreStep(session, step) {
    const methodName = INITIALIZATION_ACTION_METHODS[step.action];
    if (!methodName) throw createRemoteEnvironmentError('REMOTE_ENVIRONMENT_INITIALIZATION_FAILED');
    const result = await boundedCall(
      initializer,
      methodName,
      [session, step.parameters],
      timeoutMs,
      'REMOTE_ENVIRONMENT_INITIALIZATION_FAILED',
    );
    return Object.freeze({
      id: step.id,
      status: actionResult(result) ? 'completed' : 'already-satisfied',
    });
  }

  async function initialize(connectionUid, value) {
    const uid = canonicalUid(connectionUid);
    const request = createInitializationRequest(value);
    const plan = getInitializationPlan(uid);
    if (request.planHash !== plan.planHash) fail('REMOTE_ENVIRONMENT_PLAN_CONFLICT');
    const existing = activeCoreInitializations.get(uid);
    if (existing) return existing;
    const operation = withSession(uid, async (session) => {
      const steps = [];
      for (const step of plan.steps) steps.push(await runCoreStep(session, step));
      const report = await reportForSession(uid, session);
      if (!report.ready) throw createRemoteEnvironmentError('REMOTE_ENVIRONMENT_INITIALIZATION_FAILED');
      return Object.freeze({
        contractVersion: 'remote-initialization-result.v2',
        connectionUid: uid,
        planHash: plan.planHash,
        kind: 'core',
        status: 'completed',
        steps: Object.freeze(steps),
        report,
      });
    });
    activeCoreInitializations.set(uid, operation);
    try {
      return await operation;
    } finally {
      if (activeCoreInitializations.get(uid) === operation) activeCoreInitializations.delete(uid);
    }
  }

  async function verifyModels(connectionUid, value) {
    const uid = canonicalUid(connectionUid);
    const request = createModelVerificationRequest(value);
    const plan = getInitializationPlan(uid);
    if (request.planHash !== plan.planHash) fail('REMOTE_ENVIRONMENT_PLAN_CONFLICT');
    const existing = activeModelVerifications.get(uid);
    if (existing) return existing;
    const operation = withSession(uid, async (session) => {
      const report = await reportForSession(uid, session);
      if (!report.ready) {
        throw createRemoteEnvironmentError('REMOTE_ENVIRONMENT_INITIALIZATION_FAILED');
      }
      const steps = [];
      for (const model of plan.modelFiles) {
        const result = await boundedCall(
          initializer,
          'verifyModel',
          [session, model],
          timeoutMs,
          'REMOTE_ENVIRONMENT_INITIALIZATION_FAILED',
        );
        steps.push(Object.freeze({
          id: `model:${model.modelId}:${model.version}`,
          status: actionResult(result) ? 'completed' : 'already-satisfied',
        }));
      }
      return Object.freeze({
        contractVersion: 'remote-initialization-result.v2',
        connectionUid: uid,
        planHash: plan.planHash,
        kind: 'model-verification',
        status: 'completed',
        steps: Object.freeze(steps),
        report: null,
      });
    });
    activeModelVerifications.set(uid, operation);
    try {
      return await operation;
    } finally {
      if (activeModelVerifications.get(uid) === operation) activeModelVerifications.delete(uid);
    }
  }

  return Object.freeze({ getInitializationPlan, initialize, inspect, verifyModels });
}

module.exports = Object.freeze({ createRemoteEnvironmentService });
