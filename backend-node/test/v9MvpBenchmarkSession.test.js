'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const {
  createMvpBenchmarkSessionPlan,
  parseMvpBenchmarkSessionPlan,
  parseMvpBenchmarkSessionRequest,
  serializeMvpBenchmarkSessionJson,
} = require('../src/benchmark/mvpBenchmarkSession');
const { mvpBenchmarkSessionSourceGraphValid } = require('../src/db/v2/sqlFunctions');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
} = require('../src/repositories/v2');
const mvpBenchmarkRoutes = require('../src/routes/v2/mvpBenchmark');
const sessionSchema = require('../../schemas/v9/mvp-benchmark-session.schema.json');
const { createMvpBenchmarkSessionFixture } = require('./helpers/v9MvpBenchmarkSessionFixture');
const { uid } = require('./helpers/v2RepositoryDatabase');

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

test('session contract canonicalizes identities and binds its own digest', () => {
  const request = parseMvpBenchmarkSessionRequest({
    schemaVersion: 'mvp-benchmark-session-request.v1',
    uid: uid(99600),
    dramaUid: uid(99601),
    workflowRunUid: uid(99602),
    h3TaskUids: [uid(99613), uid(99610), uid(99612), uid(99611)],
    audioIntentUids: [uid(99621), uid(99620)],
    createdAtEpochMs: 0,
  });
  assert.deepEqual(request.h3TaskUids, [uid(99610), uid(99611), uid(99612), uid(99613)]);
  assert.deepEqual(request.audioIntentUids, [uid(99620), uid(99621)]);

  const h3Tasks = request.h3TaskUids.map((taskUid, index) => ({
    taskUid,
    intentUid: uid(99630 + index),
    nodeRunUid: uid(99640 + index),
    nodeUid: uid(99650 + index),
    assetUid: uid(99660 + index),
    manifestUid: uid(99670),
    generationSpecSha256: String(index + 1).repeat(64),
    planEvidenceSha256: String(index + 5).repeat(64),
  }));
  const audioIntents = request.audioIntentUids.map((intentUid, index) => ({
    intentUid,
    nodeRunUid: uid(99680 + index),
    nodeUid: uid(99690 + index),
    planSha256: String(index + 7).repeat(64),
  }));
  const plan = createMvpBenchmarkSessionPlan({
    schemaVersion: 'mvp-benchmark-session-plan.v1',
    uid: request.uid,
    dramaUid: request.dramaUid,
    workflowRunUid: request.workflowRunUid,
    workflowUid: uid(99700),
    graphHash: 'a'.repeat(64),
    graphRevision: 2,
    h3Tasks,
    audioIntents,
    createdAtEpochMs: request.createdAtEpochMs,
  });
  assert.deepEqual(parseMvpBenchmarkSessionPlan(structuredClone(plan)), plan);
  assert.throws(
    () => parseMvpBenchmarkSessionPlan({ ...plan, graphHash: 'b'.repeat(64) }),
    { code: 'MVP_BENCHMARK_SESSION_DATA_INVALID' },
  );
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.h3Tasks), true);
});

test('real repositories prepare one immutable same-workflow benchmark session', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  assert.equal(session.schemaVersion, 'mvp-benchmark-session-plan.v1');
  assert.equal(session.dramaUid, current.dramaUid);
  assert.equal(session.workflowRunUid, current.run.run.uid);
  assert.equal(session.h3Tasks.length, 4);
  assert.equal(session.audioIntents.length, 1);
  assert.deepEqual(
    current.repositories.mvpBenchmarkSessions.prepare(structuredClone(current.request)),
    session,
  );
  assert.deepEqual(current.repositories.mvpBenchmarkSessions.get(session.uid), session);
  const serialized = JSON.stringify(session);
  assert.doesNotMatch(serialized, /credential:v1:|worker\.example\.invalid|password|secret/iu);
  assert.equal(current.database.prepare('SELECT count(*) FROM mvp_benchmark_sessions').pluck().get(), 1);
  assert.equal(current.database.prepare('SELECT count(*) FROM generation_runs').pluck().get(), 0);
  assert.equal(current.database.prepare('SELECT count(*) FROM audio_tts_submissions').pluck().get(), 0);
  assert.equal(current.database.prepare('SELECT count(*) FROM audio_tts_outputs').pluck().get(), 0);

  assert.throws(
    () => current.repositories.mvpBenchmarkSessions.prepare({
      ...current.request,
      uid: uid(99710),
      h3TaskUids: current.request.h3TaskUids.slice(0, 3),
    }),
    { code: 'MVP_BENCHMARK_SESSION_INPUT_INVALID' },
  );
  assert.equal(current.database.prepare('SELECT count(*) FROM mvp_benchmark_sessions').pluck().get(), 1);

  const row = current.database.prepare('SELECT * FROM mvp_benchmark_sessions').get();
  assert.throws(
    () => current.database.prepare('UPDATE mvp_benchmark_sessions SET plan_sha256=? WHERE uid=?')
      .run('0'.repeat(64), session.uid),
    /immutable/u,
  );
  assert.throws(
    () => current.database.prepare('DELETE FROM mvp_benchmark_sessions WHERE uid=?').run(session.uid),
    /append-only/u,
  );
  assert.throws(
    () => current.database.prepare(`
      INSERT OR REPLACE INTO mvp_benchmark_sessions
        (uid,drama_uid,workflow_run_uid,request_json,plan_json,plan_sha256,created_at_epoch_ms)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      row.uid, row.drama_uid, row.workflow_run_uid, row.request_json,
      row.plan_json, row.plan_sha256, row.created_at_epoch_ms,
    ),
    /immutable/u,
  );
  assert.equal(current.database.prepare('SELECT count(*) FROM mvp_benchmark_sessions').pluck().get(), 1);
});

test('session read fails closed after persisted plan drift even when its update guard is absent', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  current.database.exec('DROP TRIGGER v2_mvp_benchmark_sessions_immutable_update');
  current.database.prepare('UPDATE mvp_benchmark_sessions SET plan_sha256=? WHERE uid=?')
    .run('0'.repeat(64), session.uid);
  assert.throws(
    () => current.repositories.mvpBenchmarkSessions.get(session.uid),
    (error) => error instanceof V2RepositoryDataError,
  );
});

test('session read fails closed after a bound H3 intent drifts behind its guard', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  current.database.exec('DROP TRIGGER v2_h3_generation_intents_immutable_update');
  current.database.prepare('UPDATE h3_generation_intents SET plan_evidence_sha256=? WHERE uid=?')
    .run('0'.repeat(64), session.h3Tasks[0].intentUid);
  assert.throws(
    () => current.repositories.mvpBenchmarkSessions.get(session.uid),
    (error) => error instanceof V2RepositoryDataError,
  );
});

test('session read fails closed after a bound H3 task leaves its prepared state', (t) => {
  const uploading = createMvpBenchmarkSessionFixture(t);
  const uploadingSession = uploading.repositories.mvpBenchmarkSessions.prepare(uploading.request);
  const uploadingTask = uploading.repositories.remote.getFormalTask(
    uploadingSession.h3Tasks[0].taskUid,
  );
  uploading.repositories.remote.transitionFormalTask({
    uid: uploadingTask.uid,
    expectedStateVersion: uploadingTask.stateVersion,
    nextStage: 'uploading',
    nextStatus: 'running',
    recoveryState: 'none',
  });
  assert.throws(
    () => uploading.repositories.mvpBenchmarkSessions.get(uploadingSession.uid),
    (error) => error instanceof V2RepositoryDataError,
  );

  const submitted = createMvpBenchmarkSessionFixture(t);
  const submittedSession = submitted.repositories.mvpBenchmarkSessions.prepare(submitted.request);
  const submittedTask = submitted.repositories.remote.getFormalTask(
    submittedSession.h3Tasks[0].taskUid,
  );
  submitted.repositories.remote.transitionFormalTask({
    uid: submittedTask.uid,
    expectedStateVersion: submittedTask.stateVersion,
    nextStage: 'submitted',
    nextStatus: 'running',
    recoveryState: 'none',
    submissionLeaseExpiresAtEpochMs: 1,
  });
  assert.throws(
    () => submitted.repositories.mvpBenchmarkSessions.get(submittedSession.uid),
    (error) => error instanceof V2RepositoryDataError,
  );

  const completed = createMvpBenchmarkSessionFixture(t);
  const completedSession = completed.repositories.mvpBenchmarkSessions.prepare(completed.request);
  completed.database.exec(`
    DROP TRIGGER v2_remote_tasks_formal_validate_update;
    DROP TRIGGER v2_h3_remote_task_completion_requires_history;
  `);
  completed.database.prepare(`
    UPDATE remote_tasks
    SET stage='completed', status='succeeded', prompt_id='synthetic-completed-prompt'
    WHERE uid=?
  `).run(completedSession.h3Tasks[0].taskUid);
  assert.throws(
    () => completed.repositories.mvpBenchmarkSessions.get(completedSession.uid),
    (error) => error instanceof V2RepositoryDataError,
  );
});

test('session read fails closed after a bound workflow or audio node starts running', (t) => {
  const workflow = createMvpBenchmarkSessionFixture(t);
  const workflowSession = workflow.repositories.mvpBenchmarkSessions.prepare(workflow.request);
  workflow.repositories.runs.transitionWorkflowStatus({
    uid: workflowSession.workflowRunUid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  assert.throws(
    () => workflow.repositories.mvpBenchmarkSessions.get(workflowSession.uid),
    (error) => error instanceof V2RepositoryDataError,
  );

  const audio = createMvpBenchmarkSessionFixture(t);
  const audioSession = audio.repositories.mvpBenchmarkSessions.prepare(audio.request);
  audio.repositories.runs.transitionNodeStatus({
    uid: audioSession.audioIntents[0].nodeRunUid,
    expectedStatus: 'queued',
    nextStatus: 'running',
    inputSnapshot: {},
  });
  assert.throws(
    () => audio.repositories.mvpBenchmarkSessions.get(audioSession.uid),
    (error) => error instanceof V2RepositoryDataError,
  );
});

test('session read fails closed after its frozen remote connection evidence changes', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
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
    () => current.repositories.mvpBenchmarkSessions.get(session.uid),
    (error) => error instanceof V2RepositoryDataError,
  );
});

test('session read fails closed after the active VoiceProfile changes', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const replacement = current.repositories.voiceProfiles.create({
    schemaVersion: current.profile.schemaVersion,
    uid: uid(99720),
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
    uid: uid(99721),
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
});

test('database rejects a correctly rehashed session whose task order contradicts the graph', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const requestRow = current.database.prepare(
    'SELECT request_json FROM mvp_benchmark_sessions WHERE uid=?',
  ).get(session.uid);
  current.database.exec('DROP TRIGGER v2_mvp_benchmark_sessions_append_only');
  current.database.exec('DROP TRIGGER v2_mvp_benchmark_sessions_reject_replacement');
  current.database.prepare('DELETE FROM mvp_benchmark_sessions WHERE uid=?').run(session.uid);
  const reordered = createMvpBenchmarkSessionPlan({
    schemaVersion: session.schemaVersion,
    uid: session.uid,
    dramaUid: session.dramaUid,
    workflowRunUid: session.workflowRunUid,
    workflowUid: session.workflowUid,
    graphHash: session.graphHash,
    graphRevision: session.graphRevision,
    h3Tasks: [
      session.h3Tasks[1], session.h3Tasks[0], session.h3Tasks[2], session.h3Tasks[3],
    ],
    audioIntents: session.audioIntents,
    createdAtEpochMs: session.createdAtEpochMs,
  });
  assert.throws(
    () => current.database.prepare(`
      INSERT INTO mvp_benchmark_sessions
        (uid,drama_uid,workflow_run_uid,request_json,plan_json,plan_sha256,created_at_epoch_ms)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      session.uid,
      session.dramaUid,
      session.workflowRunUid,
      requestRow.request_json,
      serializeMvpBenchmarkSessionJson(reordered),
      reordered.planSha256,
      session.createdAtEpochMs,
    ),
    /invalid/u,
  );
  assert.equal(current.database.prepare('SELECT count(*) FROM mvp_benchmark_sessions').pluck().get(), 0);
});

test('source graph validation does not execute inherited toJSON accessors', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const row = current.database.prepare(`
    SELECT runs.graph_snapshot_json, sessions.plan_json
    FROM mvp_benchmark_sessions AS sessions
    JOIN workflow_runs AS runs ON runs.uid=sessions.workflow_run_uid
    WHERE sessions.uid=?
  `).get(session.uid);
  let reads = 0;
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    get() {
      reads += 1;
      return undefined;
    },
  });
  try {
    assert.equal(mvpBenchmarkSessionSourceGraphValid(row.graph_snapshot_json, row.plan_json), 1);
    assert.equal(reads, 0);
  } finally {
    delete Object.prototype.toJSON;
  }
});

test('public route returns the current secret-free plan and rejects cross-drama reads', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/v2', mvpBenchmarkRoutes(
    Object.freeze({ error() {} }),
    Object.freeze({}),
    current.database,
  ));
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const createdResponse = await fetch(
    `${base}/api/v1/v2/dramas/${current.dramaUid}/mvp-benchmark/sessions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(current.request),
    },
  );
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).data;
  const validate = new Ajv2020({ strict: true }).compile(sessionSchema);
  assert.equal(validate(created), true, JSON.stringify(validate.errors));

  const getResponse = await fetch(
    `${base}/api/v1/v2/dramas/${current.dramaUid}/mvp-benchmark/sessions/${created.uid}`,
  );
  assert.equal(getResponse.status, 200);
  assert.deepEqual((await getResponse.json()).data, created);

  const wrongDrama = await fetch(
    `${base}/api/v1/v2/dramas/${uid(99999)}/mvp-benchmark/sessions/${created.uid}`,
  );
  assert.equal(wrongDrama.status, 404);
});

test('session request rejects Proxy and accessor values before executing traps', () => {
  let proxyReads = 0;
  const proxy = new Proxy({}, {
    ownKeys() { proxyReads += 1; throw new Error('session-proxy-sentinel'); },
  });
  assert.throws(
    () => parseMvpBenchmarkSessionRequest(proxy),
    { code: 'MVP_BENCHMARK_SESSION_INPUT_INVALID' },
  );
  assert.equal(proxyReads, 0);

  let getterReads = 0;
  const value = {
    schemaVersion: 'mvp-benchmark-session-request.v1',
    uid: uid(99800),
    dramaUid: uid(99801),
    workflowRunUid: uid(99802),
    h3TaskUids: [uid(99810), uid(99811), uid(99812), uid(99813)],
    audioIntentUids: [uid(99820)],
    createdAtEpochMs: 0,
  };
  Object.defineProperty(value, 'uid', {
    enumerable: true,
    get() { getterReads += 1; return uid(99800); },
  });
  assert.throws(
    () => parseMvpBenchmarkSessionRequest(value),
    { code: 'MVP_BENCHMARK_SESSION_INPUT_INVALID' },
  );
  assert.equal(getterReads, 0);
});
