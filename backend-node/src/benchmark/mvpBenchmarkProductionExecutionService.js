'use strict';

const crypto = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { raceNativePromise } = require('../integrations/comfyui/asyncControl');
const { parseH3LocalExecutionResult } = require('../h3/localExecutionService');
const { createH3TextToVideoWorkflowBundle } = require('../h3/workflowBundle');
const {
  parseMvpBenchmarkExecutionReservation,
} = require('./mvpBenchmarkExecutionPreflight');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_EPOCH_MS = 253402300799999;
const SCHEMA_VERSION = 'mvp-benchmark-production-execution-step.v1';
const ARRAY_IS_ARRAY = Array.isArray;
const BUFFER_FROM = Buffer.from;
const BUFFER_TO_STRING = Buffer.prototype.toString;
const MAP_DELETE = Map.prototype.delete;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const OBJECT_CREATE = Object.create;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;

class MvpBenchmarkProductionExecutionError extends Error {
  constructor(code) {
    const messages = OBJECT_FREEZE({
      MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED:
        'MVP benchmark production execution failed',
      MVP_BENCHMARK_PRODUCTION_EXECUTION_INPUT_INVALID:
        'MVP benchmark production execution input is invalid',
      MVP_BENCHMARK_PRODUCTION_EXECUTION_IN_PROGRESS:
        'MVP benchmark production execution is already in progress',
      MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE:
        'MVP benchmark production execution is unavailable',
    });
    super(messages[code] ?? messages.MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE);
    this.name = 'MvpBenchmarkProductionExecutionError';
    this.code = code;
    OBJECT_FREEZE(this);
  }
}

function fail(code) {
  throw new MvpBenchmarkProductionExecutionError(code);
}

function captureMethod(target, name) {
  if (!target || typeof target !== 'object' || isProxy(target)) return null;
  try {
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(target, name);
    return descriptor?.enumerable && OBJECT_HAS_OWN(descriptor, 'value')
      && typeof descriptor.value === 'function' && !isProxy(descriptor.value)
      ? OBJECT_FREEZE({ method: descriptor.value, target }) : null;
  } catch {
    return null;
  }
}

function exactConfiguration(value) {
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) {
    throw new TypeError('MVP benchmark production execution service configuration is invalid');
  }
  let descriptors;
  let prototype;
  try {
    descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    prototype = OBJECT_GET_PROTOTYPE_OF(value);
  } catch {
    throw new TypeError('MVP benchmark production execution service configuration is invalid');
  }
  const allowed = OBJECT_FREEZE([
    'repositories', 'executionGate', 'h3LocalExecution', 'audioTtsExecution',
    'liveEnvironmentVerifier', 'createUid', 'nowEpochMs',
  ]);
  const keys = REFLECT_OWN_KEYS(descriptors);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('MVP benchmark production execution service configuration is invalid');
  }
  for (let index = 0; index < keys.length; index += 1) {
    let allowedKey = false;
    for (let allowedIndex = 0; allowedIndex < allowed.length; allowedIndex += 1) {
      if (keys[index] === allowed[allowedIndex]) allowedKey = true;
    }
    if (typeof keys[index] !== 'string' || !allowedKey) {
      throw new TypeError('MVP benchmark production execution service configuration is invalid');
    }
  }
  const input = OBJECT_CREATE(null);
  for (let index = 0; index < allowed.length; index += 1) {
    const key = allowed[index];
    const descriptor = descriptors[key];
    if (!descriptor) continue;
    if (!descriptor.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
      throw new TypeError('MVP benchmark production execution service configuration is invalid');
    }
    input[key] = descriptor.value;
  }
  const repositories = input.repositories;
  const configured = OBJECT_FREEZE({
    audioExecute: captureMethod(input.audioTtsExecution, 'execute'),
    audioGet: captureMethod(input.audioTtsExecution, 'get'),
    assertAudio: captureMethod(input.executionGate, 'assertAudioIntentExecutionOpen'),
    assertH3: captureMethod(input.executionGate, 'assertH3TaskExecutionOpen'),
    h3Execute: captureMethod(input.h3LocalExecution, 'execute'),
    h3Get: captureMethod(input.h3LocalExecution, 'get'),
    h3Intent: captureMethod(repositories?.h3GenerationIntents, 'getExecutionSource'),
    inspect: captureMethod(input.liveEnvironmentVerifier, 'inspect'),
    loadBatch: captureMethod(input.executionGate, 'loadExecutionBatch'),
    openItem: captureMethod(input.executionGate, 'openExecutionItem'),
    remoteTask: captureMethod(repositories?.remote, 'getFormalTask'),
    createUid: input.createUid ?? crypto.randomUUID,
    nowEpochMs: input.nowEpochMs ?? Date.now,
  });
  if (!configured.audioExecute || !configured.audioGet || !configured.assertAudio
    || !configured.assertH3 || !configured.h3Execute || !configured.h3Get
    || !configured.h3Intent || !configured.inspect || !configured.loadBatch
    || !configured.openItem || !configured.remoteTask
    || typeof configured.createUid !== 'function' || isProxy(configured.createUid)
    || typeof configured.nowEpochMs !== 'function' || isProxy(configured.nowEpochMs)) {
    throw new TypeError('MVP benchmark production execution service configuration is invalid');
  }
  return configured;
}

function uid(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_INPUT_INVALID');
  }
  return value;
}

function request(value) {
  try {
    if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)
      || OBJECT_GET_PROTOTYPE_OF(value) !== Object.prototype) {
      fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_INPUT_INVALID');
    }
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    const keys = ['authorizationUid', 'dramaUid', 'sessionUid'];
    if (REFLECT_OWN_KEYS(descriptors).length !== keys.length) {
      fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_INPUT_INVALID');
    }
    const output = OBJECT_CREATE(null);
    for (let index = 0; index < keys.length; index += 1) {
      const descriptor = descriptors[keys[index]];
      if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
        fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_INPUT_INVALID');
      }
      output[keys[index]] = uid(descriptor.value);
    }
    return OBJECT_FREEZE(output);
  } catch (error) {
    if (error instanceof MvpBenchmarkProductionExecutionError) throw error;
    return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_INPUT_INVALID');
  }
}

function nextUid(configured) {
  let value;
  try { value = REFLECT_APPLY(configured.createUid, undefined, []); } catch {
    return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  return value;
}

function now(configured) {
  let value;
  try { value = REFLECT_APPLY(configured.nowEpochMs, undefined, []); } catch {
    return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EPOCH_MS) {
    fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  return value;
}

function call(binding, argumentsList) {
  return REFLECT_APPLY(binding.method, binding.target, argumentsList);
}

async function settle(value) {
  try { return await raceNativePromise(value); } catch {
    return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED');
  }
}

async function settleUnavailable(value) {
  try { return await raceNativePromise(value); } catch {
    return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
}

function denseArray(value, minimum, maximum) {
  if (!ARRAY_IS_ARRAY(value) || isProxy(value)
    || OBJECT_GET_PROTOTYPE_OF(value) !== Array.prototype) {
    fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < minimum || length > maximum
    || REFLECT_OWN_KEYS(descriptors).length !== length + 1) {
    fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
      fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
    }
    output[index] = descriptor.value;
  }
  return OBJECT_FREEZE(output);
}

function exactDataObject(value, keys) {
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) {
    fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  let descriptors;
  let prototype;
  try {
    descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    prototype = OBJECT_GET_PROTOTYPE_OF(value);
  } catch {
    return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || REFLECT_OWN_KEYS(descriptors).length !== keys.length) {
    fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  const output = OBJECT_CREATE(null);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = descriptors[keys[index]];
    if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
      fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
    }
    output[keys[index]] = descriptor.value;
  }
  return output;
}

function executionContext(value, expected) {
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) {
    fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  let descriptors;
  try { descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value); } catch {
    return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  if (REFLECT_OWN_KEYS(descriptors).length !== 2
    || !descriptors.batch?.enumerable || !OBJECT_HAS_OWN(descriptors.batch, 'value')
    || !descriptors.environmentRequest?.enumerable
    || !OBJECT_HAS_OWN(descriptors.environmentRequest, 'value')) {
    fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  const batchInput = exactDataObject(descriptors.batch.value, [
    'schemaVersion', 'authorizationUid', 'sessionUid', 'dramaUid', 'attestationUid',
    'reservations', 'estimatedCostCnyFen', 'preparedAtEpochMs', 'batchSha256',
  ]);
  if (batchInput.schemaVersion !== 'mvp-benchmark-execution-preflight-batch.v1'
    || batchInput.authorizationUid !== expected.authorizationUid
    || batchInput.sessionUid !== expected.sessionUid || batchInput.dramaUid !== expected.dramaUid
    || !UUID_V4.test(batchInput.authorizationUid) || !UUID_V4.test(batchInput.sessionUid)
    || !UUID_V4.test(batchInput.dramaUid) || !UUID_V4.test(batchInput.attestationUid)
    || !SHA256.test(batchInput.batchSha256)
    || !Number.isSafeInteger(batchInput.estimatedCostCnyFen)
    || batchInput.estimatedCostCnyFen < 0
    || !Number.isSafeInteger(batchInput.preparedAtEpochMs)
    || batchInput.preparedAtEpochMs < 0 || batchInput.preparedAtEpochMs > MAX_EPOCH_MS) {
    fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  const rawReservations = denseArray(batchInput.reservations, 2, 64);
  const reservations = [];
  for (let index = 0; index < rawReservations.length; index += 1) {
    try {
      reservations[index] = parseMvpBenchmarkExecutionReservation(rawReservations[index]);
    } catch {
      return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
    }
  }
  const environmentKeys = [
    'authorizationUid', 'sessionUid', 'connectionUid', 'connectionEvidenceSha256',
    'approvedEnvironmentSha256',
  ];
  const environmentRequest = exactDataObject(
    descriptors.environmentRequest.value,
    environmentKeys,
  );
  if (environmentRequest.authorizationUid !== expected.authorizationUid
    || environmentRequest.sessionUid !== expected.sessionUid
    || !UUID_V4.test(environmentRequest.connectionUid)
    || !SHA256.test(environmentRequest.connectionEvidenceSha256)
    || !SHA256.test(environmentRequest.approvedEnvironmentSha256)) {
    fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  const batch = OBJECT_FREEZE({
    schemaVersion: batchInput.schemaVersion,
    authorizationUid: batchInput.authorizationUid,
    sessionUid: batchInput.sessionUid,
    dramaUid: batchInput.dramaUid,
    attestationUid: batchInput.attestationUid,
    reservations: OBJECT_FREEZE(reservations),
    estimatedCostCnyFen: batchInput.estimatedCostCnyFen,
    preparedAtEpochMs: batchInput.preparedAtEpochMs,
    batchSha256: batchInput.batchSha256,
  });
  return OBJECT_FREEZE({
    batch,
    environmentRequest: OBJECT_FREEZE(environmentRequest),
    reservations,
  });
}

function h3Request(intent, task) {
  const bundle = createH3TextToVideoWorkflowBundle();
  if (intent.manifestUid !== bundle.manifest.uid
    || task.workflowManifestUid !== bundle.manifest.uid
    || task.uid !== intent.taskUid
    || !Number.isSafeInteger(task.stateVersion) || task.stateVersion < 0) {
    fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
  }
  return OBJECT_FREEZE({
    expectedStateVersion: task.stateVersion,
    workflowBase64: REFLECT_APPLY(
      BUFFER_TO_STRING,
      REFLECT_APPLY(BUFFER_FROM, Buffer, [bundle.workflowJson, 'utf8']),
      ['base64'],
    ),
    values: OBJECT_FREEZE({
      prompt: intent.generationSpec.prompt.text,
      width: intent.generationSpec.width,
      height: intent.generationSpec.height,
      frames: intent.generationSpec.frames,
      seed: intent.generationSpec.seed,
      filenamePrefix: intent.filenamePrefix,
    }),
    uploads: OBJECT_FREEZE([]),
    output: OBJECT_FREEZE({ logicalName: 'video', assetUid: intent.assetUid }),
  });
}

function step(context, completedCount, item) {
  return OBJECT_FREEZE({
    schemaVersion: SCHEMA_VERSION,
    authorizationUid: context.batch.authorizationUid,
    sessionUid: context.batch.sessionUid,
    dramaUid: context.batch.dramaUid,
    completedCount,
    totalCount: context.reservations.length,
    batchComplete: completedCount === context.reservations.length,
    item,
  });
}

function completedItem(ordinal, reservation) {
  return OBJECT_FREEZE({
    ordinal,
    itemKind: reservation.itemKind,
    itemUid: reservation.itemUid,
    status: 'succeeded',
  });
}

function audioResult(value, reservation, dramaUid) {
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)
    || value.intentUid !== reservation.itemUid || value.dramaUid !== dramaUid) {
    fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED');
  }
  return value;
}

function sameContextIdentity(left, right) {
  return left.batch.schemaVersion === right.batch.schemaVersion
    && left.batch.authorizationUid === right.batch.authorizationUid
    && left.batch.sessionUid === right.batch.sessionUid
    && left.batch.dramaUid === right.batch.dramaUid
    && left.batch.attestationUid === right.batch.attestationUid
    && left.batch.estimatedCostCnyFen === right.batch.estimatedCostCnyFen
    && left.batch.preparedAtEpochMs === right.batch.preparedAtEpochMs
    && left.batch.batchSha256 === right.batch.batchSha256
    && left.environmentRequest.authorizationUid
      === right.environmentRequest.authorizationUid
    && left.environmentRequest.sessionUid === right.environmentRequest.sessionUid
    && left.environmentRequest.connectionUid === right.environmentRequest.connectionUid
    && left.environmentRequest.connectionEvidenceSha256
      === right.environmentRequest.connectionEvidenceSha256
    && left.environmentRequest.approvedEnvironmentSha256
      === right.environmentRequest.approvedEnvironmentSha256;
}

function createMvpBenchmarkProductionExecutionService(value) {
  const configured = exactConfiguration(value);
  const contexts = new Map();
  const active = new Map();

  function loadContext(input) {
    let opened;
    try {
      opened = call(configured.loadBatch, [
        input.authorizationUid,
        OBJECT_FREEZE({ nowEpochMs: now(configured) }),
      ]);
    } catch {
      return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
    }
    const context = executionContext(opened, input);
    const existing = REFLECT_APPLY(MAP_GET, contexts, [input.authorizationUid]);
    if (existing && !sameContextIdentity(existing, context)) {
      fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
    }
    REFLECT_APPLY(MAP_SET, contexts, [input.authorizationUid, context]);
    return context;
  }

  async function freshPermit(context, reservation) {
    const observation = await settleUnavailable(call(configured.inspect, [
      context.environmentRequest,
    ]));
    try {
      return call(configured.openItem, [
        OBJECT_FREEZE({
          attestationUid: nextUid(configured),
          authorizationUid: context.batch.authorizationUid,
          itemKind: reservation.itemKind,
          itemUid: reservation.itemUid,
          observation,
          reservationUid: reservation.uid,
        }),
        OBJECT_FREEZE({ nowEpochMs: now(configured) }),
      ]);
    } catch {
      return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
    }
  }

  async function execute(input) {
    const context = loadContext(input);
    let firstIncomplete = -1;
    const taskStates = [];
    for (let index = 0; index < context.reservations.length; index += 1) {
      const reservation = context.reservations[index];
      if (reservation.itemKind === 'h3') {
        let existing;
        try { existing = call(configured.h3Get, [reservation.itemUid]); } catch {
          return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED');
        }
        if (existing !== null) {
          try { parseH3LocalExecutionResult(existing); } catch {
            return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED');
          }
          if (firstIncomplete !== -1) {
            return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
          }
          continue;
        }
        let task;
        try { task = call(configured.remoteTask, [reservation.itemUid]); } catch {
          return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED');
        }
        if (firstIncomplete === -1) firstIncomplete = index;
        else if (task.stage !== 'prepared' || task.status !== 'queued'
          || task.promptId !== null || task.outputAssetVersionUid !== null) {
          return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
        }
        taskStates[index] = task;
        continue;
      }

      let existing;
      try {
        existing = await settle(call(configured.audioGet, [
          reservation.itemUid, context.batch.dramaUid,
        ]));
      } catch (error) {
        if (error instanceof MvpBenchmarkProductionExecutionError) throw error;
        return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED');
      }
      if (existing !== null) {
        audioResult(existing, reservation, context.batch.dramaUid);
        if (firstIncomplete !== -1) {
          return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
        }
      } else if (firstIncomplete === -1) {
        firstIncomplete = index;
      }
    }

    if (firstIncomplete === -1) {
      return step(context, context.reservations.length, null);
    }
    const reservation = context.reservations[firstIncomplete];
    if (reservation.itemKind === 'h3') {
      const task = taskStates[firstIncomplete];
      let intent;
      let permit;
      try {
        if (task.stage !== 'prepared' || task.status !== 'queued'
          || task.promptId !== null || task.outputAssetVersionUid !== null) {
          const code = task.status === 'running'
            ? 'MVP_BENCHMARK_PRODUCTION_EXECUTION_IN_PROGRESS'
            : 'MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED';
          return fail(code);
        }
        permit = await freshPermit(context, reservation);
        call(configured.assertH3, [reservation.itemUid, permit]);
        intent = call(configured.h3Intent, [reservation.itemUid]);
      } catch (error) {
        if (error instanceof MvpBenchmarkProductionExecutionError) throw error;
        return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
      }
      await settle(call(configured.h3Execute, [
        reservation.itemUid,
        h3Request(intent, task),
        permit,
      ]));
      let persisted;
      try { persisted = call(configured.h3Get, [reservation.itemUid]); } catch {
        return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED');
      }
      try { parseH3LocalExecutionResult(persisted); } catch {
        return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_FAILED');
      }
      return step(
        context,
        firstIncomplete + 1,
        completedItem(firstIncomplete, reservation),
      );
    }

    let permit;
    try {
      permit = await freshPermit(context, reservation);
      call(configured.assertAudio, [reservation.itemUid, permit]);
    } catch {
      return fail('MVP_BENCHMARK_PRODUCTION_EXECUTION_UNAVAILABLE');
    }
    await settle(call(configured.audioExecute, [
      reservation.itemUid, context.batch.dramaUid, permit,
    ]));
    const persisted = await settle(call(configured.audioGet, [
      reservation.itemUid, context.batch.dramaUid,
    ]));
    audioResult(persisted, reservation, context.batch.dramaUid);
    return step(
      context,
      firstIncomplete + 1,
      completedItem(firstIncomplete, reservation),
    );
  }

  return OBJECT_FREEZE({
    executeNext(valueToExecute) {
      const input = request(valueToExecute);
      const existing = REFLECT_APPLY(MAP_GET, active, [input.authorizationUid]);
      if (existing) return existing;
      let pending;
      pending = (async () => {
        try {
          return await execute(input);
        } finally {
          if (REFLECT_APPLY(MAP_GET, active, [input.authorizationUid]) === pending) {
            REFLECT_APPLY(MAP_DELETE, active, [input.authorizationUid]);
          }
        }
      })();
      REFLECT_APPLY(MAP_SET, active, [input.authorizationUid, pending]);
      return pending;
    },
  });
}

function isMvpBenchmarkProductionExecutionError(error) {
  return error instanceof MvpBenchmarkProductionExecutionError;
}

module.exports = OBJECT_FREEZE({
  MvpBenchmarkProductionExecutionError,
  createMvpBenchmarkProductionExecutionService,
  isMvpBenchmarkProductionExecutionError,
});
