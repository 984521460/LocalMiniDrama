'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const {
  publicAudioModeIntent,
  resolveAudioModeIntent,
} = require('../src/audio/audioModeIntent');
const { createNarrativeReviewService } = require('../src/narrative/reviews');
const { createV2Repositories, V2RepositoryDataError } = require('../src/repositories/v2');
const { createNarrativeApprovalGate } = require('../src/repositories/v2/narrativeApprovalGate');
const audioModeIntentRoutes = require('../src/routes/v2/audioModeIntents');
const { createWorkflowRunService, createWorkflowService } = require('../src/workflows');
const audioModePlanSchema = require('../../schemas/v8/audio-mode-plan.schema.json');
const dialogueDeliverySchema = require('../../schemas/v8/dialogue-delivery.schema.json');
const voiceProfileSchema = require('../../schemas/v8/voice-profile.schema.json');
const h3GenerationSpecSchema = require('../../schemas/v7/h3-generation-spec.schema.json');
const h3VideoEvidenceSchema = require('../../schemas/v7/h3-video-evidence.schema.json');
const audioModeIntentSchema = require('../../schemas/v9/audio-mode-intent.schema.json');
const {
  createPromptSemanticFixture,
  seedContinuityFixture,
} = require('./helpers/v5ContinuityFixtures');
const { createMigratedV2Database, uid } = require('./helpers/v2RepositoryDatabase');

const CREDENTIAL_REF = `credential:v1:${uid(97001)}`;

test('request parsing never executes inherited collection or text hooks', () => {
  const modulePath = path.join(__dirname, '..', 'src', 'audio', 'audioModeIntent.js');
  const script = String.raw`
    const modulePath = process.argv[1];
    const {
      audioModeNarrativeEmotion,
      parseAudioModeIntentRequest,
    } = require(modulePath);
    const define = Object.defineProperty;
    const getDescriptor = Object.getOwnPropertyDescriptor;
    const hooks = [
      [Array.prototype, 'map'],
      [Array.prototype, 'push'],
      [Array.prototype, 'find'],
      [Array.prototype, 'filter'],
      [Array.prototype, 'includes'],
      [Array.prototype, Symbol.iterator],
      [Map.prototype, 'get'],
      [Map.prototype, 'set'],
      [Map.prototype, 'values'],
      [Set.prototype, 'has'],
      [Set.prototype, 'add'],
      [String.prototype, 'trim'],
      [String.prototype, 'toLowerCase'],
      [RegExp.prototype, 'test'],
    ];
    const originals = [];
    for (let index = 0; index < hooks.length; index += 1) {
      define(originals, String(index), {
        configurable: true,
        enumerable: true,
        value: getDescriptor(hooks[index][0], hooks[index][1]),
        writable: true,
      });
    }
    let reads = 0;
    try {
      for (let index = 0; index < hooks.length; index += 1) {
        const original = originals[index];
        define(hooks[index][0], hooks[index][1], {
          configurable: true,
          get() {
            reads += 1;
            return original.value;
          },
        });
      }
      const base = {
        schemaVersion: 'audio-mode-intent-request.v1',
        uid: '00000000-0000-4000-8000-000000097010',
        dramaUid: '00000000-0000-4000-8000-000000097011',
        workflowRunUid: '00000000-0000-4000-8000-000000097012',
        nodeRunUid: '00000000-0000-4000-8000-000000097013',
        shotResultUid: '00000000-0000-4000-8000-000000097014',
        scriptResultUid: '00000000-0000-4000-8000-000000097015',
        deliveries: [],
        createdAtEpochMs: 1,
      };
      let emptyRejected = false;
      try { parseAudioModeIntentRequest(base); } catch { emptyRejected = true; }
      const parsed = parseAudioModeIntentRequest({
        ...base,
        deliveries: [{
          uid: '00000000-0000-4000-8000-000000097016',
          continuitySnapshotUid: '00000000-0000-4000-8000-000000097017',
          shotId: 'shot-1',
          dialogueEntryId: 'dialogue-1',
          voiceProfileUid: '00000000-0000-4000-8000-000000097018',
          emotion: 'neutral',
          emotionIntensityPermille: 500,
          speedPermille: 1000,
          pauseBeforeMs: 0,
          pauseAfterMs: 0,
        }],
      });
      const emotion = audioModeNarrativeEmotion(' NEUTRAL ');
      process.stdout.write(JSON.stringify({
        reads,
        emptyRejected,
        parsed: parsed.deliveries.length,
        emotion,
      }));
    } finally {
      for (let index = 0; index < hooks.length; index += 1) {
        define(hooks[index][0], hooks[index][1], originals[index]);
      }
    }
  `;
  const child = spawnSync(process.execPath, ['-e', script, modulePath], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    reads: 0,
    emptyRejected: true,
    parsed: 1,
    emotion: 'neutral',
  });
});

function uidSequence(values) {
  const queue = [...values];
  return () => queue.shift();
}

function createFixture(t) {
  const fixture = seedContinuityFixture(t);
  const prompt = createPromptSemanticFixture(fixture, 97100);
  const repositories = createV2Repositories(fixture.database);
  const voice = repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'voice',
    uid: uid(97200),
    characterUid: fixture.characterUid,
    identityVersionUid: fixture.character.identity.uid,
    parentUid: null,
    metadata: {
      name: 'Prepared intent voice',
      language: 'zh-CN',
      style: 'stable synthetic delivery',
    },
    createdAtEpochMs: 10,
  });
  const profile = repositories.voiceProfiles.create({
    schemaVersion: '8.0',
    uid: uid(97201),
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
    uid: uid(97202),
    dramaUid: fixture.dramaUid,
    characterUid: fixture.characterUid,
    voiceProfileUid: profile.uid,
    previousVoiceProfileUid: null,
    stateVersion: 1,
    changedAtEpochMs: 12,
  });

  const workflowService = createWorkflowService({
    repositories,
    createUid: () => uid(97300),
  });
  const workflow = workflowService.createWorkflow({ dramaId: 1, name: 'Prepared TTS intent' });
  const canvasNodeUid = uid(97301);
  workflowService.replaceGraph(workflow.definition.uid, {
    expectedRevision: 0,
    nodes: [{
      uid: canvasNodeUid,
      nodeType: 'audio.tts',
      position: { x: 0, y: 0 },
      config: { credentialRef: CREDENTIAL_REF, profileUid: profile.uid, speed: 1 },
      domainRef: { type: 'narrative_result', uid: fixture.shot.resultUid },
      status: 'ready',
    }],
    edges: [],
  });
  const run = createWorkflowRunService({
    repositories,
    createUid: uidSequence([uid(97310), uid(97311)]),
  }).createRun({ workflowUid: workflow.definition.uid, triggerType: 'manual' });

  const reviews = createNarrativeReviewService({ repositories });
  const shotDetail = reviews.getResult(fixture.shot.resultUid);
  const scriptResultUid = shotDetail.result.upstreamResultUid;
  const script = reviews.requireApproved(scriptResultUid, 'script').result;
  const shot = fixture.shot.result.output.shots.find((candidate) => (
    candidate.dialogueEntryRefs.length > 0
  ));
  const dialogueEntryId = shot.dialogueEntryRefs[0];
  const dialogue = script.output.scenes.flatMap((scene) => scene.entries)
    .find((entry) => entry.entryId === dialogueEntryId);
  const snapshot = prompt.snapshots.find((candidate) => candidate.shotId === shot.shotId);
  const audioNodeRun = run.nodes.find((candidate) => candidate.nodeUid === canvasNodeUid);
  assert.ok(audioNodeRun);
  const request = {
    schemaVersion: 'audio-mode-intent-request.v1',
    uid: uid(97400),
    dramaUid: fixture.dramaUid,
    workflowRunUid: run.run.uid,
    nodeRunUid: audioNodeRun.uid,
    shotResultUid: fixture.shot.resultUid,
    scriptResultUid,
    deliveries: [{
      uid: uid(97401),
      continuitySnapshotUid: snapshot.snapshotUid,
      shotId: shot.shotId,
      dialogueEntryId,
      voiceProfileUid: profile.uid,
      emotion: 'fearful',
      emotionIntensityPermille: 700,
      speedPermille: 1000,
      pauseBeforeMs: 0,
      pauseAfterMs: 120,
    }],
    createdAtEpochMs: 20,
  };
  return { fixture, profile, repositories, request, run };
}

function persistedIntent(record) {
  return {
    uid: record.uid,
    dramaUid: record.dramaUid,
    workflowRunUid: record.workflowRunUid,
    nodeRunUid: record.nodeRunUid,
    shotResultUid: record.shotResultUid,
    scriptResultUid: record.scriptResultUid,
    requestJson: JSON.stringify(record.request),
    planJson: JSON.stringify(record.plan),
    planSha256: record.plan.planSha256,
    createdAtEpochMs: record.createdAtEpochMs,
  };
}

function resolveIntent(repositories, request) {
  const approval = createNarrativeApprovalGate({
    narrativeReviews: repositories.narrativeReviews,
    sources: repositories.sources,
  });
  return resolveAudioModeIntent(request, {
    requireApprovedNarrative: approval.requireApprovedNarrative,
    runs: repositories.runs,
    shotContinuitySnapshots: repositories.shotContinuitySnapshots,
    voiceProfiles: repositories.voiceProfiles,
    workflows: repositories.workflows,
  });
}

const INSERT_INTENT_SQL = `
  INSERT INTO audio_mode_intents
    (uid, drama_uid, workflow_run_uid, node_run_uid, shot_result_uid,
     script_result_uid, request_json, plan_json, plan_sha256, created_at_epoch_ms)
  VALUES
    (@uid, @dramaUid, @workflowRunUid, @nodeRunUid, @shotResultUid,
     @scriptResultUid, @requestJson, @planJson, @planSha256, @createdAtEpochMs)
`;

test('migration seventeen installs the prepared audio mode intent store', (t) => {
  const database = createMigratedV2Database(t);
  assert.equal(
    database.prepare('SELECT max(version) FROM schema_migrations').pluck().get(),
    17,
  );
  assert.equal(
    database.prepare(`
      SELECT count(*) FROM sqlite_master
      WHERE type='table' AND name='audio_mode_intents'
    `).pluck().get(),
    1,
  );
});

test('prepared intent rebuilds a secret-free TTS plan from current approved sources', (t) => {
  const { repositories, request } = createFixture(t);
  const record = repositories.audioModeIntents.prepare(request);
  const publicRecord = publicAudioModeIntent(record);
  const validate = new Ajv2020({ allErrors: true, strict: true })
    .addSchema(dialogueDeliverySchema)
    .addSchema(voiceProfileSchema)
    .addSchema(h3GenerationSpecSchema)
    .addSchema(h3VideoEvidenceSchema)
    .addSchema(audioModePlanSchema)
    .compile(audioModeIntentSchema);

  assert.equal(record.plan.mode, 'independent_tts');
  assert.equal(record.plan.ttsRequests.length, 1);
  assert.equal(record.plan.ttsRequests[0].text, '楼上有人。');
  assert.equal(record.request.deliveries[0].continuitySnapshotUid, request.deliveries[0].continuitySnapshotUid);
  assert.deepEqual(repositories.audioModeIntents.prepare(structuredClone(request)), record);
  assert.deepEqual(repositories.audioModeIntents.get(record.uid), record);
  assert.equal(validate(publicRecord), true, JSON.stringify(validate.errors));
  assert.doesNotMatch(JSON.stringify(publicRecord), /credential:v1|97001|api[_-]?key|secret/iu);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.plan), true);
});

test('prepared intent reads fail closed after approved source or active profile drift', (t) => {
  const first = createFixture(t);
  const record = first.repositories.audioModeIntents.prepare(first.request);
  first.fixture.database.prepare('DROP TRIGGER v2_audio_mode_intents_immutable_update').run();
  first.fixture.database.prepare('UPDATE audio_mode_intents SET plan_sha256=? WHERE uid=?')
    .run('f'.repeat(64), record.uid);
  assert.throws(
    () => first.repositories.audioModeIntents.get(record.uid),
    V2RepositoryDataError,
  );
});

test('database rejects replacement and mutation while a deleted prepared intent can be rebuilt safely', (t) => {
  const { fixture, repositories, request } = createFixture(t);
  const record = repositories.audioModeIntents.prepare(request);
  const row = persistedIntent(record);

  assert.throws(
    () => fixture.database.prepare('UPDATE audio_mode_intents SET plan_sha256=? WHERE uid=?')
      .run('e'.repeat(64), record.uid),
    /audio mode intents are immutable/u,
  );
  fixture.database.pragma('recursive_triggers = OFF');
  assert.throws(
    () => fixture.database.prepare(INSERT_INTENT_SQL.replace('INSERT INTO', 'INSERT OR REPLACE INTO'))
      .run(row),
    /audio mode intents are immutable/u,
  );
  assert.equal(
    fixture.database.prepare('SELECT plan_sha256 FROM audio_mode_intents WHERE uid=?').pluck().get(record.uid),
    record.plan.planSha256,
  );
  const alternate = resolveIntent(repositories, { ...record.request, uid: uid(97410) });
  const alternateRow = persistedIntent({
    schemaVersion: 'audio-mode-intent.v1',
    uid: alternate.request.uid,
    dramaUid: alternate.request.dramaUid,
    workflowRunUid: alternate.request.workflowRunUid,
    nodeRunUid: alternate.request.nodeRunUid,
    shotResultUid: alternate.request.shotResultUid,
    scriptResultUid: alternate.request.scriptResultUid,
    request: alternate.request,
    plan: alternate.plan,
    createdAtEpochMs: alternate.request.createdAtEpochMs,
  });
  assert.throws(
    () => fixture.database.prepare(INSERT_INTENT_SQL.replace('INSERT INTO', 'INSERT OR REPLACE INTO'))
      .run(alternateRow),
    /audio mode intents are immutable/u,
  );
  assert.equal(fixture.database.prepare('SELECT count(*) FROM audio_mode_intents').pluck().get(), 1);

  fixture.database.prepare('DELETE FROM audio_mode_intents WHERE uid=?').run(record.uid);
  assert.equal(fixture.database.prepare('SELECT count(*) FROM audio_mode_intents').pluck().get(), 0);
  fixture.database.prepare(INSERT_INTENT_SQL).run(row);
  assert.deepEqual(repositories.audioModeIntents.get(record.uid), record);

  fixture.database.prepare('DELETE FROM audio_mode_intents WHERE uid=?').run(record.uid);
  assert.throws(
    () => fixture.database.prepare(INSERT_INTENT_SQL).run({ ...row, planSha256: 'd'.repeat(64) }),
    /audio mode intent invalid/u,
  );
  assert.equal(fixture.database.prepare('SELECT count(*) FROM audio_mode_intents').pluck().get(), 0);
});

test('prepared intent revalidation rejects approval, profile selection, snapshot, and workflow drift', async (t) => {
  await t.test('workflow execution starts', () => {
    const current = createFixture(t);
    const record = current.repositories.audioModeIntents.prepare(current.request);
    createWorkflowRunService({ repositories: current.repositories }).transitionWorkflow({
      runUid: current.request.workflowRunUid,
      expectedStatus: 'queued',
      nextStatus: 'running',
    });
    assert.throws(
      () => current.repositories.audioModeIntents.get(record.uid),
      V2RepositoryDataError,
    );
  });

  await t.test('shot approval changes', () => {
    const current = createFixture(t);
    const record = current.repositories.audioModeIntents.prepare(current.request);
    createNarrativeReviewService({ repositories: current.repositories }).reviewResult({
      resultUid: current.request.shotResultUid,
      decision: 'reject',
    });
    assert.throws(
      () => current.repositories.audioModeIntents.get(record.uid),
      V2RepositoryDataError,
    );
  });

  await t.test('active VoiceProfile changes', () => {
    const current = createFixture(t);
    const record = current.repositories.audioModeIntents.prepare(current.request);
    const nextProfile = current.repositories.voiceProfiles.create({
      schemaVersion: '8.0',
      uid: uid(97500),
      dramaUid: current.profile.dramaUid,
      characterUid: current.profile.characterUid,
      characterVoiceVersionUid: current.profile.characterVoiceVersionUid,
      parentUid: current.profile.uid,
      revision: 2,
      provider: current.profile.provider,
      model: current.profile.model,
      voiceKey: current.profile.voiceKey,
      credentialRef: CREDENTIAL_REF,
      sourceKind: current.profile.sourceKind,
      status: 'ready',
      defaultEmotion: current.profile.defaultEmotion,
      emotionMap: current.profile.emotionMap,
      minimumSpeedPermille: current.profile.minimumSpeedPermille,
      defaultSpeedPermille: current.profile.defaultSpeedPermille,
      maximumSpeedPermille: current.profile.maximumSpeedPermille,
      createdAtEpochMs: 13,
    });
    current.repositories.voiceProfiles.activate({
      schemaVersion: '8.0',
      uid: uid(97501),
      dramaUid: current.profile.dramaUid,
      characterUid: current.profile.characterUid,
      voiceProfileUid: nextProfile.uid,
      previousVoiceProfileUid: current.profile.uid,
      stateVersion: 2,
      changedAtEpochMs: 14,
    });
    assert.throws(
      () => current.repositories.audioModeIntents.get(record.uid),
      V2RepositoryDataError,
    );
  });

  await t.test('continuity snapshot changes after its guard is removed', () => {
    const current = createFixture(t);
    const record = current.repositories.audioModeIntents.prepare(current.request);
    current.fixture.database.prepare('DROP TRIGGER v2_shot_continuity_snapshots_immutable_update').run();
    current.fixture.database.prepare('UPDATE shot_continuity_snapshots SET shot_id=? WHERE uid=?')
      .run('shot-drifted', current.request.deliveries[0].continuitySnapshotUid);
    assert.throws(
      () => current.repositories.audioModeIntents.get(record.uid),
      V2RepositoryDataError,
    );
  });

  await t.test('frozen workflow snapshot changes after its guard is removed', () => {
    const current = createFixture(t);
    const record = current.repositories.audioModeIntents.prepare(current.request);
    current.fixture.database.prepare('DROP TRIGGER v2_workflow_runs_snapshot_immutable').run();
    const graph = JSON.parse(current.fixture.database.prepare(
      'SELECT graph_snapshot_json FROM workflow_runs WHERE uid=?',
    ).pluck().get(current.request.workflowRunUid));
    graph.snapshot.nodes[0].domainRef.uid = uid(97510);
    current.fixture.database.prepare('UPDATE workflow_runs SET graph_snapshot_json=? WHERE uid=?')
      .run(JSON.stringify(graph), current.request.workflowRunUid);
    assert.throws(
      () => current.repositories.audioModeIntents.get(record.uid),
      V2RepositoryDataError,
    );
  });
});

test('localhost prepare and read routes return only the secret-free exact projection', async (t) => {
  const { fixture, repositories, request } = createFixture(t);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v2', audioModeIntentRoutes(null, {
    repository: repositories.audioModeIntents,
  }, fixture.database));
  const server = await new Promise((resolve) => {
    const active = app.listen(0, '127.0.0.1', () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v2/dramas/${request.dramaUid}/audio-mode-intents`;

  const preparedResponse = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  assert.equal(preparedResponse.status, 201);
  const prepared = (await preparedResponse.json()).data;
  assert.equal(prepared.uid, request.uid);
  assert.equal(Object.hasOwn(prepared, 'request'), false);
  assert.doesNotMatch(JSON.stringify(prepared), /credential:v1|97001|api[_-]?key|secret/iu);

  const readResponse = await fetch(`${base}/${request.uid}`);
  assert.equal(readResponse.status, 200);
  assert.deepEqual((await readResponse.json()).data, prepared);

  const mismatched = await fetch(
    `http://127.0.0.1:${server.address().port}/api/v2/dramas/${uid(97520)}/audio-mode-intents`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    },
  );
  assert.equal(mismatched.status, 400);
  assert.equal((await mismatched.json()).error.code, 'AUDIO_MODE_INTENT_INPUT_INVALID');
});
