'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');

const {
  H3ContractError,
  compileH3ShotPrompt,
  compileH3GenerationWorkflow,
  createH3ExecutionIntent,
  createH3ExecutionIntentService,
  createH3GenerationHistoryService,
  normalizeH3GenerationSpec,
} = require('../src/h3');
const { createPromptSemanticVersionRecord } = require('../src/assets/generationHistory');
const { createH3ExecutionBinding } = require('../src/h3/executionBinding');
const { createNarrativeReviewService } = require('../src/narrative/reviews');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const {
  createRemoteTaskRequest,
  hashRemoteTaskPrompt,
  hashRemoteTaskRequest,
} = require('../src/remote/remoteTask');
const { createWorkflowRunService, createWorkflowService } = require('../src/workflows');
const { provisionH3TextToVideoManifest } = require('../src/h3/provisioning');
const h3Routes = require('../src/routes/v2/h3');
const {
  createPromptSemanticFixture,
  seedContinuityFixture,
} = require('./helpers/v5ContinuityFixtures');
const { uid } = require('./helpers/v2RepositoryDatabase');

function outputMeasurement(overrides = {}) {
  return {
    sha256: '7'.repeat(64),
    bytes: 234567,
    mimeType: 'video/mp4',
    width: 608,
    height: 352,
    durationMs: 1625,
    frames: 39,
    fps: 24,
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioStreams: 1,
    blackFrameRatio: 0.01,
    frozenFrameRatio: 0.02,
    ...overrides,
  };
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function setup(t, offset = 27000) {
  const fixture = seedContinuityFixture(t);
  const promptFixture = createPromptSemanticFixture(fixture, offset + 100);
  const semanticShot = promptFixture.semantic.output.semanticShots[0];
  const prompt = compileH3ShotPrompt({
    dramaUid: fixture.dramaUid,
    semanticShot,
  });
  const generationSpec = normalizeH3GenerationSpec({
    mode: 't2v', prompt, width: 608, height: 352,
    durationSeconds: 1, seed: 42, referenceImages: [],
  });
  const manifest = provisionH3TextToVideoManifest(fixture.database).manifest;
  const assetUid = uid(offset + 1);
  const parentVersionUid = uid(offset + 2);
  const outputVersionUid = uid(offset + 3);
  fixture.repositories.assets.create({
    uid: assetUid,
    ownerType: 'drama',
    ownerUid: fixture.dramaUid,
    assetType: 'video',
    status: 'draft',
  });
  fixture.repositories.assets.addVersion({
    uid: parentVersionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${fixture.dramaUid}/shots/selected.mp4`,
    relativePath: `projects/${fixture.dramaUid}/assets/selected.mp4`,
    sha256: '6'.repeat(64),
    mimeType: 'video/mp4',
    width: 608,
    height: 352,
    durationMs: 1625,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  fixture.repositories.assets.addVersion({
    uid: outputVersionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${fixture.dramaUid}/generated/${outputVersionUid}`,
    relativePath: `projects/${fixture.dramaUid}/assets/${outputVersionUid}.mp4`,
    sha256: '7'.repeat(64),
    mimeType: 'video/mp4',
    width: 608,
    height: 352,
    durationMs: 1625,
    parentUid: parentVersionUid,
    status: 'ready',
  });
  const promptSemantic = {
    uid: uid(offset + 4),
    semantic: promptFixture.semantic,
    createdAtEpochMs: 0,
  };
  const input = {
    runUid: uid(offset + 5),
    historyUid: uid(offset + 6),
    remotePromptId: uid(offset + 7),
    promptSemantic,
    generationSpec,
    manifestUid: manifest.uid,
    assetUid,
    outputVersionUid,
    measured: outputMeasurement(),
  };
  return {
    ...fixture,
    assetUid,
    generationSpec,
    input,
    manifest,
    outputVersionUid,
    parentVersionUid,
    promptFixture,
    service: createH3GenerationHistoryService({ repositories: fixture.repositories }),
  };
}

function prepareFormalTask(fixture, offset = 30100, manifest = fixture.manifest) {
  const connectionUid = uid(offset + 1);
  const credentialRef = `credential:v1:${uid(offset + 2)}`;
  const connection = fixture.repositories.remote.createConnection({
    uid: connectionUid,
    name: 'Synthetic H3 history connection',
    host: 'worker.example.invalid',
    port: 22,
    username: 'worker',
    hostFingerprint: `SHA256:${'A'.repeat(43)}`,
    credentialRef,
    status: 'ready',
    authMethod: 'password',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
  });
  const connectionEvidenceSha256 = remoteConnectionEvidenceSha256(connection);
  const workflowService = createWorkflowService({ repositories: fixture.repositories });
  const workflow = workflowService.createWorkflow({
    dramaId: 1,
    name: `H3 history intent ${offset}`,
  });
  const nodeUid = uid(offset + 3);
  workflowService.replaceGraph(workflow.definition.uid, {
    expectedRevision: 0,
    nodes: [{
      uid: nodeUid,
      nodeType: 'shot.video',
      position: { x: 0, y: 0 },
      config: {
        connectionEvidenceSha256,
        connectionUid,
        credentialRef,
        durationMs: 1625,
        fps: 24,
        height: fixture.generationSpec.height,
        manifestUid: manifest.uid,
        profileUid: fixture.generationSpec.profileUid,
        seed: fixture.generationSpec.seed,
        width: fixture.generationSpec.width,
      },
      domainRef: { type: 'asset', uid: fixture.assetUid },
      status: 'ready',
    }],
    edges: [],
  });
  const run = createWorkflowRunService({ repositories: fixture.repositories }).createRun({
    workflowUid: workflow.definition.uid,
    triggerType: 'manual',
  });
  const compiled = compileH3GenerationWorkflow({
    generationSpec: fixture.generationSpec,
    filenamePrefix: 'video/history-intent',
  });
  const taskUid = uid(offset + 4);
  const request = createRemoteTaskRequest({
    connectionUid,
    connectionEvidenceSha256,
    workflowRunUid: run.run.uid,
    workflowManifestUid: manifest.uid,
    idempotencyKey: `remote-task:v1:${run.nodes[0].uid}`,
    promptSha256: hashRemoteTaskPrompt(compiled.prompt),
    remoteRelativeDir: `jobs/${taskUid}`,
  });
  return fixture.repositories.remote.createFormalTaskIdempotent({
    uid: taskUid,
    ...request,
    requestSha256: hashRemoteTaskRequest(request),
  }).task;
}

function executionBinding(fixture, task, {
  generationSpec = fixture.generationSpec,
  filenamePrefix = 'video/history-intent',
  manifestUid = task.workflowManifestUid,
} = {}) {
  const runService = createWorkflowRunService({ repositories: fixture.repositories });
  const aggregate = runService.getRun(task.workflowRunUid);
  const nodeRunUid = task.idempotencyKey.slice('remote-task:v1:'.length);
  const nodeRun = runService.getNode(nodeRunUid);
  return createH3ExecutionBinding({
    generationSpec,
    filenamePrefix,
    task,
    graphSnapshot: aggregate.run.graphSnapshot,
    nodeUid: nodeRun.nodeUid,
    connection: fixture.repositories.remote.getConnection(task.connectionUid),
    asset: fixture.repositories.assets.get(fixture.assetUid),
    manifestUid,
  });
}

function advanceTaskToVerifying(fixture, current, remotePromptId) {
  let task = fixture.repositories.remote.transitionFormalTask({
    uid: current.uid,
    expectedStateVersion: current.stateVersion,
    nextStage: 'submitted',
    nextStatus: 'running',
    recoveryState: 'none',
    submissionLeaseExpiresAtEpochMs: 1,
  });
  task = fixture.repositories.remote.assignFormalPrompt({
    uid: task.uid,
    expectedStateVersion: task.stateVersion,
    promptId: remotePromptId,
  });
  task = fixture.repositories.remote.transitionFormalTask({
    uid: task.uid,
    expectedStateVersion: task.stateVersion,
    nextStage: 'downloading',
    nextStatus: 'running',
    recoveryState: 'none',
  });
  return fixture.repositories.remote.transitionFormalTask({
    uid: task.uid,
    expectedStateVersion: task.stateVersion,
    nextStage: 'verifying',
    nextStatus: 'running',
    recoveryState: 'none',
  });
}

test('validated H3 output appends immutable history without replacing selected video', (t) => {
  const fixture = setup(t);
  const completed = fixture.service.record(fixture.input);
  assert.equal(completed.history.outputVersionUid, fixture.outputVersionUid);
  assert.equal(completed.history.input.remotePromptId, fixture.input.remotePromptId);
  assert.equal(completed.history.input.videoEvidence.sha256, fixture.input.measured.sha256);
  assert.equal(completed.selection.selectedVersionUid, fixture.parentVersionUid);
  assert.equal(completed.selection.stateVersion, 0);
  assert.equal(fixture.repositories.assets.get(fixture.assetUid).currentVersionUid, fixture.parentVersionUid);

  const reread = fixture.service.get(completed.history.uid);
  assert.equal(reread.videoEvidence.generationSpecSha256, completed.videoEvidence.generationSpecSha256);
  assert.equal(Object.isFrozen(reread), true);
});

test('invalid H3 output fails before generation history or selection changes', (t) => {
  const fixture = setup(t, 28000);
  assert.throws(
    () => fixture.service.record({
      ...fixture.input,
      measured: outputMeasurement({ audioStreams: 0, audioCodec: null }),
    }),
    (error) => error instanceof H3ContractError && error.code === 'H3_OUTPUT_INVALID',
  );
  assert.equal(fixture.repositories.generationHistory.listByAsset(fixture.assetUid).length, 0);
  assert.equal(fixture.repositories.generationHistory.getSelectionState(fixture.assetUid).selectedVersionUid, fixture.parentVersionUid);
  assert.throws(() => fixture.repositories.runs.getGeneration(fixture.input.runUid));
});

test('T2V reference audio is rejected before generation history writes', (t) => {
  const fixture = setup(t, 28500);
  const generationSpec = normalizeH3GenerationSpec({
    mode: 't2v',
    prompt: fixture.generationSpec.prompt,
    width: 608,
    height: 352,
    durationSeconds: 1,
    seed: 42,
    referenceImages: [],
    referenceAudio: {
      dramaUid: fixture.dramaUid,
      assetVersionUid: uid(28590),
      sha256: '5'.repeat(64),
      mimeType: 'audio/wav',
      durationMs: 1000,
    },
  });
  assert.throws(
    () => fixture.service.record({ ...fixture.input, generationSpec }),
    (error) => error instanceof H3ContractError && error.code === 'H3_WORKFLOW_UNVERIFIED',
  );
  assert.equal(fixture.repositories.generationHistory.listByAsset(fixture.assetUid).length, 0);
  assert.equal(
    fixture.repositories.generationHistory.getSelectionState(fixture.assetUid).selectedVersionUid,
    fixture.parentVersionUid,
  );
  assert.throws(() => fixture.repositories.runs.getGeneration(fixture.input.runUid));
});

test('H3 completion rejects mismatched asset evidence and unverified workflow modes', (t) => {
  const fixture = setup(t, 29000);
  assert.throws(
    () => fixture.service.record({
      ...fixture.input,
      measured: outputMeasurement({ sha256: '8'.repeat(64) }),
    }),
    (error) => error instanceof H3ContractError && error.code === 'H3_HISTORY_CONFLICT',
  );
  const firstImage = {
    ordinal: 1,
    role: 'first',
    dramaUid: fixture.dramaUid,
    assetVersionUid: uid(29990),
    sha256: '9'.repeat(64),
    mimeType: 'image/png',
    width: 608,
    height: 352,
  };
  const firstSpec = normalizeH3GenerationSpec({
    mode: 'fl2va-first',
    prompt: fixture.generationSpec.prompt,
    width: 608,
    height: 352,
    durationSeconds: 1,
    seed: 42,
    referenceImages: [firstImage],
  });
  assert.throws(
    () => fixture.service.record({ ...fixture.input, generationSpec: firstSpec }),
    (error) => error instanceof H3ContractError && error.code === 'H3_WORKFLOW_UNVERIFIED',
  );
});

test('H3 execution intent freezes the approved semantic, spec, task and output asset identities', (t) => {
  const fixture = setup(t, 30000);
  const filenamePrefix = 'video/history-intent';
  const taskPromptSha256 = hashRemoteTaskPrompt(compileH3GenerationWorkflow({
    generationSpec: fixture.generationSpec,
    filenamePrefix,
  }).prompt);
  const intent = createH3ExecutionIntent({
    uid: uid(30020),
    taskUid: uid(30021),
    generationRunUid: fixture.input.runUid,
    historyUid: fixture.input.historyUid,
    assetUid: fixture.assetUid,
    promptSemantic: fixture.input.promptSemantic,
    generationSpec: fixture.generationSpec,
    manifestUid: fixture.manifest.uid,
    parentVersionUid: fixture.parentVersionUid,
    filenamePrefix,
    taskPromptSha256,
    planEvidenceSha256: 'a'.repeat(64),
    createdAtEpochMs: 0,
  });

  assert.equal(intent.schemaVersion, 'h3-local-execution-intent.v1');
  assert.equal(intent.promptSemantic.uid, fixture.input.promptSemantic.uid);
  assert.equal(intent.generationSpec.prompt.semanticSha256, fixture.generationSpec.prompt.semanticSha256);
  assert.equal(Object.isFrozen(intent), true);
  assert.equal(Object.isFrozen(intent.generationSpec), true);

  assert.throws(
    () => createH3ExecutionIntent({
      ...intent,
      generationSpec: {
        ...fixture.generationSpec,
        prompt: { ...fixture.generationSpec.prompt, semanticSha256: '0'.repeat(64) },
      },
    }),
    (error) => error instanceof H3ContractError && error.code === 'H3_HISTORY_CONFLICT',
  );
});

test('H3 execution intent repository persists an approved prepared task binding', (t) => {
  const fixture = setup(t, 30200);
  const task = prepareFormalTask(fixture, 30300);
  const binding = executionBinding(fixture, task);
  const input = {
    uid: uid(30310),
    taskUid: task.uid,
    generationRunUid: fixture.input.runUid,
    historyUid: fixture.input.historyUid,
    assetUid: fixture.assetUid,
    promptSemantic: fixture.input.promptSemantic,
    generationSpec: fixture.generationSpec,
    manifestUid: fixture.manifest.uid,
    parentVersionUid: fixture.parentVersionUid,
    ...binding,
    createdAtEpochMs: 0,
  };
  const prepared = fixture.repositories.h3GenerationIntents.prepare(input);

  assert.equal(prepared.taskUid, task.uid);
  assert.equal(
    fixture.repositories.h3GenerationIntents.getByTask(task.uid).generationSpec.prompt.promptSha256,
    fixture.generationSpec.prompt.promptSha256,
  );
  let history;
  fixture.repositories.withTransaction((scoped) => {
    history = fixture.service.recordPrepared(scoped, {
      intent: prepared,
      remotePromptId: 'production-prompt-2',
      outputVersionUid: fixture.outputVersionUid,
      measured: fixture.input.measured,
    });
  });
  assert.equal(history.uid, fixture.input.historyUid);
  assert.equal(history.input.remotePromptId, 'production-prompt-2');
  assert.equal(
    fixture.service.get(history.uid).history.input.remotePromptId,
    'production-prompt-2',
  );
  assert.throws(
    () => fixture.repositories.h3GenerationIntents.prepare({
      ...input,
      uid: uid(30311),
    }),
    (error) => error?.code === 'V2_REPOSITORY_CONFLICT',
  );
  fixture.database.exec('DROP TRIGGER v2_workflow_runs_snapshot_immutable');
  fixture.database.prepare(`
    UPDATE workflow_runs
    SET graph_snapshot_json=json_set(graph_snapshot_json,'$.snapshot.nodes[0].config.seed',43)
    WHERE uid=?
  `).run(task.workflowRunUid);
  assert.throws(
    () => fixture.repositories.h3GenerationIntents.getByTask(task.uid),
    (error) => error?.code === 'V2_REPOSITORY_DATA_INVALID',
  );
});

test('H3 task completion rejects generation history that contradicts the frozen intent', (t) => {
  const fixture = setup(t, 30320);
  let task = prepareFormalTask(fixture, 30330);
  const binding = executionBinding(fixture, task);
  const intent = fixture.repositories.h3GenerationIntents.prepare({
    uid: uid(30340),
    taskUid: task.uid,
    generationRunUid: fixture.input.runUid,
    historyUid: fixture.input.historyUid,
    assetUid: fixture.assetUid,
    promptSemantic: fixture.input.promptSemantic,
    generationSpec: fixture.generationSpec,
    manifestUid: fixture.manifest.uid,
    parentVersionUid: fixture.parentVersionUid,
    ...binding,
    createdAtEpochMs: 0,
  });
  const mismatchedSpec = Object.freeze({
    ...fixture.generationSpec,
    seed: fixture.generationSpec.seed + 1,
  });
  const { schemaVersion: _schemaVersion, ...intentInput } = intent;
  const mismatchedIntent = createH3ExecutionIntent({
    ...intentInput,
    generationSpec: mismatchedSpec,
    taskPromptSha256: hashRemoteTaskPrompt(compileH3GenerationWorkflow({
      generationSpec: mismatchedSpec,
      filenamePrefix: intent.filenamePrefix,
    }).prompt),
  });
  const remotePromptId = 'synthetic-mismatched-history';
  fixture.repositories.withTransaction((scoped) => {
    fixture.service.recordPrepared(scoped, {
      intent: mismatchedIntent,
      remotePromptId,
      outputVersionUid: fixture.outputVersionUid,
      measured: fixture.input.measured,
    });
  });

  task = advanceTaskToVerifying(fixture, task, remotePromptId);

  assert.throws(() => fixture.repositories.remote.transitionFormalTask({
    uid: task.uid,
    expectedStateVersion: task.stateVersion,
    nextStage: 'completed',
    nextStatus: 'succeeded',
    recoveryState: 'completed',
    outputAssetVersionUid: fixture.outputVersionUid,
  }));
  assert.equal(fixture.repositories.remote.getFormalTask(task.uid).stage, 'verifying');
});

test('H3 task completion revalidates full live output and parent version evidence', (t) => {
  const fixture = setup(t, 30345);
  let task = prepareFormalTask(fixture, 30355);
  const binding = executionBinding(fixture, task);
  const intent = fixture.repositories.h3GenerationIntents.prepare({
    uid: uid(30365),
    taskUid: task.uid,
    generationRunUid: fixture.input.runUid,
    historyUid: fixture.input.historyUid,
    assetUid: fixture.assetUid,
    promptSemantic: fixture.input.promptSemantic,
    generationSpec: fixture.generationSpec,
    manifestUid: fixture.manifest.uid,
    parentVersionUid: fixture.parentVersionUid,
    ...binding,
    createdAtEpochMs: 0,
  });
  const remotePromptId = 'synthetic-parent-evidence-drift';
  fixture.repositories.withTransaction((scoped) => {
    fixture.service.recordPrepared(scoped, {
      intent,
      remotePromptId,
      outputVersionUid: fixture.outputVersionUid,
      measured: fixture.input.measured,
    });
  });
  fixture.database.exec('DROP TRIGGER v2_asset_generation_history_immutable_update');
  task = advanceTaskToVerifying(fixture, task, remotePromptId);
  const originalEvidence = fixture.database.prepare(`
    SELECT parent_version_evidence_json FROM asset_generation_history WHERE uid=?
  `).pluck().get(fixture.input.historyUid);
  const drifts = [
    ['$.sha256', '0'.repeat(64)],
    ['$.storageProvider', 'nas'],
    ['$.relativePath', 'projects/synthetic/relocated-parent.mp4'],
    ['$.createdAt', '2026-08-29T00:00:00.000Z'],
  ];
  for (const [path, value] of drifts) {
    fixture.database.prepare(`
      UPDATE asset_generation_history
      SET parent_version_evidence_json=json_set(?, ?, ?)
      WHERE uid=?
    `).run(originalEvidence, path, value, fixture.input.historyUid);
    assert.throws(
      () => fixture.service.get(fixture.input.historyUid),
      (error) => error instanceof H3ContractError && error.code === 'H3_HISTORY_CONFLICT',
    );
    assert.throws(() => fixture.repositories.remote.transitionFormalTask({
      uid: task.uid,
      expectedStateVersion: task.stateVersion,
      nextStage: 'completed',
      nextStatus: 'succeeded',
      recoveryState: 'completed',
      outputAssetVersionUid: fixture.outputVersionUid,
    }));
    assert.equal(fixture.repositories.remote.getFormalTask(task.uid).stage, 'verifying');
  }
});

test('H3 intent database rejects incomplete specifications and unverifiable digests before sealing', (t) => {
  const fixture = setup(t, 30350);
  const task = prepareFormalTask(fixture, 30370);
  const binding = executionBinding(fixture, task);
  const prompt = createPromptSemanticVersionRecord(fixture.input.promptSemantic);
  fixture.database.prepare(`
    INSERT INTO prompt_semantic_versions
      (uid, drama_uid, shot_result_uid, shot_result_hash, shot_envelope_hash,
       shot_approval_ref, semantic_sha256, semantic_json, created_at_epoch_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    prompt.uid,
    prompt.dramaUid,
    prompt.shotResultUid,
    prompt.shotResultHash,
    prompt.shotEnvelopeHash,
    prompt.shotApprovalRef,
    prompt.semanticSha256,
    JSON.stringify(prompt.semantic),
    prompt.createdAtEpochMs,
  );
  const incomplete = JSON.stringify({
    schemaVersion: 'h3-generation-spec.v1',
    mode: 't2v',
    referenceAudio: null,
    referenceImages: [],
    prompt: { dramaUid: fixture.dramaUid },
  });
  assert.throws(() => fixture.database.prepare(`
    INSERT INTO h3_generation_intents
      (uid, task_uid, generation_run_uid, history_uid, asset_uid, prompt_semantic_uid,
       manifest_uid, parent_version_uid, generation_spec_json, generation_spec_sha256,
       filename_prefix, task_prompt_sha256, plan_evidence_sha256, created_at_epoch_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    uid(30391), task.uid, uid(30392), uid(30393), fixture.assetUid, prompt.uid,
    fixture.manifest.uid, fixture.parentVersionUid, incomplete, 'f'.repeat(64),
    binding.filenamePrefix, binding.taskPromptSha256, binding.planEvidenceSha256,
  ));
  assert.equal(
    fixture.database.prepare('SELECT count(*) FROM h3_generation_intents WHERE task_uid=?')
      .pluck().get(task.uid),
    0,
  );
  assert.throws(() => fixture.database.prepare(`
    INSERT INTO h3_generation_intents
      (uid, task_uid, generation_run_uid, history_uid, asset_uid, prompt_semantic_uid,
       manifest_uid, parent_version_uid, generation_spec_json, generation_spec_sha256,
       filename_prefix, task_prompt_sha256, plan_evidence_sha256, created_at_epoch_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    uid(30394), task.uid, uid(30395), uid(30396), fixture.assetUid, prompt.uid,
    fixture.manifest.uid, fixture.parentVersionUid,
    JSON.stringify(fixture.generationSpec), 'f'.repeat(64),
    binding.filenamePrefix, binding.taskPromptSha256, binding.planEvidenceSha256,
  ));
  assert.equal(
    fixture.database.prepare('SELECT count(*) FROM h3_generation_intents WHERE task_uid=?')
      .pluck().get(task.uid),
    0,
  );
  const mismatchedPrompts = [
    {
      ...fixture.generationSpec.prompt,
      continuitySnapshotUid: uid(30397),
    },
    {
      ...fixture.generationSpec.prompt,
      shotId: 'different-shot',
    },
    {
      ...fixture.generationSpec.prompt,
      semanticSha256: '0'.repeat(64),
    },
  ];
  const insertIntent = fixture.database.prepare(`
    INSERT INTO h3_generation_intents
      (uid, task_uid, generation_run_uid, history_uid, asset_uid, prompt_semantic_uid,
       manifest_uid, parent_version_uid, generation_spec_json, generation_spec_sha256,
       filename_prefix, task_prompt_sha256, plan_evidence_sha256, created_at_epoch_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  mismatchedPrompts.forEach((mismatchedPrompt, index) => {
    const generationSpec = { ...fixture.generationSpec, prompt: mismatchedPrompt };
    const generationSpecJson = JSON.stringify(generationSpec);
    const digest = fixture.database.prepare('SELECT h3_generation_spec_sha256(?)').pluck()
      .get(generationSpecJson);
    assert.match(digest, /^[0-9a-f]{64}$/u);
    assert.throws(() => insertIntent.run(
      uid(30400 + (index * 3)), task.uid, uid(30401 + (index * 3)),
      uid(30402 + (index * 3)), fixture.assetUid, prompt.uid,
      fixture.manifest.uid, fixture.parentVersionUid, generationSpecJson, digest,
      binding.filenamePrefix, binding.taskPromptSha256, binding.planEvidenceSha256,
    ));
  });
  assert.equal(
    fixture.database.prepare('SELECT count(*) FROM h3_generation_intents WHERE task_uid=?')
      .pluck().get(task.uid),
    0,
  );

  const alternateManifestUid = uid(30600);
  fixture.database.prepare(`
    INSERT INTO workflow_manifests
      (uid, manifest_id, version, engine, workflow_file, workflow_sha256, model_family,
       requirements_json, inputs_json, outputs_json, validation_json, status,
       created_at, updated_at)
    SELECT ?, ?, version, engine, workflow_file, workflow_sha256, model_family,
           requirements_json, inputs_json, outputs_json, validation_json, status,
           created_at, updated_at
    FROM workflow_manifests WHERE uid=?
  `).run(alternateManifestUid, 'synthetic-h3-validated', fixture.manifest.uid);
  const alternateTask = prepareFormalTask(
    fixture,
    30610,
    { ...fixture.manifest, uid: alternateManifestUid, manifestId: 'synthetic-h3-validated' },
  );
  const officialSpecJson = JSON.stringify(fixture.generationSpec);
  const officialSpecDigest = fixture.database.prepare('SELECT h3_generation_spec_sha256(?)').pluck()
    .get(officialSpecJson);
  const alternateBinding = executionBinding(fixture, alternateTask, {
    manifestUid: alternateManifestUid,
  });
  assert.throws(() => insertIntent.run(
    uid(30620), alternateTask.uid, uid(30621), uid(30622), fixture.assetUid, prompt.uid,
    alternateManifestUid, fixture.parentVersionUid, officialSpecJson, officialSpecDigest,
    alternateBinding.filenamePrefix, alternateBinding.taskPromptSha256,
    alternateBinding.planEvidenceSha256,
  ));
  assert.equal(
    fixture.database.prepare('SELECT count(*) FROM h3_generation_intents WHERE task_uid=?')
      .pluck().get(alternateTask.uid),
    0,
  );

  const mismatchedPlanSpecs = [
    { ...fixture.generationSpec, seed: fixture.generationSpec.seed + 1 },
    normalizeH3GenerationSpec({
      mode: 't2v', prompt: fixture.generationSpec.prompt, width: 640, height: 384,
      durationSeconds: 1, seed: fixture.generationSpec.seed, referenceImages: [],
    }),
    normalizeH3GenerationSpec({
      mode: 't2v', prompt: fixture.generationSpec.prompt, width: 608, height: 352,
      durationSeconds: 2, seed: fixture.generationSpec.seed, referenceImages: [],
    }),
  ];
  mismatchedPlanSpecs.forEach((generationSpec, index) => {
    const generationSpecJson = JSON.stringify(generationSpec);
    const digest = fixture.database.prepare('SELECT h3_generation_spec_sha256(?)').pluck()
      .get(generationSpecJson);
    assert.throws(() => insertIntent.run(
      uid(30700 + (index * 3)), task.uid, uid(30701 + (index * 3)),
      uid(30702 + (index * 3)), fixture.assetUid, prompt.uid,
      fixture.manifest.uid, fixture.parentVersionUid, generationSpecJson, digest,
      binding.filenamePrefix, binding.taskPromptSha256, binding.planEvidenceSha256,
    ));
  });
  assert.throws(() => insertIntent.run(
    uid(30720), task.uid, uid(30721), uid(30722), fixture.assetUid, prompt.uid,
    fixture.manifest.uid, fixture.parentVersionUid, officialSpecJson, officialSpecDigest,
    binding.filenamePrefix, '0'.repeat(64), binding.planEvidenceSha256,
  ));
  assert.equal(
    fixture.database.prepare('SELECT count(*) FROM h3_generation_intents WHERE task_uid=?')
      .pluck().get(task.uid),
    0,
  );

  fixture.database.exec('DROP TRIGGER v2_prompt_semantic_versions_immutable_update');
  fixture.database.prepare(`
    UPDATE prompt_semantic_versions SET semantic_sha256=? WHERE uid=?
  `).run('0'.repeat(64), prompt.uid);
  const validSpecJson = JSON.stringify(fixture.generationSpec);
  const validSpecDigest = fixture.database.prepare('SELECT h3_generation_spec_sha256(?)').pluck()
    .get(validSpecJson);
  assert.throws(() => insertIntent.run(
    uid(30409), task.uid, uid(30410), uid(30411), fixture.assetUid, prompt.uid,
    fixture.manifest.uid, fixture.parentVersionUid, validSpecJson, validSpecDigest,
    binding.filenamePrefix, binding.taskPromptSha256, binding.planEvidenceSha256,
  ));
  assert.equal(
    fixture.database.prepare('SELECT count(*) FROM h3_generation_intents WHERE task_uid=?')
      .pluck().get(task.uid),
    0,
  );
  fixture.database.prepare(`
    UPDATE prompt_semantic_versions SET semantic_sha256=? WHERE uid=?
  `).run(prompt.semanticSha256, prompt.uid);
  createNarrativeReviewService({ repositories: fixture.repositories }).reviewResult({
    resultUid: prompt.shotResultUid,
    decision: 'reject',
    comment: 'synthetic current-approval boundary',
  });
  assert.throws(() => insertIntent.run(
    uid(30730), task.uid, uid(30731), uid(30732), fixture.assetUid, prompt.uid,
    fixture.manifest.uid, fixture.parentVersionUid, validSpecJson, validSpecDigest,
    binding.filenamePrefix, binding.taskPromptSha256, binding.planEvidenceSha256,
  ));
  assert.equal(
    fixture.database.prepare('SELECT count(*) FROM h3_generation_intents WHERE task_uid=?')
      .pluck().get(task.uid),
    0,
  );
});

test('H3 execution intent service rebuilds approved semantics before preparing an idempotent intent', (t) => {
  const fixture = setup(t, 30400);
  const task = prepareFormalTask(fixture, 30500);
  let generated = 30520;
  const service = createH3ExecutionIntentService({
    repositories: fixture.repositories,
    createUid: () => uid(generated++),
    nowEpochMs: () => 1234,
  });
  const request = {
    taskUid: task.uid,
    promptInput: fixture.promptFixture.promptInput,
    continuitySnapshotUids: fixture.promptFixture.snapshots.map((snapshot) => snapshot.snapshotUid),
    generationSpec: fixture.generationSpec,
    filenamePrefix: 'video/history-intent',
  };

  const prepared = service.prepare(request);
  const repeated = service.prepare(request);
  assert.equal(prepared.taskUid, task.uid);
  assert.equal(prepared.assetUid, fixture.assetUid);
  assert.equal(
    prepared.promptSemantic.shotResultHash,
    fixture.promptFixture.semantic.shotResultHash,
  );
  assert.deepEqual(repeated, prepared);
  assert.equal(
    fixture.repositories.h3GenerationIntents.getByTask(task.uid).historyUid,
    prepared.historyUid,
  );
});

test('H3 localhost preparation route returns only durable intent identities', async (t) => {
  const fixture = setup(t, 30600);
  const task = prepareFormalTask(fixture, 30700);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/v2', h3Routes({ error() {} }, fixture.database));
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const result = await fetch(`${base}/v2/h3/prepare-t2v-intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      taskUid: task.uid,
      promptInput: fixture.promptFixture.promptInput,
      continuitySnapshotUids: fixture.promptFixture.snapshots.map(
        (snapshot) => snapshot.snapshotUid,
      ),
      generationSpec: fixture.generationSpec,
      filenamePrefix: 'video/history-intent',
    }),
  });
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.taskUid, task.uid);
  assert.equal(body.data.assetUid, fixture.assetUid);
  assert.deepEqual(Object.keys(body.data).sort(), [
    'assetUid', 'createdAtEpochMs', 'generationRunUid', 'historyUid', 'manifestUid',
    'parentVersionUid', 'schemaVersion', 'taskUid', 'uid',
  ]);
  assert.doesNotMatch(JSON.stringify(body), /prompt|semantic|credential|password|authorization/i);
});
