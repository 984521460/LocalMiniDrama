'use strict';

const { types: { isProxy } } = require('node:util');

const {
  MvpBenchmarkExternalAuthorizationError,
} = require('./mvpBenchmarkExternalAuthorization');
const {
  assertMvpBenchmarkLiveEnvironmentAttestationFresh,
} = require('./mvpBenchmarkExecutionPreflight');
const { remoteConnectionEvidenceSha256 } = require('../remote/connectionProfile');

const ARRAY_IS_ARRAY = Array.isArray;
const DATE_NOW = Date.now;
const MATH_MIN = Math.min;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_CREATE = Object.create;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const MONOTONIC_NOW = process.hrtime.bigint;

function unavailable() {
  throw new MvpBenchmarkExternalAuthorizationError(
    'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE',
  );
}

function captureMethod(target, name) {
  if (!target || typeof target !== 'object' || isProxy(target)) return null;
  try {
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(target)[name];
    return descriptor && OBJECT_HAS_OWN(descriptor, 'value')
      && typeof descriptor.value === 'function' && !isProxy(descriptor.value)
      ? OBJECT_FREEZE({ method: descriptor.value, target })
      : null;
  } catch {
    return null;
  }
}

function configuration(value) {
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) {
    throw new TypeError('MVP benchmark execution gate configuration is invalid');
  }
  let descriptors;
  let prototype;
  try {
    descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    prototype = OBJECT_GET_PROTOTYPE_OF(value);
  } catch {
    throw new TypeError('MVP benchmark execution gate configuration is invalid');
  }
  const keys = REFLECT_OWN_KEYS(descriptors);
  const expectedKeys = [
    'audioModeIntents', 'authorizations', 'h3GenerationIntents', 'preflights', 'remote',
  ];
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== expectedKeys.length) {
    throw new TypeError('MVP benchmark execution gate configuration is invalid');
  }
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = descriptors[keys[index]];
    if (typeof keys[index] !== 'string' || !descriptor?.enumerable
      || !OBJECT_HAS_OWN(descriptor, 'value')) {
      throw new TypeError('MVP benchmark execution gate configuration is invalid');
    }
  }
  for (let index = 0; index < expectedKeys.length; index += 1) {
    if (!OBJECT_HAS_OWN(descriptors, expectedKeys[index])) {
      throw new TypeError('MVP benchmark execution gate configuration is invalid');
    }
  }
  const authorizations = descriptors.authorizations.value;
  const preflights = descriptors.preflights.value;
  const configured = {
    audioIntent: captureMethod(descriptors.audioModeIntents.value, 'getExecutionSource'),
    assertAudio: captureMethod(authorizations, 'assertAudioIntentExecutionOpen'),
    assertH3: captureMethod(authorizations, 'assertH3TaskExecutionOpen'),
    authorizationStored: captureMethod(authorizations, 'getStored'),
    connection: captureMethod(descriptors.remote.value, 'getConnection'),
    requireActive: captureMethod(authorizations, 'requireActive'),
    h3Intent: captureMethod(descriptors.h3GenerationIntents.value, 'getExecutionSource'),
    getAttestation: captureMethod(preflights, 'getAttestation'),
    getBatch: captureMethod(preflights, 'getBatchByAuthorization'),
    storedAttestation: captureMethod(preflights, 'getStoredAttestation'),
    storedReservation: captureMethod(preflights, 'getStoredReservation'),
  };
  const configuredKeys = REFLECT_OWN_KEYS(configured);
  for (let index = 0; index < configuredKeys.length; index += 1) {
    if (!configured[configuredKeys[index]]) {
      throw new TypeError('MVP benchmark execution gate configuration is invalid');
    }
  }
  if (!configured.assertAudio || !configured.assertH3 || !configured.requireActive) {
    throw new TypeError('MVP benchmark execution gate configuration is invalid');
  }
  return OBJECT_FREEZE(configured);
}

function nowOptions(value) {
  if (value === undefined) return REFLECT_APPLY(DATE_NOW, Date, []);
  try {
    if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)
      || OBJECT_GET_PROTOTYPE_OF(value) !== Object.prototype) unavailable();
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    if (REFLECT_OWN_KEYS(descriptors).length !== 1
      || !descriptors.nowEpochMs?.enumerable
      || !OBJECT_HAS_OWN(descriptors.nowEpochMs, 'value')) unavailable();
    const nowEpochMs = descriptors.nowEpochMs.value;
    if (!NUMBER_IS_SAFE_INTEGER(nowEpochMs) || nowEpochMs < 0
      || nowEpochMs > 253402300799999) unavailable();
    return nowEpochMs;
  } catch (error) {
    if (error instanceof MvpBenchmarkExternalAuthorizationError) throw error;
    return unavailable();
  }
}

function createMvpBenchmarkExecutionGate(options) {
  const configured = configuration(options);
  const permits = new WeakMap();

  function call(binding, argumentsList) {
    return REFLECT_APPLY(binding.method, binding.target, argumentsList);
  }

  function assertPermitCurrent(metadata) {
    try {
      if (MONOTONIC_NOW() >= metadata.expiresAtMonotonicNanoseconds) unavailable();
      const authorization = call(configured.authorizationStored, [metadata.authorizationUid]);
      const attestation = call(configured.storedAttestation, [metadata.attestationUid]);
      const reservation = call(configured.storedReservation, [metadata.reservationUid]);
      const connection = call(configured.connection, [metadata.connectionUid]);
      if (authorization.authorizationSha256 !== metadata.authorizationSha256
        || authorization.sessionPlanSha256 !== metadata.sessionPlanSha256
        || attestation.attestationSha256 !== metadata.attestationSha256
        || reservation.reservationSha256 !== metadata.reservationSha256
        || reservation.authorizationUid !== metadata.authorizationUid
        || reservation.attestationUid !== metadata.attestationUid
        || reservation.sessionUid !== metadata.sessionUid
        || reservation.itemKind !== metadata.itemKind
        || reservation.itemUid !== metadata.itemUid
        || reservation.requestSha256 !== metadata.requestSha256
        || connection.uid !== metadata.connectionUid
        || remoteConnectionEvidenceSha256(connection) !== metadata.connectionEvidenceSha256) {
        unavailable();
      }
      if (metadata.itemKind === 'h3') {
        const intent = call(configured.h3Intent, [metadata.itemUid]);
        if (intent.planEvidenceSha256 !== metadata.requestSha256) unavailable();
      } else {
        const intent = call(configured.audioIntent, [metadata.itemUid]);
        if (intent.plan.planSha256 !== metadata.requestSha256) unavailable();
      }
      return true;
    } catch (error) {
      if (error instanceof MvpBenchmarkExternalAuthorizationError) throw error;
      return unavailable();
    }
  }

  function assertItemOpen(kind, itemUid, permit) {
    const metadata = permit !== null && (typeof permit === 'object' || typeof permit === 'function')
      ? REFLECT_APPLY(WEAK_MAP_GET, permits, [permit])
      : undefined;
    if (metadata !== undefined) {
      if (metadata.itemKind !== kind || metadata.itemUid !== itemUid) unavailable();
      return assertPermitCurrent(metadata);
    }
    const fallback = kind === 'h3' ? configured.assertH3 : configured.assertAudio;
    return REFLECT_APPLY(fallback.method, fallback.target, [itemUid]);
  }

  return OBJECT_FREEZE({
    assertAudioIntentExecutionOpen(intentUid, permit) {
      return assertItemOpen('tts', intentUid, permit);
    },
    assertH3TaskExecutionOpen(taskUid, permit) {
      return assertItemOpen('h3', taskUid, permit);
    },
    openBatch(authorizationUid, optionsValue) {
      const nowEpochMs = nowOptions(optionsValue);
      try {
        const authorization = call(configured.requireActive, [authorizationUid, nowEpochMs]);
        const batch = call(configured.getBatch, [authorizationUid]);
        if (!batch || batch.authorizationUid !== authorization.uid) unavailable();
        const attestation = call(configured.getAttestation, [batch.attestationUid]);
        assertMvpBenchmarkLiveEnvironmentAttestationFresh(attestation, nowEpochMs);
        const expiresAfterMs = REFLECT_APPLY(MATH_MIN, Math, [
          authorization.expiresAtEpochMs,
          attestation.expiresAtEpochMs,
        ]) - nowEpochMs;
        if (!NUMBER_IS_SAFE_INTEGER(expiresAfterMs) || expiresAfterMs <= 0) unavailable();
        const expiresAtMonotonicNanoseconds = MONOTONIC_NOW()
          + BigInt(expiresAfterMs) * 1_000_000n;
        const output = [];
        for (let index = 0; index < batch.reservations.length; index += 1) {
          const reservation = batch.reservations[index];
          const permit = OBJECT_FREEZE(OBJECT_CREATE(null));
          REFLECT_APPLY(WEAK_MAP_SET, permits, [permit, OBJECT_FREEZE({
            authorizationUid: authorization.uid,
            authorizationSha256: authorization.authorizationSha256,
            attestationSha256: attestation.attestationSha256,
            attestationUid: attestation.uid,
            batchSha256: batch.batchSha256,
            connectionEvidenceSha256: authorization.connectionEvidenceSha256,
            connectionUid: authorization.connectionUid,
            expiresAtMonotonicNanoseconds,
            itemKind: reservation.itemKind,
            itemUid: reservation.itemUid,
            requestSha256: reservation.requestSha256,
            reservationUid: reservation.uid,
            reservationSha256: reservation.reservationSha256,
            sessionUid: batch.sessionUid,
            sessionPlanSha256: authorization.sessionPlanSha256,
          })]);
          output[index] = permit;
        }
        return OBJECT_FREEZE(output);
      } catch {
        return unavailable();
      }
    },
  });
}

module.exports = OBJECT_FREEZE({ createMvpBenchmarkExecutionGate });
