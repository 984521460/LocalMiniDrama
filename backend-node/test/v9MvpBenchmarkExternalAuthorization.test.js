'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const {
  MvpBenchmarkExternalAuthorizationError,
  createMvpBenchmarkExternalAuthorization,
  parseMvpBenchmarkExternalAuthorization,
  parseMvpBenchmarkExternalAuthorizationRequest,
  serializeMvpBenchmarkExternalAuthorizationJson,
} = require('../src/benchmark/mvpBenchmarkExternalAuthorization');
const { PROJECT_ARCHIVE_CATALOG } = require('../src/adapters/v2/zip/projectArchiveCatalog');
const {
  V2RepositoryDataError,
} = require('../src/repositories/v2');
const {
  createMvpBenchmarkExternalAuthorizationRepository,
} = require('../src/repositories/v2/mvpBenchmarkExternalAuthorizationRepository');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const { createRemoteTaskService } = require('../src/remote/remoteTaskService');
const audioTtsExecutionRoutes = require('../src/routes/v2/audioTtsExecution');
const h3Routes = require('../src/routes/v2/h3');
const mvpBenchmarkRoutes = require('../src/routes/v2/mvpBenchmark');
const remoteTaskRoutes = require('../src/routes/v2/remoteTasks');
const schema = require('../../schemas/v9/mvp-benchmark-external-authorization.schema.json');
const { createMvpBenchmarkSessionFixture } = require('./helpers/v9MvpBenchmarkSessionFixture');
const {
  createCoordinatorTransferFailureFixture,
} = require('./helpers/v9RemoteFailureFixture');
const { uid } = require('./helpers/v2RepositoryDatabase');

function requestFor(current, session, overrides = {}) {
  return {
    schemaVersion: 'mvp-benchmark-external-authorization-request.v1',
    uid: uid(99500),
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    sessionPlanSha256: session.planSha256,
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    maximumCostCnyFen: 20_000,
    validityDurationMs: 60 * 60 * 1000,
    ...overrides,
  };
}

function counts(database) {
  const row = database.prepare(`
    SELECT
      (SELECT count(*) FROM generation_runs) AS generation_runs,
      (SELECT count(*) FROM audio_tts_submissions) AS audio_tts_submissions,
      (SELECT count(*) FROM audio_tts_outputs) AS audio_tts_outputs,
      (SELECT count(*) FROM asset_versions) AS asset_versions
  `).get();
  return row;
}

function activateReplacementVoiceProfile(current, profileUid, selectionUid) {
  const replacement = current.repositories.voiceProfiles.create({
    schemaVersion: current.profile.schemaVersion,
    uid: profileUid,
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
    uid: selectionUid,
    dramaUid: current.profile.dramaUid,
    characterUid: current.profile.characterUid,
    voiceProfileUid: replacement.uid,
    previousVoiceProfileUid: current.profile.uid,
    stateVersion: 2,
    changedAtEpochMs: 61,
  });
}

function insertAuthorization(database, request, authorization, verb = 'INSERT') {
  return database.prepare(`
    ${verb} INTO mvp_benchmark_external_authorizations
      (uid,session_uid,drama_uid,request_json,authorization_json,authorization_sha256,
       authorized_at_epoch_ms,expires_at_epoch_ms)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    authorization.uid,
    authorization.sessionUid,
    authorization.dramaUid,
    serializeMvpBenchmarkExternalAuthorizationJson(request),
    serializeMvpBenchmarkExternalAuthorizationJson(authorization),
    authorization.authorizationSha256,
    authorization.authorizedAtEpochMs,
    authorization.expiresAtEpochMs,
  );
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

test('authorization contract fixes trusted environment, limits, expiry, and its digest', () => {
  const request = parseMvpBenchmarkExternalAuthorizationRequest({
    schemaVersion: 'mvp-benchmark-external-authorization-request.v1',
    uid: uid(99510),
    sessionUid: uid(99511),
    dramaUid: uid(99512),
    sessionPlanSha256: 'a'.repeat(64),
    connectionUid: uid(99513),
    connectionEvidenceSha256: 'b'.repeat(64),
    maximumCostCnyFen: 1,
    validityDurationMs: 60_000,
  });
  const authorization = createMvpBenchmarkExternalAuthorization({
    request,
    h3SubmissionLimit: 4,
    ttsSubmissionLimit: 1,
    authorizedAtEpochMs: 1_000,
  });
  assert.equal(authorization.requiredGpuClass, 'rtx4090-24gb');
  assert.equal(
    authorization.requiredEnvironmentSha256,
    '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43',
  );
  assert.equal(authorization.liveEnvironmentCheck, 'required-before-execution');
  assert.equal(authorization.dataScope, 'single-benchmark-session');
  assert.equal(authorization.perItemAttemptLimit, 1);
  assert.equal(authorization.instanceDisposition, 'return-after-terminal-or-expiry');
  assert.equal(authorization.expiresAtEpochMs, 61_000);
  assert.throws(
    () => parseMvpBenchmarkExternalAuthorizationRequest({ ...request, maximumCostCnyFen: 0 }),
    { code: 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID' },
  );
  assert.throws(
    () => parseMvpBenchmarkExternalAuthorization({
      ...authorization,
      expiresAtEpochMs: Symbol('hostile-expiry'),
    }),
    { code: 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_DATA_INVALID' },
  );
  assert.throws(
    () => parseMvpBenchmarkExternalAuthorizationRequest({
      ...request,
      validityDurationMs: 24 * 60 * 60 * 1000 + 1,
    }),
    { code: 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID' },
  );
});

test('repository prepares one immutable secret-free authorization without external side effects', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const request = requestFor(current, session);
  const before = counts(current.database);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    request,
    { nowEpochMs: 1_000 },
  );
  assert.equal(authorization.sessionUid, session.uid);
  assert.equal(authorization.h3SubmissionLimit, session.h3Tasks.length);
  assert.equal(authorization.ttsSubmissionLimit, session.audioIntents.length);
  assert.deepEqual(
    current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
      structuredClone(request),
      { nowEpochMs: 2_000 },
    ),
    authorization,
  );
  assert.deepEqual(
    current.repositories.mvpBenchmarkExternalAuthorizations.get(authorization.uid),
    authorization,
  );
  assert.deepEqual(
    current.repositories.mvpBenchmarkExternalAuthorizations.requireActive(
      authorization.uid,
      60 * 60 * 1000,
    ),
    authorization,
  );
  assert.throws(
    () => current.repositories.mvpBenchmarkExternalAuthorizations.requireActive(
      authorization.uid,
      60 * 60 * 1000 + 1_000,
    ),
    { code: 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_EXPIRED' },
  );
  assert.deepEqual(counts(current.database), before);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_external_authorizations',
  ).pluck().get(), 1);
  assert.doesNotMatch(
    JSON.stringify(authorization),
    /credential:v1:|worker\.example\.invalid|remoteWorkDir|password|secret/iu,
  );
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(authorization), true, JSON.stringify(validate.errors));

  assert.throws(
    () => current.database.prepare(
      'UPDATE mvp_benchmark_external_authorizations SET authorization_sha256=? WHERE uid=?',
    ).run('0'.repeat(64), authorization.uid),
    /immutable/u,
  );
  assert.throws(
    () => current.database.prepare(
      'DELETE FROM mvp_benchmark_external_authorizations WHERE uid=?',
    ).run(authorization.uid),
    /append-only/u,
  );
});

test('authorization rejects wrong target evidence and fails closed after source drift', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  assert.throws(
    () => current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
      requestFor(current, session, { connectionEvidenceSha256: '0'.repeat(64) }),
      { nowEpochMs: 1_000 },
    ),
    { code: 'V2_REPOSITORY_CONFLICT' },
  );
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    requestFor(current, session),
    { nowEpochMs: 1_000 },
  );
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
  assert.throws(
    () => current.repositories.mvpBenchmarkExternalAuthorizations.get(authorization.uid),
    (error) => error instanceof V2RepositoryDataError,
  );
});

test('authorization read rejects a re-signed persisted record after its guard is removed', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    requestFor(current, session),
    { nowEpochMs: 1_000 },
  );
  current.database.exec('DROP TRIGGER v2_mvp_benchmark_external_authorizations_immutable_update');
  current.database.prepare(`
    UPDATE mvp_benchmark_external_authorizations
    SET authorization_sha256=? WHERE uid=?
  `).run('0'.repeat(64), authorization.uid);
  assert.throws(
    () => current.repositories.mvpBenchmarkExternalAuthorizations.get(authorization.uid),
    (error) => error instanceof V2RepositoryDataError,
  );
});

test('database rejects coordinated wrong-target inserts and replacement conflict algorithms', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const wrongRequest = parseMvpBenchmarkExternalAuthorizationRequest(requestFor(
    current,
    session,
    { connectionEvidenceSha256: '0'.repeat(64) },
  ));
  const wrongAuthorization = createMvpBenchmarkExternalAuthorization({
    request: wrongRequest,
    h3SubmissionLimit: session.h3Tasks.length,
    ttsSubmissionLimit: session.audioIntents.length,
    authorizedAtEpochMs: 1_000,
  });
  assert.throws(
    () => current.database.prepare(`
      INSERT INTO mvp_benchmark_external_authorizations
        (uid,session_uid,drama_uid,request_json,authorization_json,authorization_sha256,
         authorized_at_epoch_ms,expires_at_epoch_ms)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      wrongAuthorization.uid,
      wrongAuthorization.sessionUid,
      wrongAuthorization.dramaUid,
      serializeMvpBenchmarkExternalAuthorizationJson(wrongRequest),
      serializeMvpBenchmarkExternalAuthorizationJson(wrongAuthorization),
      wrongAuthorization.authorizationSha256,
      wrongAuthorization.authorizedAtEpochMs,
      wrongAuthorization.expiresAtEpochMs,
    ),
    /invalid/u,
  );
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_external_authorizations',
  ).pluck().get(), 0);

  const valid = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    requestFor(current, session),
    { nowEpochMs: 1_000 },
  );
  current.database.pragma('recursive_triggers = OFF');
  assert.throws(
    () => current.database.prepare(`
      INSERT OR REPLACE INTO mvp_benchmark_external_authorizations
        (uid,session_uid,drama_uid,request_json,authorization_json,authorization_sha256,
         authorized_at_epoch_ms,expires_at_epoch_ms)
      SELECT ?,session_uid,drama_uid,request_json,authorization_json,authorization_sha256,
             authorized_at_epoch_ms,expires_at_epoch_ms
      FROM mvp_benchmark_external_authorizations WHERE uid=?
    `).run(uid(99599), valid.uid),
    /immutable/u,
  );
  assert.equal(current.database.prepare(
    'SELECT uid FROM mvp_benchmark_external_authorizations',
  ).pluck().get(), valid.uid);
});

test('database rejects a new authorization after current H3 source drift', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const request = parseMvpBenchmarkExternalAuthorizationRequest(requestFor(current, session));
  const authorization = createMvpBenchmarkExternalAuthorization({
    request,
    h3SubmissionLimit: session.h3Tasks.length,
    ttsSubmissionLimit: session.audioIntents.length,
    authorizedAtEpochMs: 1_000,
  });
  const intent = current.h3Intents[0];
  current.repositories.assets.addVersion({
    uid: uid(99580),
    assetUid: intent.assetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${session.dramaUid}/benchmark/drift/${uid(99580)}`,
    relativePath: `projects/${session.dramaUid}/assets/video/drift-${uid(99580)}.mp4`,
    sha256: 'f'.repeat(64),
    mimeType: 'video/mp4',
    width: 608,
    height: 352,
    durationMs: 1625,
    parentUid: intent.parentVersionUid,
    status: 'ready',
  }, { makeCurrent: true });
  current.database.pragma('recursive_triggers = OFF');
  assert.throws(
    () => insertAuthorization(current.database, request, authorization, 'INSERT OR REPLACE'),
    /current sources invalid/u,
  );
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_external_authorizations',
  ).pluck().get(), 0);
});

test('database rejects a new authorization after active VoiceProfile drift', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const request = parseMvpBenchmarkExternalAuthorizationRequest(requestFor(current, session));
  const authorization = createMvpBenchmarkExternalAuthorization({
    request,
    h3SubmissionLimit: session.h3Tasks.length,
    ttsSubmissionLimit: session.audioIntents.length,
    authorizedAtEpochMs: 1_000,
  });
  activateReplacementVoiceProfile(current, uid(99581), uid(99582));
  current.database.pragma('recursive_triggers = OFF');
  assert.throws(
    () => insertAuthorization(current.database, request, authorization, 'INSERT OR REPLACE'),
    /current sources invalid/u,
  );
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_external_authorizations',
  ).pluck().get(), 0);
});

test('derived authorization rolls back a source change injected during current-source validation', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const replacementUid = uid(99583);
  let shifted = false;
  const repository = createMvpBenchmarkExternalAuthorizationRepository(current.database, {
    mvpBenchmarkSessions: Object.freeze({
      get(sessionUid) {
        const value = current.repositories.mvpBenchmarkSessions.get(sessionUid);
        if (!shifted) {
          shifted = true;
          const intent = current.h3Intents[0];
          current.repositories.assets.addVersion({
            uid: replacementUid,
            assetUid: intent.assetUid,
            storageProvider: 'local',
            logicalUri: `asset://dramas/${session.dramaUid}/benchmark/drift/${replacementUid}`,
            relativePath: `projects/${session.dramaUid}/assets/video/drift-${replacementUid}.mp4`,
            sha256: 'e'.repeat(64),
            mimeType: 'video/mp4',
            width: 608,
            height: 352,
            durationMs: 1625,
            parentUid: intent.parentVersionUid,
            status: 'ready',
          }, { makeCurrent: true });
        }
        return value;
      },
    }),
    remote: current.repositories.remote,
  });
  assert.throws(
    () => repository.prepareFromSession({
      uid: uid(99584),
      sessionUid: session.uid,
      dramaUid: session.dramaUid,
      connectionUid: current.connection.uid,
      maximumCostCnyFen: 374,
      validityDurationMs: 7_200_000,
    }, { nowEpochMs: 1_000 }),
    { code: 'V2_REPOSITORY_CONFLICT' },
  );
  assert.equal(shifted, true);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_external_authorizations',
  ).pluck().get(), 0);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM asset_versions WHERE uid=?',
  ).pluck().get(replacementUid), 0);
});

test('benchmark session and external authorization stay outside project archives', () => {
  assert.equal(PROJECT_ARCHIVE_CATALOG.excludedTables.includes('mvp_benchmark_sessions'), true);
  assert.equal(
    PROJECT_ARCHIVE_CATALOG.excludedTables.includes('mvp_benchmark_external_authorizations'),
    true,
  );
});

test('public routes create and read the authorization but reject cross-session access', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/v2', mvpBenchmarkRoutes(
    Object.freeze({ error() {} }),
    Object.freeze({}),
    current.database,
  ));
  const { server, base } = await listen(app);
  t.after(() => server.close());
  const body = requestFor(current, session);
  const createdResponse = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/mvp-benchmark/sessions/${session.uid}/authorizations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).data;
  assert.equal(created.sessionUid, session.uid);

  const readResponse = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/mvp-benchmark/sessions/${session.uid}/authorizations/${created.uid}`,
  );
  assert.equal(readResponse.status, 200);
  assert.deepEqual((await readResponse.json()).data, created);

  const wrongSession = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/mvp-benchmark/sessions/${uid(99998)}/authorizations/${created.uid}`,
  );
  assert.equal(wrongSession.status, 404);

  const malformedUid = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/mvp-benchmark/sessions/${session.uid}/authorizations/not-a-uuid`,
  );
  assert.equal(malformedUid.status, 400);
});

test('path-bound route derives authorization identity and source evidence from local records', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/v2', mvpBenchmarkRoutes(
    Object.freeze({ error() {} }),
    Object.freeze({}),
    current.database,
  ));
  const { server, base } = await listen(app);
  t.after(() => server.close());
  const invalid = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/mvp-benchmark/sessions/${session.uid}/connections/${current.connection.uid}/authorization`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        maximumCostCnyFen: 374,
        validityDurationMs: 2 * 60 * 60 * 1000,
        extra: true,
      }),
    },
  );
  assert.equal(invalid.status, 400);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_external_authorizations',
  ).pluck().get(), 0);
  const result = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/mvp-benchmark/sessions/${session.uid}/connections/${current.connection.uid}/authorization`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maximumCostCnyFen: 374, validityDurationMs: 2 * 60 * 60 * 1000 }),
    },
  );
  assert.equal(result.status, 201);
  const authorization = (await result.json()).data;
  assert.equal(authorization.sessionUid, session.uid);
  assert.equal(authorization.dramaUid, session.dramaUid);
  assert.equal(authorization.sessionPlanSha256, session.planSha256);
  assert.equal(authorization.connectionUid, current.connection.uid);
  assert.equal(
    authorization.connectionEvidenceSha256,
    remoteConnectionEvidenceSha256(current.repositories.remote.getConnection(current.connection.uid)),
  );
  assert.equal(authorization.maximumCostCnyFen, 374);
  assert.equal(authorization.expiresAtEpochMs - authorization.authorizedAtEpochMs, 7_200_000);
  assert.doesNotMatch(JSON.stringify(authorization), /credential:v1:|password|secret/iu);
  const retry = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/mvp-benchmark/sessions/${session.uid}/connections/${current.connection.uid}/authorization`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maximumCostCnyFen: 374, validityDurationMs: 2 * 60 * 60 * 1000 }),
    },
  );
  assert.equal(retry.status, 201);
  assert.deepEqual((await retry.json()).data, authorization);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_external_authorizations',
  ).pluck().get(), 1);
});

test('benchmark-reserved H3 and TTS items cannot use existing execution routes', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    requestFor(current, session),
    { nowEpochMs: 1_000 },
  );
  let sideEffectCalls = 0;
  const neverCall = async () => {
    sideEffectCalls += 1;
    return Object.freeze({ status: 'unexpected' });
  };
  const app = express();
  app.use(express.json());
  const log = Object.freeze({ error() {} });
  app.use('/api/v1/v2', remoteTaskRoutes(log, {
    remoteTasks: Object.freeze({
      heartbeat: neverCall,
      recover: neverCall,
      submit: neverCall,
    }),
    remoteCoordinator: Object.freeze({ execute: neverCall, retry: neverCall }),
  }, current.database));
  app.use('/api/v1/v2', h3Routes(log, current.database, {
    localExecution: Object.freeze({ execute: neverCall }),
  }));
  app.use('/api/v1/v2', audioTtsExecutionRoutes(log, {
    service: Object.freeze({ execute: neverCall }),
  }, current.database));
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const taskUid = session.h3Tasks[0].taskUid;
  const intentUid = session.audioIntents[0].intentUid;
  assert.throws(
    () => current.repositories.mvpBenchmarkExternalAuthorizations
      .assertH3TaskExecutionOpen(taskUid),
    { code: 'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE' },
  );
  assert.throws(
    () => current.repositories.mvpBenchmarkExternalAuthorizations
      .assertAudioIntentExecutionOpen(intentUid),
    { code: 'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE' },
  );
  const requests = [
    [`/remote-tasks/${taskUid}/submit`, {}],
    [`/remote-tasks/${taskUid}/execute`, {}],
    [`/remote-tasks/${taskUid}/heartbeat`, {}],
    [`/remote-tasks/${taskUid}/retry`, {}],
    [`/remote-tasks/${taskUid}/recover`, {}],
    [`/h3/local-t2v/${taskUid}/execute`, {}],
    [`/dramas/${session.dramaUid}/audio-tts-executions/${intentUid}/execute`, {}],
  ];
  for (let index = 0; index < requests.length; index += 1) {
    const [path, body] = requests[index];
    const result = await fetch(`${base}/api/v1/v2${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(result.status, 409, path);
    assert.equal(
      (await result.json()).error.code,
      'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE',
    );
  }
  assert.equal(sideEffectCalls, 0);

  const directService = createRemoteTaskService({
    repository: current.repositories.remote,
    manifestRepository: current.repositories.comfyManifests,
    executionGate: current.repositories.mvpBenchmarkExternalAuthorizations,
    remoteClient: Object.freeze({
      requireReady: neverCall,
      submitPrompt: neverCall,
      getPromptState: neverCall,
      queueSnapshot: neverCall,
    }),
  });
  const task = current.repositories.remote.getFormalTask(taskUid);
  assert.throws(
    () => directService.beginUpload(taskUid, { expectedStateVersion: task.stateVersion }),
    { code: 'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE' },
  );
  await assert.rejects(
    directService.submit(taskUid, {
      expectedStateVersion: task.stateVersion,
      prompt: { synthetic: 'benchmark prompt must not run' },
    }),
    { code: 'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE' },
  );
  await assert.rejects(
    directService.recover(taskUid),
    { code: 'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE' },
  );
  assert.equal(sideEffectCalls, 0);
  assert.equal(
    current.repositories.mvpBenchmarkExternalAuthorizations
      .assertH3TaskExecutionOpen(uid(99597)),
    true,
  );
  assert.equal(
    current.repositories.mvpBenchmarkExternalAuthorizations
      .assertAudioIntentExecutionOpen(uid(99598)),
    true,
  );
});

test('coordinator execute and retry gates reject before state or remote side effects', async (t) => {
  let executionOpen = true;
  let gateCalls = 0;
  const executionGate = Object.freeze({
    assertH3TaskExecutionOpen() {
      gateCalls += 1;
      if (!executionOpen) {
        throw new MvpBenchmarkExternalAuthorizationError(
          'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE',
        );
      }
      return true;
    },
  });
  const fixture = await createCoordinatorTransferFailureFixture(
    t,
    'upload_network',
    { executionGate },
  );
  const content = Buffer.from('synthetic upload payload');
  fs.mkdirSync(path.join(fixture.localRoot, 'input'), { recursive: true });
  fs.writeFileSync(path.join(fixture.localRoot, 'input', 'source.bin'), content);

  await assert.rejects(
    fixture.coordinator.execute(fixture.taskUid, fixture.executeRequest),
    { code: 'REMOTE_TASK_UNEXPECTED' },
  );
  const failedTask = fixture.taskService.get(fixture.taskUid);
  const beforeTask = failedTask;
  const beforeRun = fixture.runService.getRun(fixture.runUid);
  const beforeSessionOpenCalls = fixture.sessionOpenCalls();
  const beforeSubmitCalls = fixture.submitCalls();
  const beforeGateCalls = gateCalls;
  executionOpen = false;

  assert.throws(
    () => fixture.coordinator.retry(fixture.taskUid, {
      ...fixture.executeRequest,
      expectedStateVersion: failedTask.stateVersion,
    }),
    { code: 'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE' },
  );
  assert.equal(gateCalls, beforeGateCalls + 1);
  assert.deepEqual(fixture.taskService.get(fixture.taskUid), beforeTask);
  assert.deepEqual(fixture.runService.getRun(fixture.runUid), beforeRun);
  assert.equal(fixture.sessionOpenCalls(), beforeSessionOpenCalls);
  assert.equal(fixture.submitCalls(), beforeSubmitCalls);

  const executeFixture = await createCoordinatorTransferFailureFixture(
    t,
    'upload_network',
    { executionGate },
  );
  const preparedTask = executeFixture.taskService.get(executeFixture.taskUid);
  const preparedRun = executeFixture.runService.getRun(executeFixture.runUid);
  const executeGateCalls = gateCalls;
  assert.throws(
    () => executeFixture.coordinator.execute(
      executeFixture.taskUid,
      executeFixture.executeRequest,
    ),
    { code: 'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE' },
  );
  assert.equal(gateCalls, executeGateCalls + 1);
  assert.deepEqual(executeFixture.taskService.get(executeFixture.taskUid), preparedTask);
  assert.deepEqual(executeFixture.runService.getRun(executeFixture.runUid), preparedRun);
  assert.equal(executeFixture.sessionOpenCalls(), 0);
  assert.equal(executeFixture.submitCalls(), 0);
});

test('authorization request rejects Proxy and accessor inputs without executing traps', () => {
  let proxyReads = 0;
  const proxy = new Proxy({}, {
    ownKeys() { proxyReads += 1; throw new Error('authorization-proxy-sentinel'); },
  });
  assert.throws(
    () => parseMvpBenchmarkExternalAuthorizationRequest(proxy),
    { code: 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID' },
  );
  assert.equal(proxyReads, 0);

  let getterReads = 0;
  const value = {
    schemaVersion: 'mvp-benchmark-external-authorization-request.v1',
    uid: uid(99550),
    sessionUid: uid(99551),
    dramaUid: uid(99552),
    sessionPlanSha256: 'a'.repeat(64),
    connectionUid: uid(99553),
    connectionEvidenceSha256: 'b'.repeat(64),
    maximumCostCnyFen: 1,
    validityDurationMs: 60_000,
  };
  Object.defineProperty(value, 'uid', {
    enumerable: true,
    get() { getterReads += 1; return uid(99550); },
  });
  assert.throws(
    () => parseMvpBenchmarkExternalAuthorizationRequest(value),
    { code: 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID' },
  );
  assert.equal(getterReads, 0);

  const missing = { ...value };
  delete missing.schemaVersion;
  missing.extra = true;
  let inheritedReads = 0;
  Object.defineProperty(Object.prototype, 'schemaVersion', {
    configurable: true,
    get() {
      inheritedReads += 1;
      return 'mvp-benchmark-external-authorization-request.v1';
    },
  });
  try {
    assert.throws(
      () => parseMvpBenchmarkExternalAuthorizationRequest(missing),
      { code: 'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_INPUT_INVALID' },
    );
    assert.equal(inheritedReads, 0);
  } finally {
    delete Object.prototype.schemaVersion;
  }
});

test('connection evidence hashing does not execute inherited toJSON accessors', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const expected = remoteConnectionEvidenceSha256(current.connection);
  let reads = 0;
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    get() { reads += 1; return undefined; },
  });
  try {
    assert.equal(remoteConnectionEvidenceSha256(current.connection), expected);
    assert.equal(reads, 0);
  } finally {
    delete Object.prototype.toJSON;
  }
});
