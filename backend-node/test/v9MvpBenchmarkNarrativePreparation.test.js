'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');
const Ajv2020 = require('ajv/dist/2020');

const {
  createMvpBenchmarkNarrativePreparation,
} = require('../src/benchmark/mvpBenchmarkNarrativePreparation');
const { createNarrativeStalenessService } = require('../src/narrative/staleness');
const { createV2Repositories } = require('../src/repositories/v2');
const {
  DATABASE_RELATIVE_PATH,
  WORKSPACE_NAME,
} = require('../src/benchmark/mvpBenchmarkWorkspace');
const { registerV2SqlFunctions } = require('../src/db/v2/sqlFunctions');
const {
  prepareMvpBenchmarkWorkspace,
} = require('../../scripts/mvp-benchmark-workspace');
const {
  command,
} = require('../scripts/mvp-benchmark-narrative');
const { uid } = require('./helpers/v2RepositoryDatabase');
const statusSchema = require('../../schemas/v9/mvp-benchmark-narrative-status.schema.json');

const SOURCE_ROOT = path.resolve(__dirname, '../../benchmarks/mvp-source');
const validateStatus = new Ajv2020({ allErrors: true, strict: true }).compile(statusSchema);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localminidrama-mvp-narrative-'));
  const dataRoot = path.join(root, 'data');
  const configRoot = path.join(root, 'config');
  const configPath = path.join(configRoot, 'config.yaml');
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(configRoot);
  fs.writeFileSync(configPath, 'server:\n  host: 127.0.0.1\n', { flag: 'wx' });
  let next = 310000;
  const workspace = prepareMvpBenchmarkWorkspace({
    dataRoot,
    configPath,
    sourceRoot: SOURCE_ROOT,
    nowEpochMs: () => 1788566400000,
    createUid: () => uid(next++),
  });
  const databasePath = path.join(dataRoot, WORKSPACE_NAME, DATABASE_RELATIVE_PATH);
  const database = new Database(databasePath, { fileMustExist: true });
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  registerV2SqlFunctions(database);
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return Object.freeze({
    database,
    workspace: Object.freeze({
      workspaceName: workspace.workspaceName,
      sourceId: workspace.sourceId,
      dramaUid: workspace.dramaUid,
      sourceSelectionUid: workspace.sourceSelectionUid,
    }),
  });
}

function createPreparation(current, start = 311000) {
  let next = start;
  return createMvpBenchmarkNarrativePreparation({
    ...current,
    createUid: () => uid(next++),
  });
}

function approvalFor(status) {
  const stage = status.stages[status.stages.length - 1];
  return {
    stage: stage.stage,
    resultUid: stage.resultUid,
    resultHash: stage.resultHash,
    envelopeHash: stage.envelopeHash,
  };
}

test('fixed benchmark narrative advances only through explicit exact stage approvals', async (t) => {
  const current = fixture(t);
  const preparation = createPreparation(current);
  assert.deepEqual(preparation.inspect().stages, []);
  assert.deepEqual(preparation.inspect().history, []);
  assert.equal(preparation.inspect().nextStage, 'extraction');

  const extraction = await preparation.stage('extraction');
  assert.equal(validateStatus(extraction), true, JSON.stringify(validateStatus.errors));
  assert.equal(extraction.status, 'awaiting_review');
  assert.equal(extraction.stages[0].stage, 'extraction');
  assert.equal(extraction.stages[0].status, 'pending_review');
  assert.equal(extraction.stages[0].output.characters.length, 2);
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_results').pluck().get(), 1);
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_review_events').pluck().get(), 0);

  const replay = await preparation.stage('extraction');
  assert.equal(replay.stages[0].resultUid, extraction.stages[0].resultUid);
  await assert.rejects(preparation.stage('adaptation'), {
    code: 'MVP_BENCHMARK_NARRATIVE_INVALID',
  });
  assert.throws(() => preparation.approve({
    ...approvalFor(extraction),
    resultHash: 'f'.repeat(64),
  }), { code: 'MVP_BENCHMARK_NARRATIVE_INVALID' });
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_review_events').pluck().get(), 0);

  let status = preparation.approve(approvalFor(extraction));
  assert.equal(status.status, 'ready_for_next_stage');
  assert.equal(status.nextStage, 'adaptation');
  assert.equal(status.stages[0].status, 'approved');
  assert.match(status.stages[0].approvalRef, /^review:v1:/u);

  for (const stage of ['adaptation', 'script', 'shot']) {
    status = await preparation.stage(stage);
    assert.equal(status.status, 'awaiting_review');
    assert.equal(status.stages[status.stages.length - 1].stage, stage);
    assert.equal(status.stages[status.stages.length - 1].status, 'pending_review');
    status = preparation.approve(approvalFor(status));
  }
  assert.equal(status.status, 'approved_complete');
  assert.equal(validateStatus(status), true, JSON.stringify(validateStatus.errors));
  assert.equal(status.nextStage, null);
  assert.deepEqual(status.stages.map((item) => item.stage), [
    'extraction', 'adaptation', 'script', 'shot',
  ]);
  assert.equal(status.stages[1].output.durationSummary.totalSeconds, 60);
  assert.equal(status.stages[2].output.durationSummary.totalSeconds, 60);
  assert.equal(status.stages[3].output.durationSummary.totalSeconds, 60);
  assert.equal(status.stages[3].output.shots.length, 5);

  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_results').pluck().get(), 4);
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_review_events').pluck().get(), 4);
  assert.deepEqual([
    'workflow_runs', 'remote_connections', 'remote_tasks', 'h3_generation_intents',
    'audio_mode_intents', 'audio_tts_submissions', 'bgm_tracks', 'assets',
    'mvp_benchmark_sessions', 'export_runs',
  ].map((table) => current.database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()),
  new Array(10).fill(0));
});

test('explicit supersession preserves the old work and stages a separately reviewable correction', async (t) => {
  const current = fixture(t);
  const preparation = createPreparation(current, 311500);
  const first = await preparation.stage('extraction');
  const original = first.stages[0];
  const persistedBefore = current.database.prepare(`
    SELECT result_json FROM narrative_results WHERE uid=?
  `).pluck().get(original.resultUid);

  await assert.rejects(preparation.supersede({
    ...approvalFor(first),
    resultHash: 'f'.repeat(64),
  }), { code: 'MVP_BENCHMARK_NARRATIVE_INVALID' });
  assert.equal(current.database.prepare(
    "SELECT count(*) FROM narrative_results WHERE status='stale'",
  ).pluck().get(), 0);

  const replacement = await preparation.supersede(approvalFor(first));
  assert.equal(validateStatus(replacement), true, JSON.stringify(validateStatus.errors));
  assert.equal(replacement.status, 'awaiting_review');
  assert.equal(replacement.stages.length, 1);
  assert.equal(replacement.history.length, 1);
  assert.notEqual(replacement.stages[0].resultUid, original.resultUid);
  assert.equal(replacement.stages[0].status, 'pending_review');
  assert.equal(replacement.history[0].resultUid, original.resultUid);
  assert.equal(replacement.history[0].resultHash, original.resultHash);
  assert.equal(replacement.history[0].envelopeHash, original.envelopeHash);
  assert.deepEqual(replacement.history[0].output, original.output);
  assert.deepEqual(replacement.history[0].reviews, []);
  assert.equal(replacement.history[0].staleEvent.reasonCode, 'narrative_result_superseded');
  assert.equal(replacement.history[0].staleEvent.rootUid, original.resultUid);
  assert.equal(current.database.prepare(`
    SELECT result_json FROM narrative_results WHERE uid=?
  `).pluck().get(original.resultUid), persistedBefore);
  assert.equal(current.database.prepare(`
    SELECT status FROM narrative_results WHERE uid=?
  `).pluck().get(original.resultUid), 'stale');
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_results').pluck().get(), 2);
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_stale_events').pluck().get(), 1);
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_task_executions').pluck().get(), 2);

  const corrected = replacement.stages[0].output;
  assert.equal(corrected.characters[0].evidence[0].quote,
    '修复师林澈抱着一只银色证物箱冲进站内');
  assert.equal(corrected.scenes[0].location, '海城旧车站');
  assert.equal(corrected.scenes[0].time, '暴雨中');
  assert.deepEqual(corrected.scenes[0].evidence.map((item) => item.quote), [
    '暴雨压住海城最后一班列车',
    '旧车站突然断电',
  ]);
  assert.deepEqual(corrected.relationships[0].evidence.map((item) => item.quote), [
    '林澈故意走向三号柜，把箱子放在地上，却用维修钥匙打开旁边的配电井',
    '夏弦借应急灯熄灭的一秒翻过检票闸机，追向控制室',
    '夏弦低声提醒：广播来自站内旧线路，操作者一定还在楼里',
  ]);

  const replay = await preparation.supersede(approvalFor(first));
  assert.equal(replay.stages[0].resultUid, replacement.stages[0].resultUid);
  assert.equal(replay.history.length, 1);
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_results').pluck().get(), 2);
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_stale_events').pluck().get(), 1);
});

test('rejected fixed stage cannot be approved or silently replaced', async (t) => {
  const current = fixture(t);
  const preparation = createPreparation(current, 312000);
  const extraction = await preparation.stage('extraction');
  const stage = extraction.stages[0];
  current.database.prepare(`
    INSERT INTO narrative_review_events
      (uid,result_uid,decision,result_hash,envelope_hash,comment)
    VALUES (?,?,'reject',?,?,?)
  `).run(uid(312900), stage.resultUid, stage.resultHash, stage.envelopeHash, 'Synthetic rejection');
  current.database.prepare(`
    UPDATE narrative_results
    SET status='rejected',current_review_uid=?
    WHERE uid=?
  `).run(uid(312900), stage.resultUid);
  const rejected = preparation.inspect();
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.nextStage, null);
  assert.throws(() => preparation.approve(approvalFor(rejected)), {
    code: 'MVP_BENCHMARK_NARRATIVE_INVALID',
  });
  await assert.rejects(preparation.stage('adaptation'), {
    code: 'MVP_BENCHMARK_NARRATIVE_INVALID',
  });
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_results').pluck().get(), 1);

  const replacement = await preparation.supersede(approvalFor(rejected));
  assert.equal(replacement.history.length, 1);
  assert.equal(replacement.history[0].resultUid, stage.resultUid);
  assert.equal(replacement.history[0].reviews.length, 1);
  assert.equal(replacement.history[0].reviews[0].decision, 'reject');
  assert.equal(replacement.stages[0].status, 'pending_review');
});

test('an interrupted exact supersession resumes without deleting or duplicating work', async (t) => {
  const current = fixture(t);
  const preparation = createPreparation(current, 312500);
  const first = await preparation.stage('extraction');
  const old = approvalFor(first);
  createNarrativeStalenessService({
    repositories: createV2Repositories(current.database),
    createUid: () => uid(312900),
    nowEpochMs: () => 1788566401000,
  }).invalidate({ rootKind: 'narrative_result', rootUid: old.resultUid });

  const interrupted = preparation.inspect();
  assert.equal(interrupted.status, 'replacement_required');
  assert.equal(interrupted.nextStage, null);
  assert.equal(interrupted.stages.length, 0);
  assert.equal(interrupted.history.length, 1);

  const recovered = await preparation.supersede(old);
  assert.equal(recovered.status, 'awaiting_review');
  assert.equal(recovered.stages.length, 1);
  assert.equal(recovered.history.length, 1);
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_results').pluck().get(), 2);
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_stale_events').pluck().get(), 1);
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_task_executions').pluck().get(), 2);
});

test('superseding an approved fact result preserves it and every dependent test work', async (t) => {
  const current = fixture(t);
  const preparation = createPreparation(current, 313500);
  let status = await preparation.stage('extraction');
  const extractionIdentity = approvalFor(status);
  const extractionOutput = status.stages[0].output;
  status = preparation.approve(extractionIdentity);
  status = await preparation.stage('adaptation');
  const adaptation = status.stages[1];

  const replacement = await preparation.supersede(extractionIdentity);
  assert.equal(validateStatus(replacement), true, JSON.stringify(validateStatus.errors));
  assert.equal(replacement.status, 'awaiting_review');
  assert.deepEqual(replacement.stages.map((item) => item.stage), ['extraction']);
  assert.deepEqual(replacement.history.map((item) => item.stage), ['extraction', 'adaptation']);
  assert.deepEqual(replacement.history[0].output, extractionOutput);
  assert.equal(replacement.history[0].reviews.length, 1);
  assert.equal(replacement.history[0].reviews[0].decision, 'approve');
  assert.equal(replacement.history[1].resultUid, adaptation.resultUid);
  assert.deepEqual(replacement.history[1].output, adaptation.output);
  assert.equal(replacement.history[1].reviews.length, 0);
  assert.equal(replacement.history[0].staleEvent.rootUid, extractionIdentity.resultUid);
  assert.equal(replacement.history[1].staleEvent.rootUid, extractionIdentity.resultUid);
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_results').pluck().get(), 3);
  assert.equal(current.database.prepare('SELECT count(*) FROM narrative_stale_events').pluck().get(), 2);
});

test('persisted narrative status fails closed after source evidence drift', async (t) => {
  const current = fixture(t);
  const preparation = createPreparation(current, 313000);
  await preparation.stage('extraction');
  const block = current.database.prepare(`
    SELECT uid FROM source_blocks ORDER BY ordinal LIMIT 1
  `).get();
  current.database.exec('DROP TRIGGER v2_source_blocks_immutable_content');
  current.database.prepare('UPDATE source_blocks SET text_sha256=? WHERE uid=?')
    .run('f'.repeat(64), block.uid);
  assert.throws(() => preparation.inspect(), {
    code: 'MVP_BENCHMARK_NARRATIVE_INVALID',
  });
});

test('narrative CLI accepts only explicit status, stage, and exact approval shapes', () => {
  assert.deepEqual(command(['status']), { kind: 'status' });
  assert.deepEqual(command(['stage', 'extraction']), { kind: 'stage', stage: 'extraction' });
  assert.deepEqual(command(['approve', 'extraction', uid(314000), 'a'.repeat(64), 'b'.repeat(64)]), {
    kind: 'approve',
    stage: 'extraction',
    resultUid: uid(314000),
    resultHash: 'a'.repeat(64),
    envelopeHash: 'b'.repeat(64),
  });
  assert.deepEqual(command(['supersede', 'extraction', uid(314001), 'c'.repeat(64), 'd'.repeat(64)]), {
    kind: 'supersede',
    stage: 'extraction',
    resultUid: uid(314001),
    resultHash: 'c'.repeat(64),
    envelopeHash: 'd'.repeat(64),
  });
  for (const invalid of [
    [], ['approve'], ['supersede'], ['stage'], ['stage', 'extraction', 'extra'], ['approve-all'],
  ]) {
    assert.throws(() => command(invalid), TypeError);
  }
});
