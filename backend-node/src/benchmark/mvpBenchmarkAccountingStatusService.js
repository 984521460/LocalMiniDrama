'use strict';

const { types: { isProxy } } = require('node:util');

const ARRAY_CONSTRUCTOR = Array;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_CREATE = Object.create;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_PROTOTYPE = Object.prototype;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_TEST = RegExp.prototype.test;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SCHEMA_VERSION = 'mvp-benchmark-accounting-status.v1';
const MAXIMUM_COST_CNY_FEN = 1_000_000;

class MvpBenchmarkAccountingStatusError extends Error {
  constructor(code) {
    const messages = OBJECT_FREEZE({
      MVP_BENCHMARK_ACCOUNTING_STATUS_INPUT_INVALID:
        'MVP benchmark accounting status input is invalid',
      MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE:
        'MVP benchmark accounting status is unavailable',
    });
    super(messages[code] ?? messages.MVP_BENCHMARK_ACCOUNTING_STATUS_INPUT_INVALID);
    this.name = 'MvpBenchmarkAccountingStatusError';
    this.code = code;
    OBJECT_FREEZE(this);
  }
}

function fail(code) {
  throw new MvpBenchmarkAccountingStatusError(code);
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

function ownDataValue(target, name) {
  if (!target || typeof target !== 'object' || isProxy(target)) return null;
  try {
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(target);
    if (!OBJECT_HAS_OWN(descriptors, name)) return null;
    const descriptor = descriptors[name];
    if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) return null;
    return descriptor.value;
  } catch {
    return null;
  }
}

function configuration(value) {
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) {
    throw new TypeError('MVP benchmark accounting status service configuration is invalid');
  }
  let descriptors;
  let prototype;
  try {
    descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    prototype = OBJECT_GET_PROTOTYPE_OF(value);
  } catch {
    throw new TypeError('MVP benchmark accounting status service configuration is invalid');
  }
  if (prototype !== Object.prototype && prototype !== null
    || REFLECT_OWN_KEYS(descriptors).length !== 1
    || !OBJECT_HAS_OWN(descriptors, 'repositories')) {
    throw new TypeError('MVP benchmark accounting status service configuration is invalid');
  }
  const descriptor = descriptors.repositories;
  if (!descriptor.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
    throw new TypeError('MVP benchmark accounting status service configuration is invalid');
  }
  const repositories = descriptor.value;
  const authorizations = ownDataValue(repositories, 'mvpBenchmarkExternalAuthorizations');
  const preflights = ownDataValue(repositories, 'mvpBenchmarkExecutionPreflights');
  const accounting = ownDataValue(repositories, 'mvpBenchmarkExecutionAccounting');
  const configured = OBJECT_FREEZE({
    authorizationStored: captureMethod(authorizations, 'getStoredBySession'),
    batchStored: captureMethod(preflights, 'getStoredBatchByAuthorization'),
    settlementByReservation: captureMethod(accounting, 'getSettlementByReservation'),
    actualCost: captureMethod(accounting, 'getActualCostCnyFen'),
    release: captureMethod(accounting, 'getReleaseObligation'),
  });
  const keys = REFLECT_OWN_KEYS(configured);
  for (let index = 0; index < keys.length; index += 1) {
    if (configured[keys[index]] === null) {
      throw new TypeError('MVP benchmark accounting status service configuration is invalid');
    }
  }
  return configured;
}

function call(binding, argumentsList) {
  return REFLECT_APPLY(binding.method, binding.target, argumentsList);
}

function plainData(value) {
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) {
    return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
  }
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  const keys = REFLECT_OWN_KEYS(descriptors);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
    return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
  }
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string' || !OBJECT_HAS_OWN(descriptors, key)) {
      return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
      return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
    }
  }
  return value;
}

function denseDataArray(value, maximumLength) {
  if (!ARRAY_IS_ARRAY(value) || isProxy(value)
    || OBJECT_GET_PROTOTYPE_OF(value) !== ARRAY_PROTOTYPE) {
    return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
  }
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
  if (!OBJECT_HAS_OWN(descriptors, 'length')) {
    return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
  }
  const lengthDescriptor = descriptors.length;
  if (!OBJECT_HAS_OWN(lengthDescriptor, 'value')) {
    return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
  }
  const length = lengthDescriptor.value;
  if (!NUMBER_IS_SAFE_INTEGER(length) || length < 1 || length > maximumLength
    || REFLECT_OWN_KEYS(descriptors).length !== length + 1) {
    return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
  }
  const output = new ARRAY_CONSTRUCTOR(length);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!OBJECT_HAS_OWN(descriptors, key)) {
      return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
      return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
    }
    output[index] = plainData(descriptor.value);
  }
  return output;
}

function uid(value) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, UUID_V4, [value])) {
    fail('MVP_BENCHMARK_ACCOUNTING_STATUS_INPUT_INVALID');
  }
  return value;
}

function sha256(value) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, SHA256, [value])) {
    fail('MVP_BENCHMARK_ACCOUNTING_STATUS_INPUT_INVALID');
  }
  return value;
}

function isUid(value) {
  return typeof value === 'string' && REFLECT_APPLY(REGEXP_TEST, UUID_V4, [value]);
}

function isSha256(value) {
  return typeof value === 'string' && REFLECT_APPLY(REGEXP_TEST, SHA256, [value]);
}

function request(value) {
  try {
    if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)
      || OBJECT_GET_PROTOTYPE_OF(value) !== OBJECT_PROTOTYPE) {
      fail('MVP_BENCHMARK_ACCOUNTING_STATUS_INPUT_INVALID');
    }
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    const keys = ['dramaUid', 'sessionUid', 'authorizationUid', 'batchSha256'];
    if (REFLECT_OWN_KEYS(descriptors).length !== keys.length) {
      fail('MVP_BENCHMARK_ACCOUNTING_STATUS_INPUT_INVALID');
    }
    const output = OBJECT_CREATE(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!OBJECT_HAS_OWN(descriptors, key)) {
        fail('MVP_BENCHMARK_ACCOUNTING_STATUS_INPUT_INVALID');
      }
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
        fail('MVP_BENCHMARK_ACCOUNTING_STATUS_INPUT_INVALID');
      }
      output[key] = descriptor.value;
    }
    return OBJECT_FREEZE({
      dramaUid: uid(output.dramaUid),
      sessionUid: uid(output.sessionUid),
      authorizationUid: uid(output.authorizationUid),
      batchSha256: sha256(output.batchSha256),
    });
  } catch (error) {
    if (error instanceof MvpBenchmarkAccountingStatusError) throw error;
    return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_INPUT_INVALID');
  }
}

function createMvpBenchmarkAccountingStatusService(value) {
  const configured = configuration(value);

  return OBJECT_FREEZE({
    read(valueToRead) {
      const input = request(valueToRead);
      try {
        const authorization = plainData(call(configured.authorizationStored, [input.sessionUid]));
        if (!authorization || authorization.uid !== input.authorizationUid
          || authorization.sessionUid !== input.sessionUid
          || authorization.dramaUid !== input.dramaUid) {
          return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
        }
        const batch = plainData(call(configured.batchStored, [input.authorizationUid]));
        if (!batch || batch.authorizationUid !== input.authorizationUid
          || batch.sessionUid !== input.sessionUid || batch.dramaUid !== input.dramaUid
          || batch.batchSha256 !== input.batchSha256) {
          return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
        }
        const reservations = denseDataArray(batch.reservations, 128);
        const totalCount = reservations.length;
        const items = new ARRAY_CONSTRUCTOR(totalCount);
        let settledCount = 0;
        let actualCostCnyFen = 0;
        for (let index = 0; index < totalCount; index += 1) {
          const reservation = reservations[index];
          if (!isUid(reservation.uid)
            || (reservation.itemKind !== 'h3' && reservation.itemKind !== 'tts')
            || !isUid(reservation.itemUid)
            || !isSha256(reservation.requestSha256)
            || !NUMBER_IS_SAFE_INTEGER(reservation.estimatedCostCnyFen)
            || reservation.estimatedCostCnyFen < 0
            || reservation.estimatedCostCnyFen > MAXIMUM_COST_CNY_FEN) {
            return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
          }
          const loadedSettlement = call(configured.settlementByReservation, [reservation.uid]);
          const settlement = loadedSettlement === null ? null : plainData(loadedSettlement);
          if (!settlement) {
            items[index] = OBJECT_FREEZE({
              ordinal: index,
              itemKind: reservation.itemKind,
              itemUid: reservation.itemUid,
              reservationUid: reservation.uid,
              settlementState: 'pending',
              settlementUid: null,
              settlementSha256: null,
              actualCostCnyFen: null,
            });
            continue;
          }
          if (settlement.reservationUid !== reservation.uid
            || settlement.authorizationUid !== input.authorizationUid
            || settlement.sessionUid !== input.sessionUid
            || settlement.dramaUid !== input.dramaUid
            || settlement.itemKind !== reservation.itemKind
            || settlement.itemUid !== reservation.itemUid
            || settlement.requestSha256 !== reservation.requestSha256
            || settlement.estimatedCostCnyFen !== reservation.estimatedCostCnyFen
            || !isUid(settlement.uid)
            || !NUMBER_IS_SAFE_INTEGER(settlement.actualCostCnyFen)
            || settlement.actualCostCnyFen < 0
            || settlement.actualCostCnyFen > reservation.estimatedCostCnyFen
            || typeof settlement.settlementSha256 !== 'string'
            || !REFLECT_APPLY(REGEXP_TEST, SHA256, [settlement.settlementSha256])) {
            return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
          }
          settledCount += 1;
          actualCostCnyFen += settlement.actualCostCnyFen;
          if (!NUMBER_IS_SAFE_INTEGER(actualCostCnyFen)
            || actualCostCnyFen < 0 || actualCostCnyFen > MAXIMUM_COST_CNY_FEN) {
            return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
          }
          items[index] = OBJECT_FREEZE({
            ordinal: index,
            itemKind: reservation.itemKind,
            itemUid: reservation.itemUid,
            reservationUid: reservation.uid,
            settlementState: 'settled',
            settlementUid: settlement.uid,
            settlementSha256: settlement.settlementSha256,
            actualCostCnyFen: settlement.actualCostCnyFen,
          });
        }
        if (call(configured.actualCost, [input.authorizationUid]) !== actualCostCnyFen) {
          return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
        }
        const release = plainData(call(configured.release, [input.authorizationUid]));
        const obligation = plainData(release.obligation);
        const receipt = release.receipt === null ? null : plainData(release.receipt);
        if (!release || (release.state !== 'required' && release.state !== 'released')
          || obligation.authorizationUid !== input.authorizationUid
          || obligation.sessionUid !== input.sessionUid
          || obligation.dramaUid !== input.dramaUid
          || typeof obligation.obligationSha256 !== 'string'
          || !REFLECT_APPLY(REGEXP_TEST, SHA256, [obligation.obligationSha256])
          || (release.state === 'required' && receipt !== null)
          || (release.state === 'released' && (!receipt
            || receipt.authorizationUid !== input.authorizationUid
            || receipt.obligationSha256 !== obligation.obligationSha256
            || typeof receipt.receiptSha256 !== 'string'
            || !REFLECT_APPLY(REGEXP_TEST, SHA256, [receipt.receiptSha256])))) {
          return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
        }
        return OBJECT_FREEZE({
          schemaVersion: SCHEMA_VERSION,
          dramaUid: input.dramaUid,
          sessionUid: input.sessionUid,
          authorizationUid: input.authorizationUid,
          batchSha256: input.batchSha256,
          totalCount,
          settledCount,
          actualCostCnyFen,
          allSettled: settledCount === totalCount,
          releaseState: release.state,
          obligationSha256: obligation.obligationSha256,
          receiptSha256: receipt?.receiptSha256 ?? null,
          items: OBJECT_FREEZE(items),
        });
      } catch (error) {
        if (error instanceof MvpBenchmarkAccountingStatusError) throw error;
        return fail('MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE');
      }
    },
  });
}

module.exports = OBJECT_FREEZE({
  MvpBenchmarkAccountingStatusError,
  SCHEMA_VERSION,
  createMvpBenchmarkAccountingStatusService,
});
