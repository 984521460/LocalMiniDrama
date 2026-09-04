'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const express = require('express');
const Ajv2020 = require('ajv/dist/2020');

const finalizationRequestSchema = require('../../schemas/v9/mvp-benchmark-finalization-request.schema.json');
const { createGenerationHistoryRecord } = require('../src/assets/generationHistory');
const { createAudioExecutionEvidence } = require('../src/audio/audioExecutionEvidence');
const {
  APPROVED_LIVE_ENVIRONMENT,
  createMvpBenchmarkLiveEnvironmentObservation,
} = require('../src/benchmark/mvpBenchmarkExecutionPreflight');
const {
  createMvpBenchmarkExecutionPreflightService,
} = require('../src/benchmark/mvpBenchmarkExecutionPreflightService');
const {
  createMvpBenchmarkFinalizationService,
} = require('../src/benchmark/mvpBenchmarkFinalizationService');
const {
  createProductionMvpBenchmarkRuntime,
} = require('../src/benchmark/productionRuntime');
const { createLocalMediaProbe } = require('../src/media/localMediaProbe');
const { createProductionMediaExportRuntime } = require('../src/media/productionRuntime');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const mvpBenchmarkRoutes = require('../src/routes/v2/mvpBenchmark');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const { createMvpBenchmarkSessionFixture } = require('./helpers/v9MvpBenchmarkSessionFixture');
const { probeInput, trustedProbe } = require('./helpers/v8MediaFixture');
const { createMigratedV2Database, uid } = require('./helpers/v2RepositoryDatabase');

const FINAL_TIME = 2_000_000_000_000;

function fileSha256(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function generateVideo(ffmpegPath, filename, color, frequency) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=608x352:r=24:d=1.625`,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=1.625`,
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', filename,
  ], { stdio: 'pipe' });
}

function generateAudio(ffmpegPath, filename, frequency, durationSeconds) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i',
    `sine=frequency=${frequency}:sample_rate=48000:duration=${durationSeconds}`,
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', filename,
  ], { stdio: 'pipe' });
}

async function createRealFinalizationMedia(t, current) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mvp-finalization-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspaces');
  await fs.promises.mkdir(workspaceRoot, { recursive: true });
  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();
  const videoColors = ['red', 'blue', 'green', 'yellow'];
  const videos = [];
  for (let index = 0; index < current.h3Intents.length; index += 1) {
    const versionUid = uid(120100 + index);
    const relativePath = `projects/${current.dramaUid}/finalization/${versionUid}.mp4`;
    const filename = path.join(root, ...relativePath.split('/'));
    generateVideo(ffmpegPath, filename, videoColors[index], 330 + (index * 110));
    videos.push(Object.freeze({
      relativePath, sha256: fileSha256(filename), durationMs: 1_625,
    }));
  }
  const dialogueRelativePath = `projects/${current.dramaUid}/assets/audio/${uid(120110)}/${uid(120111)}.wav`;
  const dialogueFilename = path.join(root, ...dialogueRelativePath.split('/'));
  generateAudio(ffmpegPath, dialogueFilename, 660, 1);
  const bgmRelativePath = `projects/${current.dramaUid}/assets/bgm/${uid(120120)}/${uid(120121)}.wav`;
  const bgmFilename = path.join(root, ...bgmRelativePath.split('/'));
  generateAudio(ffmpegPath, bgmFilename, 220, 6.5);
  let exportUid = 120500;
  const mediaExportService = createProductionMediaExportRuntime({
    database: current.database,
    localRoot: root,
    workspaceRoot,
    dependencies: {
      ffmpegPath,
      ffprobePath,
      createUid: () => uid(exportUid++),
      nowEpochMs: () => FINAL_TIME + 1_000,
      timeoutMs: 120_000,
    },
  }).mediaExports.service;
  return Object.freeze({
    root,
    videos: Object.freeze(videos),
    dialogue: Object.freeze({
      relativePath: dialogueRelativePath,
      sha256: fileSha256(dialogueFilename),
      durationMs: 1_000,
    }),
    bgm: Object.freeze({
      relativePath: bgmRelativePath,
      sha256: fileSha256(bgmFilename),
      durationMs: 6_500,
    }),
    mediaProbe: createLocalMediaProbe({
      localRoot: root, ffmpegPath, ffprobePath, timeoutMs: 120_000,
    }),
    mediaExportService,
  });
}

async function listen(app) {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  return Object.freeze({ server, base: `http://127.0.0.1:${server.address().port}` });
}

function authorizationRequest(current, session) {
  return {
    schemaVersion: 'mvp-benchmark-external-authorization-request.v1',
    uid: uid(120000),
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    sessionPlanSha256: session.planSha256,
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    maximumCostCnyFen: 1_000,
    validityDurationMs: 60 * 60 * 1000,
  };
}

function observation(current) {
  const value = createMvpBenchmarkLiveEnvironmentObservation({
    schemaVersion: 'mvp-benchmark-live-environment-observation.v1',
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    observedAtEpochMs: 2_000,
    approvedEnvironmentSha256:
      '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
    gpu: structuredClone(APPROVED_LIVE_ENVIRONMENT.gpu),
    comfyUI: structuredClone(APPROVED_LIVE_ENVIRONMENT.comfyUI),
    runtime: structuredClone(APPROVED_LIVE_ENVIRONMENT.runtime),
    models: structuredClone(APPROVED_LIVE_ENVIRONMENT.models),
  });
  const { observationSha256: _digest, ...raw } = value;
  return raw;
}

async function prepareBatch(current) {
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  let nextUid = 120010;
  const preflight = createMvpBenchmarkExecutionPreflightService({
    repositories: current.repositories,
    liveEnvironmentVerifier: Object.freeze({
      inspect() { return Promise.resolve(observation(current)); },
    }),
    costEstimator: Object.freeze({
      estimateH3() {
        return Promise.resolve({ estimatedCostCnyFen: 10, policyUid: uid(120090) });
      },
      estimateTts() {
        return Promise.resolve({ estimatedCostCnyFen: 5, policyUid: uid(120091) });
      },
    }),
    createUid: () => uid(nextUid++),
    nowEpochMs: () => 2_100,
  });
  return Object.freeze({
    authorization,
    batch: await preflight.prepareBatch(authorization.uid),
    session,
  });
}

function completeSourceNodes(current) {
  current.repositories.runs.transitionWorkflowStatus({
    uid: current.run.run.uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  const sourceNodes = [
    ...current.run.nodes.filter((node) => (
      current.h3Intents.some((intent) => intent.taskUid
        === current.request.h3TaskUids[node.ordinal])
    )),
    current.run.nodes.find((node) => node.uid === current.audioIntent.nodeRunUid),
  ].filter(Boolean);
  for (let index = 0; index < sourceNodes.length; index += 1) {
    const node = sourceNodes[index];
    current.repositories.runs.transitionNodeStatus({
      uid: node.uid,
      expectedStatus: 'queued',
      nextStatus: 'running',
      inputSnapshot: {},
    });
    current.repositories.runs.transitionNodeStatus({
      uid: node.uid,
      expectedStatus: 'running',
      nextStatus: 'succeeded',
      output: { schemaVersion: 'synthetic-source-result.v1' },
    });
  }
}

function addH3Results(current, media = null) {
  const results = new Map();
  const histories = new Map();
  for (let index = 0; index < current.h3Intents.length; index += 1) {
    const intent = current.h3Intents[index];
    const parent = current.repositories.assets.getVersion(intent.parentVersionUid);
    const versionUid = uid(120100 + index);
    const source = media?.videos[index] ?? Object.freeze({
      relativePath: `projects/${current.dramaUid}/finalization/${versionUid}.mp4`,
      sha256: (index + 5).toString(16).repeat(64),
      durationMs: 1_625,
    });
    current.repositories.assets.addVersion({
      uid: versionUid,
      assetUid: intent.assetUid,
      storageProvider: 'local',
      logicalUri: `asset://dramas/${current.dramaUid}/finalization/${intent.assetUid}/${versionUid}`,
      relativePath: source.relativePath,
      sha256: source.sha256,
      mimeType: 'video/mp4',
      width: 608,
      height: 352,
      durationMs: source.durationMs,
      parentUid: parent.uid,
      status: 'ready',
    }, { makeCurrent: true });
    const version = current.repositories.assets.getVersion(versionUid);
    const manifest = current.repositories.comfyManifests.get(intent.manifestUid);
    const history = createGenerationHistoryRecord({
      uid: intent.historyUid,
      runUid: intent.generationRunUid,
      dramaUid: current.dramaUid,
      assetUid: intent.assetUid,
      promptSemanticUid: intent.promptSemantic.uid,
      manifestUid: intent.manifestUid,
      manifestSha256: manifest.workflowSha256,
      provider: 'local-comfy',
      model: 'MiniMax-H3',
      seed: intent.generationSpec.seed,
      parameters: { width: 608, height: 352 },
      input: {
        promptSemanticUid: intent.promptSemantic.uid,
        manifestUid: intent.manifestUid,
        generationSpec: intent.generationSpec,
      },
      status: 'succeeded',
      outputVersionUid: version.uid,
      outputVersionEvidence: version,
      parentVersionUid: parent.uid,
      parentVersionEvidence: parent,
      errorCode: null,
      errorDetailRef: null,
      createdAtEpochMs: FINAL_TIME - 3_000,
      completedAtEpochMs: FINAL_TIME - 2_000,
    });
    const item = current.request.h3TaskUids.indexOf(intent.taskUid);
    const nodeRun = current.run.nodes[item];
    const result = Object.freeze({
      schemaVersion: 'h3-local-execution-result.v2',
      taskUid: intent.taskUid,
      taskStateVersion: 9,
      workflowRunUid: current.run.run.uid,
      generationRunUid: intent.generationRunUid,
      historyUid: history.uid,
      assetUid: intent.assetUid,
      assetVersionUid: version.uid,
      nodeRunUid: nodeRun.uid,
      status: 'succeeded',
    });
    results.set(intent.taskUid, result);
    histories.set(history.uid, history);
  }
  return Object.freeze({ histories, results });
}

function addAudioResult(current, media = null) {
  const assetUid = uid(120110);
  const versionUid = uid(120111);
  const source = media?.dialogue ?? Object.freeze({
    relativePath: `projects/${current.dramaUid}/assets/audio/${assetUid}/${versionUid}.wav`,
    sha256: 'a'.repeat(64),
    durationMs: 1_000,
  });
  current.repositories.assets.create({
    uid: assetUid,
    ownerType: 'drama',
    ownerUid: current.dramaUid,
    assetType: 'audio',
    status: 'ready',
  });
  current.repositories.assets.addVersion({
    uid: versionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${current.dramaUid}/audio/${assetUid}/${versionUid}`,
    relativePath: source.relativePath,
    sha256: source.sha256,
    mimeType: 'audio/wav',
    width: null,
    height: null,
    durationMs: source.durationMs,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  const version = current.repositories.assets.getVersion(versionUid);
  const asset = current.repositories.assets.get(assetUid);
  const ttsRequest = current.audioIntent.plan.ttsRequests[0];
  const evidence = createAudioExecutionEvidence({
    schemaVersion: '8.0',
    uid: uid(120112),
    plan: current.audioIntent.plan,
    ttsOutputs: [{
      dialogueDeliveryUid: ttsRequest.dialogueDeliveryUid,
      requestSha256: ttsRequest.requestSha256,
      audioAsset: asset,
      audioVersionEvidence: version,
    }],
    createdAtEpochMs: FINAL_TIME - 1_000,
  });
  return Object.freeze({
    schemaVersion: 'audio-tts-execution-record.v1',
    intentUid: current.audioIntent.uid,
    dramaUid: current.dramaUid,
    workflowRunUid: current.run.run.uid,
    nodeRunUid: current.audioIntent.nodeRunUid,
    evidence,
  });
}

function addBgm(current, media = null) {
  const assetUid = uid(120120);
  const versionUid = uid(120121);
  const source = media?.bgm ?? Object.freeze({
    relativePath: `projects/${current.dramaUid}/assets/bgm/${assetUid}/${versionUid}.wav`,
    sha256: 'b'.repeat(64),
    durationMs: 6_500,
  });
  current.repositories.assets.create({
    uid: assetUid,
    ownerType: 'drama',
    ownerUid: current.dramaUid,
    assetType: 'bgm',
    status: 'ready',
  });
  current.repositories.assets.addVersion({
    uid: versionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${current.dramaUid}/bgm/${assetUid}/${versionUid}`,
    relativePath: source.relativePath,
    sha256: source.sha256,
    mimeType: 'audio/wav',
    width: null,
    height: null,
    durationMs: source.durationMs,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  return current.repositories.bgmTracks.create({
    schemaVersion: 'bgm-track.v1',
    uid: uid(120122),
    dramaUid: current.dramaUid,
    title: 'Synthetic final score',
    sourceKind: 'local-import',
    providerId: 'local-library',
    assetVersionUid: versionUid,
    license: {
      schemaVersion: 'bgm-license.v1',
      uid: uid(120123),
      basis: 'licensed',
      attestationKind: 'user-attestation',
      commercialUseAllowed: true,
      derivativesAllowed: true,
      attributionRequired: false,
      attributionText: null,
      attestedAtEpochMs: 100,
    },
    createdAtEpochMs: 101,
  });
}

async function finalizationFixture(t, options = {}) {
  const current = createMvpBenchmarkSessionFixture(t, {
    includeExportFinal: options.includeExportFinal ?? true,
  });
  const prepared = await prepareBatch(current);
  completeSourceNodes(current);
  const media = options.realMedia === true ? await createRealFinalizationMedia(t, current) : null;
  const h3 = addH3Results(current, media);
  const audio = addAudioResult(current, media);
  const bgm = addBgm(current, media);
  let uidNumber = 120200;
  const probeRequests = [];
  const starts = [];
  const repositories = Object.freeze({
    ...current.repositories,
    generationHistory: Object.freeze({
      get(historyUid) { return h3.histories.get(historyUid); },
    }),
  });
  const service = createMvpBenchmarkFinalizationService({
    repositories,
    h3LocalExecution: Object.freeze({
      get(taskUid) { return h3.results.get(taskUid) ?? null; },
    }),
    audioTtsExecution: Object.freeze({
      get() { return Promise.resolve(audio); },
      getPersisted() { return audio; },
    }),
    mediaProbe: media?.mediaProbe ?? Object.freeze({
      inspect(request) {
        probeRequests.push(request);
        const result = trustedProbe({
          ...probeInput(request.assetVersion, uidNumber++, {
            includeAudio: request.assetVersion.mimeType === 'video/mp4',
          }),
          uid: request.uid,
          probedAtEpochMs: request.probedAtEpochMs,
        });
        options.onProbe?.({ bgm, current, count: probeRequests.length, request });
        return Promise.resolve(result);
      },
    }),
    mediaExportService: media?.mediaExportService ?? Object.freeze({
      start(request, dramaUid) {
        starts.push({ request, dramaUid });
        return Promise.resolve(options.exportResult ?? Object.freeze({
          schemaVersion: 'media-export-run.v1',
          uid: uid(120300),
          dramaUid,
          sourceNodeRunUid: request.nodeRunUid,
          status: options.exportStatus ?? 'succeeded',
        }));
      },
    }),
    createUid: () => uid(uidNumber++),
    nowEpochMs: () => FINAL_TIME,
  });
  const request = Object.freeze({
    schemaVersion: 'mvp-benchmark-finalization-request.v1',
    authorizationUid: prepared.authorization.uid,
    sessionUid: prepared.session.uid,
    dramaUid: current.dramaUid,
    expectedBatchSha256: prepared.batch.batchSha256,
    bgmTrackUid: bgm.uid,
  });
  return Object.freeze({
    audio, bgm, current, h3, prepared, probeRequests, repositories,
    media, request, service, starts, ...options,
  });
}

test('a complete benchmark session compiles its frozen graph and starts one final export', async (t) => {
  const fixture = await finalizationFixture(t);
  const result = await fixture.service.finalize(fixture.request);
  assert.equal(result.status, 'succeeded');
  assert.equal(fixture.probeRequests.length, 6);
  assert.equal(fixture.starts.length, 1);
  assert.equal(fixture.starts[0].request.nodeRunUid, fixture.current.exportNodeRun.uid);
  assert.equal(fixture.starts[0].dramaUid, fixture.current.dramaUid);

  const aggregate = fixture.repositories.runs.getWorkflowWithNodes(fixture.current.run.run.uid);
  assert.equal(aggregate.run.status, 'succeeded');
  const exportRun = aggregate.nodes.find((node) => node.uid === fixture.current.exportNodeRun.uid);
  assert.equal(exportRun.status, 'succeeded');
  assert.equal(exportRun.output.schemaVersion, 'media-export-node-output.v1');
  assert.equal(exportRun.output.executionPlan.workflowRunUid, fixture.current.run.run.uid);
  assert.equal(exportRun.output.executionPlan.audioMixPlan.bgm.trackUid, fixture.bgm.uid);
  assert.deepEqual(
    exportRun.output.executionPlan.videoSources.map((shot) => shot.startMs),
    [0, 1625, 3250, 4875],
  );
  assert.equal(exportRun.output.executionPlan.audioSources
    .find((source) => source.role === 'dialogue').placements[0].startMs, 1625);

  const repeated = await fixture.service.finalize(fixture.request);
  assert.equal(repeated.status, 'succeeded');
  assert.equal(fixture.probeRequests.length, 6);
  assert.equal(fixture.starts.length, 2);

  let inheritedReads = 0;
  Object.defineProperty(Object.prototype, 'authorizationUid', {
    configurable: true,
    get() { inheritedReads += 1; return fixture.request.authorizationUid; },
  });
  try {
    const { authorizationUid: _missing, ...withoutAuthorization } = fixture.request;
    assert.throws(() => fixture.service.finalize({
      ...withoutAuthorization,
      extra: true,
    }), { code: 'MVP_BENCHMARK_FINALIZATION_INPUT_INVALID' });
    assert.equal(inheritedReads, 0);
  } finally {
    delete Object.prototype.authorizationUid;
  }
});

test('the finalizer plan produces one real verified local 1080p MP4', async (t) => {
  const fixture = await finalizationFixture(t, { realMedia: true });
  const result = await fixture.service.finalize(fixture.request);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.dramaUid, fixture.current.dramaUid);
  assert.equal(result.sourceNodeRunUid, fixture.current.exportNodeRun.uid);
  assert.equal(result.output.width, 1920);
  assert.equal(result.output.height, 1080);
  assert.equal(result.output.frameRate, '24/1');
  assert.equal(result.output.durationMs, 6_500);
  const version = fixture.repositories.assets.getVersion(result.outputAssetVersionUid);
  const outputPath = path.join(fixture.media.root, ...version.relativePath.split('/'));
  assert.equal(fs.existsSync(outputPath), true);
  assert.equal(fileSha256(outputPath), result.output.sha256);
  assert.equal(version.sha256, result.output.sha256);
  assert.equal(version.mimeType, 'video/mp4');
});

test('finalization rejects an incomplete H3 result without probing media or mutating export state', async (t) => {
  const fixture = await finalizationFixture(t);
  const taskUid = fixture.prepared.session.h3Tasks[0].taskUid;
  fixture.h3.results.delete(taskUid);
  await assert.rejects(fixture.service.finalize(fixture.request), {
    code: 'MVP_BENCHMARK_FINALIZATION_UNAVAILABLE',
  });
  assert.equal(fixture.probeRequests.length, 0);
  assert.equal(fixture.starts.length, 0);
  assert.equal(fixture.repositories.runs.getNode(fixture.current.exportNodeRun.uid).status, 'queued');
  assert.equal(fixture.repositories.runs.getWorkflow(fixture.current.run.run.uid).status, 'running');
});

test('finalization rejects a frozen workflow without its declared export.final node', async (t) => {
  const fixture = await finalizationFixture(t, { includeExportFinal: false });
  await assert.rejects(fixture.service.finalize(fixture.request), {
    code: 'MVP_BENCHMARK_FINALIZATION_UNAVAILABLE',
  });
  assert.equal(fixture.probeRequests.length, 0);
  assert.equal(fixture.starts.length, 0);
  assert.equal(fixture.repositories.runs.getWorkflow(fixture.current.run.run.uid).status, 'running');
});

test('a BGM current-version drift after media probing rolls back finalization before export', async (t) => {
  let drifted = false;
  const fixture = await finalizationFixture(t, {
    onProbe({ bgm, current, count }) {
      if (count !== 6 || drifted) return;
      drifted = true;
      const replacementUid = uid(120130);
      current.repositories.assets.addVersion({
        uid: replacementUid,
        assetUid: bgm.assetVersion.assetUid,
        storageProvider: 'local',
        logicalUri: `asset://dramas/${current.dramaUid}/bgm/${bgm.assetVersion.assetUid}/${replacementUid}`,
        relativePath: `projects/${current.dramaUid}/assets/bgm/${bgm.assetVersion.assetUid}/${replacementUid}.wav`,
        sha256: 'd'.repeat(64),
        mimeType: 'audio/wav',
        width: null,
        height: null,
        durationMs: 6_500,
        parentUid: bgm.assetVersion.uid,
        status: 'ready',
      }, { makeCurrent: true });
    },
  });
  await assert.rejects(fixture.service.finalize(fixture.request), {
    code: 'MVP_BENCHMARK_FINALIZATION_UNAVAILABLE',
  });
  assert.equal(drifted, true);
  assert.equal(fixture.probeRequests.length, 6);
  assert.equal(fixture.starts.length, 0);
  assert.equal(fixture.repositories.runs.getNode(fixture.current.exportNodeRun.uid).status, 'queued');
  assert.equal(fixture.repositories.runs.getWorkflow(fixture.current.run.run.uid).status, 'running');
});

test('a failed local export is reported as finalization failure while retaining its sealed plan', async (t) => {
  const fixture = await finalizationFixture(t, { exportStatus: 'failed' });
  await assert.rejects(fixture.service.finalize(fixture.request), {
    code: 'MVP_BENCHMARK_FINALIZATION_FAILED',
  });
  assert.equal(fixture.starts.length, 1);
  assert.equal(fixture.repositories.runs.getWorkflow(fixture.current.run.run.uid).status, 'succeeded');
  const exportNode = fixture.repositories.runs.getNode(fixture.current.exportNodeRun.uid);
  assert.equal(exportNode.status, 'succeeded');
  assert.equal(exportNode.output.schemaVersion, 'media-export-node-output.v1');
});

test('production benchmark runtime exposes finalization only with local media export wiring', (t) => {
  const database = createMigratedV2Database(t);
  const noExternal = Object.freeze({
    inspect() { throw new Error('must not inspect'); },
  });
  const h3LocalExecution = Object.freeze({
    execute() { throw new Error('must not execute'); },
    get() { return null; },
  });
  const audioTtsExecution = Object.freeze({
    execute() { throw new Error('must not execute'); },
    get() { return Promise.resolve(null); },
    getPersisted() { return null; },
  });
  const shared = Object.freeze({
    database,
    sessionService: Object.freeze({ openSession() { throw new Error('must not open'); } }),
    h3LocalExecution,
    audioTtsExecution,
    dependencies: Object.freeze({
      liveEnvironmentVerifier: noExternal,
      costEstimator: Object.freeze({
        estimateH3() { throw new Error('must not estimate'); },
        estimateTts() { throw new Error('must not estimate'); },
      }),
      nowEpochMs: () => FINAL_TIME,
    }),
  });
  assert.equal(createProductionMvpBenchmarkRuntime(shared).finalization, null);
  const production = createProductionMvpBenchmarkRuntime({
    ...shared,
    localRoot: 'synthetic-local-root',
    mediaExportService: Object.freeze({
      start() { throw new Error('must not export'); },
    }),
    dependencies: Object.freeze({
      ...shared.dependencies,
      mediaProbe: noExternal,
    }),
  });
  assert.equal(typeof production.finalization.finalize, 'function');
});

test('the localhost finalization route binds path identity and rejects extra request fields', async (t) => {
  const calls = [];
  const result = Object.freeze({ schemaVersion: 'synthetic-finalization-result.v1' });
  const database = createMigratedV2Database(t);
  const app = express();
  app.use(express.json());
  app.use('/v2', mvpBenchmarkRoutes(Object.freeze({ error() {} }), Object.freeze({
    mvpBenchmark: Object.freeze({
      finalization: Object.freeze({
        finalize(request) {
          calls.push(request);
          return Promise.resolve(result);
        },
      }),
    }),
  }), database));
  const { server, base } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const path = `/v2/dramas/${uid(120400)}/mvp-benchmark/sessions/${uid(120401)}`
    + `/authorizations/${uid(120402)}/finalize`;
  const body = {
    schemaVersion: 'mvp-benchmark-finalization-request.v1',
    expectedBatchSha256: 'c'.repeat(64),
    bgmTrackUid: uid(120403),
  };
  const validateRequest = new Ajv2020({ strict: true }).compile(finalizationRequestSchema);
  assert.equal(validateRequest(body), true);
  assert.equal(validateRequest({ ...body, extra: true }), false);
  const invalid = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, extra: true }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 0);

  const valid = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(valid.status, 200);
  assert.deepEqual((await valid.json()).data, result);
  assert.deepEqual(calls, [{
    schemaVersion: body.schemaVersion,
    authorizationUid: uid(120402),
    sessionUid: uid(120401),
    dramaUid: uid(120400),
    expectedBatchSha256: body.expectedBatchSha256,
    bgmTrackUid: body.bgmTrackUid,
  }]);
});
