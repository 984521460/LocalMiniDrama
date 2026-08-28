const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const express = require('express');

const {
  GenerationHistoryError,
  createAssetVersionSelectionEvent,
  createGenerationHistoryRecord,
  createPromptSemanticVersionRecord,
} = require('../src/assets/generationHistory');
const {
  createV2Repositories,
  V2RepositoryConflictError,
  V2RepositoryDataError,
} = require('../src/repositories/v2');
const generationHistoryRoutes = require('../src/routes/v2/generationHistory');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const projectZipService = require('../src/services/projectZipService');
const {
  createPromptSemanticFixture,
  seedContinuityFixture,
} = require('./helpers/v5ContinuityFixtures');
const { uid } = require('./helpers/v2RepositoryDatabase');

const schema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../schemas/v5/generation-history.schema.json'),
  'utf8',
));
const hash = (digit) => digit.repeat(64);

function assetVersionEvidence({
  versionUid = uid(21005),
  assetUid = uid(21002),
  parentUid = uid(21006),
  sha256 = hash('c'),
} = {}) {
  return {
    uid: versionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri: `asset://synthetic/${versionUid}`,
    relativePath: `synthetic/${versionUid}.png`,
    sha256,
    mimeType: 'image/png',
    width: 1280,
    height: 720,
    durationMs: null,
    parentUid,
    status: 'ready',
    createdAt: '1970-01-01T00:00:00.000Z',
  };
}

function semanticShot(ordinal) {
  return {
    shotId: `shot-${ordinal + 1}`,
    ordinal: ordinal + 1,
    durationSeconds: 12,
    continuitySnapshotUid: uid(20100 + ordinal),
    subjects: {
      description: 'A performer holds a stable pose.',
      characters: [{
        factRef: `character-${ordinal + 1}`,
        characterUid: uid(20200 + ordinal),
        referencePackageUid: uid(20300 + ordinal),
        identityVersionUid: uid(20400 + ordinal),
        costumeVersionUid: uid(20500 + ordinal),
      }],
    },
    environment: {
      sceneId: `scene-${ordinal + 1}`,
      description: 'A consistent interior location.',
      scene: { sceneUid: uid(20600 + ordinal), versionUid: uid(20700 + ordinal) },
      props: [{ factRef: `prop-${ordinal + 1}`, propUid: uid(20800 + ordinal), versionUid: uid(20900 + ordinal) }],
    },
    action: 'The performer crosses the frame.',
    camera: {
      shotSize: 'MS',
      cameraAngle: 'eye_level',
      cameraMovement: 'dolly',
      composition: 'The performer remains centered with clear travel space.',
    },
    lighting: {
      quality: 'soft',
      direction: 'side',
      colorTemperature: 'neutral',
      description: 'Soft side light preserves facial and wardrobe detail.',
    },
    continuity: {
      transitionFromPrevious: ordinal === 0 ? 'start' : 'cut',
      screenDirection: 'left_to_right',
      axisStrategy: ordinal === 0 ? 'establish' : 'maintain',
      notes: 'Screen direction and wardrobe remain stable.',
    },
  };
}

function promptSemantic() {
  return {
    taskType: 'PromptSemanticVersioningTask',
    schemaVersion: 'prompt-semantic-versioned.v1',
    inputHash: hash('1'),
    upstreamPromptHash: hash('2'),
    dramaUid: uid(20000),
    shotResultUid: uid(20001),
    shotResultHash: hash('3'),
    shotEnvelopeHash: hash('4'),
    shotApprovalRef: `review:v1:${uid(20002)}`,
    output: {
      aspectRatio: '16:9',
      durationSummary: { totalSeconds: 48 },
      semanticShots: Array.from({ length: 4 }, (_, ordinal) => semanticShot(ordinal)),
    },
  };
}

function historyInput(overrides = {}) {
  return {
    uid: uid(21000),
    runUid: uid(21001),
    dramaUid: uid(20000),
    assetUid: uid(21002),
    promptSemanticUid: uid(21003),
    manifestUid: uid(21004),
    manifestSha256: hash('5'),
    provider: 'local',
    model: 'synthetic-image-v1',
    seed: 42,
    parameters: { steps: 20, width: 1280, height: 720 },
    input: {
      promptSemanticUid: uid(21003),
      manifestUid: uid(21004),
      continuitySnapshotUids: [uid(20100), uid(20101), uid(20102), uid(20103)],
    },
    status: 'succeeded',
    outputVersionUid: uid(21005),
    outputVersionEvidence: assetVersionEvidence(),
    parentVersionUid: uid(21006),
    parentVersionEvidence: assetVersionEvidence({
      versionUid: uid(21006),
      parentUid: null,
      sha256: hash('b'),
    }),
    errorCode: null,
    errorDetailRef: null,
    createdAtEpochMs: 0,
    completedAtEpochMs: 1,
    ...overrides,
  };
}

function createPersistedGenerationFixture(t, offset = 22000) {
  const fixture = seedContinuityFixture(t);
  const promptFixture = createPromptSemanticFixture(fixture, offset + 10);
  const promptSemanticUid = uid(offset + 1);
  const manifestUid = uid(offset + 2);
  const manifestSha256 = hash('a');
  const assetUid = uid(offset + 3);
  const parentVersionUid = uid(offset + 4);
  const outputVersionUid = uid(offset + 5);
  const runUid = uid(offset + 6);
  const historyUid = uid(offset + 7);
  const parameters = { steps: 20, width: 1280, height: 720 };
  const input = {
    promptSemanticUid,
    manifestUid,
    continuitySnapshotUids: promptFixture.snapshots.map((snapshot) => snapshot.snapshotUid),
  };
  fixture.repositories.workflows.createManifest({
    uid: manifestUid,
    manifestId: `generation-history-${offset}`,
    version: '1.0.0',
    engine: 'local',
    workflowFile: `workflows/generation-history-${offset}.json`,
    workflowSha256: manifestSha256,
    modelFamily: 'synthetic',
    requirements: [],
    inputs: { promptSemanticUid: 'uuid' },
    outputs: { image: 'asset-version' },
    validation: { valid: true },
    status: 'validated',
  });
  fixture.repositories.assets.create({
    uid: assetUid,
    ownerType: 'drama',
    ownerUid: fixture.dramaUid,
    assetType: 'image',
    status: 'draft',
  });
  fixture.repositories.assets.addVersion({
    uid: parentVersionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${fixture.dramaUid}/generation-history/parent.png`,
    relativePath: `dramas/${fixture.dramaUid}/generation-history/parent.png`,
    sha256: hash('b'),
    mimeType: 'image/png',
    width: 1280,
    height: 720,
    durationMs: null,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  fixture.repositories.assets.addVersion({
    uid: outputVersionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${fixture.dramaUid}/generation-history/output.png`,
    relativePath: `dramas/${fixture.dramaUid}/generation-history/output.png`,
    sha256: hash('c'),
    mimeType: 'image/png',
    width: 1280,
    height: 720,
    durationMs: null,
    parentUid: parentVersionUid,
    status: 'ready',
  });
  fixture.repositories.runs.createGeneration({
    uid: runUid,
    ownerType: 'drama',
    ownerUid: fixture.dramaUid,
    provider: 'local',
    model: 'synthetic-image-v1',
    seed: 42,
    parameters,
    input,
    promptVersionUid: promptSemanticUid,
    status: 'queued',
  });
  fixture.repositories.runs.transitionGenerationStatus({
    uid: runUid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  const terminalRun = fixture.repositories.runs.transitionGenerationStatus({
    uid: runUid,
    expectedStatus: 'running',
    nextStatus: 'succeeded',
    outputAssetVersionUid: outputVersionUid,
  });
  const createdAtEpochMs = Date.parse(terminalRun.createdAt);
  const completedAtEpochMs = Date.parse(terminalRun.completedAt);
  const promptInputRecord = {
    uid: promptSemanticUid,
    semantic: promptFixture.semantic,
    createdAtEpochMs,
  };
  const persistedHistoryInput = {
    uid: historyUid,
    runUid,
    dramaUid: fixture.dramaUid,
    assetUid,
    promptSemanticUid,
    manifestUid,
    manifestSha256,
    provider: 'local',
    model: 'synthetic-image-v1',
    seed: 42,
    parameters,
    input,
    status: 'succeeded',
    outputVersionUid,
    outputVersionEvidence: fixture.repositories.assets.getVersion(outputVersionUid),
    parentVersionUid,
    parentVersionEvidence: fixture.repositories.assets.getVersion(parentVersionUid),
    errorCode: null,
    errorDetailRef: null,
    createdAtEpochMs,
    completedAtEpochMs,
  };
  return {
    ...fixture,
    assetUid,
    completedAtEpochMs,
    createdAtEpochMs,
    historyUid,
    historyInput: persistedHistoryInput,
    manifestSha256,
    manifestUid,
    outputVersionUid,
    parentVersionUid,
    promptFixture,
    promptInputRecord,
    promptSemanticUid,
    runUid,
  };
}

function storageRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `local-mini-drama-${label}-`));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

test('generation history contracts freeze Prompt, terminal result, and selection evidence', () => {
  const prompt = createPromptSemanticVersionRecord({
    uid: uid(21003),
    semantic: promptSemantic(),
    createdAtEpochMs: 0,
  });
  const history = createGenerationHistoryRecord(historyInput());
  const selection = createAssetVersionSelectionEvent({
    uid: uid(21007),
    historyUid: history.uid,
    assetUid: history.assetUid,
    selectedVersionUid: history.outputVersionUid,
    previousVersionUid: history.parentVersionUid,
    stateVersion: 1,
    changedAtEpochMs: 2,
  });

  assert.equal(prompt.semanticSha256.length, 64);
  assert.equal(history.promptSemanticUid, prompt.uid);
  assert.equal(history.parametersSha256.length, 64);
  assert.equal(history.inputSha256.length, 64);
  assert.equal(selection.stateVersion, 1);
  assert.equal(Object.isFrozen(prompt.semantic.output.semanticShots), true);
  assert.equal(Object.isFrozen(history.parameters), true);
  assert.equal(Object.isFrozen(selection), true);
  assert.equal(new Ajv2020({ allErrors: true, strict: true }).compile(schema)(history), true);
});

test('generation history rejects secrets, inconsistent terminal states, and hostile containers', () => {
  assert.throws(
    () => createGenerationHistoryRecord(historyInput({ parameters: { api_key: 'synthetic-secret' } })),
    (error) => error instanceof GenerationHistoryError
      && error.code === 'GENERATION_HISTORY_INPUT_INVALID',
  );
  assert.throws(
    () => createGenerationHistoryRecord(historyInput({ status: 'failed' })),
    (error) => error instanceof GenerationHistoryError
      && error.code === 'GENERATION_HISTORY_INPUT_INVALID',
  );
  const semanticWithRawValue = structuredClone(promptSemantic());
  semanticWithRawValue.output.semanticShots[0].action = 'sk-synthetic-secret-value';
  assert.throws(
    () => createPromptSemanticVersionRecord({
      uid: uid(21003),
      semantic: semanticWithRawValue,
      createdAtEpochMs: 0,
    }),
    (error) => error instanceof GenerationHistoryError
      && error.code === 'GENERATION_HISTORY_INPUT_INVALID',
  );

  let reads = 0;
  const hostile = new Proxy(historyInput(), {
    ownKeys() {
      reads += 1;
      throw new Error('synthetic-generation-history-proxy');
    },
  });
  assert.throws(
    () => createGenerationHistoryRecord(hostile),
    (error) => error instanceof GenerationHistoryError
      && error.code === 'GENERATION_HISTORY_INPUT_INVALID',
  );
  assert.equal(reads, 0);
});

test('generation history persists terminal evidence and changes current version only by events', (t) => {
  const fixture = createPersistedGenerationFixture(t);
  const sensitiveValue = 'synthetic-secret-must-not-persist';
  assert.throws(
    () => fixture.repositories.runs.createGeneration({
      uid: uid(22020),
      ownerType: 'drama',
      ownerUid: fixture.dramaUid,
      provider: 'local',
      model: 'synthetic-image-v1',
      seed: null,
      parameters: { api_key: sensitiveValue },
      input: fixture.historyInput.input,
      promptVersionUid: fixture.promptSemanticUid,
      status: 'queued',
    }),
    (error) => error instanceof GenerationHistoryError
      && !String(error).includes(sensitiveValue),
  );
  assert.throws(
    () => fixture.database.prepare(`
      INSERT INTO generation_runs
        (uid,owner_type,owner_uid,provider,model,seed,parameters_json,input_json,
         prompt_version_uid,status)
      VALUES (?,?,?,?,?,NULL,?,?,?,'queued')
    `).run(
      uid(22021),
      'drama',
      fixture.dramaUid,
      'local',
      'synthetic-image-v1',
      JSON.stringify({ api_key: sensitiveValue }),
      JSON.stringify(fixture.historyInput.input),
      fixture.promptSemanticUid,
    ),
    (error) => !String(error).includes(sensitiveValue),
  );
  const history = fixture.repositories.generationHistory.append(
    fixture.promptInputRecord,
    fixture.historyInput,
  );
  assert.equal(history.uid, fixture.historyUid);
  assert.equal(
    fixture.repositories.generationHistory.getPrompt(fixture.promptSemanticUid).semanticSha256,
    createPromptSemanticVersionRecord(fixture.promptInputRecord).semanticSha256,
  );
  assert.deepEqual(fixture.repositories.generationHistory.getSelectionState(fixture.assetUid), {
    assetUid: fixture.assetUid,
    selectedVersionUid: fixture.parentVersionUid,
    stateVersion: 0,
    latestEvent: null,
  });
  assert.throws(
    () => fixture.repositories.assets.setCurrentVersion(fixture.assetUid, fixture.outputVersionUid),
    (error) => error instanceof V2RepositoryConflictError,
  );

  const state = fixture.repositories.generationHistory.select({
    uid: uid(22008),
    historyUid: fixture.historyUid,
    assetUid: fixture.assetUid,
    selectedVersionUid: fixture.outputVersionUid,
    previousVersionUid: fixture.parentVersionUid,
    stateVersion: 1,
    changedAtEpochMs: fixture.completedAtEpochMs + 1,
  });
  assert.equal(state.selectedVersionUid, fixture.outputVersionUid);
  assert.equal(state.stateVersion, 1);
  assert.equal(fixture.repositories.assets.get(fixture.assetUid).currentVersionUid, fixture.outputVersionUid);
  assert.equal(fixture.repositories.generationHistory.listByAsset(fixture.assetUid).length, 1);
  assert.equal(fixture.repositories.generationHistory.listSelections(fixture.assetUid).length, 1);

  assert.throws(
    () => fixture.repositories.generationHistory.select({
      uid: uid(22010),
      historyUid: fixture.historyUid,
      assetUid: fixture.assetUid,
      selectedVersionUid: fixture.outputVersionUid,
      previousVersionUid: fixture.outputVersionUid,
      stateVersion: 2,
      changedAtEpochMs: fixture.completedAtEpochMs + 2,
    }),
    (error) => error instanceof GenerationHistoryError,
  );

  assert.throws(
    () => fixture.repositories.assets.setCurrentVersion(fixture.assetUid, fixture.parentVersionUid),
    (error) => error instanceof V2RepositoryConflictError,
  );
  assert.throws(
    () => fixture.repositories.generationHistory.select({
      uid: uid(22009),
      historyUid: fixture.historyUid,
      assetUid: fixture.assetUid,
      selectedVersionUid: fixture.outputVersionUid,
      previousVersionUid: fixture.parentVersionUid,
      stateVersion: 2,
      changedAtEpochMs: fixture.completedAtEpochMs + 2,
    }),
    (error) => error instanceof V2RepositoryConflictError,
  );
  assert.equal(fixture.repositories.generationHistory.listSelections(fixture.assetUid).length, 1);
});

test('failed regeneration preserves its parent version and fixed error references', (t) => {
  const fixture = createPersistedGenerationFixture(t, 22050);
  const failedRunUid = uid(22058);
  const failedHistoryUid = uid(22059);
  const errorDetailRef = `error-detail:v1:${uid(22060)}`;
  fixture.repositories.runs.createGeneration({
    uid: failedRunUid,
    ownerType: 'drama',
    ownerUid: fixture.dramaUid,
    provider: fixture.historyInput.provider,
    model: fixture.historyInput.model,
    seed: fixture.historyInput.seed,
    parameters: fixture.historyInput.parameters,
    input: fixture.historyInput.input,
    promptVersionUid: fixture.promptSemanticUid,
    status: 'queued',
  });
  fixture.repositories.runs.transitionGenerationStatus({
    uid: failedRunUid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  const terminalRun = fixture.repositories.runs.transitionGenerationStatus({
    uid: failedRunUid,
    expectedStatus: 'running',
    nextStatus: 'failed',
    errorCode: 'ERR_SYNTHETIC_GENERATION_FAILED',
    errorDetailRef,
  });

  const history = fixture.repositories.generationHistory.append(
    fixture.promptInputRecord,
    {
      ...fixture.historyInput,
      uid: failedHistoryUid,
      runUid: failedRunUid,
      status: 'failed',
      outputVersionUid: null,
      outputVersionEvidence: null,
      parentVersionUid: fixture.parentVersionUid,
      errorCode: 'ERR_SYNTHETIC_GENERATION_FAILED',
      errorDetailRef,
      createdAtEpochMs: Date.parse(terminalRun.createdAt),
      completedAtEpochMs: Date.parse(terminalRun.completedAt),
    },
  );

  assert.equal(history.status, 'failed');
  assert.equal(history.outputVersionUid, null);
  assert.equal(history.parentVersionUid, fixture.parentVersionUid);
  assert.equal(history.errorCode, 'ERR_SYNTHETIC_GENERATION_FAILED');
  assert.equal(history.errorDetailRef, errorDetailRef);
  assert.equal(
    fixture.repositories.generationHistory.getSelectionState(fixture.assetUid).selectedVersionUid,
    fixture.parentVersionUid,
  );
});

test('generation history is append-only and persisted dependency drift fails closed on read', (t) => {
  const fixture = createPersistedGenerationFixture(t, 22100);
  fixture.repositories.generationHistory.append(fixture.promptInputRecord, fixture.historyInput);
  assert.throws(
    () => fixture.repositories.generationHistory.append(
      { ...fixture.promptInputRecord, createdAtEpochMs: fixture.createdAtEpochMs - 1 },
      fixture.historyInput,
    ),
    (error) => error instanceof V2RepositoryConflictError,
  );
  const rawPromptValue = 'sk-synthetic-direct-sql-value';
  assert.throws(
    () => fixture.database.prepare(`
      INSERT INTO prompt_semantic_versions
        (uid,drama_uid,shot_result_uid,shot_result_hash,shot_envelope_hash,
         shot_approval_ref,semantic_sha256,semantic_json,created_at_epoch_ms)
      SELECT ?,drama_uid,shot_result_uid,shot_result_hash,shot_envelope_hash,
        shot_approval_ref,semantic_sha256,
        json_set(semantic_json,'$.output.semanticShots[0].action',?),created_at_epoch_ms
      FROM prompt_semantic_versions WHERE uid=?
    `).run(uid(22108), rawPromptValue, fixture.promptSemanticUid),
    (error) => !String(error).includes(rawPromptValue),
  );
  for (const statement of [
    "UPDATE asset_generation_history SET provider='changed' WHERE uid=?",
    'DELETE FROM asset_generation_history WHERE uid=?',
    "UPDATE prompt_semantic_versions SET semantic_sha256=replace(semantic_sha256,'a','b') WHERE uid=?",
    'DELETE FROM prompt_semantic_versions WHERE uid=?',
  ]) {
    assert.throws(() => fixture.database.prepare(statement).run(
      statement.includes('prompt_semantic') ? fixture.promptSemanticUid : fixture.historyUid,
    ));
  }
  assert.throws(() => fixture.database.prepare(`
    UPDATE workflow_manifests SET workflow_file='workflows/changed.json' WHERE uid=?
  `).run(fixture.manifestUid));
  assert.throws(() => fixture.database.prepare(
    'DELETE FROM workflow_manifests WHERE uid=?',
  ).run(fixture.manifestUid));

  fixture.database.exec('DROP TRIGGER v2_asset_generation_history_immutable_update');
  fixture.database.prepare(`
    UPDATE asset_generation_history SET provider='changed' WHERE uid=?
  `).run(fixture.historyUid);
  assert.throws(
    () => fixture.repositories.generationHistory.get(fixture.historyUid),
    (error) => error instanceof V2RepositoryDataError,
  );
  assert.throws(
    () => fixture.repositories.generationHistory.listByAsset(fixture.assetUid),
    (error) => error instanceof V2RepositoryDataError,
  );
});

test('generation history seals complete output and parent AssetVersion evidence', (t) => {
  const outputFixture = createPersistedGenerationFixture(t, 22120);
  assert.throws(
    () => outputFixture.repositories.generationHistory.append(
      outputFixture.promptInputRecord,
      {
        ...outputFixture.historyInput,
        outputVersionEvidence: {
          ...outputFixture.historyInput.outputVersionEvidence,
          sha256: hash('d'),
        },
      },
    ),
    (error) => error instanceof V2RepositoryConflictError,
  );
  outputFixture.repositories.generationHistory.append(
    outputFixture.promptInputRecord,
    outputFixture.historyInput,
  );
  outputFixture.database.exec('DROP TRIGGER v2_generation_asset_versions_frozen_after_history');
  outputFixture.database.prepare('UPDATE asset_versions SET sha256=? WHERE uid=?')
    .run(hash('d'), outputFixture.outputVersionUid);
  assert.throws(
    () => outputFixture.repositories.generationHistory.get(outputFixture.historyUid),
    (error) => error instanceof V2RepositoryDataError,
  );

  const parentFixture = createPersistedGenerationFixture(t, 22140);
  parentFixture.repositories.generationHistory.append(
    parentFixture.promptInputRecord,
    parentFixture.historyInput,
  );
  parentFixture.database.exec('DROP TRIGGER v2_generation_asset_versions_frozen_after_history');
  parentFixture.database.prepare('UPDATE asset_versions SET relative_path=? WHERE uid=?')
    .run('synthetic/relocated-parent.png', parentFixture.parentVersionUid);
  assert.throws(
    () => parentFixture.repositories.generationHistory.listByAsset(parentFixture.assetUid),
    (error) => error instanceof V2RepositoryDataError,
  );
});

test('generation history rejects non-canonical persisted AssetVersion evidence JSON', (t) => {
  const fixture = createPersistedGenerationFixture(t, 22160);
  fixture.repositories.generationHistory.append(
    fixture.promptInputRecord,
    fixture.historyInput,
  );
  fixture.repositories.generationHistory.select({
    uid: uid(22168),
    historyUid: fixture.historyUid,
    assetUid: fixture.assetUid,
    selectedVersionUid: fixture.outputVersionUid,
    previousVersionUid: fixture.parentVersionUid,
    stateVersion: 1,
    changedAtEpochMs: fixture.completedAtEpochMs + 1,
  });

  fixture.database.exec('DROP TRIGGER v2_asset_generation_history_immutable_update');
  const canonical = fixture.database.prepare(`
    SELECT output_version_evidence_json FROM asset_generation_history WHERE uid=?
  `).pluck().get(fixture.historyUid);
  const parsed = JSON.parse(canonical);
  const variants = [
    canonical.replace(
      `"sha256":"${hash('c')}"`,
      `"sha256":"${hash('d')}","sha256":"${hash('c')}"`,
    ),
    ` ${canonical}`,
    JSON.stringify({ sha256: parsed.sha256, ...parsed }),
    canonical.replace('image/png', 'image\\/png'),
  ];
  const updateEvidence = fixture.database.prepare(`
    UPDATE asset_generation_history SET output_version_evidence_json=? WHERE uid=?
  `);
  for (const variant of variants) {
    assert.notEqual(variant, canonical);
    updateEvidence.run(variant, fixture.historyUid);
    for (const read of [
      () => fixture.repositories.generationHistory.get(fixture.historyUid),
      () => fixture.repositories.generationHistory.listByAsset(fixture.assetUid),
      () => fixture.repositories.generationHistory.getSelectionState(fixture.assetUid),
    ]) {
      assert.throws(read, (error) => error instanceof V2RepositoryDataError);
    }
  }
});

test('generation history refuses to seal a Prompt after its approval chain becomes stale', (t) => {
  const fixture = createPersistedGenerationFixture(t, 22500);
  const extraction = fixture.database.prepare(`
    SELECT uid, result_hash, envelope_hash FROM narrative_results
    WHERE drama_uid=? AND result_type='extraction'
  `).get(fixture.dramaUid);
  const reviewUid = uid(22508);
  fixture.database.prepare(`
    INSERT INTO narrative_review_events
      (uid, result_uid, decision, result_hash, envelope_hash, comment)
    VALUES (?, ?, 'approve', ?, ?, NULL)
  `).run(reviewUid, extraction.uid, extraction.result_hash, extraction.envelope_hash);
  fixture.database.prepare(`
    UPDATE narrative_results SET status='approved', current_review_uid=? WHERE uid=?
  `).run(reviewUid, extraction.uid);

  assert.throws(
    () => fixture.repositories.generationHistory.append(
      fixture.promptInputRecord,
      fixture.historyInput,
    ),
    (error) => error instanceof V2RepositoryConflictError,
  );
  assert.equal(fixture.database.prepare('SELECT count(*) FROM prompt_semantic_versions').pluck().get(), 0);
  assert.equal(fixture.database.prepare('SELECT count(*) FROM asset_generation_history').pluck().get(), 0);
});

test('regeneration appends a child version and preserves the previous selected history', (t) => {
  const fixture = createPersistedGenerationFixture(t, 22200);
  const first = fixture.repositories.generationHistory.append(
    fixture.promptInputRecord,
    fixture.historyInput,
  );
  fixture.repositories.generationHistory.select({
    uid: uid(22208),
    historyUid: first.uid,
    assetUid: fixture.assetUid,
    selectedVersionUid: fixture.outputVersionUid,
    previousVersionUid: fixture.parentVersionUid,
    stateVersion: 1,
    changedAtEpochMs: fixture.completedAtEpochMs + 1,
  });

  const nextVersionUid = uid(22209);
  const nextRunUid = uid(22210);
  const nextHistoryUid = uid(22211);
  fixture.repositories.assets.addVersion({
    uid: nextVersionUid,
    assetUid: fixture.assetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${fixture.dramaUid}/generation-history/regenerated.png`,
    relativePath: `dramas/${fixture.dramaUid}/generation-history/regenerated.png`,
    sha256: hash('d'),
    mimeType: 'image/png',
    width: 1280,
    height: 720,
    durationMs: null,
    parentUid: fixture.outputVersionUid,
    status: 'ready',
  });
  fixture.repositories.runs.createGeneration({
    uid: nextRunUid,
    ownerType: 'drama',
    ownerUid: fixture.dramaUid,
    provider: fixture.historyInput.provider,
    model: fixture.historyInput.model,
    seed: 43,
    parameters: fixture.historyInput.parameters,
    input: fixture.historyInput.input,
    promptVersionUid: fixture.promptSemanticUid,
    status: 'queued',
  });
  fixture.repositories.runs.transitionGenerationStatus({
    uid: nextRunUid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  const nextTerminalRun = fixture.repositories.runs.transitionGenerationStatus({
    uid: nextRunUid,
    expectedStatus: 'running',
    nextStatus: 'succeeded',
    outputAssetVersionUid: nextVersionUid,
  });
  const second = fixture.repositories.generationHistory.append(
    fixture.promptInputRecord,
    {
      ...fixture.historyInput,
      uid: nextHistoryUid,
      runUid: nextRunUid,
      seed: 43,
      outputVersionUid: nextVersionUid,
      outputVersionEvidence: fixture.repositories.assets.getVersion(nextVersionUid),
      parentVersionUid: fixture.outputVersionUid,
      parentVersionEvidence: fixture.repositories.assets.getVersion(fixture.outputVersionUid),
      createdAtEpochMs: Date.parse(nextTerminalRun.createdAt),
      completedAtEpochMs: Date.parse(nextTerminalRun.completedAt),
    },
  );
  const state = fixture.repositories.generationHistory.select({
    uid: uid(22212),
    historyUid: second.uid,
    assetUid: fixture.assetUid,
    selectedVersionUid: nextVersionUid,
    previousVersionUid: fixture.outputVersionUid,
    stateVersion: 2,
    changedAtEpochMs: Math.max(
      fixture.completedAtEpochMs + 2,
      Date.parse(nextTerminalRun.completedAt) + 1,
    ),
  });

  assert.equal(state.selectedVersionUid, nextVersionUid);
  assert.equal(state.stateVersion, 2);
  assert.deepEqual(
    fixture.repositories.generationHistory.listByAsset(fixture.assetUid).map((row) => row.uid),
    [first.uid, second.uid],
  );
  assert.equal(
    fixture.repositories.generationHistory.get(first.uid).outputVersionUid,
    fixture.outputVersionUid,
  );
  assert.deepEqual(
    fixture.repositories.generationHistory.listSelections(fixture.assetUid)
      .map((event) => event.selectedVersionUid),
    [fixture.outputVersionUid, nextVersionUid],
  );
});

test('generation history localhost routes expose frozen history and use optimistic selection', async (t) => {
  const fixture = createPersistedGenerationFixture(t, 22300);
  fixture.repositories.generationHistory.append(fixture.promptInputRecord, fixture.historyInput);
  const app = express();
  app.use(express.json());
  app.use(generationHistoryRoutes(null, {
    createEventUid: () => uid(22308),
    nowEpochMs: () => fixture.completedAtEpochMs + 1,
  }, fixture.database));
  const server = await new Promise((resolve) => {
    const active = app.listen(0, '127.0.0.1', () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const listResponse = await fetch(`${origin}/assets/${fixture.assetUid}/generation-history`);
  const listPayload = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listPayload.data.history.length, 1);
  assert.equal(listPayload.data.selection.stateVersion, 0);

  const selectedResponse = await fetch(`${origin}/assets/${fixture.assetUid}/version-selection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      history_uid: fixture.historyUid,
      selected_version_uid: fixture.outputVersionUid,
      expected_state_version: 0,
    }),
  });
  const selectedPayload = await selectedResponse.json();
  assert.equal(selectedResponse.status, 201);
  assert.equal(selectedPayload.data.selectedVersionUid, fixture.outputVersionUid);
  assert.equal(selectedPayload.data.stateVersion, 1);

  const staleResponse = await fetch(`${origin}/assets/${fixture.assetUid}/version-selection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      history_uid: fixture.historyUid,
      selected_version_uid: fixture.outputVersionUid,
      expected_state_version: 0,
    }),
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error.code, 'GENERATION_HISTORY_CONFLICT');

  const invalidResponse = await fetch(`${origin}/assets/${fixture.assetUid}/version-selection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      history_uid: fixture.historyUid,
      selected_version_uid: fixture.outputVersionUid,
      expected_state_version: 1,
      api_key: 'synthetic-secret-must-not-echo',
    }),
  });
  const invalidText = await invalidResponse.text();
  assert.equal(invalidResponse.status, 400);
  assert.doesNotMatch(invalidText, /synthetic-secret-must-not-echo/u);
});

test('generation history survives project ZIP export, clean import, and re-export', (t) => {
  const source = createPersistedGenerationFixture(t, 22400);
  source.repositories.generationHistory.append(source.promptInputRecord, source.historyInput);
  source.repositories.generationHistory.select({
    uid: uid(22408),
    historyUid: source.historyUid,
    assetUid: source.assetUid,
    selectedVersionUid: source.outputVersionUid,
    previousVersionUid: source.parentVersionUid,
    stateVersion: 1,
    changedAtEpochMs: source.completedAtEpochMs + 1,
  });
  const log = Object.freeze({ info() {}, error() {} });
  const exported = projectZipService.exportDrama(
    source.database,
    { storage: { local_path: storageRoot(t, 'generation-source') } },
    log,
    1,
  );
  const sourceZip = new AdmZip(exported.buffer);
  const manifest = JSON.parse(
    sourceZip.getEntry('v2/manifest.json').getData().toString('utf8'),
  );
  assert.equal(manifest.records.promptSemanticVersions.length, 1);
  assert.equal(manifest.records.assetGenerationHistory.length, 1);
  assert.equal(manifest.records.assetVersionSelectionEvents.length, 1);
  assert.equal(manifest.records.workflowManifests.length, 1);

  const destination = new Database(':memory:');
  destination.pragma('foreign_keys = ON');
  runMigrationsAndEnsure(destination);
  t.after(() => destination.close());
  const destinationConfig = { storage: { local_path: storageRoot(t, 'generation-destination') } };
  const imported = projectZipService.importDrama(
    destination,
    destinationConfig,
    log,
    exported.buffer,
  );
  const importedRepositories = createV2Repositories(destination);
  assert.equal(
    importedRepositories.generationHistory.get(source.historyUid).outputVersionUid,
    source.outputVersionUid,
  );
  assert.equal(
    importedRepositories.generationHistory.getSelectionState(source.assetUid).selectedVersionUid,
    source.outputVersionUid,
  );
  const reexported = projectZipService.exportDrama(
    destination,
    { storage: { local_path: storageRoot(t, 'generation-reexport') } },
    log,
    imported.drama_id,
  );
  const reexportedManifest = JSON.parse(
    new AdmZip(reexported.buffer).getEntry('v2/manifest.json').getData().toString('utf8'),
  );
  assert.deepEqual(
    reexportedManifest.records.assetGenerationHistory,
    manifest.records.assetGenerationHistory,
  );
  assert.deepEqual(
    reexportedManifest.records.assetVersionSelectionEvents,
    manifest.records.assetVersionSelectionEvents,
  );

  const tamperedManifest = structuredClone(manifest);
  const tamperedEvidence = JSON.parse(
    tamperedManifest.records.assetGenerationHistory[0].output_version_evidence_json,
  );
  tamperedEvidence.sha256 = hash('f');
  tamperedManifest.records.assetGenerationHistory[0].output_version_evidence_json =
    JSON.stringify(tamperedEvidence);
  const tamperedZip = new AdmZip(exported.buffer);
  tamperedZip.deleteFile('v2/manifest.json');
  tamperedZip.addFile(
    'v2/manifest.json',
    Buffer.from(JSON.stringify(tamperedManifest, null, 2), 'utf8'),
  );
  const rejectedDestination = new Database(':memory:');
  rejectedDestination.pragma('foreign_keys = ON');
  runMigrationsAndEnsure(rejectedDestination);
  t.after(() => rejectedDestination.close());
  assert.throws(
    () => projectZipService.importDrama(
      rejectedDestination,
      { storage: { local_path: storageRoot(t, 'generation-rejected') } },
      log,
      tamperedZip.toBuffer(),
    ),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID'
      && !JSON.stringify(error).includes(hash('f')),
  );
  assert.equal(rejectedDestination.prepare('SELECT count(*) FROM dramas').pluck().get(), 0);
  assert.equal(
    rejectedDestination.prepare('SELECT count(*) FROM asset_generation_history').pluck().get(),
    0,
  );

  const duplicateKeyManifest = structuredClone(manifest);
  const canonicalEvidence =
    duplicateKeyManifest.records.assetGenerationHistory[0].output_version_evidence_json;
  const duplicateKeyEvidence = canonicalEvidence.replace(
    `"sha256":"${hash('c')}"`,
    `"sha256":"${hash('f')}","sha256":"${hash('c')}"`,
  );
  assert.notEqual(duplicateKeyEvidence, canonicalEvidence);
  duplicateKeyManifest.records.assetGenerationHistory[0].output_version_evidence_json =
    duplicateKeyEvidence;
  const duplicateKeyZip = new AdmZip(exported.buffer);
  duplicateKeyZip.deleteFile('v2/manifest.json');
  duplicateKeyZip.addFile(
    'v2/manifest.json',
    Buffer.from(JSON.stringify(duplicateKeyManifest, null, 2), 'utf8'),
  );
  const duplicateKeyDestination = new Database(':memory:');
  duplicateKeyDestination.pragma('foreign_keys = ON');
  runMigrationsAndEnsure(duplicateKeyDestination);
  t.after(() => duplicateKeyDestination.close());
  assert.throws(
    () => projectZipService.importDrama(
      duplicateKeyDestination,
      { storage: { local_path: storageRoot(t, 'generation-duplicate-key') } },
      log,
      duplicateKeyZip.toBuffer(),
    ),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID'
      && !JSON.stringify(error).includes(hash('f')),
  );
  assert.equal(duplicateKeyDestination.prepare('SELECT count(*) FROM dramas').pluck().get(), 0);
});
