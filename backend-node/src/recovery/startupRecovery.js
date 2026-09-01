'use strict';

const { types: { isProxy } } = require('node:util');

const FAMILY_SPECS = Object.freeze([
  Object.freeze({ name: 'legacy_async_tasks', dependency: 'legacyAsyncTasks', method: 'recover' }),
  Object.freeze({ name: 'legacy_video_generations', dependency: 'legacyVideoGenerations', method: 'recover' }),
  Object.freeze({ name: 'workflow_runs', dependency: 'workflowRuns', method: 'recoverInterruptedRuns' }),
  Object.freeze({ name: 'media_exports', dependency: 'mediaExports', method: 'recoverInterrupted' }),
  Object.freeze({ name: 'h3_api_submissions', dependency: 'h3ApiSubmissions', method: 'recoverInterrupted' }),
  Object.freeze({ name: 'audio_tts_submissions', dependency: 'audioTtsSubmissions', method: 'recoverInterrupted' }),
  Object.freeze({ name: 'narrative_task_executions', dependency: 'narrativeExecutions', method: 'recoverInterrupted' }),
  Object.freeze({ name: 'benchmark_releases', dependency: 'benchmarkReleases', method: 'recoverOpen', remote: true }),
  Object.freeze({ name: 'remote_tasks', dependency: 'remoteTasks', method: 'recoverAll', remote: true }),
]);
const CONFIG_KEYS = Object.freeze([...FAMILY_SPECS.map((item) => item.dependency), 'log']);

function invalidConfiguration() {
  throw new TypeError('Startup recovery dependencies are invalid');
}

function exactConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    invalidConfiguration();
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    invalidConfiguration();
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some((key) => (
      typeof key !== 'string' || !CONFIG_KEYS.includes(key)
    ))) invalidConfiguration();
  const output = Object.create(null);
  for (const key of CONFIG_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalidConfiguration();
    }
    output[key] = descriptor.value;
  }
  return output;
}

function captureMethod(service, name) {
  if (!service || typeof service !== 'object' || Array.isArray(service) || isProxy(service)) {
    invalidConfiguration();
  }
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(service, name); } catch {
    invalidConfiguration();
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')
    || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) {
    invalidConfiguration();
  }
  return descriptor.value.bind(service);
}

function captureLogger(log) {
  if (!log || typeof log !== 'object' || isProxy(log)) invalidConfiguration();
  return Object.freeze({
    info: captureMethod(log, 'info'),
    warn: captureMethod(log, 'warn'),
  });
}

function countResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Startup recovery result is invalid');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError('Startup recovery result is invalid');
  }
  const keys = Reflect.ownKeys(descriptors);
  const descriptor = descriptors.recoveredCount;
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== 1 || keys[0] !== 'recoveredCount'
    || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
    || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) {
    throw new TypeError('Startup recovery result is invalid');
  }
  return descriptor.value;
}

function remoteResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Startup recovery result is invalid');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError('Startup recovery result is invalid');
  }
  const expected = ['failedCount', 'recoveredCount'];
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== expected.length
    || keys.some((key) => typeof key !== 'string' || !expected.includes(key))
    || expected.some((key) => !descriptors[key]?.enumerable
      || !Object.hasOwn(descriptors[key], 'value')
      || !Number.isSafeInteger(descriptors[key].value)
      || descriptors[key].value < 0)
    || !Number.isSafeInteger(
      descriptors.recoveredCount.value + descriptors.failedCount.value,
    )) {
    throw new TypeError('Startup recovery result is invalid');
  }
  return Object.freeze({
    recoveredCount: descriptors.recoveredCount.value,
    failedCount: descriptors.failedCount.value,
  });
}

function familyRecord(name, status, recoveredCount, failedCount) {
  return Object.freeze({ name, status, recoveredCount, failedCount });
}

function safeLog(logger, level, event, details) {
  try { logger[level](event, details); } catch { /* recovery must not depend on logging */ }
}

function createStartupRecoveryCoordinator(value) {
  const configured = exactConfiguration(value);
  const logger = captureLogger(configured.log);
  const families = FAMILY_SPECS.map((spec) => Object.freeze({
    ...spec,
    recover: captureMethod(configured[spec.dependency], spec.method),
  }));
  let completion = null;

  async function execute() {
    const records = [];
    for (const family of families) {
      try {
        if (family.remote) {
          const value = await family.recover();
          const counts = remoteResult(value);
          records.push(familyRecord(
            family.name,
            counts.failedCount === 0 ? 'completed' : 'partial_failure',
            counts.recoveredCount,
            counts.failedCount,
          ));
        } else {
          const value = family.recover();
          records.push(familyRecord(family.name, 'completed', countResult(value), 0));
        }
      } catch {
        records.push(familyRecord(family.name, 'failed', 0, 1));
      }
    }
    const frozenFamilies = Object.freeze(records);
    const status = records.some((record) => record.status !== 'completed')
      ? 'partial_failure' : 'completed';
    const report = Object.freeze({
      schemaVersion: 'startup-recovery.v1',
      status,
      families: frozenFamilies,
    });
    safeLog(
      logger,
      status === 'completed' ? 'info' : 'warn',
      'startup-recovery-complete',
      Object.freeze({
        status,
        recoveredCount: records.reduce((total, item) => total + item.recoveredCount, 0),
        failedCount: records.reduce((total, item) => total + item.failedCount, 0),
      }),
    );
    return report;
  }

  return Object.freeze({
    run() {
      if (completion === null) completion = execute();
      return completion;
    },
  });
}

module.exports = Object.freeze({ createStartupRecoveryCoordinator });
