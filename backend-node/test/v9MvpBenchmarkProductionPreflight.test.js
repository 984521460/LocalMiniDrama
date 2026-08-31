'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const express = require('express');

const {
  APPROVED_LIVE_ENVIRONMENT,
} = require('../src/benchmark/mvpBenchmarkExecutionPreflight');
const {
  MVP_BENCHMARK_AUTHORIZATION_CEILING_POLICY_UID,
  createMvpBenchmarkAuthorizationCeilingEstimator,
} = require('../src/benchmark/mvpBenchmarkAuthorizationCeilingEstimator');
const {
  createMvpBenchmarkSshLiveEnvironmentVerifier,
} = require('../src/benchmark/mvpBenchmarkSshLiveEnvironmentVerifier');
const {
  createProductionMvpBenchmarkRuntime,
} = require('../src/benchmark/productionRuntime');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const mvpBenchmarkRoutes = require('../src/routes/v2/mvpBenchmark');
const { createMvpBenchmarkSessionFixture } = require('./helpers/v9MvpBenchmarkSessionFixture');
const { uid } = require('./helpers/v2RepositoryDatabase');

function authorizationRequest(current, session, overrides = {}) {
  return {
    schemaVersion: 'mvp-benchmark-external-authorization-request.v1',
    uid: uid(99800),
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    sessionPlanSha256: session.planSha256,
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    maximumCostCnyFen: 374,
    validityDurationMs: 60 * 60 * 1000,
    ...overrides,
  };
}

function observationInput(current, observedAtEpochMs = 2_000) {
  return {
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
  };
}

function exactProbeOutput() {
  return JSON.stringify({
    gpu: APPROVED_LIVE_ENVIRONMENT.gpu,
    comfyUI: APPROVED_LIVE_ENVIRONMENT.comfyUI,
    runtime: APPROVED_LIVE_ENVIRONMENT.runtime,
    models: APPROVED_LIVE_ENVIRONMENT.models,
  });
}

function outputStream(value) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.destroy = () => {};
  process.nextTick(() => {
    stream.emit('data', Buffer.from(value, 'utf8'));
    stream.emit('close', 0);
  });
  return stream;
}

async function listen(app) {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test('authorization ceiling estimator deterministically reserves the exact approved maximum', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  const estimator = createMvpBenchmarkAuthorizationCeilingEstimator({
    repositories: current.repositories,
  });
  const estimates = [];
  for (let index = 0; index < session.h3Tasks.length; index += 1) {
    const item = session.h3Tasks[index];
    estimates.push(await estimator.estimateH3({
      authorizationUid: authorization.uid,
      attestationUid: uid(99801),
      itemUid: item.taskUid,
      requestSha256: item.planEvidenceSha256,
    }));
  }
  for (let index = 0; index < session.audioIntents.length; index += 1) {
    const item = session.audioIntents[index];
    estimates.push(await estimator.estimateTts({
      authorizationUid: authorization.uid,
      attestationUid: uid(99801),
      itemUid: item.intentUid,
      requestSha256: item.planSha256,
    }));
  }
  assert.deepEqual(estimates.map((entry) => entry.estimatedCostCnyFen), [75, 75, 75, 75, 74]);
  assert.equal(
    estimates.reduce((total, entry) => total + entry.estimatedCostCnyFen, 0),
    authorization.maximumCostCnyFen,
  );
  assert.equal(estimates.every(
    (entry) => entry.policyUid === MVP_BENCHMARK_AUTHORIZATION_CEILING_POLICY_UID,
  ), true);
  await assert.rejects(() => estimator.estimateH3({
    authorizationUid: authorization.uid,
    attestationUid: uid(99801),
    itemUid: session.h3Tasks[0].taskUid,
    requestSha256: '0'.repeat(64),
  }), { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE' });
});

test('SSH live verifier binds connection evidence, returns exact observation, and closes', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const evidence = remoteConnectionEvidenceSha256(current.connection);
  let openCalls = 0;
  let closeCalls = 0;
  let command = '';
  const session = Object.freeze({
    exec(value) {
      command = value;
      return Promise.resolve(outputStream(exactProbeOutput()));
    },
    close() {
      closeCalls += 1;
      return Promise.resolve();
    },
  });
  const verifier = createMvpBenchmarkSshLiveEnvironmentVerifier({
    sessionService: Object.freeze({
      openSession(connectionUid, expectedEvidenceSha256) {
        openCalls += 1;
        assert.equal(connectionUid, current.connection.uid);
        assert.equal(expectedEvidenceSha256, evidence);
        return Promise.resolve(Object.freeze({ connection: current.connection, session }));
      },
    }),
    nowEpochMs: () => 2_000,
    timeoutMs: 1_000,
  });
  const actual = await verifier.inspect(Object.freeze({
    authorizationUid: uid(99802),
    sessionUid: uid(99803),
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: evidence,
    approvedEnvironmentSha256:
      '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
  }));
  assert.deepEqual(actual, observationInput(current));
  assert.equal(openCalls, 1);
  assert.equal(closeCalls, 1);
  assert.match(command, /^python3 -c /u);
  assert.equal(command.includes(current.connection.host), false);
  const encodedPayload = / '([A-Za-z0-9+/=]+)'$/u.exec(command)?.[1];
  assert.equal(typeof encodedPayload, 'string');
  const probeRequest = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8'));
  assert.equal(probeRequest.comfyPort, current.connection.comfyPort);
  assert.deepEqual(probeRequest.models.map((model) => model.relativePath), [
    'models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    'models/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors',
    'models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    'models/vae/minimax_h3_video_vae_fp16.safetensors',
    'models/vae/minimax_h3_audio_vae_fp32.safetensors',
    'models/loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
    'models/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
  ]);

  let failedCloseCalls = 0;
  const closeFailureVerifier = createMvpBenchmarkSshLiveEnvironmentVerifier({
    sessionService: Object.freeze({
      openSession() {
        return Promise.resolve(Object.freeze({
          connection: current.connection,
          session: Object.freeze({
            exec: () => Promise.resolve(outputStream(exactProbeOutput())),
            close() {
              failedCloseCalls += 1;
              return Promise.reject(new Error('synthetic close failure'));
            },
          }),
        }));
      },
    }),
    nowEpochMs: () => 2_000,
    timeoutMs: 1_000,
  });
  await assert.rejects(() => closeFailureVerifier.inspect(Object.freeze({
    authorizationUid: uid(99802),
    sessionUid: uid(99803),
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: evidence,
    approvedEnvironmentSha256:
      '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
  })), { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE' });
  assert.equal(failedCloseCalls, 1);

  let mismatchedCloseCalls = 0;
  let mismatchedExecCalls = 0;
  const mismatchedConnection = Object.freeze({
    ...current.connection,
    host: 'drifted.example.invalid',
  });
  const mismatchedVerifier = createMvpBenchmarkSshLiveEnvironmentVerifier({
    sessionService: Object.freeze({
      openSession() {
        return Promise.resolve(Object.freeze({
          connection: mismatchedConnection,
          session: Object.freeze({
            exec() { mismatchedExecCalls += 1; return Promise.resolve(); },
            close() { mismatchedCloseCalls += 1; return Promise.resolve(); },
          }),
        }));
      },
    }),
    nowEpochMs: () => 2_000,
    timeoutMs: 1_000,
  });
  await assert.rejects(() => mismatchedVerifier.inspect(Object.freeze({
    authorizationUid: uid(99802),
    sessionUid: uid(99803),
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: evidence,
    approvedEnvironmentSha256:
      '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
  })), { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE' });
  assert.equal(mismatchedExecCalls, 0);
  assert.equal(mismatchedCloseCalls, 1);

  let timeoutCloseCalls = 0;
  const timeoutVerifier = createMvpBenchmarkSshLiveEnvironmentVerifier({
    sessionService: Object.freeze({
      openSession() {
        return Promise.resolve(Object.freeze({
          connection: current.connection,
          session: Object.freeze({
            exec: () => new Promise(() => {}),
            close() { timeoutCloseCalls += 1; return Promise.resolve(); },
          }),
        }));
      },
    }),
    nowEpochMs: () => 2_000,
    timeoutMs: 20,
  });
  await assert.rejects(() => timeoutVerifier.inspect(Object.freeze({
    authorizationUid: uid(99802),
    sessionUid: uid(99803),
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: evidence,
    approvedEnvironmentSha256:
      '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
  })), { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE' });
  assert.equal(timeoutCloseCalls, 1);

  const drifted = JSON.parse(exactProbeOutput());
  drifted.models[0].sha256 = '0'.repeat(64);
  const driftedVerifier = createMvpBenchmarkSshLiveEnvironmentVerifier({
    sessionService: Object.freeze({
      openSession() {
        return Promise.resolve(Object.freeze({
          connection: current.connection,
          session: Object.freeze({
            exec: () => Promise.resolve(outputStream(JSON.stringify(drifted))),
            close: () => Promise.resolve(),
          }),
        }));
      },
    }),
    nowEpochMs: () => 2_000,
    timeoutMs: 1_000,
  });
  await assert.rejects(() => driftedVerifier.inspect(Object.freeze({
    authorizationUid: uid(99802),
    sessionUid: uid(99803),
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: evidence,
    approvedEnvironmentSha256:
      '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
  })), { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE' });
});

test('SSH live verifier does not execute connection or stream accessors', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const evidence = remoteConnectionEvidenceSha256(current.connection);
  const request = Object.freeze({
    authorizationUid: uid(99802),
    sessionUid: uid(99803),
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: evidence,
    approvedEnvironmentSha256:
      '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
  });

  let connectionAccessorReads = 0;
  let connectionCloseCalls = 0;
  let connectionExecCalls = 0;
  const hostileConnection = { ...current.connection };
  Object.defineProperty(hostileConnection, 'comfyPort', {
    enumerable: true,
    get() {
      connectionAccessorReads += 1;
      return current.connection.comfyPort;
    },
  });
  const connectionVerifier = createMvpBenchmarkSshLiveEnvironmentVerifier({
    sessionService: Object.freeze({
      openSession() {
        return Promise.resolve(Object.freeze({
          connection: hostileConnection,
          session: Object.freeze({
            exec() { connectionExecCalls += 1; return Promise.resolve(); },
            close() { connectionCloseCalls += 1; return Promise.resolve(); },
          }),
        }));
      },
    }),
    nowEpochMs: () => 2_000,
    timeoutMs: 1_000,
  });
  await assert.rejects(
    () => connectionVerifier.inspect(request),
    { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE' },
  );
  assert.equal(connectionAccessorReads, 0);
  assert.equal(connectionExecCalls, 0);
  assert.equal(connectionCloseCalls, 1);

  let streamAccessorReads = 0;
  const stream = outputStream(exactProbeOutput());
  Object.defineProperties(stream, {
    on: {
      configurable: true,
      get() { streamAccessorReads += 1; return EventEmitter.prototype.on; },
    },
    once: {
      configurable: true,
      get() { streamAccessorReads += 1; return EventEmitter.prototype.once; },
    },
    destroy: {
      configurable: true,
      get() { streamAccessorReads += 1; return () => {}; },
    },
  });
  Object.defineProperty(stream.stderr, 'on', {
    configurable: true,
    get() { streamAccessorReads += 1; return EventEmitter.prototype.on; },
  });
  const streamVerifier = createMvpBenchmarkSshLiveEnvironmentVerifier({
    sessionService: Object.freeze({
      openSession() {
        return Promise.resolve(Object.freeze({
          connection: current.connection,
          session: Object.freeze({
            exec: () => Promise.resolve(stream),
            close: () => Promise.resolve(),
          }),
        }));
      },
    }),
    nowEpochMs: () => 2_000,
    timeoutMs: 1_000,
  });
  assert.deepEqual(await streamVerifier.inspect(request), observationInput(current));
  assert.equal(streamAccessorReads, 0);
});

test('SSH live verifier closes resources that settle after its deadline', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const evidence = remoteConnectionEvidenceSha256(current.connection);
  const request = Object.freeze({
    authorizationUid: uid(99802),
    sessionUid: uid(99803),
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: evidence,
    approvedEnvironmentSha256:
      '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
  });

  let resolveOpen;
  let lateOpenCloseCalls = 0;
  const lateOpenVerifier = createMvpBenchmarkSshLiveEnvironmentVerifier({
    sessionService: Object.freeze({
      openSession() {
        return new Promise((resolve) => { resolveOpen = resolve; });
      },
    }),
    nowEpochMs: () => 2_000,
    timeoutMs: 20,
  });
  await assert.rejects(
    () => lateOpenVerifier.inspect(request),
    { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE' },
  );
  resolveOpen(Object.freeze({
    connection: current.connection,
    session: Object.freeze({
      exec: () => Promise.resolve(),
      close() { lateOpenCloseCalls += 1; return Promise.resolve(); },
    }),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateOpenCloseCalls, 1);

  let resolveExec;
  let lateExecCloseCalls = 0;
  const lateExecVerifier = createMvpBenchmarkSshLiveEnvironmentVerifier({
    sessionService: Object.freeze({
      openSession() {
        return Promise.resolve(Object.freeze({
          connection: current.connection,
          session: Object.freeze({
            exec: () => new Promise((resolve) => { resolveExec = resolve; }),
            close() { lateExecCloseCalls += 1; return Promise.resolve(); },
          }),
        }));
      },
    }),
    nowEpochMs: () => 2_000,
    timeoutMs: 20,
  });
  await assert.rejects(
    () => lateExecVerifier.inspect(request),
    { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE' },
  );
  const lateStream = new PassThrough();
  lateStream.stderr = new PassThrough();
  resolveExec(lateStream);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateExecCloseCalls, 1);
  assert.equal(lateStream.destroyed, true);
});

test('SSH live verifier bounds stderr and combined probe output', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const evidence = remoteConnectionEvidenceSha256(current.connection);
  const request = Object.freeze({
    authorizationUid: uid(99802),
    sessionUid: uid(99803),
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: evidence,
    approvedEnvironmentSha256:
      '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
  });
  const stdout = exactProbeOutput();

  async function rejectProbe(stderrBytes) {
    let closeCalls = 0;
    const stream = new PassThrough();
    stream.stderr = new PassThrough();
    const verifier = createMvpBenchmarkSshLiveEnvironmentVerifier({
      sessionService: Object.freeze({
        openSession() {
          return Promise.resolve(Object.freeze({
            connection: current.connection,
            session: Object.freeze({
              exec() {
                process.nextTick(() => {
                  EventEmitter.prototype.emit.call(
                    stream.stderr, 'data', Buffer.alloc(stderrBytes, 65),
                  );
                  if (!stream.destroyed) {
                    EventEmitter.prototype.emit.call(stream, 'data', Buffer.from(stdout));
                    EventEmitter.prototype.emit.call(stream, 'close', 0);
                  }
                });
                return Promise.resolve(stream);
              },
              close() { closeCalls += 1; return Promise.resolve(); },
            }),
          }));
        },
      }),
      nowEpochMs: () => 2_000,
      timeoutMs: 1_000,
    });
    await assert.rejects(
      () => verifier.inspect(request),
      { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE' },
    );
    assert.equal(stream.destroyed, true);
    assert.equal(closeCalls, 1);
  }

  await rejectProbe(32 * 1024 + 1);
  await rejectProbe(32 * 1024 - Buffer.byteLength(stdout, 'utf8') + 1);
});

test('SSH live verifier contains immediate and late stderr errors', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const evidence = remoteConnectionEvidenceSha256(current.connection);
  const request = Object.freeze({
    authorizationUid: uid(99802),
    sessionUid: uid(99803),
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: evidence,
    approvedEnvironmentSha256:
      '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
  });
  const uncaught = [];
  const unhandled = [];
  const recordUncaught = () => { uncaught.push('uncaught'); };
  const recordUnhandled = () => { unhandled.push('unhandled'); };
  process.on('uncaughtException', recordUncaught);
  process.on('unhandledRejection', recordUnhandled);
  t.after(() => {
    process.off('uncaughtException', recordUncaught);
    process.off('unhandledRejection', recordUnhandled);
  });

  async function inspectStream({ emitError, timeoutMs }) {
    let closeCalls = 0;
    const stream = new PassThrough();
    stream.stderr = new PassThrough();
    const verifier = createMvpBenchmarkSshLiveEnvironmentVerifier({
      sessionService: Object.freeze({
        openSession() {
          return Promise.resolve(Object.freeze({
            connection: current.connection,
            session: Object.freeze({
              exec() {
                if (emitError) {
                  process.nextTick(() => {
                    EventEmitter.prototype.emit.call(
                      stream.stderr, 'error', new Error('synthetic stderr failure'),
                    );
                  });
                }
                return Promise.resolve(stream);
              },
              close() { closeCalls += 1; return Promise.resolve(); },
            }),
          }));
        },
      }),
      nowEpochMs: () => 2_000,
      timeoutMs,
    });
    await assert.rejects(
      () => verifier.inspect(request),
      { code: 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE' },
    );
    assert.equal(stream.destroyed, true);
    assert.equal(closeCalls, 1);
    return stream;
  }

  await inspectStream({ emitError: true, timeoutMs: 1_000 });
  const lateStream = await inspectStream({ emitError: false, timeoutMs: 20 });
  EventEmitter.prototype.emit.call(
    lateStream.stderr, 'error', new Error('synthetic late stderr failure'),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(uncaught, []);
  assert.deepEqual(unhandled, []);
});

test('production preflight route binds drama, session, and authorization before inspection', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  let inspectCalls = 0;
  let nextUid = 99810;
  const runtime = createProductionMvpBenchmarkRuntime({
    database: current.database,
    sessionService: Object.freeze({ openSession() { throw new Error('must not open'); } }),
    dependencies: Object.freeze({
      liveEnvironmentVerifier: Object.freeze({
        inspect() {
          inspectCalls += 1;
          return Promise.resolve(observationInput(current));
        },
      }),
      createUid: () => uid(nextUid++),
      nowEpochMs: () => 2_500,
      timeoutMs: 1_000,
    }),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/v2', mvpBenchmarkRoutes(
    Object.freeze({ error() {} }),
    Object.freeze({ mvpBenchmark: runtime }),
    current.database,
  ));
  const { server, base } = await listen(app);
  t.after(() => server.close());
  const suffix = `mvp-benchmark/sessions/${session.uid}/authorizations/${authorization.uid}/preflight`;

  const wrongDrama = await fetch(`${base}/api/v1/v2/dramas/${uid(99899)}/${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(wrongDrama.status, 404);
  assert.equal(inspectCalls, 0);

  const createdResponse = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/${suffix}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  const createdBody = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify({ createdBody, inspectCalls }));
  const batch = createdBody.data;
  assert.equal(batch.authorizationUid, authorization.uid);
  assert.equal(batch.reservations.reduce(
    (total, reservation) => total + reservation.estimatedCostCnyFen, 0,
  ), authorization.maximumCostCnyFen);
  assert.equal(inspectCalls, 1);

  const repeatedResponse = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/${suffix}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  assert.equal(repeatedResponse.status, 201);
  assert.deepEqual((await repeatedResponse.json()).data, batch);
  assert.equal(inspectCalls, 1);

  const callerFacts = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/${suffix}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ estimatedCostCnyFen: 1 }),
    },
  );
  assert.equal(callerFacts.status, 400);
  assert.equal(inspectCalls, 1);

  const readResponse = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/${suffix}`,
  );
  assert.equal(readResponse.status, 200);
  assert.deepEqual((await readResponse.json()).data, batch);

  const malformedUid = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/mvp-benchmark/sessions/${session.uid}`
      + '/authorizations/not-a-uuid/preflight',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  assert.equal(malformedUid.status, 400);
});

test('production preflight route fails closed when runtime is unavailable', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  const app = express();
  app.use(express.json());
  app.use('/api/v1/v2', mvpBenchmarkRoutes(
    Object.freeze({ error() {} }), Object.freeze({}), current.database,
  ));
  const { server, base } = await listen(app);
  t.after(() => server.close());
  const response = await fetch(
    `${base}/api/v1/v2/dramas/${session.dramaUid}/mvp-benchmark/sessions/${session.uid}`
      + `/authorizations/${authorization.uid}/preflight`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  assert.equal(response.status, 503);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_live_environment_attestations',
  ).pluck().get(), 0);
});
