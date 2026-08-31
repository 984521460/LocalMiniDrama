'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const {
  APPROVED_LIVE_ENVIRONMENT,
  createMvpBenchmarkCostEstimate,
  createMvpBenchmarkExecutionReservation,
  createMvpBenchmarkLiveEnvironmentObservation,
  serializeMvpBenchmarkExecutionPreflightJson,
} = require('../src/benchmark/mvpBenchmarkExecutionPreflight');
const {
  createMvpBenchmarkExecutionPreflightService,
} = require('../src/benchmark/mvpBenchmarkExecutionPreflightService');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const {
  V2RepositoryConflictError,
} = require('../src/repositories/v2');
const { createMvpBenchmarkSessionFixture } = require('./helpers/v9MvpBenchmarkSessionFixture');
const { uid } = require('./helpers/v2RepositoryDatabase');

function authorizationRequest(current, session, overrides = {}) {
  return {
    schemaVersion: 'mvp-benchmark-external-authorization-request.v1',
    uid: uid(99900),
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    sessionPlanSha256: session.planSha256,
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    maximumCostCnyFen: 1_000,
    validityDurationMs: 60 * 60 * 1000,
    ...overrides,
  };
}

function rawObservation(current, observedAtEpochMs) {
  const observation = createMvpBenchmarkLiveEnvironmentObservation({
    schemaVersion: 'mvp-benchmark-live-environment-observation.v1',
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    observedAtEpochMs,
    approvedEnvironmentSha256:
      '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
    gpu: structuredClone(APPROVED_LIVE_ENVIRONMENT.gpu),
    comfyUI: structuredClone(APPROVED_LIVE_ENVIRONMENT.comfyUI),
    runtime: structuredClone(APPROVED_LIVE_ENVIRONMENT.runtime),
    models: structuredClone(APPROVED_LIVE_ENVIRONMENT.models),
  });
  const { observationSha256: _digest, ...raw } = observation;
  return raw;
}

function uidSequence(start) {
  let value = start;
  return () => uid(value++);
}

function serviceFixture(current, options = {}) {
  let currentTime = options.currentTime ?? 2_100;
  let inspections = 0;
  let h3Estimates = 0;
  let ttsEstimates = 0;
  const nextUid = uidSequence(options.uidStart ?? 99910);
  const service = createMvpBenchmarkExecutionPreflightService({
    repositories: current.repositories,
    liveEnvironmentVerifier: Object.freeze({
      inspect() {
        inspections += 1;
        if (options.onInspect) options.onInspect(() => currentTime, (value) => { currentTime = value; });
        return Promise.resolve(rawObservation(current, options.observedAtEpochMs ?? 2_000));
      },
    }),
    costEstimator: Object.freeze({
      estimateH3(input) {
        h3Estimates += 1;
        if (options.onEstimate) options.onEstimate(input, () => currentTime, (value) => { currentTime = value; });
        return Promise.resolve({
          estimatedCostCnyFen: options.h3Cost ?? 10,
          policyUid: uid(99980),
        });
      },
      estimateTts(input) {
        ttsEstimates += 1;
        if (options.onEstimate) options.onEstimate(input, () => currentTime, (value) => { currentTime = value; });
        return Promise.resolve({
          estimatedCostCnyFen: options.ttsCost ?? 5,
          policyUid: uid(99981),
        });
      },
    }),
    createUid: nextUid,
    nowEpochMs: () => currentTime,
  });
  return {
    service,
    counts: () => ({ inspections, h3Estimates, ttsEstimates }),
    setTime(value) { currentTime = value; },
  };
}

function count(database, table) {
  return database.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
}

function prepareAuthorization(current, overrides) {
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session, overrides),
    { nowEpochMs: 1_000 },
  );
  return { authorization, session };
}

function directAttestation(current, authorization, nowEpochMs = 2_100) {
  const observation = createMvpBenchmarkLiveEnvironmentObservation(
    rawObservation(current, 2_000),
  );
  return current.repositories.mvpBenchmarkExecutionPreflights.attest({
    uid: uid(99970),
    authorizationUid: authorization.uid,
    observation,
  }, { nowEpochMs });
}

function directReservation(current, authorization, attestation, itemKind, item, requestSha256) {
  const itemUid = itemKind === 'h3' ? item.taskUid : item.intentUid;
  const estimate = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1',
    itemKind,
    itemUid,
    requestSha256,
    estimatedCostCnyFen: 1,
    policyUid: uid(99971),
  });
  return current.repositories.mvpBenchmarkExecutionPreflights.reserve({
    uid: uid(itemKind === 'h3' ? 99972 : 99973),
    authorizationUid: authorization.uid,
    attestationUid: attestation.uid,
    itemKind,
    itemUid,
    requestSha256,
    estimate,
  }, { nowEpochMs: 2_200 });
}

function resignedReservation(authorization, attestation, session, itemKind, item, requestSha256) {
  const itemUid = itemKind === 'h3' ? item.taskUid : item.intentUid;
  const estimate = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1',
    itemKind,
    itemUid,
    requestSha256,
    estimatedCostCnyFen: 1,
    policyUid: uid(99974),
  });
  const correctRequestSha256 = itemKind === 'h3'
    ? item.planEvidenceSha256 : item.planSha256;
  const correctEstimate = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1',
    itemKind,
    itemUid,
    requestSha256: correctRequestSha256,
    estimatedCostCnyFen: 1,
    policyUid: uid(99974),
  });
  const correct = createMvpBenchmarkExecutionReservation({
    uid: uid(itemKind === 'h3' ? 99975 : 99976),
    authorization,
    attestation,
    session,
    itemKind,
    itemUid,
    requestSha256: correctRequestSha256,
    estimate: correctEstimate,
    reservedAtEpochMs: 2_200,
  });
  const { reservationSha256: _reservationSha256, ...base } = correct;
  const resignedBase = Object.freeze({ ...base, requestSha256, estimate });
  return Object.freeze({
    ...resignedBase,
    reservationSha256: createHash('sha256')
      .update(serializeMvpBenchmarkExecutionPreflightJson(resignedBase), 'utf8')
      .digest('hex'),
  });
}

function rawInsertReservation(database, reservation, algorithm = '') {
  return database.prepare(`
    INSERT ${algorithm} INTO mvp_benchmark_execution_reservations
      (uid,authorization_uid,attestation_uid,session_uid,drama_uid,item_kind,item_uid,
       request_sha256,estimate_json,estimate_sha256,estimated_cost_cny_fen,
       reservation_json,reservation_sha256,reserved_at_epoch_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    reservation.uid,
    reservation.authorizationUid,
    reservation.attestationUid,
    reservation.sessionUid,
    reservation.dramaUid,
    reservation.itemKind,
    reservation.itemUid,
    reservation.requestSha256,
    serializeMvpBenchmarkExecutionPreflightJson(reservation.estimate),
    reservation.estimate.estimateSha256,
    reservation.estimatedCostCnyFen,
    serializeMvpBenchmarkExecutionPreflightJson(reservation),
    reservation.reservationSha256,
    reservation.reservedAtEpochMs,
  );
}

test('batch preflight reserves every frozen item atomically and is idempotent', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, session } = prepareAuthorization(current);
  const configured = serviceFixture(current);

  const batch = await configured.service.prepareBatch(authorization.uid);
  assert.equal(batch.schemaVersion, 'mvp-benchmark-execution-preflight-batch.v1');
  assert.equal(batch.authorizationUid, authorization.uid);
  assert.equal(batch.reservations.length, session.h3Tasks.length + session.audioIntents.length);
  assert.equal(batch.estimatedCostCnyFen, 45);
  assert.equal(new Set(batch.reservations.map((entry) => entry.attestationUid)).size, 1);
  for (let index = 0; index < session.h3Tasks.length; index += 1) {
    assert.equal(batch.reservations[index].itemKind, 'h3');
    assert.equal(batch.reservations[index].itemUid, session.h3Tasks[index].taskUid);
    assert.equal(batch.reservations[index].requestSha256, session.h3Tasks[index].planEvidenceSha256);
  }
  for (let index = 0; index < session.audioIntents.length; index += 1) {
    const reservation = batch.reservations[session.h3Tasks.length + index];
    assert.equal(reservation.itemKind, 'tts');
    assert.equal(reservation.itemUid, session.audioIntents[index].intentUid);
    assert.equal(reservation.requestSha256, session.audioIntents[index].planSha256);
  }
  assert.deepEqual(configured.counts(), { inspections: 1, h3Estimates: 4, ttsEstimates: 1 });
  assert.equal(count(current.database, 'mvp_benchmark_execution_reservations'), 5);
  assert.equal(count(current.database, 'mvp_benchmark_live_environment_attestations'), 1);
  assert.equal(count(current.database, 'mvp_benchmark_resource_release_obligations'), 1);

  assert.deepEqual(await configured.service.prepareBatch(authorization.uid), batch);
  assert.deepEqual(configured.counts(), { inspections: 1, h3Estimates: 4, ttsEstimates: 1 });

  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v9/mvp-benchmark-execution-preflight-batch.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(batch), true, JSON.stringify(validate.errors));
});

test('wrong frozen request digests are rejected for both H3 and TTS reservations', (t) => {
  const h3 = createMvpBenchmarkSessionFixture(t);
  const h3Prepared = prepareAuthorization(h3);
  const h3Attestation = directAttestation(h3, h3Prepared.authorization);
  assert.throws(
    () => directReservation(
      h3,
      h3Prepared.authorization,
      h3Attestation,
      'h3',
      h3Prepared.session.h3Tasks[0],
      'f'.repeat(64),
    ),
    V2RepositoryConflictError,
  );
  assert.equal(count(h3.database, 'mvp_benchmark_execution_reservations'), 0);

  const tts = createMvpBenchmarkSessionFixture(t);
  const ttsPrepared = prepareAuthorization(tts);
  const ttsAttestation = directAttestation(tts, ttsPrepared.authorization);
  assert.throws(
    () => directReservation(
      tts,
      ttsPrepared.authorization,
      ttsAttestation,
      'tts',
      ttsPrepared.session.audioIntents[0],
      'e'.repeat(64),
    ),
    V2RepositoryConflictError,
  );
  assert.equal(count(tts.database, 'mvp_benchmark_execution_reservations'), 0);
});

test('direct SQL cannot coordinate-resign a different frozen request digest', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, session } = prepareAuthorization(current);
  const attestation = directAttestation(current, authorization);
  const h3 = resignedReservation(
    authorization, attestation, session, 'h3', session.h3Tasks[0], 'f'.repeat(64),
  );
  const tts = resignedReservation(
    authorization, attestation, session, 'tts', session.audioIntents[0], 'e'.repeat(64),
  );
  current.database.pragma('recursive_triggers = OFF');
  assert.throws(() => rawInsertReservation(current.database, h3, 'OR REPLACE'));
  assert.throws(() => rawInsertReservation(current.database, tts, 'OR REPLACE'));
  assert.equal(count(current.database, 'mvp_benchmark_execution_reservations'), 0);
  assert.equal(count(current.database, 'mvp_benchmark_execution_reservation_seals'), 0);
});

test('batch preflight rolls back attestation, reservations, seals, and release obligation', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, session } = prepareAuthorization(current);
  current.database.exec(`
    CREATE TRIGGER synthetic_batch_failure
    BEFORE INSERT ON mvp_benchmark_execution_reservations
    WHEN NEW.item_uid='${session.h3Tasks[2].taskUid}'
    BEGIN SELECT RAISE(ABORT,'synthetic batch failure'); END
  `);
  const configured = serviceFixture(current);
  await assert.rejects(configured.service.prepareBatch(authorization.uid));
  for (const table of [
    'mvp_benchmark_live_environment_attestations',
    'mvp_benchmark_live_environment_attestation_seals',
    'mvp_benchmark_execution_reservations',
    'mvp_benchmark_execution_reservation_seals',
    'mvp_benchmark_resource_release_obligations',
    'mvp_benchmark_resource_release_obligation_seals',
  ]) assert.equal(count(current.database, table), 0, table);
});

test('over-budget or expired batches leave no durable preflight evidence', async (t) => {
  const over = createMvpBenchmarkSessionFixture(t);
  const overPrepared = prepareAuthorization(over, { maximumCostCnyFen: 49 });
  const overService = serviceFixture(over, { h3Cost: 10, ttsCost: 10 });
  await assert.rejects(overService.service.prepareBatch(overPrepared.authorization.uid));
  assert.equal(count(over.database, 'mvp_benchmark_live_environment_attestations'), 0);
  assert.equal(count(over.database, 'mvp_benchmark_execution_reservations'), 0);
  assert.equal(count(over.database, 'mvp_benchmark_resource_release_obligations'), 0);

  const expired = createMvpBenchmarkSessionFixture(t);
  const expiredPrepared = prepareAuthorization(expired, { validityDurationMs: 60_000 });
  const expiredService = serviceFixture(expired, {
    onEstimate(_input, _getTime, setTime) { setTime(61_000); },
  });
  await assert.rejects(expiredService.service.prepareBatch(expiredPrepared.authorization.uid));
  assert.equal(count(expired.database, 'mvp_benchmark_live_environment_attestations'), 0);
  assert.equal(count(expired.database, 'mvp_benchmark_execution_reservations'), 0);
  assert.equal(count(expired.database, 'mvp_benchmark_resource_release_obligations'), 0);
});

test('a partial legacy reservation set conflicts without further calls or writes', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, session } = prepareAuthorization(current);
  const attestation = directAttestation(current, authorization);
  directReservation(
    current,
    authorization,
    attestation,
    'h3',
    session.h3Tasks[0],
    session.h3Tasks[0].planEvidenceSha256,
  );
  const configured = serviceFixture(current);
  await assert.rejects(
    configured.service.prepareBatch(authorization.uid),
    V2RepositoryConflictError,
  );
  assert.deepEqual(configured.counts(), { inspections: 0, h3Estimates: 0, ttsEstimates: 0 });
  assert.equal(count(current.database, 'mvp_benchmark_execution_reservations'), 1);
  assert.equal(count(current.database, 'mvp_benchmark_live_environment_attestations'), 1);
});
