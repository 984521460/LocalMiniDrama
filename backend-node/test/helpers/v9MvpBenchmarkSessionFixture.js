'use strict';

const assert = require('node:assert/strict');

const { createNarrativeReviewService } = require('../../src/narrative/reviews');
const { createV2Repositories } = require('../../src/repositories/v2');
const { createWorkflowRunService, createWorkflowService } = require('../../src/workflows');
const { provisionH3TextToVideoManifest } = require('../../src/h3/provisioning');
const {
  compileH3GenerationWorkflow,
  compileH3ShotPrompt,
  normalizeH3GenerationSpec,
} = require('../../src/h3');
const { createH3ExecutionBinding } = require('../../src/h3/executionBinding');
const { remoteConnectionEvidenceSha256 } = require('../../src/remote/connectionProfile');
const {
  createMvpBenchmarkOperatorAttestation,
} = require('../../src/benchmark/mvpBenchmarkOperatorAttestation');
const {
  createRemoteTaskRequest,
  hashRemoteTaskPrompt,
  hashRemoteTaskRequest,
} = require('../../src/remote/remoteTask');
const { createPromptSemanticFixture, seedContinuityFixture } = require('./v5ContinuityFixtures');
const { uid } = require('./v2RepositoryDatabase');

const CREDENTIAL_REF = `credential:v1:${uid(99101)}`;

function mvpBenchmarkOperatorAttestationSeedFixture(overrides = {}) {
  return {
    schemaVersion: 'mvp-benchmark-operator-attestation-seed.v1',
    territoryEligibilityConfirmed: true,
    commercialEligibilityBasis: 'annual-revenue-not-over-usd-20000000',
    commercialUiAttributionAccepted: true,
    acceptableUseAndSafeguardsAccepted: true,
    downstreamUseRestrictionsAccepted: true,
    publicAiContentDisclosureAccepted: true,
    benchmarkInputRightsConfirmed: true,
    ...overrides,
  };
}

function mvpBenchmarkOperatorAttestationFixture(overrides = {}) {
  return createMvpBenchmarkOperatorAttestation(
    mvpBenchmarkOperatorAttestationSeedFixture(overrides),
  );
}

function mvpBenchmarkExternalAuthorizationRequestFixture(
  current,
  session,
  overrides = {},
) {
  return {
    schemaVersion: 'mvp-benchmark-external-authorization-request.v2',
    uid: uid(99500),
    sessionUid: session.uid,
    dramaUid: session.dramaUid,
    sessionPlanSha256: session.planSha256,
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    maximumCostCnyFen: 1_000,
    validityDurationMs: 60 * 60 * 1000,
    operatorAttestation: mvpBenchmarkOperatorAttestationFixture(),
    ...overrides,
  };
}

function uidSequence(start) {
  let current = start;
  return () => {
    const value = uid(current);
    current += 1;
    return value;
  };
}

function createMvpBenchmarkSessionFixture(t, options = {}) {
  const fixture = seedContinuityFixture(t);
  const promptFixture = createPromptSemanticFixture(fixture, 99200);
  const repositories = createV2Repositories(fixture.database);
  const manifest = provisionH3TextToVideoManifest(fixture.database).manifest;

  const voice = repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'voice',
    uid: uid(99250),
    characterUid: fixture.characterUid,
    identityVersionUid: fixture.character.identity.uid,
    parentUid: null,
    metadata: {
      name: 'MVP benchmark voice',
      language: 'zh-CN',
      style: 'stable synthetic benchmark delivery',
    },
    createdAtEpochMs: 10,
  });
  const profile = repositories.voiceProfiles.create({
    schemaVersion: '8.0',
    uid: uid(99251),
    dramaUid: fixture.dramaUid,
    characterUid: fixture.characterUid,
    characterVoiceVersionUid: voice.uid,
    parentUid: null,
    revision: 1,
    provider: 'openai-compatible',
    model: 'gpt-4o-mini-tts',
    voiceKey: 'alloy',
    credentialRef: CREDENTIAL_REF,
    sourceKind: 'provider-preset',
    status: 'ready',
    defaultEmotion: 'neutral',
    emotionMap: {
      neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
      fearful: 'fearful', surprised: 'surprised',
    },
    minimumSpeedPermille: 500,
    defaultSpeedPermille: 1000,
    maximumSpeedPermille: 2000,
    createdAtEpochMs: 11,
  });
  repositories.voiceProfiles.activate({
    schemaVersion: '8.0',
    uid: uid(99252),
    dramaUid: fixture.dramaUid,
    characterUid: fixture.characterUid,
    voiceProfileUid: profile.uid,
    previousVoiceProfileUid: null,
    stateVersion: 1,
    changedAtEpochMs: 12,
  });

  const connection = repositories.remote.createConnection({
    uid: uid(99300),
    name: 'Synthetic MVP benchmark worker',
    host: 'worker.example.invalid',
    port: 22,
    username: 'worker',
    hostFingerprint: `SHA256:${'B'.repeat(43)}`,
    credentialRef: CREDENTIAL_REF,
    status: 'ready',
    authMethod: 'password',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
  });
  const connectionEvidenceSha256 = remoteConnectionEvidenceSha256(connection);
  const semanticShots = promptFixture.semantic.output.semanticShots;
  assert.ok(semanticShots.length >= 4);
  const videoRecords = [];
  const nodes = [];
  for (let index = 0; index < 4; index += 1) {
    const assetUid = uid(99310 + index);
    repositories.assets.create({
      uid: assetUid,
      ownerType: 'drama',
      ownerUid: fixture.dramaUid,
      assetType: 'video',
      status: 'ready',
    });
    const parentVersionUid = uid(99360 + index);
    repositories.assets.addVersion({
      uid: parentVersionUid,
      assetUid,
      storageProvider: 'local',
      logicalUri: `asset://dramas/${fixture.dramaUid}/benchmark/video/${assetUid}/${parentVersionUid}`,
      relativePath: `projects/${fixture.dramaUid}/assets/video/${assetUid}/${parentVersionUid}.mp4`,
      sha256: String(index + 1).repeat(64),
      mimeType: 'video/mp4',
      width: 608,
      height: 352,
      durationMs: 1625,
      parentUid: null,
      status: 'ready',
    }, { makeCurrent: true });
    const generationSpec = normalizeH3GenerationSpec({
      mode: 't2v',
      prompt: compileH3ShotPrompt({
        dramaUid: fixture.dramaUid,
        semanticShot: semanticShots[index],
      }),
      width: 608,
      height: 352,
      durationSeconds: 1,
      seed: 100 + index,
      referenceImages: [],
    });
    const nodeUid = uid(99320 + index);
    nodes.push({
      uid: nodeUid,
      nodeType: 'shot.video',
      position: { x: index * 200, y: 0 },
      config: {
        connectionEvidenceSha256,
        connectionUid: connection.uid,
        credentialRef: CREDENTIAL_REF,
        durationMs: 1625,
        fps: 24,
        height: generationSpec.height,
        manifestUid: manifest.uid,
        profileUid: generationSpec.profileUid,
        seed: generationSpec.seed,
        width: generationSpec.width,
      },
      domainRef: { type: 'asset', uid: assetUid },
      status: 'ready',
    });
    videoRecords.push({ assetUid, generationSpec, nodeUid, parentVersionUid });
  }
  const audioNodeUid = uid(99330);
  nodes.push({
    uid: audioNodeUid,
    nodeType: 'audio.tts',
    position: { x: 0, y: 300 },
    config: { credentialRef: CREDENTIAL_REF, profileUid: profile.uid, speed: 1 },
    domainRef: { type: 'narrative_result', uid: fixture.shot.resultUid },
    status: 'ready',
  });
  const includeExportFinal = options.includeExportFinal === true;
  const exportNodeUid = includeExportFinal ? uid(99331) : null;
  if (includeExportFinal) {
    nodes.push({
      uid: exportNodeUid,
      nodeType: 'export.final',
      position: { x: 800, y: 300 },
      config: { format: 'mp4', fps: 30, height: 1080, width: 1920 },
      domainRef: null,
      status: 'ready',
    });
  }

  const edges = [];
  if (includeExportFinal) {
    for (let index = 0; index < videoRecords.length; index += 1) {
      edges.push({
        uid: uid(99370 + index),
        sourceNodeUid: videoRecords[index].nodeUid,
        sourcePort: 'video',
        targetNodeUid: exportNodeUid,
        targetPort: 'videos',
      });
    }
    edges.push({
      uid: uid(99374),
      sourceNodeUid: audioNodeUid,
      sourcePort: 'audio',
      targetNodeUid: exportNodeUid,
      targetPort: 'audio',
    });
  }

  const workflowService = createWorkflowService({ repositories, createUid: () => uid(99340) });
  const workflow = workflowService.createWorkflow({ dramaId: 1, name: 'MVP benchmark session' });
  workflowService.replaceGraph(workflow.definition.uid, {
    expectedRevision: 0,
    nodes,
    edges,
  });
  const run = createWorkflowRunService({
    repositories,
    createUid: uidSequence(99350),
  }).createRun({ workflowUid: workflow.definition.uid, triggerType: 'manual' });
  const nodeRunByNodeUid = new Map();
  for (let index = 0; index < run.nodes.length; index += 1) {
    nodeRunByNodeUid.set(run.nodes[index].nodeUid, run.nodes[index]);
  }

  const h3TaskUids = [];
  const h3Intents = [];
  for (let index = 0; index < videoRecords.length; index += 1) {
    const current = videoRecords[index];
    const nodeRun = nodeRunByNodeUid.get(current.nodeUid);
    assert.ok(nodeRun);
    const filenamePrefix = `video/mvp-benchmark-${index + 1}`;
    const compiled = compileH3GenerationWorkflow({
      generationSpec: current.generationSpec,
      filenamePrefix,
    });
    const taskUid = uid(99400 + index);
    const remoteRequest = createRemoteTaskRequest({
      connectionUid: connection.uid,
      connectionEvidenceSha256,
      workflowRunUid: run.run.uid,
      workflowManifestUid: manifest.uid,
      idempotencyKey: `remote-task:v1:${nodeRun.uid}`,
      promptSha256: hashRemoteTaskPrompt(compiled.prompt),
      remoteRelativeDir: `jobs/${taskUid}`,
    });
    const task = repositories.remote.createFormalTaskIdempotent({
      uid: taskUid,
      ...remoteRequest,
      requestSha256: hashRemoteTaskRequest(remoteRequest),
    }).task;
    const binding = createH3ExecutionBinding({
      generationSpec: current.generationSpec,
      filenamePrefix,
      task,
      graphSnapshot: run.run.graphSnapshot,
      nodeUid: current.nodeUid,
      connection,
      asset: repositories.assets.get(current.assetUid),
      manifestUid: manifest.uid,
    });
    const intent = repositories.h3GenerationIntents.prepare({
      uid: uid(99410 + index),
      taskUid,
      generationRunUid: uid(99420 + index),
      historyUid: uid(99430 + index),
      assetUid: current.assetUid,
      promptSemantic: {
        uid: uid(99440 + index),
        semantic: promptFixture.semantic,
        createdAtEpochMs: 20 + index,
      },
      generationSpec: current.generationSpec,
      manifestUid: manifest.uid,
      parentVersionUid: current.parentVersionUid,
      ...binding,
      createdAtEpochMs: 30 + index,
    });
    h3TaskUids.push(taskUid);
    h3Intents.push(intent);
  }

  const reviews = createNarrativeReviewService({ repositories });
  const shotDetail = reviews.getResult(fixture.shot.resultUid);
  const scriptResultUid = shotDetail.result.upstreamResultUid;
  const script = reviews.requireApproved(scriptResultUid, 'script').result;
  const plannedShot = fixture.shot.result.output.shots.find((candidate) => (
    candidate.dialogueEntryRefs.length > 0
  ));
  const dialogueEntryId = plannedShot.dialogueEntryRefs[0];
  const continuity = promptFixture.snapshots.find((candidate) => (
    candidate.shotId === plannedShot.shotId
  ));
  const audioNodeRun = nodeRunByNodeUid.get(audioNodeUid);
  assert.ok(audioNodeRun);
  assert.ok(script);
  const audioRequest = {
    schemaVersion: 'audio-mode-intent-request.v1',
    uid: uid(99460),
    dramaUid: fixture.dramaUid,
    workflowRunUid: run.run.uid,
    nodeRunUid: audioNodeRun.uid,
    shotResultUid: fixture.shot.resultUid,
    scriptResultUid,
    deliveries: [{
      uid: uid(99461),
      continuitySnapshotUid: continuity.snapshotUid,
      shotId: plannedShot.shotId,
      dialogueEntryId,
      voiceProfileUid: profile.uid,
      emotion: 'fearful',
      emotionIntensityPermille: 700,
      speedPermille: 1000,
      pauseBeforeMs: 0,
      pauseAfterMs: 120,
    }],
    createdAtEpochMs: 40,
  };
  const audioIntent = repositories.audioModeIntents.prepare(audioRequest);
  const request = {
    schemaVersion: 'mvp-benchmark-session-request.v1',
    uid: uid(99470),
    dramaUid: fixture.dramaUid,
    workflowRunUid: run.run.uid,
    h3TaskUids,
    audioIntentUids: [audioIntent.uid],
    createdAtEpochMs: 50,
  };
  return {
    ...fixture,
    audioIntent,
    connection,
    exportNodeRun: exportNodeUid === null ? null : nodeRunByNodeUid.get(exportNodeUid),
    exportNodeUid,
    h3Intents,
    profile,
    repositories,
    request,
    run,
  };
}

module.exports = Object.freeze({
  createMvpBenchmarkSessionFixture,
  mvpBenchmarkExternalAuthorizationRequestFixture,
  mvpBenchmarkOperatorAttestationFixture,
  mvpBenchmarkOperatorAttestationSeedFixture,
});
