'use strict';

const { types: { isProxy } } = require('node:util');

const {
  assertMvpBenchmarkExternalAuthorizationActive,
  serializeMvpBenchmarkExternalAuthorizationJson,
} = require('./mvpBenchmarkExternalAuthorization');
const {
  serializeMvpBenchmarkExecutionPreflightJson,
} = require('./mvpBenchmarkExecutionPreflight');
const { serializeMvpBenchmarkSessionJson } = require('./mvpBenchmarkSession');

const ARRAY_IS_ARRAY = Array.isArray;
const DATE_NOW = Date.now;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_CREATE = Object.create;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_TEST = RegExp.prototype.test;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SCHEMA_VERSION = 'mvp-benchmark-resume-snapshot.v1';

class MvpBenchmarkResumeError extends Error {
  constructor(code) {
    const messages = OBJECT_FREEZE({
      MVP_BENCHMARK_RESUME_INPUT_INVALID: 'MVP benchmark resume input is invalid',
      MVP_BENCHMARK_RESUME_UNAVAILABLE: 'MVP benchmark resume state is unavailable',
    });
    super(messages[code] ?? messages.MVP_BENCHMARK_RESUME_INPUT_INVALID);
    this.name = 'MvpBenchmarkResumeError';
    this.code = code;
    OBJECT_FREEZE(this);
  }
}

function fail(code) {
  throw new MvpBenchmarkResumeError(code);
}

function captureMethod(target, name) {
  if (!target || typeof target !== 'object' || isProxy(target)) return null;
  try {
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(target);
    if (!OBJECT_HAS_OWN(descriptors, name)) return null;
    const descriptor = descriptors[name];
    if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')
      || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) return null;
    return OBJECT_FREEZE({ method: descriptor.value, target });
  } catch {
    return null;
  }
}

function configuration(value) {
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) {
    throw new TypeError('MVP benchmark resume service configuration is invalid');
  }
  let descriptors;
  let prototype;
  try {
    descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    prototype = OBJECT_GET_PROTOTYPE_OF(value);
  } catch {
    throw new TypeError('MVP benchmark resume service configuration is invalid');
  }
  const keys = REFLECT_OWN_KEYS(descriptors);
  const expected = ['execution', 'nowEpochMs', 'repositories'];
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length < 2 || keys.length > expected.length) {
    throw new TypeError('MVP benchmark resume service configuration is invalid');
  }
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    let allowed = false;
    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
      if (key === expected[expectedIndex]) allowed = true;
    }
    if (typeof key !== 'string' || !allowed || !OBJECT_HAS_OWN(descriptors, key)) {
      throw new TypeError('MVP benchmark resume service configuration is invalid');
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
      throw new TypeError('MVP benchmark resume service configuration is invalid');
    }
  }
  if (!OBJECT_HAS_OWN(descriptors, 'execution') || !OBJECT_HAS_OWN(descriptors, 'repositories')) {
    throw new TypeError('MVP benchmark resume service configuration is invalid');
  }
  const repositories = descriptors.repositories.value;
  const nowEpochMs = descriptors.nowEpochMs?.value ?? DATE_NOW;
  const configured = OBJECT_FREEZE({
    authorizationCurrent: captureMethod(repositories?.mvpBenchmarkExternalAuthorizations, 'get'),
    authorizationStored: captureMethod(
      repositories?.mvpBenchmarkExternalAuthorizations, 'getStoredBySession',
    ),
    batchStored: captureMethod(
      repositories?.mvpBenchmarkExecutionPreflights, 'getStoredBatchByAuthorization',
    ),
    progress: captureMethod(descriptors.execution.value, 'readProgress'),
    sessionCurrent: captureMethod(repositories?.mvpBenchmarkSessions, 'get'),
    sessionStored: captureMethod(repositories?.mvpBenchmarkSessions, 'getStoredByWorkflowRun'),
    workflow: captureMethod(repositories?.workflows, 'getDefinition'),
    workflowRun: captureMethod(repositories?.runs, 'getWorkflow'),
    nowEpochMs,
  });
  const configuredKeys = REFLECT_OWN_KEYS(configured);
  for (let index = 0; index < configuredKeys.length; index += 1) {
    if (configured[configuredKeys[index]] === null) {
      throw new TypeError('MVP benchmark resume service configuration is invalid');
    }
  }
  if (typeof nowEpochMs !== 'function' || isProxy(nowEpochMs)) {
    throw new TypeError('MVP benchmark resume service configuration is invalid');
  }
  return configured;
}

function call(binding, argumentsList) {
  return REFLECT_APPLY(binding.method, binding.target, argumentsList);
}

function uid(value) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, UUID_V4, [value])) {
    fail('MVP_BENCHMARK_RESUME_INPUT_INVALID');
  }
  return value;
}

function request(value) {
  try {
    if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)
      || OBJECT_GET_PROTOTYPE_OF(value) !== Object.prototype) fail('MVP_BENCHMARK_RESUME_INPUT_INVALID');
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    if (REFLECT_OWN_KEYS(descriptors).length !== 2
      || !OBJECT_HAS_OWN(descriptors, 'dramaUid')
      || !OBJECT_HAS_OWN(descriptors, 'workflowRunUid')) {
      fail('MVP_BENCHMARK_RESUME_INPUT_INVALID');
    }
    const drama = descriptors.dramaUid;
    const run = descriptors.workflowRunUid;
    if (!drama?.enumerable || !run?.enumerable
      || !OBJECT_HAS_OWN(drama, 'value') || !OBJECT_HAS_OWN(run, 'value')) {
      fail('MVP_BENCHMARK_RESUME_INPUT_INVALID');
    }
    return OBJECT_FREEZE({ dramaUid: uid(drama.value), workflowRunUid: uid(run.value) });
  } catch (error) {
    if (error instanceof MvpBenchmarkResumeError) throw error;
    return fail('MVP_BENCHMARK_RESUME_INPUT_INVALID');
  }
}

function currentTime(configured) {
  let value;
  try { value = REFLECT_APPLY(configured.nowEpochMs, undefined, []); } catch {
    return fail('MVP_BENCHMARK_RESUME_UNAVAILABLE');
  }
  if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [value])
    || value < 0 || value > 253402300799999) {
    fail('MVP_BENCHMARK_RESUME_UNAVAILABLE');
  }
  return value;
}

function snapshot(input, state, values = {}) {
  return OBJECT_FREEZE({
    schemaVersion: SCHEMA_VERSION,
    dramaUid: input.dramaUid,
    workflowRunUid: input.workflowRunUid,
    state,
    sessionJson: values.session === undefined
      ? null : serializeMvpBenchmarkSessionJson(values.session),
    authorizationJson: values.authorization === undefined
      ? null : serializeMvpBenchmarkExternalAuthorizationJson(values.authorization),
    batchJson: values.batch === undefined
      ? null : serializeMvpBenchmarkExecutionPreflightJson(values.batch),
    progressJson: values.progress === undefined
      ? null : serializeMvpBenchmarkSessionJson(values.progress),
  });
}

function createMvpBenchmarkResumeService(value) {
  const configured = configuration(value);

  return OBJECT_FREEZE({
    async read(valueToRead) {
      const input = request(valueToRead);
      try {
        const workflowRun = call(configured.workflowRun, [input.workflowRunUid]);
        const workflow = call(configured.workflow, [workflowRun.workflowUid]);
        if (workflowRun.uid !== input.workflowRunUid || workflow.uid !== workflowRun.workflowUid
          || workflow.dramaUid !== input.dramaUid) {
          return fail('MVP_BENCHMARK_RESUME_UNAVAILABLE');
        }
        const session = call(configured.sessionStored, [input.workflowRunUid]);
        if (!session) return snapshot(input, 'empty');
        if (session.dramaUid !== input.dramaUid || session.workflowRunUid !== input.workflowRunUid) {
          return fail('MVP_BENCHMARK_RESUME_UNAVAILABLE');
        }
        const authorization = call(configured.authorizationStored, [session.uid]);
        if (!authorization) {
          const current = call(configured.sessionCurrent, [session.uid]);
          if (current.planSha256 !== session.planSha256) {
            return fail('MVP_BENCHMARK_RESUME_UNAVAILABLE');
          }
          return snapshot(input, 'session', { session });
        }
        if (authorization.sessionUid !== session.uid
          || authorization.dramaUid !== session.dramaUid
          || authorization.sessionPlanSha256 !== session.planSha256) {
          return fail('MVP_BENCHMARK_RESUME_UNAVAILABLE');
        }
        const batch = call(configured.batchStored, [authorization.uid]);
        if (!batch) {
          const current = assertMvpBenchmarkExternalAuthorizationActive(
            call(configured.authorizationCurrent, [authorization.uid]),
            currentTime(configured),
          );
          if (current.authorizationSha256 !== authorization.authorizationSha256) {
            return fail('MVP_BENCHMARK_RESUME_UNAVAILABLE');
          }
          return snapshot(input, 'authorization', { authorization, session });
        }
        if (batch.authorizationUid !== authorization.uid
          || batch.sessionUid !== session.uid || batch.dramaUid !== session.dramaUid) {
          return fail('MVP_BENCHMARK_RESUME_UNAVAILABLE');
        }
        const progress = await call(configured.progress, [{
          schemaVersion: 'mvp-benchmark-production-execution-progress-request.v1',
          authorizationUid: authorization.uid,
          dramaUid: session.dramaUid,
          sessionUid: session.uid,
          expectedBatchSha256: batch.batchSha256,
        }]);
        if (progress.authorizationUid !== authorization.uid
          || progress.sessionUid !== session.uid || progress.dramaUid !== session.dramaUid
          || progress.batchSha256 !== batch.batchSha256) {
          return fail('MVP_BENCHMARK_RESUME_UNAVAILABLE');
        }
        return snapshot(input, 'execution', { authorization, batch, progress, session });
      } catch (error) {
        if (error instanceof MvpBenchmarkResumeError) throw error;
        return fail('MVP_BENCHMARK_RESUME_UNAVAILABLE');
      }
    },
  });
}

module.exports = OBJECT_FREEZE({
  MvpBenchmarkResumeError,
  SCHEMA_VERSION,
  createMvpBenchmarkResumeService,
});
