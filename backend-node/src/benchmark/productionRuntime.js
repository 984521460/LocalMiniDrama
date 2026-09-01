'use strict';

const { types: { isProxy } } = require('node:util');

const { createV2Repositories } = require('../repositories/v2');
const {
  createMvpBenchmarkAuthorizationCeilingEstimator,
} = require('./mvpBenchmarkAuthorizationCeilingEstimator');
const {
  createMvpBenchmarkExecutionPreflightService,
} = require('./mvpBenchmarkExecutionPreflightService');
const {
  createMvpBenchmarkProductionExecutionService,
} = require('./mvpBenchmarkProductionExecutionService');
const {
  createMvpBenchmarkSshLiveEnvironmentVerifier,
} = require('./mvpBenchmarkSshLiveEnvironmentVerifier');

const DEPENDENCY_KEYS = Object.freeze([
  'liveEnvironmentVerifier', 'costEstimator', 'createUid', 'nowEpochMs', 'timeoutMs',
]);

function dependencySnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Production MVP benchmark runtime dependencies are invalid');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError('Production MVP benchmark runtime dependencies are invalid');
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== 'string' || !DEPENDENCY_KEYS.includes(key),
    )) throw new TypeError('Production MVP benchmark runtime dependencies are invalid');
  const output = Object.create(null);
  for (let index = 0; index < DEPENDENCY_KEYS.length; index += 1) {
    const key = DEPENDENCY_KEYS[index];
    if (!Object.hasOwn(descriptors, key)) continue;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Production MVP benchmark runtime dependencies are invalid');
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function createProductionMvpBenchmarkRuntime({
  database, sessionService, h3LocalExecution, audioTtsExecution, dependencies = {},
} = {}) {
  if (!database || typeof database !== 'object' || isProxy(database)
    || !sessionService || typeof sessionService !== 'object' || isProxy(sessionService)
    || !h3LocalExecution || typeof h3LocalExecution !== 'object' || isProxy(h3LocalExecution)
    || !audioTtsExecution || typeof audioTtsExecution !== 'object'
    || isProxy(audioTtsExecution)) {
    throw new TypeError('Production MVP benchmark runtime configuration is invalid');
  }
  const configured = dependencySnapshot(dependencies);
  const repositories = createV2Repositories(database);
  const liveEnvironmentVerifier = configured.liveEnvironmentVerifier
    ?? createMvpBenchmarkSshLiveEnvironmentVerifier({
      sessionService,
      ...(configured.nowEpochMs !== undefined
        ? { nowEpochMs: configured.nowEpochMs } : {}),
      ...(configured.timeoutMs !== undefined ? { timeoutMs: configured.timeoutMs } : {}),
    });
  const costEstimator = configured.costEstimator
    ?? createMvpBenchmarkAuthorizationCeilingEstimator({ repositories });
  const preflight = createMvpBenchmarkExecutionPreflightService({
    repositories,
    liveEnvironmentVerifier,
    costEstimator,
    ...(configured.createUid !== undefined ? { createUid: configured.createUid } : {}),
    ...(configured.nowEpochMs !== undefined ? { nowEpochMs: configured.nowEpochMs } : {}),
    ...(configured.timeoutMs !== undefined ? { timeoutMs: configured.timeoutMs } : {}),
  });
  const execution = createMvpBenchmarkProductionExecutionService({
    repositories,
    executionGate: repositories.mvpBenchmarkExecutionGate,
    h3LocalExecution,
    audioTtsExecution,
    liveEnvironmentVerifier,
    ...(configured.createUid !== undefined ? { createUid: configured.createUid } : {}),
    ...(configured.nowEpochMs !== undefined ? { nowEpochMs: configured.nowEpochMs } : {}),
  });
  return Object.freeze({ execution, preflight });
}

module.exports = Object.freeze({ createProductionMvpBenchmarkRuntime });
