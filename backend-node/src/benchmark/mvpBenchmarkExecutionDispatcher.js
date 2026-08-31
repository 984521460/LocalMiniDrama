'use strict';

const { types: { isProxy } } = require('node:util');

const { raceNativePromise } = require('../integrations/comfyui/asyncControl');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ARRAY_IS_ARRAY = Array.isArray;
const MAP_CONSTRUCTOR = Map;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const MAP_SIZE = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_FREEZE = Object.freeze;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_TEST = RegExp.prototype.test;

class MvpBenchmarkExecutionDispatchError extends Error {
  constructor(code) {
    const messages = {
      MVP_BENCHMARK_EXECUTION_DISPATCH_FAILED:
        'MVP benchmark synthetic execution dispatch failed',
      MVP_BENCHMARK_EXECUTION_DISPATCH_INVALID:
        'MVP benchmark synthetic execution dispatch is invalid',
    };
    super(messages[code] ?? messages.MVP_BENCHMARK_EXECUTION_DISPATCH_INVALID);
    this.name = 'MvpBenchmarkExecutionDispatchError';
    this.code = code;
    OBJECT_FREEZE(this);
  }
}

function fail(code) {
  throw new MvpBenchmarkExecutionDispatchError(code);
}

function method(target, name) {
  if (!target || typeof target !== 'object' || isProxy(target)) return null;
  try {
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(target, name);
    return descriptor?.enumerable && OBJECT_HAS_OWN(descriptor, 'value')
      && typeof descriptor.value === 'function' && !isProxy(descriptor.value)
      ? OBJECT_FREEZE({ method: descriptor.value, target })
      : null;
  } catch {
    return null;
  }
}

function configuration(value) {
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) {
    throw new TypeError('MVP benchmark synthetic dispatcher configuration is invalid');
  }
  let descriptors;
  try { descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value); } catch {
    throw new TypeError('MVP benchmark synthetic dispatcher configuration is invalid');
  }
  const expected = [
    'executionGate', 'preflights', 'syntheticH3Executor', 'syntheticTtsExecutor',
  ];
  if (OBJECT_GET_PROTOTYPE_OF(value) !== Object.prototype
    || REFLECT_OWN_KEYS(descriptors).length !== expected.length) {
    throw new TypeError('MVP benchmark synthetic dispatcher configuration is invalid');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const descriptor = descriptors[expected[index]];
    if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
      throw new TypeError('MVP benchmark synthetic dispatcher configuration is invalid');
    }
  }
  const configured = OBJECT_FREEZE({
    assertH3: method(descriptors.executionGate.value, 'assertH3TaskExecutionOpen'),
    assertTts: method(descriptors.executionGate.value, 'assertAudioIntentExecutionOpen'),
    getBatch: method(descriptors.preflights.value, 'getBatchByAuthorization'),
    h3: method(descriptors.syntheticH3Executor.value, 'execute'),
    openBatch: method(descriptors.executionGate.value, 'openBatch'),
    tts: method(descriptors.syntheticTtsExecutor.value, 'execute'),
  });
  if (!configured.assertH3 || !configured.assertTts || !configured.getBatch
    || !configured.h3 || !configured.openBatch || !configured.tts) {
    throw new TypeError('MVP benchmark synthetic dispatcher configuration is invalid');
  }
  return configured;
}

function itemKey(kind, uid) {
  if ((kind !== 'h3' && kind !== 'tts')
    || typeof uid !== 'string' || !REFLECT_APPLY(REGEXP_TEST, UUID_V4, [uid])) {
    fail('MVP_BENCHMARK_EXECUTION_DISPATCH_INVALID');
  }
  return `${kind}:${uid}`;
}

function createMvpBenchmarkExecutionDispatcher(options) {
  const configured = configuration(options);
  const openedBatches = new MAP_CONSTRUCTOR();

  return OBJECT_FREEZE({
    openSyntheticBatch(authorizationUid, openOptions) {
      const opened = REFLECT_APPLY(MAP_GET, openedBatches, [authorizationUid]);
      if (opened) return opened;
      let batch;
      let permits;
      try {
        permits = REFLECT_APPLY(
          configured.openBatch.method,
          configured.openBatch.target,
          [authorizationUid, openOptions],
        );
        batch = REFLECT_APPLY(
          configured.getBatch.method,
          configured.getBatch.target,
          [authorizationUid],
        );
      } catch {
        return fail('MVP_BENCHMARK_EXECUTION_DISPATCH_INVALID');
      }
      if (!batch || !ARRAY_IS_ARRAY(permits)
        || permits.length !== batch.reservations.length) {
        fail('MVP_BENCHMARK_EXECUTION_DISPATCH_INVALID');
      }
      const entries = new MAP_CONSTRUCTOR();
      for (let index = 0; index < batch.reservations.length; index += 1) {
        const reservation = batch.reservations[index];
        REFLECT_APPLY(MAP_SET, entries, [
          itemKey(reservation.itemKind, reservation.itemUid), OBJECT_FREEZE({
            assertOpen: reservation.itemKind === 'h3'
              ? configured.assertH3 : configured.assertTts,
            executor: reservation.itemKind === 'h3' ? configured.h3 : configured.tts,
            itemKind: reservation.itemKind,
            itemUid: reservation.itemUid,
            permit: permits[index],
          }),
        ]);
      }
      if (REFLECT_APPLY(MAP_SIZE, entries, []) !== batch.reservations.length) {
        fail('MVP_BENCHMARK_EXECUTION_DISPATCH_INVALID');
      }
      const executions = new MAP_CONSTRUCTOR();

      const openedBatch = OBJECT_FREEZE({
        executeItem(kind, uid) {
          const key = itemKey(kind, uid);
          const entry = REFLECT_APPLY(MAP_GET, entries, [key]);
          if (!entry) fail('MVP_BENCHMARK_EXECUTION_DISPATCH_INVALID');
          const existing = REFLECT_APPLY(MAP_GET, executions, [key]);
          if (existing) return existing;
          const pending = (async () => {
            await 0;
            try {
              REFLECT_APPLY(
                entry.assertOpen.method,
                entry.assertOpen.target,
                [entry.itemUid, entry.permit],
              );
              const result = REFLECT_APPLY(
                entry.executor.method,
                entry.executor.target,
                [entry.itemUid, entry.permit],
              );
              return await raceNativePromise(result);
            } catch {
              return fail('MVP_BENCHMARK_EXECUTION_DISPATCH_FAILED');
            }
          })();
          REFLECT_APPLY(MAP_SET, executions, [key, pending]);
          return pending;
        },
      });
      REFLECT_APPLY(MAP_SET, openedBatches, [authorizationUid, openedBatch]);
      return openedBatch;
    },
  });
}

module.exports = OBJECT_FREEZE({
  MvpBenchmarkExecutionDispatchError,
  createMvpBenchmarkExecutionDispatcher,
});
