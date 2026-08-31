'use strict';

const { types: { isPromise, isProxy } } = require('node:util');

const { sha256Canonical } = require('./contract');
const { fail, isH3ContractError } = require('./errors');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SCHEMA_VERSION = 'h3-local-execution-result.v1';
const CONFLICT_CODE = 'H3_HISTORY_CONFLICT';
const INPUT_CODE = 'H3_GENERATION_INPUT_INVALID';
const NATIVE_PROMISE = Promise;
const NATIVE_PROMISE_THEN = Object.getOwnPropertyDescriptor(
  NATIVE_PROMISE.prototype, 'then',
).value;
const SAFE_SPECIES_HOLDER = Object.create(null);
Object.defineProperty(SAFE_SPECIES_HOLDER, Symbol.species, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: NATIVE_PROMISE,
});
Object.freeze(SAFE_SPECIES_HOLDER);
const RESULT_FIELDS = Object.freeze([
  'schemaVersion', 'taskUid', 'taskStateVersion', 'generationRunUid', 'historyUid',
  'assetUid', 'assetVersionUid', 'nodeRunUid', 'status',
]);

function recordSnapshot(value, code) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail(code);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !descriptor.enumerable
        || !Object.hasOwn(descriptor, 'value')) fail(code);
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (isH3ContractError(error)) throw error;
    return fail(code);
  }
}

function exactRecord(value, fields, code) {
  const snapshot = recordSnapshot(value, code);
  const keys = Object.keys(snapshot).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])) fail(code);
  return snapshot;
}

function uid(value, code) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail(code);
  return value;
}

function dataField(value, field, code) {
  const snapshot = recordSnapshot(value, code);
  if (!Object.hasOwn(snapshot, field)) fail(code);
  return snapshot[field];
}

function parseH3LocalExecutionResult(value) {
  const input = exactRecord(value, RESULT_FIELDS, CONFLICT_CODE);
  if (input.schemaVersion !== SCHEMA_VERSION || input.status !== 'succeeded'
    || !Number.isSafeInteger(input.taskStateVersion)
    || input.taskStateVersion < 0 || input.taskStateVersion > 2_147_483_647) {
    fail(CONFLICT_CODE);
  }
  const result = Object.create(null);
  Object.assign(result, {
    schemaVersion: SCHEMA_VERSION,
    taskUid: uid(input.taskUid, CONFLICT_CODE),
    taskStateVersion: input.taskStateVersion,
    generationRunUid: uid(input.generationRunUid, CONFLICT_CODE),
    historyUid: uid(input.historyUid, CONFLICT_CODE),
    assetUid: uid(input.assetUid, CONFLICT_CODE),
    assetVersionUid: uid(input.assetVersionUid, CONFLICT_CODE),
    nodeRunUid: uid(input.nodeRunUid, CONFLICT_CODE),
    status: 'succeeded',
  });
  return Object.freeze(result);
}

function method(target, name) {
  if (!target || typeof target !== 'object' || isProxy(target)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
      && typeof descriptor.value === 'function' && !isProxy(descriptor.value)
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function isSafePromiseCandidate(value) {
  if (!isPromise(value) || isProxy(value)) return false;
  try {
    if (!Object.isExtensible(value)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'constructor');
    return descriptor === undefined || descriptor.configurable === true;
  } catch {
    return false;
  }
}

function shieldInternalPromise(value) {
  Object.defineProperty(value, 'constructor', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: SAFE_SPECIES_HOLDER,
  });
  return value;
}

function conflictError() {
  try {
    fail(CONFLICT_CODE);
  } catch (error) {
    return error;
  }
  return new Error('H3 local execution failed');
}

function rejectedInternalPromise(error) {
  return shieldInternalPromise(new NATIVE_PROMISE((resolve, reject) => reject(error)));
}

function settleCoordinatorResult(value, transform) {
  return shieldInternalPromise(new NATIVE_PROMISE((resolve, reject) => {
    if (!isSafePromiseCandidate(value)) {
      reject(conflictError());
      return;
    }
    const originalConstructor = Object.getOwnPropertyDescriptor(value, 'constructor');
    let constructorShielded = false;
    try {
      Object.defineProperty(value, 'constructor', {
        configurable: true,
        enumerable: false,
        writable: false,
        value: SAFE_SPECIES_HOLDER,
      });
      constructorShielded = true;
      Reflect.apply(NATIVE_PROMISE_THEN, value, [
        (result) => {
          try {
            resolve(transform(result));
          } catch (error) {
            reject(error);
          }
        },
        reject,
      ]);
    } catch {
      reject(conflictError());
    } finally {
      if (constructorShielded) {
        if (originalConstructor === undefined) delete value.constructor;
        else Object.defineProperty(value, 'constructor', originalConstructor);
      }
    }
  }));
}

function configuration(value) {
  let input;
  try {
    input = exactRecord(value, ['repositories', 'coordinator'], INPUT_CODE);
  } catch {
    throw new TypeError('H3 local execution service configuration is invalid');
  }
  const repositories = input.repositories;
  const coordinator = input.coordinator;
  if (!repositories || typeof repositories !== 'object' || isProxy(repositories)
    || !repositories.assets || !repositories.generationHistory
    || !repositories.h3GenerationIntents || !repositories.remote || !repositories.runs
    || method(repositories.assets, 'getVersion') === null
    || method(repositories.generationHistory, 'get') === null
    || method(repositories.h3GenerationIntents, 'getByTask') === null
    || method(repositories.remote, 'getFormalTask') === null
    || method(repositories.runs, 'getGeneration') === null
    || method(repositories.runs, 'getNode') === null
    || method(coordinator, 'execute') === null) {
    throw new TypeError('H3 local execution service configuration is invalid');
  }
  return Object.freeze({ repositories, coordinator });
}

function readPreparedIntent(repositories, taskUid) {
  try {
    const intent = repositories.h3GenerationIntents.getByTask(taskUid);
    if (intent.taskUid !== taskUid) fail(CONFLICT_CODE);
    return intent;
  } catch (error) {
    if (isH3ContractError(error)) throw error;
    return fail(CONFLICT_CODE);
  }
}

function persistedResult(configured, intent, executionResult) {
  const output = exactRecord(
    executionResult,
    ['task', 'assetVersion', 'node', 'generationHistory'],
    CONFLICT_CODE,
  );
  const resultTaskUid = dataField(output.task, 'uid', CONFLICT_CODE);
  const resultVersionUid = dataField(output.assetVersion, 'uid', CONFLICT_CODE);
  const resultNodeUid = dataField(output.node, 'uid', CONFLICT_CODE);
  const resultHistoryUid = dataField(output.generationHistory, 'uid', CONFLICT_CODE);
  if (resultTaskUid !== intent.taskUid || resultHistoryUid !== intent.historyUid) {
    fail(CONFLICT_CODE);
  }

  const { repositories } = configured;
  let currentIntent;
  let task;
  let generationRun;
  let history;
  let version;
  let node;
  try {
    currentIntent = repositories.h3GenerationIntents.getByTask(intent.taskUid);
    task = repositories.remote.getFormalTask(intent.taskUid);
    generationRun = repositories.runs.getGeneration(intent.generationRunUid);
    history = repositories.generationHistory.get(intent.historyUid);
    version = repositories.assets.getVersion(task.outputAssetVersionUid);
    node = repositories.runs.getNode(resultNodeUid);
  } catch {
    return fail(CONFLICT_CODE);
  }

  const nodeOutput = dataField(node, 'output', CONFLICT_CODE);
  if (sha256Canonical(currentIntent) !== sha256Canonical(intent)
    || task.uid !== intent.taskUid || task.stage !== 'completed' || task.status !== 'succeeded'
    || task.workflowRunUid === null
    || task.workflowManifestUid !== intent.manifestUid
    || task.idempotencyKey !== `remote-task:v1:${node.uid}`
    || task.outputAssetVersionUid === null || task.outputAssetVersionUid !== resultVersionUid
    || generationRun.uid !== intent.generationRunUid || generationRun.status !== 'succeeded'
    || generationRun.ownerType !== 'drama'
    || generationRun.ownerUid !== intent.promptSemantic.dramaUid
    || generationRun.provider !== 'local-comfy' || generationRun.model !== 'MiniMax-H3'
    || generationRun.seed !== intent.generationSpec.seed
    || generationRun.promptVersionUid !== intent.promptSemantic.uid
    || generationRun.outputAssetVersionUid !== resultVersionUid
    || history.uid !== intent.historyUid || history.runUid !== intent.generationRunUid
    || history.dramaUid !== intent.promptSemantic.dramaUid
    || history.assetUid !== intent.assetUid || history.status !== 'succeeded'
    || history.manifestUid !== intent.manifestUid
    || history.promptSemanticUid !== intent.promptSemantic.uid
    || history.outputVersionUid !== resultVersionUid
    || version.uid !== resultVersionUid || version.assetUid !== intent.assetUid
    || version.status !== 'ready' || node.status !== 'succeeded'
    || node.workflowRunUid !== task.workflowRunUid
    || dataField(nodeOutput, 'assetVersionUid', CONFLICT_CODE) !== resultVersionUid
    || dataField(nodeOutput, 'remoteTaskUid', CONFLICT_CODE) !== intent.taskUid) {
    fail(CONFLICT_CODE);
  }

  return parseH3LocalExecutionResult({
    schemaVersion: SCHEMA_VERSION,
    taskUid: task.uid,
    taskStateVersion: task.stateVersion,
    generationRunUid: generationRun.uid,
    historyUid: history.uid,
    assetUid: history.assetUid,
    assetVersionUid: version.uid,
    nodeRunUid: node.uid,
    status: 'succeeded',
  });
}

function createH3LocalExecutionService(options) {
  const configured = configuration(options);
  return Object.freeze({
    execute(taskUidValue, request) {
      let taskUid;
      let intent;
      let pending;
      try {
        taskUid = uid(taskUidValue, INPUT_CODE);
        intent = readPreparedIntent(configured.repositories, taskUid);
        pending = Reflect.apply(
          method(configured.coordinator, 'execute'),
          configured.coordinator,
          [taskUid, request],
        );
      } catch (error) {
        return rejectedInternalPromise(error);
      }
      return settleCoordinatorResult(
        pending,
        (result) => persistedResult(configured, intent, result),
      );
    },
  });
}

module.exports = Object.freeze({
  createH3LocalExecutionService,
  parseH3LocalExecutionResult,
});
