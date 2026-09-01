'use strict';

const { types: { isProxy } } = require('node:util');

const {
  MvpBenchmarkExternalAuthorizationError,
  assertMvpBenchmarkExternalAuthorizationActive,
} = require('./mvpBenchmarkExternalAuthorization');
const {
  createMvpBenchmarkLiveEnvironmentAttestation,
  createMvpBenchmarkLiveEnvironmentObservation,
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
const MAX_ITEM_EXECUTION_LEASE_MS = 30 * 60 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
    formalTask: captureMethod(descriptors.remote.value, 'getFormalTask'),
    requireActive: captureMethod(authorizations, 'requireActive'),
    h3Intent: captureMethod(descriptors.h3GenerationIntents.value, 'getExecutionSource'),
    h3StoredIntent: captureMethod(descriptors.h3GenerationIntents.value, 'getByTask'),
    getAttestation: captureMethod(preflights, 'getAttestation'),
    getBatch: captureMethod(preflights, 'getBatchByAuthorization'),
    getStoredBatch: captureMethod(preflights, 'getStoredBatchByAuthorization'),
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

function itemRequest(value) {
  try {
    if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)
      || OBJECT_GET_PROTOTYPE_OF(value) !== Object.prototype) unavailable();
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    const expected = [
      'attestationUid', 'authorizationUid', 'itemKind', 'itemUid', 'observation',
      'reservationUid',
    ];
    if (REFLECT_OWN_KEYS(descriptors).length !== expected.length) unavailable();
    const output = OBJECT_CREATE(null);
    for (let index = 0; index < expected.length; index += 1) {
      const descriptor = descriptors[expected[index]];
      if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) unavailable();
      output[expected[index]] = descriptor.value;
    }
    if (!UUID_V4.test(output.attestationUid)
      || !UUID_V4.test(output.authorizationUid)
      || !UUID_V4.test(output.itemUid)
      || !UUID_V4.test(output.reservationUid)
      || (output.itemKind !== 'h3' && output.itemKind !== 'tts')) unavailable();
    return OBJECT_FREEZE(output);
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
      const currentMonotonic = MONOTONIC_NOW();
      if (metadata.leaseState.endsAtMonotonicNanoseconds === null) {
        if (currentMonotonic >= metadata.firstUseDeadlineMonotonicNanoseconds) unavailable();
      } else if (currentMonotonic >= metadata.leaseState.endsAtMonotonicNanoseconds) {
        unavailable();
      }
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
      if (metadata.leaseState.endsAtMonotonicNanoseconds === null) {
        const maximumLeaseEnd = currentMonotonic
          + BigInt(MAX_ITEM_EXECUTION_LEASE_MS) * 1_000_000n;
        const leaseEnd = maximumLeaseEnd < metadata.authorizationDeadlineMonotonicNanoseconds
          ? maximumLeaseEnd : metadata.authorizationDeadlineMonotonicNanoseconds;
        if (leaseEnd <= currentMonotonic) unavailable();
        metadata.leaseState.endsAtMonotonicNanoseconds = leaseEnd;
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

  function storedExecutionBatch(authorizationUid, nowEpochMs, requireFresh, requireStarted) {
    const authorization = assertMvpBenchmarkExternalAuthorizationActive(
      call(configured.authorizationStored, [authorizationUid]),
      nowEpochMs,
    );
    const batch = call(configured.getStoredBatch, [authorizationUid]);
    if (!batch || batch.authorizationUid !== authorization.uid
      || batch.sessionUid !== authorization.sessionUid
      || batch.dramaUid !== authorization.dramaUid) unavailable();
    const attestation = call(configured.storedAttestation, [batch.attestationUid]);
    if (attestation.authorizationUid !== authorization.uid
      || attestation.sessionUid !== authorization.sessionUid
      || attestation.dramaUid !== authorization.dramaUid
      || attestation.connectionUid !== authorization.connectionUid
      || attestation.connectionEvidenceSha256 !== authorization.connectionEvidenceSha256) {
      unavailable();
    }
    if (requireFresh) assertMvpBenchmarkLiveEnvironmentAttestationFresh(attestation, nowEpochMs);
    const connection = call(configured.connection, [authorization.connectionUid]);
    if (connection.status !== 'ready'
      || remoteConnectionEvidenceSha256(connection) !== authorization.connectionEvidenceSha256) {
      unavailable();
    }
    let started = false;
    for (let index = 0; index < batch.reservations.length; index += 1) {
      const reservation = batch.reservations[index];
      if (reservation.itemKind === 'h3') {
        const task = call(configured.formalTask, [reservation.itemUid]);
        const intent = call(configured.h3StoredIntent, [reservation.itemUid]);
        if (task.uid !== reservation.itemUid
          || task.connectionUid !== authorization.connectionUid
          || task.connectionEvidenceSha256 !== authorization.connectionEvidenceSha256
          || intent.taskUid !== reservation.itemUid
          || intent.planEvidenceSha256 !== reservation.requestSha256) unavailable();
        const initial = task.stage === 'prepared' && task.status === 'queued'
          && task.promptId === null && task.outputAssetVersionUid === null;
        if (initial) {
          const executionSource = call(configured.h3Intent, [reservation.itemUid]);
          if (executionSource.planEvidenceSha256 !== reservation.requestSha256) unavailable();
        } else started = true;
      } else {
        const executionSource = call(configured.audioIntent, [reservation.itemUid]);
        if (executionSource.plan.planSha256 !== reservation.requestSha256) unavailable();
      }
    }
    if (requireStarted && !started) unavailable();
    return OBJECT_FREEZE({ authorization, attestation, batch });
  }

  function currentExecutionBatch(authorizationUid, nowEpochMs) {
    const authorization = call(configured.requireActive, [authorizationUid, nowEpochMs]);
    const batch = call(configured.getBatch, [authorizationUid]);
    if (!batch || batch.authorizationUid !== authorization.uid) unavailable();
    const attestation = call(configured.getAttestation, [batch.attestationUid]);
    assertMvpBenchmarkLiveEnvironmentAttestationFresh(attestation, nowEpochMs);
    return OBJECT_FREEZE({ authorization, attestation, batch });
  }

  function permitFor(state, reservation, liveAttestation, nowEpochMs) {
    const { authorization, attestation } = state;
    const firstUseAfterMs = REFLECT_APPLY(MATH_MIN, Math, [
      authorization.expiresAtEpochMs,
      liveAttestation.expiresAtEpochMs,
    ]) - nowEpochMs;
    const authorizationAfterMs = authorization.expiresAtEpochMs - nowEpochMs;
    if (!NUMBER_IS_SAFE_INTEGER(firstUseAfterMs) || firstUseAfterMs <= 0
      || !NUMBER_IS_SAFE_INTEGER(authorizationAfterMs) || authorizationAfterMs <= 0) {
      unavailable();
    }
    const currentMonotonic = MONOTONIC_NOW();
    const permit = OBJECT_FREEZE(OBJECT_CREATE(null));
    REFLECT_APPLY(WEAK_MAP_SET, permits, [permit, OBJECT_FREEZE({
      authorizationUid: authorization.uid,
      authorizationSha256: authorization.authorizationSha256,
      attestationSha256: attestation.attestationSha256,
      attestationUid: attestation.uid,
      batchSha256: state.batch.batchSha256,
      connectionEvidenceSha256: authorization.connectionEvidenceSha256,
      connectionUid: authorization.connectionUid,
      firstUseDeadlineMonotonicNanoseconds: currentMonotonic
        + BigInt(firstUseAfterMs) * 1_000_000n,
      authorizationDeadlineMonotonicNanoseconds: currentMonotonic
        + BigInt(authorizationAfterMs) * 1_000_000n,
      itemKind: reservation.itemKind,
      itemUid: reservation.itemUid,
      leaseState: { endsAtMonotonicNanoseconds: null },
      requestSha256: reservation.requestSha256,
      reservationUid: reservation.uid,
      reservationSha256: reservation.reservationSha256,
      sessionUid: state.batch.sessionUid,
      sessionPlanSha256: authorization.sessionPlanSha256,
    })]);
    return permit;
  }

  function permitsFor(state, nowEpochMs) {
    const { attestation, batch } = state;
    const output = [];
    for (let index = 0; index < batch.reservations.length; index += 1) {
      const reservation = batch.reservations[index];
      output[index] = permitFor(state, reservation, attestation, nowEpochMs);
    }
    return OBJECT_FREEZE(output);
  }

  function executionState(authorizationUid, nowEpochMs, requireFreshStored) {
    try {
      return currentExecutionBatch(authorizationUid, nowEpochMs);
    } catch {
      return storedExecutionBatch(
        authorizationUid,
        nowEpochMs,
        requireFreshStored,
        requireFreshStored,
      );
    }
  }

  function environmentRequest(state) {
    return OBJECT_FREEZE({
      authorizationUid: state.authorization.uid,
      sessionUid: state.authorization.sessionUid,
      connectionUid: state.authorization.connectionUid,
      connectionEvidenceSha256: state.authorization.connectionEvidenceSha256,
      approvedEnvironmentSha256: state.authorization.requiredEnvironmentSha256,
    });
  }

  function loadExecutionBatch(authorizationUid, optionsValue) {
    const nowEpochMs = nowOptions(optionsValue);
    try {
      const state = storedExecutionBatch(
        authorizationUid,
        nowEpochMs,
        false,
        false,
      );
      return OBJECT_FREEZE({
        batch: state.batch,
        environmentRequest: environmentRequest(state),
      });
    } catch {
      return unavailable();
    }
  }

  function openExecutionItem(valueToOpen, optionsValue) {
    const input = itemRequest(valueToOpen);
    const nowEpochMs = nowOptions(optionsValue);
    try {
      const state = executionState(input.authorizationUid, nowEpochMs, false);
      let reservation = null;
      for (let index = 0; index < state.batch.reservations.length; index += 1) {
        const candidate = state.batch.reservations[index];
        if (candidate.uid === input.reservationUid) reservation = candidate;
      }
      if (!reservation || reservation.itemKind !== input.itemKind
        || reservation.itemUid !== input.itemUid) unavailable();
      const observation = createMvpBenchmarkLiveEnvironmentObservation(input.observation);
      const liveAttestation = createMvpBenchmarkLiveEnvironmentAttestation({
        uid: input.attestationUid,
        authorization: state.authorization,
        observation,
        attestedAtEpochMs: nowEpochMs,
      });
      assertMvpBenchmarkLiveEnvironmentAttestationFresh(liveAttestation, nowEpochMs);
      return permitFor(state, reservation, liveAttestation, nowEpochMs);
    } catch {
      return unavailable();
    }
  }

  function openExecutionBatch(authorizationUid, optionsValue) {
    const nowEpochMs = nowOptions(optionsValue);
    try {
      let state;
      try {
        state = currentExecutionBatch(authorizationUid, nowEpochMs);
      } catch {
        state = storedExecutionBatch(authorizationUid, nowEpochMs, true, true);
      }
      return OBJECT_FREEZE({
        batch: state.batch,
        permits: permitsFor(state, nowEpochMs),
      });
    } catch {
      return unavailable();
    }
  }

  return OBJECT_FREEZE({
    assertAudioIntentExecutionOpen(intentUid, permit) {
      return assertItemOpen('tts', intentUid, permit);
    },
    assertH3TaskExecutionOpen(taskUid, permit) {
      return assertItemOpen('h3', taskUid, permit);
    },
    loadExecutionBatch,
    openExecutionItem,
    openExecutionBatch,
    openBatch(authorizationUid, optionsValue) {
      return openExecutionBatch(authorizationUid, optionsValue).permits;
    },
  });
}

module.exports = OBJECT_FREEZE({ createMvpBenchmarkExecutionGate });
