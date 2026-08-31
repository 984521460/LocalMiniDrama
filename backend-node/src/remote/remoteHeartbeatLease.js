'use strict';

const { types: { isProxy } } = require('node:util');

const { createRemoteTaskError, createRemoteTaskRecord } = require('./remoteTask');

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const MIN_HEARTBEAT_INTERVAL_MS = 5;
const MAX_HEARTBEAT_INTERVAL_MS = 60_000;

function configuration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Remote heartbeat lease configuration is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(['service', 'task', 'intervalMs', 'executionPermit']);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))
    || !Object.hasOwn(descriptors, 'service') || !Object.hasOwn(descriptors, 'task')) {
    throw new TypeError('Remote heartbeat lease configuration is invalid');
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Remote heartbeat lease configuration is invalid');
    }
  }
  const service = descriptors.service.value;
  const heartbeat = service && !isProxy(service)
    ? Object.getOwnPropertyDescriptor(service, 'heartbeat')?.value
    : null;
  const intervalMs = descriptors.intervalMs?.value ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (typeof heartbeat !== 'function'
    || !Number.isSafeInteger(intervalMs)
    || intervalMs < MIN_HEARTBEAT_INTERVAL_MS
    || intervalMs > MAX_HEARTBEAT_INTERVAL_MS) {
    throw new TypeError('Remote heartbeat lease configuration is invalid');
  }
  return Object.freeze({
    heartbeat: heartbeat.bind(service),
    executionPermit: descriptors.executionPermit?.value,
    intervalMs,
    task: createRemoteTaskRecord(descriptors.task.value),
  });
}

async function runWithRemoteTaskHeartbeat(options, operation) {
  const configured = configuration(options);
  if (typeof operation !== 'function' || isProxy(operation)) {
    throw new TypeError('Remote heartbeat lease operation is invalid');
  }
  let current = configured.task;
  let heartbeatError = null;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || heartbeatError) return;
    try {
      current = createRemoteTaskRecord(configured.heartbeat(current.uid, {
        expectedStateVersion: current.stateVersion,
      }, configured.executionPermit));
    } catch {
      heartbeatError = createRemoteTaskError('REMOTE_TASK_CONFLICT');
    }
  }, configured.intervalMs);
  timer.unref?.();
  try {
    const result = await operation();
    if (heartbeatError) throw heartbeatError;
    return Object.freeze({ task: current, result });
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}

module.exports = Object.freeze({
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  runWithRemoteTaskHeartbeat,
});
