'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  APPROVED_LIVE_ENVIRONMENT,
  createMvpBenchmarkLiveEnvironmentObservation,
} = require('../src/benchmark/mvpBenchmarkExecutionPreflight');
const {
  createMvpBenchmarkExecutionPreflightService,
} = require('../src/benchmark/mvpBenchmarkExecutionPreflightService');
const {
  MvpBenchmarkExternalAuthorizationError,
} = require('../src/benchmark/mvpBenchmarkExternalAuthorization');
const {
  createMvpBenchmarkExecutionDispatcher,
} = require('../src/benchmark/mvpBenchmarkExecutionDispatcher');
const { createProductionAudioTtsRuntime } = require('../src/audio/productionRuntime');
const { createH3LocalExecutionService } = require('../src/h3/localExecutionService');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const {
  createCoordinatorTransferFailureFixture,
} = require('./helpers/v9RemoteFailureFixture');
const { createMvpBenchmarkSessionFixture } = require('./helpers/v9MvpBenchmarkSessionFixture');
const { uid } = require('./helpers/v2RepositoryDatabase');

function authorizationRequest(current, session) {
  return {
    schemaVersion: 'mvp-benchmark-external-authorization-request.v1',
    uid: uid(99800),
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    sessionPlanSha256: session.planSha256,
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    maximumCostCnyFen: 1_000,
    validityDurationMs: 60 * 60 * 1000,
  };
}

function rawObservation(current) {
  const observation = createMvpBenchmarkLiveEnvironmentObservation({
    schemaVersion: 'mvp-benchmark-live-environment-observation.v1',
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    observedAtEpochMs: 2_000,
    approvedEnvironmentSha256:
      '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43',
    gpu: structuredClone(APPROVED_LIVE_ENVIRONMENT.gpu),
    comfyUI: structuredClone(APPROVED_LIVE_ENVIRONMENT.comfyUI),
    runtime: structuredClone(APPROVED_LIVE_ENVIRONMENT.runtime),
    models: structuredClone(APPROVED_LIVE_ENVIRONMENT.models),
  });
  const { observationSha256: _digest, ...raw } = observation;
  return raw;
}

async function preparedBatch(current) {
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  let nextUid = 99810;
  const service = createMvpBenchmarkExecutionPreflightService({
    repositories: current.repositories,
    liveEnvironmentVerifier: Object.freeze({
      inspect() { return Promise.resolve(rawObservation(current)); },
    }),
    costEstimator: Object.freeze({
      estimateH3() {
        return Promise.resolve({ estimatedCostCnyFen: 10, policyUid: uid(99890) });
      },
      estimateTts() {
        return Promise.resolve({ estimatedCostCnyFen: 5, policyUid: uid(99891) });
      },
    }),
    createUid: () => uid(nextUid++),
    nowEpochMs: () => 2_100,
  });
  return { authorization, batch: await service.prepareBatch(authorization.uid), session };
}

function activateReplacementVoice(current) {
  const replacement = current.repositories.voiceProfiles.create({
    schemaVersion: current.profile.schemaVersion,
    uid: uid(99870),
    dramaUid: current.profile.dramaUid,
    characterUid: current.profile.characterUid,
    characterVoiceVersionUid: current.profile.characterVoiceVersionUid,
    parentUid: current.profile.uid,
    revision: current.profile.revision + 1,
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
    uid: uid(99871),
    dramaUid: current.profile.dramaUid,
    characterUid: current.profile.characterUid,
    voiceProfileUid: replacement.uid,
    previousVoiceProfileUid: current.profile.uid,
    stateVersion: 2,
    changedAtEpochMs: 70,
  });
}

function unavailable(operation) {
  assert.throws(operation, (error) => {
    assert.equal(error.code, 'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE');
    assert.equal(JSON.stringify(error).includes('998'), false);
    return true;
  });
}

test('a complete current batch issues exact opaque in-process execution permits', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, batch, session } = await preparedBatch(current);
  const gate = current.repositories.mvpBenchmarkExecutionGate;
  assert.equal(Object.hasOwn(
    current.repositories.mvpBenchmarkExternalAuthorizations,
    'getStored',
  ), false);
  assert.equal(Object.hasOwn(
    current.repositories.mvpBenchmarkExecutionPreflights,
    'getStoredReservation',
  ), false);

  unavailable(() => gate.assertH3TaskExecutionOpen(session.h3Tasks[0].taskUid));
  unavailable(() => gate.assertAudioIntentExecutionOpen(session.audioIntents[0].intentUid));

  const permits = gate.openBatch(authorization.uid, { nowEpochMs: 2_200 });
  assert.equal(Object.isFrozen(permits), true);
  assert.equal(permits.length, batch.reservations.length);
  for (let index = 0; index < permits.length; index += 1) {
    assert.equal(Object.isFrozen(permits[index]), true);
    assert.equal(Object.getPrototypeOf(permits[index]), null);
    assert.deepEqual(Reflect.ownKeys(permits[index]), []);
  }

  for (let index = 0; index < session.h3Tasks.length; index += 1) {
    assert.equal(
      gate.assertH3TaskExecutionOpen(session.h3Tasks[index].taskUid, permits[index]),
      true,
    );
  }
  const ttsOffset = session.h3Tasks.length;
  assert.equal(gate.assertAudioIntentExecutionOpen(
    session.audioIntents[0].intentUid, permits[ttsOffset],
  ), true);
  assert.equal(gate.assertH3TaskExecutionOpen(uid(123456)), true);

  current.repositories.remote.transitionFormalTask({
    uid: session.h3Tasks[0].taskUid,
    expectedStateVersion: 0,
    nextStage: 'uploading',
    nextStatus: 'running',
    recoveryState: 'none',
  });
  assert.equal(gate.assertH3TaskExecutionOpen(
    session.h3Tasks[0].taskUid,
    permits[0],
  ), true);
  current.repositories.runs.transitionWorkflowStatus({
    uid: session.workflowRunUid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  assert.equal(gate.assertAudioIntentExecutionOpen(
    session.audioIntents[0].intentUid,
    permits[ttsOffset],
  ), true);
});

test('plain, proxy, cross-kind, and cross-item permits fail without trap execution', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, session } = await preparedBatch(current);
  const gate = current.repositories.mvpBenchmarkExecutionGate;
  const permits = gate.openBatch(authorization.uid, { nowEpochMs: 2_200 });

  unavailable(() => gate.assertH3TaskExecutionOpen(session.h3Tasks[0].taskUid, {}));
  unavailable(() => gate.assertH3TaskExecutionOpen(session.h3Tasks[1].taskUid, permits[0]));
  unavailable(() => gate.assertAudioIntentExecutionOpen(
    session.audioIntents[0].intentUid, permits[0],
  ));

  let reads = 0;
  const hostile = new Proxy({}, {
    get() { reads += 1; throw new Error('permit-sentinel'); },
    getOwnPropertyDescriptor() { reads += 1; throw new Error('permit-sentinel'); },
    getPrototypeOf() { reads += 1; throw new Error('permit-sentinel'); },
    ownKeys() { reads += 1; throw new Error('permit-sentinel'); },
  });
  unavailable(() => gate.assertH3TaskExecutionOpen(session.h3Tasks[0].taskUid, hostile));
  assert.equal(reads, 0);
});

test('batch permit opening revalidates current sources and leaves no durable permit record', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, session } = await preparedBatch(current);
  const beforeTables = current.database.prepare(`
    SELECT count(*) FROM sqlite_master
    WHERE type='table' AND name LIKE 'mvp_benchmark_execution_permit%'
  `).pluck().get();
  const permits = current.repositories.mvpBenchmarkExecutionGate.openBatch(
    authorization.uid,
    { nowEpochMs: 2_200 },
  );
  activateReplacementVoice(current);

  unavailable(() => current.repositories.mvpBenchmarkExecutionGate
    .assertAudioIntentExecutionOpen(
      session.audioIntents[0].intentUid,
      permits[session.h3Tasks.length],
    ));
  unavailable(() => current.repositories.mvpBenchmarkExecutionGate.openBatch(
    authorization.uid,
    { nowEpochMs: 2_200 },
  ));
  assert.equal(current.database.prepare(`
    SELECT count(*) FROM sqlite_master
    WHERE type='table' AND name LIKE 'mvp_benchmark_execution_permit%'
  `).pluck().get(), beforeTables);
});

test('issued permits fail closed after connection or reservation evidence drifts', async (t) => {
  const connectionFixture = createMvpBenchmarkSessionFixture(t);
  const connectionBatch = await preparedBatch(connectionFixture);
  const connectionPermits = connectionFixture.repositories.mvpBenchmarkExecutionGate.openBatch(
    connectionBatch.authorization.uid,
    { nowEpochMs: 2_200 },
  );
  connectionFixture.repositories.remote.updateConnection({
    uid: connectionFixture.connection.uid,
    expectedStateVersion: connectionFixture.connection.stateVersion,
    name: connectionFixture.connection.name,
    host: 'replacement.example.invalid',
    port: connectionFixture.connection.port,
    username: connectionFixture.connection.username,
    comfyHost: connectionFixture.connection.comfyHost,
    comfyPort: connectionFixture.connection.comfyPort,
    remoteWorkDir: connectionFixture.connection.remoteWorkDir,
  });
  unavailable(() => connectionFixture.repositories.mvpBenchmarkExecutionGate
    .assertH3TaskExecutionOpen(
      connectionBatch.session.h3Tasks[0].taskUid,
      connectionPermits[0],
    ));

  const reservationFixture = createMvpBenchmarkSessionFixture(t);
  const reservationBatch = await preparedBatch(reservationFixture);
  const reservationPermits = reservationFixture.repositories.mvpBenchmarkExecutionGate.openBatch(
    reservationBatch.authorization.uid,
    { nowEpochMs: 2_200 },
  );
  reservationFixture.database.exec(
    'DROP TRIGGER v2_mvp_benchmark_execution_reservations_immutable_update',
  );
  reservationFixture.database.prepare(`
    UPDATE mvp_benchmark_execution_reservations
    SET estimated_cost_cny_fen=estimated_cost_cny_fen+1
    WHERE uid=?
  `).run(reservationBatch.batch.reservations[0].uid);
  unavailable(() => reservationFixture.repositories.mvpBenchmarkExecutionGate
    .assertH3TaskExecutionOpen(
      reservationBatch.session.h3Tasks[0].taskUid,
      reservationPermits[0],
    ));

  const assetFixture = createMvpBenchmarkSessionFixture(t);
  const assetBatch = await preparedBatch(assetFixture);
  const assetPermits = assetFixture.repositories.mvpBenchmarkExecutionGate.openBatch(
    assetBatch.authorization.uid,
    { nowEpochMs: 2_200 },
  );
  const intent = assetFixture.h3Intents[0];
  const replacementVersionUid = uid(99872);
  assetFixture.repositories.assets.addVersion({
    uid: replacementVersionUid,
    assetUid: intent.assetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${assetFixture.dramaUid}/benchmark/video/${intent.assetUid}/${replacementVersionUid}`,
    relativePath: `projects/${assetFixture.dramaUid}/assets/video/${intent.assetUid}/${replacementVersionUid}.mp4`,
    sha256: '9'.repeat(64),
    mimeType: 'video/mp4',
    width: 608,
    height: 352,
    durationMs: 1625,
    parentUid: intent.parentVersionUid,
    status: 'ready',
  }, { makeCurrent: true });
  unavailable(() => assetFixture.repositories.mvpBenchmarkExecutionGate
    .assertH3TaskExecutionOpen(
      assetBatch.session.h3Tasks[0].taskUid,
      assetPermits[0],
    ));
});

test('the same opaque permit reaches coordinator and remote task transition gates', async (t) => {
  const executionPermit = Object.freeze(Object.create(null));
  let gateCalls = 0;
  const executionGate = Object.freeze({
    assertH3TaskExecutionOpen(_taskUid, receivedPermit) {
      gateCalls += 1;
      if (receivedPermit !== executionPermit) {
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
  const source = Buffer.from('synthetic upload payload');
  fs.mkdirSync(path.join(fixture.localRoot, 'input'), { recursive: true });
  fs.writeFileSync(path.join(fixture.localRoot, 'input', 'source.bin'), source);

  await assert.rejects(
    fixture.coordinator.execute(
      fixture.taskUid,
      fixture.executeRequest,
      executionPermit,
    ),
    { code: 'REMOTE_TASK_UNEXPECTED' },
  );
  assert.equal(gateCalls >= 4, true);
  assert.equal(fixture.taskService.get(fixture.taskUid).stage, 'failed');
});

test('synthetic dispatcher routes exact items once and isolates a late failure', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const { authorization, session } = await preparedBatch(current);
  const calls = [];
  let rejectFirst;
  const firstFailure = new Promise((_resolve, reject) => { rejectFirst = reject; });
  const dispatcher = createMvpBenchmarkExecutionDispatcher({
    executionGate: current.repositories.mvpBenchmarkExecutionGate,
    preflights: current.repositories.mvpBenchmarkExecutionPreflights,
    syntheticH3Executor: Object.freeze({
      execute(itemUid, permit) {
        calls.push(Object.freeze({ itemKind: 'h3', itemUid, permit }));
        if (itemUid === session.h3Tasks[0].taskUid) return firstFailure;
        return Promise.resolve(Object.freeze({ itemUid, status: 'synthetic-succeeded' }));
      },
    }),
    syntheticTtsExecutor: Object.freeze({
      execute(itemUid, permit) {
        calls.push(Object.freeze({ itemKind: 'tts', itemUid, permit }));
        return Promise.resolve(Object.freeze({ itemUid, status: 'synthetic-succeeded' }));
      },
    }),
  });
  const batch = dispatcher.openSyntheticBatch(
    authorization.uid,
    { nowEpochMs: 2_200 },
  );
  assert.equal(dispatcher.openSyntheticBatch(
    authorization.uid,
    { nowEpochMs: 2_201 },
  ), batch);
  const first = batch.executeItem('h3', session.h3Tasks[0].taskUid);
  assert.equal(batch.executeItem('h3', session.h3Tasks[0].taskUid), first);
  const second = batch.executeItem('h3', session.h3Tasks[1].taskUid);
  assert.deepEqual(await second, Object.freeze({
    itemUid: session.h3Tasks[1].taskUid,
    status: 'synthetic-succeeded',
  }));
  rejectFirst(new Error('late synthetic executor sentinel'));
  await assert.rejects(first, (error) => {
    assert.equal(error.code, 'MVP_BENCHMARK_EXECUTION_DISPATCH_FAILED');
    assert.equal(JSON.stringify(error).includes('sentinel'), false);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.throws(
    () => batch.executeItem('tts', session.h3Tasks[0].taskUid),
    { code: 'MVP_BENCHMARK_EXECUTION_DISPATCH_INVALID' },
  );
  assert.equal(calls.length, 2);
});

test('H3 local and production TTS wrappers forward permits before execution', async (t) => {
  const executionPermit = Object.freeze(Object.create(null));
  const taskUid = uid(99895);
  let h3Permit = null;
  const method = () => {};
  const h3Service = createH3LocalExecutionService({
    repositories: Object.freeze({
      assets: Object.freeze({ getVersion: method }),
      generationHistory: Object.freeze({ get: method }),
      h3GenerationIntents: Object.freeze({
        getByTask(value) { return Object.freeze({ taskUid: value }); },
      }),
      remote: Object.freeze({ getFormalTask: method }),
      runs: Object.freeze({ getGeneration: method, getNode: method }),
    }),
    coordinator: Object.freeze({
      execute(_taskUid, _request, receivedPermit) {
        h3Permit = receivedPermit;
        return Promise.reject(new Error('synthetic coordinator stop'));
      },
    }),
  });
  await assert.rejects(h3Service.execute(taskUid, {}, executionPermit));
  assert.equal(h3Permit, executionPermit);

  const current = createMvpBenchmarkSessionFixture(t);
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-permit-audio-'));
  t.after(() => fs.rmSync(localRoot, { force: true, recursive: true }));
  let ttsPermit = null;
  const runtime = createProductionAudioTtsRuntime({
    database: current.database,
    localRoot,
    dependencies: {
      executionGate: Object.freeze({
        assertAudioIntentExecutionOpen(_intentUid, receivedPermit) {
          ttsPermit = receivedPermit;
          throw new MvpBenchmarkExternalAuthorizationError(
            'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE',
          );
        },
      }),
    },
  });
  assert.throws(
    () => runtime.audioTts.service.execute(
      current.audioIntent.uid,
      current.audioIntent.dramaUid,
      executionPermit,
    ),
    { code: 'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE' },
  );
  assert.equal(ttsPermit, executionPermit);
});
