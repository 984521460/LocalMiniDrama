'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const {
  APPROVED_LIVE_ENVIRONMENT,
  createMvpBenchmarkCostEstimate,
  createMvpBenchmarkExecutionReservation,
  createMvpBenchmarkLiveEnvironmentAttestation,
  createMvpBenchmarkLiveEnvironmentObservation,
  serializeMvpBenchmarkExecutionPreflightJson,
} = require('../src/benchmark/mvpBenchmarkExecutionPreflight');
const {
  createMvpBenchmarkExecutionPreflightService,
} = require('../src/benchmark/mvpBenchmarkExecutionPreflightService');
const { PROJECT_ARCHIVE_CATALOG } = require('../src/adapters/v2/zip/projectArchiveCatalog');
const { createNarrativeReviewService } = require('../src/narrative/reviews');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const { V2RepositoryDataError } = require('../src/repositories/v2');
const { createMvpBenchmarkSessionFixture } = require('./helpers/v9MvpBenchmarkSessionFixture');
const { uid } = require('./helpers/v2RepositoryDatabase');

function authorizationRequest(current, session, overrides = {}) {
  return {
    schemaVersion: 'mvp-benchmark-external-authorization-request.v1',
    uid: uid(99600),
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

function observation(current, observedAtEpochMs = 2_000, overrides = {}) {
  return createMvpBenchmarkLiveEnvironmentObservation({
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
    ...overrides,
  });
}

function schema(name) {
  return JSON.parse(fs.readFileSync(
    path.resolve(__dirname, `../../schemas/v9/${name}.schema.json`),
    'utf8',
  ));
}

test('live observation binds the reviewed GPU runtime and seven model files', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const reviewed = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../evidence/h3/phase7/environment.json'),
    'utf8',
  ));
  assert.deepEqual(APPROVED_LIVE_ENVIRONMENT, {
    gpu: reviewed.gpu,
    comfyUI: reviewed.comfyUI,
    runtime: reviewed.runtime,
    models: reviewed.models,
  });
  const accepted = observation(current);
  assert.equal(accepted.gpu.gpuClass, 'rtx4090-24gb');
  assert.equal(accepted.models.length, 7);
  assert.throws(
    () => observation(current, 2_000, {
      gpu: { ...APPROVED_LIVE_ENVIRONMENT.gpu, vramMiB: 49_128 },
    }),
    { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID' },
  );
  const driftedModels = structuredClone(APPROVED_LIVE_ENVIRONMENT.models);
  driftedModels[0].sha256 = '0'.repeat(64);
  assert.throws(
    () => observation(current, 2_000, { models: driftedModels }),
    { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID' },
  );
});

test('repository attests a fresh environment and atomically reserves one attempt per item', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  const attestation = current.repositories.mvpBenchmarkExecutionPreflights.attest({
    uid: uid(99601),
    authorizationUid: authorization.uid,
    observation: observation(current),
  }, { nowEpochMs: 2_100 });
  assert.equal(attestation.authorizationUid, authorization.uid);
  assert.equal(attestation.expiresAtEpochMs, 302_000);
  const validateAttestation = new Ajv2020({ strict: true }).compile(
    schema('mvp-benchmark-live-environment-attestation'),
  );
  assert.equal(validateAttestation(attestation), true, JSON.stringify(validateAttestation.errors));

  const item = session.h3Tasks[0];
  const requestSha256 = item.planEvidenceSha256;
  const estimate = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1',
    itemKind: 'h3',
    itemUid: item.taskUid,
    requestSha256,
    estimatedCostCnyFen: 600,
    policyUid: uid(99602),
  });
  const reservation = current.repositories.mvpBenchmarkExecutionPreflights.reserve({
    uid: uid(99603),
    authorizationUid: authorization.uid,
    attestationUid: attestation.uid,
    itemKind: 'h3',
    itemUid: item.taskUid,
    requestSha256,
    estimate,
  }, { nowEpochMs: 2_200 });
  assert.equal(reservation.estimatedCostCnyFen, 600);
  assert.equal(reservation.attemptNumber, 1);
  const validateReservation = new Ajv2020({ strict: true }).compile(
    schema('mvp-benchmark-execution-reservation'),
  );
  assert.equal(validateReservation(reservation), true, JSON.stringify(validateReservation.errors));
  assert.deepEqual(
    current.repositories.mvpBenchmarkExecutionPreflights.getReservation(reservation.uid),
    reservation,
  );
  assert.throws(
    () => current.repositories.mvpBenchmarkExecutionPreflights.reserve({
      uid: uid(99604),
      authorizationUid: authorization.uid,
      attestationUid: attestation.uid,
      itemKind: 'h3',
      itemUid: item.taskUid,
      requestSha256,
      estimate,
    }, { nowEpochMs: 2_300 }),
    { code: 'V2_REPOSITORY_CONFLICT' },
  );

  const tts = session.audioIntents[0];
  const ttsHash = tts.planSha256;
  const tooExpensive = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1',
    itemKind: 'tts',
    itemUid: tts.intentUid,
    requestSha256: ttsHash,
    estimatedCostCnyFen: 401,
    policyUid: uid(99602),
  });
  assert.throws(
    () => current.repositories.mvpBenchmarkExecutionPreflights.reserve({
      uid: uid(99605),
      authorizationUid: authorization.uid,
      attestationUid: attestation.uid,
      itemKind: 'tts',
      itemUid: tts.intentUid,
      requestSha256: ttsHash,
      estimate: tooExpensive,
    }, { nowEpochMs: 2_400 }),
    { code: 'V2_REPOSITORY_CONFLICT' },
  );
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_execution_reservations',
  ).pluck().get(), 1);

  const exactBudget = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1',
    itemKind: 'tts',
    itemUid: tts.intentUid,
    requestSha256: ttsHash,
    estimatedCostCnyFen: 400,
    policyUid: uid(99602),
  });
  const ttsReservation = current.repositories.mvpBenchmarkExecutionPreflights.reserve({
    uid: uid(99606),
    authorizationUid: authorization.uid,
    attestationUid: attestation.uid,
    itemKind: 'tts',
    itemUid: tts.intentUid,
    requestSha256: ttsHash,
    estimate: exactBudget,
  }, { nowEpochMs: 2_400 });
  assert.equal(ttsReservation.estimatedCostCnyFen, 400);
  assert.equal(current.database.prepare(
    'SELECT sum(estimated_cost_cny_fen) FROM mvp_benchmark_execution_reservations',
  ).pluck().get(), 1_000);
});

test('expired or source-drifted authorization cannot create a reservation', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session, { validityDurationMs: 60_000 }),
    { nowEpochMs: 1_000 },
  );
  const attestation = current.repositories.mvpBenchmarkExecutionPreflights.attest({
    uid: uid(99610),
    authorizationUid: authorization.uid,
    observation: observation(current),
  }, { nowEpochMs: 2_100 });
  const item = session.h3Tasks[0];
  const requestSha256 = item.planEvidenceSha256;
  const estimate = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1',
    itemKind: 'h3', itemUid: item.taskUid, requestSha256,
    estimatedCostCnyFen: 1, policyUid: uid(99611),
  });
  assert.throws(
    () => current.repositories.mvpBenchmarkExecutionPreflights.reserve({
      uid: uid(99612), authorizationUid: authorization.uid,
      attestationUid: attestation.uid, itemKind: 'h3', itemUid: item.taskUid,
      requestSha256, estimate,
    }, { nowEpochMs: 61_000 }),
    { code: 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_EXPIRED' },
  );
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_execution_reservations',
  ).pluck().get(), 0);
});

test('direct reservation insert rejects current RemoteConnection evidence drift', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  const attestation = current.repositories.mvpBenchmarkExecutionPreflights.attest({
    uid: uid(99615), authorizationUid: authorization.uid, observation: observation(current),
  }, { nowEpochMs: 2_100 });
  const item = session.h3Tasks[0];
  const requestSha256 = item.planEvidenceSha256;
  const estimate = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1', itemKind: 'h3',
    itemUid: item.taskUid, requestSha256, estimatedCostCnyFen: 1,
    policyUid: uid(99616),
  });
  const reservation = createMvpBenchmarkExecutionReservation({
    uid: uid(99617), authorization, attestation, session, itemKind: 'h3',
    itemUid: item.taskUid, requestSha256, estimate, reservedAtEpochMs: 2_200,
  });

  current.repositories.remote.updateConnection({
    uid: current.connection.uid,
    expectedStateVersion: current.connection.stateVersion,
    name: current.connection.name,
    host: 'replacement.example.invalid',
    port: current.connection.port,
    username: current.connection.username,
    comfyHost: current.connection.comfyHost,
    comfyPort: current.connection.comfyPort,
    remoteWorkDir: current.connection.remoteWorkDir,
  });

  assert.throws(() => current.database.prepare(`
    INSERT INTO mvp_benchmark_execution_reservations
      (uid,authorization_uid,attestation_uid,session_uid,drama_uid,item_kind,item_uid,
       request_sha256,estimate_json,estimate_sha256,estimated_cost_cny_fen,
       reservation_json,reservation_sha256,reserved_at_epoch_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    reservation.uid, reservation.authorizationUid, reservation.attestationUid,
    reservation.sessionUid, reservation.dramaUid, reservation.itemKind,
    reservation.itemUid, reservation.requestSha256,
    serializeMvpBenchmarkExecutionPreflightJson(reservation.estimate),
    reservation.estimate.estimateSha256, reservation.estimatedCostCnyFen,
    serializeMvpBenchmarkExecutionPreflightJson(reservation),
    reservation.reservationSha256, reservation.reservedAtEpochMs,
  ), /MVP benchmark execution reservation invalid/u);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_execution_reservations',
  ).pluck().get(), 0);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_execution_reservation_seals',
  ).pluck().get(), 0);
});

test('direct preflight inserts reject current D3A source drift before sealing evidence', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  const firstAttestation = current.repositories.mvpBenchmarkExecutionPreflights.attest({
    uid: uid(99618), authorizationUid: authorization.uid, observation: observation(current),
  }, { nowEpochMs: 2_100 });
  const lateObservation = observation(current, 2_200);
  const lateAttestation = createMvpBenchmarkLiveEnvironmentAttestation({
    uid: uid(99619), authorization, observation: lateObservation, attestedAtEpochMs: 2_300,
  });
  const item = session.audioIntents[0];
  const requestSha256 = item.planSha256;
  const estimate = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1', itemKind: 'tts',
    itemUid: item.intentUid, requestSha256, estimatedCostCnyFen: 1,
    policyUid: uid(99620),
  });
  const reservation = createMvpBenchmarkExecutionReservation({
    uid: uid(99621), authorization, attestation: firstAttestation, session,
    itemKind: 'tts', itemUid: item.intentUid, requestSha256, estimate,
    reservedAtEpochMs: 2_400,
  });

  const replacement = current.repositories.voiceProfiles.create({
    schemaVersion: current.profile.schemaVersion,
    uid: uid(99622),
    dramaUid: current.profile.dramaUid,
    characterUid: current.profile.characterUid,
    characterVoiceVersionUid: current.profile.characterVoiceVersionUid,
    parentUid: current.profile.uid,
    revision: 2,
    provider: current.profile.provider,
    model: current.profile.model,
    voiceKey: 'replacement-voice',
    credentialRef: current.profile.credentialRef,
    sourceKind: current.profile.sourceKind,
    status: current.profile.status,
    defaultEmotion: current.profile.defaultEmotion,
    emotionMap: current.profile.emotionMap,
    minimumSpeedPermille: current.profile.minimumSpeedPermille,
    defaultSpeedPermille: current.profile.defaultSpeedPermille,
    maximumSpeedPermille: current.profile.maximumSpeedPermille,
    createdAtEpochMs: 60,
  });
  current.repositories.voiceProfiles.activate({
    schemaVersion: '8.0',
    uid: uid(99623),
    dramaUid: current.profile.dramaUid,
    characterUid: current.profile.characterUid,
    voiceProfileUid: replacement.uid,
    previousVoiceProfileUid: current.profile.uid,
    stateVersion: 2,
    changedAtEpochMs: 61,
  });
  assert.throws(
    () => current.repositories.mvpBenchmarkSessions.get(session.uid),
    (error) => error instanceof V2RepositoryDataError,
  );
  current.database.pragma('recursive_triggers = OFF');
  assert.throws(() => current.database.prepare(`
    INSERT OR REPLACE INTO mvp_benchmark_live_environment_attestations
      (uid,authorization_uid,session_uid,drama_uid,connection_uid,
       connection_evidence_sha256,observation_json,observation_sha256,
       attestation_json,attestation_sha256,attested_at_epoch_ms,expires_at_epoch_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    lateAttestation.uid, lateAttestation.authorizationUid, lateAttestation.sessionUid,
    lateAttestation.dramaUid, lateAttestation.connectionUid,
    lateAttestation.connectionEvidenceSha256,
    serializeMvpBenchmarkExecutionPreflightJson(lateAttestation.observation),
    lateAttestation.observation.observationSha256,
    serializeMvpBenchmarkExecutionPreflightJson(lateAttestation),
    lateAttestation.attestationSha256, lateAttestation.attestedAtEpochMs,
    lateAttestation.expiresAtEpochMs,
  ), /MVP benchmark live environment attestation invalid/u);
  assert.throws(() => current.database.prepare(`
    INSERT OR REPLACE INTO mvp_benchmark_execution_reservations
      (uid,authorization_uid,attestation_uid,session_uid,drama_uid,item_kind,item_uid,
       request_sha256,estimate_json,estimate_sha256,estimated_cost_cny_fen,
       reservation_json,reservation_sha256,reserved_at_epoch_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    reservation.uid, reservation.authorizationUid, reservation.attestationUid,
    reservation.sessionUid, reservation.dramaUid, reservation.itemKind,
    reservation.itemUid, reservation.requestSha256,
    serializeMvpBenchmarkExecutionPreflightJson(reservation.estimate),
    reservation.estimate.estimateSha256, reservation.estimatedCostCnyFen,
    serializeMvpBenchmarkExecutionPreflightJson(reservation),
    reservation.reservationSha256, reservation.reservedAtEpochMs,
  ), /MVP benchmark execution reservation invalid/u);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_live_environment_attestations',
  ).pluck().get(), 1);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_live_environment_attestation_seals',
  ).pluck().get(), 1);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_execution_reservations',
  ).pluck().get(), 0);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_execution_reservation_seals',
  ).pluck().get(), 0);
});

test('direct preflight inserts reject current narrative approval drift', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  const firstAttestation = current.repositories.mvpBenchmarkExecutionPreflights.attest({
    uid: uid(99624), authorizationUid: authorization.uid, observation: observation(current),
  }, { nowEpochMs: 2_100 });
  const lateAttestation = createMvpBenchmarkLiveEnvironmentAttestation({
    uid: uid(99625), authorization, observation: observation(current, 2_200),
    attestedAtEpochMs: 2_300,
  });
  const item = session.h3Tasks[0];
  const requestSha256 = item.planEvidenceSha256;
  const estimate = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1', itemKind: 'h3',
    itemUid: item.taskUid, requestSha256, estimatedCostCnyFen: 1,
    policyUid: uid(99626),
  });
  const reservation = createMvpBenchmarkExecutionReservation({
    uid: uid(99627), authorization, attestation: firstAttestation, session,
    itemKind: 'h3', itemUid: item.taskUid, requestSha256, estimate,
    reservedAtEpochMs: 2_400,
  });

  createNarrativeReviewService({ repositories: current.repositories }).reviewResult({
    resultUid: current.shot.resultUid,
    decision: 'reject',
    comment: 'synthetic benchmark approval drift',
  });
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_execution_ready_sessions WHERE uid=?',
  ).pluck().get(session.uid), 0);
  assert.throws(
    () => current.repositories.mvpBenchmarkSessions.get(session.uid),
    (error) => error instanceof V2RepositoryDataError,
  );
  current.database.pragma('recursive_triggers = OFF');
  assert.throws(() => current.database.prepare(`
    INSERT OR REPLACE INTO mvp_benchmark_live_environment_attestations
      (uid,authorization_uid,session_uid,drama_uid,connection_uid,
       connection_evidence_sha256,observation_json,observation_sha256,
       attestation_json,attestation_sha256,attested_at_epoch_ms,expires_at_epoch_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    lateAttestation.uid, lateAttestation.authorizationUid, lateAttestation.sessionUid,
    lateAttestation.dramaUid, lateAttestation.connectionUid,
    lateAttestation.connectionEvidenceSha256,
    serializeMvpBenchmarkExecutionPreflightJson(lateAttestation.observation),
    lateAttestation.observation.observationSha256,
    serializeMvpBenchmarkExecutionPreflightJson(lateAttestation),
    lateAttestation.attestationSha256, lateAttestation.attestedAtEpochMs,
    lateAttestation.expiresAtEpochMs,
  ), /MVP benchmark live environment attestation invalid/u);
  assert.throws(() => current.database.prepare(`
    INSERT OR REPLACE INTO mvp_benchmark_execution_reservations
      (uid,authorization_uid,attestation_uid,session_uid,drama_uid,item_kind,item_uid,
       request_sha256,estimate_json,estimate_sha256,estimated_cost_cny_fen,
       reservation_json,reservation_sha256,reserved_at_epoch_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    reservation.uid, reservation.authorizationUid, reservation.attestationUid,
    reservation.sessionUid, reservation.dramaUid, reservation.itemKind,
    reservation.itemUid, reservation.requestSha256,
    serializeMvpBenchmarkExecutionPreflightJson(reservation.estimate),
    reservation.estimate.estimateSha256, reservation.estimatedCostCnyFen,
    serializeMvpBenchmarkExecutionPreflightJson(reservation),
    reservation.reservationSha256, reservation.reservedAtEpochMs,
  ), /MVP benchmark execution reservation invalid/u);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_live_environment_attestations',
  ).pluck().get(), 1);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_live_environment_attestation_seals',
  ).pluck().get(), 1);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_execution_reservations',
  ).pluck().get(), 0);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_execution_reservation_seals',
  ).pluck().get(), 0);
});

test('preflight contracts reject Proxy and accessors without executing them', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  let reads = 0;
  const proxy = new Proxy({}, {
    ownKeys() { reads += 1; throw new Error('preflight-proxy-sentinel'); },
  });
  assert.throws(
    () => createMvpBenchmarkLiveEnvironmentObservation(proxy),
    { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID' },
  );
  assert.equal(reads, 0);
  const value = {
    schemaVersion: 'mvp-benchmark-live-environment-observation.v1',
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    observedAtEpochMs: 2_000,
    approvedEnvironmentSha256: '5'.repeat(64),
    gpu: {}, comfyUI: {}, runtime: {}, models: [],
  };
  Object.defineProperty(value, 'gpu', {
    enumerable: true,
    get() { reads += 1; return {}; },
  });
  assert.throws(
    () => createMvpBenchmarkLiveEnvironmentObservation(value),
    { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID' },
  );
  assert.equal(reads, 0);
});

test('preflight JSON serializer rejects hostile containers without executing them', () => {
  let reads = 0;
  const proxy = new Proxy({}, {
    ownKeys() { reads += 1; throw new Error('serializer-proxy-sentinel'); },
  });
  assert.throws(
    () => serializeMvpBenchmarkExecutionPreflightJson(proxy),
    { name: 'TypeError', message: 'MVP benchmark execution preflight JSON is invalid' },
  );
  assert.equal(reads, 0);

  const array = [1];
  Object.defineProperty(array, '0', {
    enumerable: true,
    get() { reads += 1; return 1; },
  });
  assert.throws(
    () => serializeMvpBenchmarkExecutionPreflightJson(array),
    { name: 'TypeError', message: 'MVP benchmark execution preflight JSON is invalid' },
  );
  assert.equal(reads, 0);

  const cyclic = Object.create(null);
  cyclic.self = cyclic;
  assert.throws(
    () => serializeMvpBenchmarkExecutionPreflightJson(cyclic),
    { name: 'TypeError', message: 'MVP benchmark execution preflight JSON is invalid' },
  );
});

test('preflight service consumes only captured live-check and cost-estimator outputs', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  let currentTime = 2_100;
  let checks = 0;
  let estimates = 0;
  const uids = [uid(99620), uid(99621)];
  const service = createMvpBenchmarkExecutionPreflightService({
    repositories: current.repositories,
    liveEnvironmentVerifier: Object.freeze({
      inspect() {
        checks += 1;
        const value = observation(current, 2_000);
        const { observationSha256: _sha, ...raw } = value;
        return Promise.resolve(raw);
      },
    }),
    costEstimator: Object.freeze({
      estimateH3() {
        estimates += 1;
        return Promise.resolve({ estimatedCostCnyFen: 25, policyUid: uid(99622) });
      },
      estimateTts() {
        throw new Error('not expected');
      },
    }),
    createUid: () => uids.shift(),
    nowEpochMs: () => currentTime,
  });
  const attestation = await service.attest(authorization.uid);
  currentTime = 2_200;
  const reservation = await service.reserveH3({
    authorizationUid: authorization.uid,
    attestationUid: attestation.uid,
    itemUid: session.h3Tasks[0].taskUid,
    requestSha256: session.h3Tasks[0].planEvidenceSha256,
  });
  assert.equal(checks, 1);
  assert.equal(estimates, 1);
  assert.equal(reservation.estimatedCostCnyFen, 25);
});

test('preflight service rechecks expiry after slow inspection and estimation', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session, { validityDurationMs: 60_000 }),
    { nowEpochMs: 1_000 },
  );
  let currentTime = 1_500;
  let checks = 0;
  let estimates = 0;
  const service = createMvpBenchmarkExecutionPreflightService({
    repositories: current.repositories,
    liveEnvironmentVerifier: Object.freeze({
      inspect() {
        checks += 1;
        const value = observation(current, 1_500);
        const { observationSha256: _sha, ...raw } = value;
        currentTime = 2_000;
        return Promise.resolve(raw);
      },
    }),
    costEstimator: Object.freeze({
      estimateH3() {
        estimates += 1;
        currentTime = 61_000;
        return Promise.resolve({ estimatedCostCnyFen: 1, policyUid: uid(99627) });
      },
      estimateTts() { throw new Error('not expected'); },
    }),
    createUid: () => uid(99628),
    nowEpochMs: () => currentTime,
  });
  const attestation = await service.attest(authorization.uid);
  assert.equal(checks, 1);
  currentTime = 60_500;
  await assert.rejects(
    service.reserveH3({
      authorizationUid: authorization.uid,
      attestationUid: attestation.uid,
      itemUid: session.h3Tasks[0].taskUid,
      requestSha256: session.h3Tasks[0].planEvidenceSha256,
    }),
    { code: 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_EXPIRED' },
  );
  assert.equal(estimates, 1);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_execution_reservations',
  ).pluck().get(), 0);
});

test('independent seals reject coordinated persisted attestation and reservation rewrites', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  const attestation = current.repositories.mvpBenchmarkExecutionPreflights.attest({
    uid: uid(99630), authorizationUid: authorization.uid, observation: observation(current),
  }, { nowEpochMs: 2_100 });
  const item = session.h3Tasks[0];
  const requestSha256 = item.planEvidenceSha256;
  const estimate = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1', itemKind: 'h3',
    itemUid: item.taskUid, requestSha256, estimatedCostCnyFen: 10,
    policyUid: uid(99631),
  });
  const reservation = current.repositories.mvpBenchmarkExecutionPreflights.reserve({
    uid: uid(99632), authorizationUid: authorization.uid, attestationUid: attestation.uid,
    itemKind: 'h3', itemUid: item.taskUid, requestSha256, estimate,
  }, { nowEpochMs: 2_200 });

  const driftedEstimate = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1', itemKind: 'h3',
    itemUid: item.taskUid, requestSha256, estimatedCostCnyFen: 20,
    policyUid: uid(99631),
  });
  const driftedReservation = createMvpBenchmarkExecutionReservation({
    uid: reservation.uid, authorization, attestation, session, itemKind: 'h3',
    itemUid: item.taskUid, requestSha256, estimate: driftedEstimate,
    reservedAtEpochMs: reservation.reservedAtEpochMs,
  });
  current.database.exec('DROP TRIGGER v2_mvp_benchmark_execution_reservations_immutable_update');
  current.database.prepare(`
    UPDATE mvp_benchmark_execution_reservations
    SET estimate_json=?,estimate_sha256=?,estimated_cost_cny_fen=?,
        reservation_json=?,reservation_sha256=? WHERE uid=?
  `).run(
    serializeMvpBenchmarkExecutionPreflightJson(driftedEstimate),
    driftedEstimate.estimateSha256,
    driftedEstimate.estimatedCostCnyFen,
    serializeMvpBenchmarkExecutionPreflightJson(driftedReservation),
    driftedReservation.reservationSha256,
    reservation.uid,
  );
  assert.throws(
    () => current.repositories.mvpBenchmarkExecutionPreflights.getReservation(reservation.uid),
    (error) => error instanceof V2RepositoryDataError,
  );

  const driftedObservation = observation(current, 2_001);
  const driftedAttestation = createMvpBenchmarkLiveEnvironmentAttestation({
    uid: attestation.uid, authorization, observation: driftedObservation,
    attestedAtEpochMs: attestation.attestedAtEpochMs,
  });
  current.database.exec(
    'DROP TRIGGER v2_mvp_benchmark_live_environment_attestations_immutable_update',
  );
  current.database.prepare(`
    UPDATE mvp_benchmark_live_environment_attestations
    SET observation_json=?,observation_sha256=?,attestation_json=?,attestation_sha256=?,
        expires_at_epoch_ms=? WHERE uid=?
  `).run(
    serializeMvpBenchmarkExecutionPreflightJson(driftedObservation),
    driftedObservation.observationSha256,
    serializeMvpBenchmarkExecutionPreflightJson(driftedAttestation),
    driftedAttestation.attestationSha256,
    driftedAttestation.expiresAtEpochMs,
    attestation.uid,
  );
  assert.throws(
    () => current.repositories.mvpBenchmarkExecutionPreflights.getAttestation(attestation.uid),
    (error) => error instanceof V2RepositoryDataError,
  );
});

test('missing independent seals are persisted-data errors rather than absent evidence', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  const attestation = current.repositories.mvpBenchmarkExecutionPreflights.attest({
    uid: uid(99635), authorizationUid: authorization.uid, observation: observation(current),
  }, { nowEpochMs: 2_100 });
  const item = session.h3Tasks[0];
  const requestSha256 = item.planEvidenceSha256;
  const estimate = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1', itemKind: 'h3',
    itemUid: item.taskUid, requestSha256, estimatedCostCnyFen: 1,
    policyUid: uid(99636),
  });
  const reservation = current.repositories.mvpBenchmarkExecutionPreflights.reserve({
    uid: uid(99637), authorizationUid: authorization.uid, attestationUid: attestation.uid,
    itemKind: 'h3', itemUid: item.taskUid, requestSha256, estimate,
  }, { nowEpochMs: 2_200 });
  current.database.exec('DROP TRIGGER v2_mvp_benchmark_execution_reservation_seals_append_only');
  current.database.prepare(
    'DELETE FROM mvp_benchmark_execution_reservation_seals WHERE reservation_uid=?',
  ).run(reservation.uid);
  assert.throws(
    () => current.repositories.mvpBenchmarkExecutionPreflights.getReservation(reservation.uid),
    (error) => error instanceof V2RepositoryDataError,
  );
  current.database.exec(
    'DROP TRIGGER v2_mvp_benchmark_live_environment_attestation_seals_append_only',
  );
  current.database.prepare(
    'DELETE FROM mvp_benchmark_live_environment_attestation_seals WHERE attestation_uid=?',
  ).run(attestation.uid);
  assert.throws(
    () => current.repositories.mvpBenchmarkExecutionPreflights.getAttestation(attestation.uid),
    (error) => error instanceof V2RepositoryDataError,
  );
});

test('all four preflight evidence tables reject replacement, update, and delete', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  const attestation = current.repositories.mvpBenchmarkExecutionPreflights.attest({
    uid: uid(99640), authorizationUid: authorization.uid, observation: observation(current),
  }, { nowEpochMs: 2_100 });
  const item = session.h3Tasks[0];
  const requestSha256 = item.planEvidenceSha256;
  const estimate = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1', itemKind: 'h3',
    itemUid: item.taskUid, requestSha256, estimatedCostCnyFen: 1,
    policyUid: uid(99641),
  });
  const reservation = current.repositories.mvpBenchmarkExecutionPreflights.reserve({
    uid: uid(99642), authorizationUid: authorization.uid, attestationUid: attestation.uid,
    itemKind: 'h3', itemUid: item.taskUid, requestSha256, estimate,
  }, { nowEpochMs: 2_200 });
  current.database.pragma('recursive_triggers = OFF');
  assert.throws(() => current.database.prepare(`
    INSERT OR REPLACE INTO mvp_benchmark_execution_reservations
    SELECT ?,authorization_uid,attestation_uid,session_uid,drama_uid,item_kind,item_uid,
      request_sha256,estimate_json,estimate_sha256,estimated_cost_cny_fen,
      reservation_json,reservation_sha256,reserved_at_epoch_ms
    FROM mvp_benchmark_execution_reservations WHERE uid=?
  `).run(uid(99643), reservation.uid), /immutable/u);
  const tables = [
    ['mvp_benchmark_live_environment_attestations', 'uid', attestation.uid],
    ['mvp_benchmark_execution_reservations', 'uid', reservation.uid],
    ['mvp_benchmark_live_environment_attestation_seals', 'attestation_uid', attestation.uid],
    ['mvp_benchmark_execution_reservation_seals', 'reservation_uid', reservation.uid],
  ];
  for (let index = 0; index < tables.length; index += 1) {
    const [table, column, value] = tables[index];
    assert.throws(
      () => current.database.prepare(`UPDATE ${table} SET ${column}=${column} WHERE ${column}=?`).run(value),
      /immutable/u,
    );
    assert.throws(
      () => current.database.prepare(`DELETE FROM ${table} WHERE ${column}=?`).run(value),
      /append-only/u,
    );
  }
});

test('live attestations and attempt reservations stay outside project archives', () => {
  assert.equal(PROJECT_ARCHIVE_CATALOG.excludedTables.includes(
    'mvp_benchmark_live_environment_attestations',
  ), true);
  assert.equal(PROJECT_ARCHIVE_CATALOG.excludedTables.includes(
    'mvp_benchmark_execution_reservations',
  ), true);
  assert.equal(PROJECT_ARCHIVE_CATALOG.excludedTables.includes(
    'mvp_benchmark_live_environment_attestation_seals',
  ), true);
  assert.equal(PROJECT_ARCHIVE_CATALOG.excludedTables.includes(
    'mvp_benchmark_execution_reservation_seals',
  ), true);
});
