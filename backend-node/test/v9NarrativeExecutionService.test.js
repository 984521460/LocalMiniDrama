'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const test = require('node:test');

const { createNarrativeExecutionService } = require('../src/narrative/execution');
const { createNarrativeReviewService } = require('../src/narrative/reviews');
const { createEpisodeAdaptationTask } = require('../src/narrative/tasks');
const { createV2Repositories } = require('../src/repositories/v2');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function seedSelection(database) {
  const ids = Object.freeze({
    drama: uid(26000),
    document: uid(26001),
    block: uid(26002),
    selection: uid(26003),
  });
  const text = '第一章：夜雨中的重逢。';
  const textHash = sha256(text);
  insertDrama(database, ids.drama, 'Narrative execution service fixture');
  database.transaction(() => {
    database.prepare(`
      INSERT INTO source_documents
        (uid, drama_uid, source_type, original_name, encoding, content_sha256,
         full_text, block_count)
      VALUES (?, ?, 'txt', 'chapter.txt', 'utf-8', ?, ?, 1)
    `).run(ids.document, ids.drama, textHash, text);
    database.prepare(`
      INSERT INTO source_blocks
        (uid, document_uid, ordinal, heading_path_json, char_start, char_end,
         text, text_sha256)
      VALUES (?, ?, 0, '[]', 0, ?, ?, ?)
    `).run(ids.block, ids.document, Array.from(text).length, text, textHash);
    database.prepare(`
      INSERT INTO source_selections
        (uid, document_uid, start_block_uid, end_block_uid,
         start_offset, end_offset, selected_text_sha256)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(
      ids.selection,
      ids.document,
      ids.block,
      ids.block,
      Array.from(text).length,
      textHash,
    );
  })();
  return ids;
}

function request(ids, operationUid = uid(26010)) {
  return {
    schemaVersion: 'narrative-execution-request.v1',
    operationUid,
    dramaUid: ids.drama,
    sourceSelectionUid: ids.selection,
    resultType: 'extraction',
    upstreamResultUid: null,
    upstreamResultHash: null,
    upstreamEnvelopeHash: null,
    upstreamApprovalRef: null,
    durationBudget: null,
    style: null,
    assetVersions: [],
  };
}

function validRawResponse() {
  return JSON.stringify({
    schemaVersion: 'novel-extraction.v1',
    characters: [],
    scenes: [],
    props: [],
    relationships: [],
    events: [],
    dialogue: [],
  });
}

function adaptationRawResponse() {
  return JSON.stringify({
    schemaVersion: 'episode-adaptation.v1',
    durationSummary: { targetSeconds: 60, toleranceSeconds: 5, totalSeconds: 60 },
    beats: ['hook', 'setup', 'escalation', 'climax', 'cliffhanger'].map((kind, index) => ({
      beatId: `beat-${index + 1}`,
      kind,
      summary: `${kind} summary`,
      classification: 'adaptation',
      inferenceRationale: null,
      estimatedDurationSeconds: 12,
      factRefs: [],
      adaptationDecisionRefs: ['decision-1'],
    })),
    adaptationDecisions: [{
      decisionId: 'decision-1',
      classification: 'adaptation',
      category: 'invented-event',
      summary: '根据空白样例构造测试节拍。',
      rationale: '仅用于本地执行链合同验证。',
      factRefs: [],
    }],
  });
}

function scriptRawResponse() {
  const beatRefs = ['beat-1', 'beat-2', 'beat-3', 'beat-4', 'beat-5'];
  return JSON.stringify({
    schemaVersion: 'script-formatting.v1',
    durationSummary: { totalSeconds: 60 },
    scenes: [{
      sceneId: 'scene-1',
      ordinal: 1,
      heading: { interiorExterior: 'UNKNOWN', location: '未指定', time: '未指定' },
      purpose: '完成五段叙事节拍',
      sceneFactRef: null,
      characterFactRefs: [],
      propFactRefs: [],
      beatRefs,
      adaptationDecisionRefs: ['decision-1'],
      estimatedDurationSeconds: 60,
      entries: [{
        entryId: 'entry-1',
        type: 'action',
        text: '叙事动作依次完成五个节拍。',
        characterFactRefs: [],
        propFactRefs: [],
        beatRefs,
        adaptationDecisionRefs: ['decision-1'],
        durationSeconds: 60,
      }],
    }],
  });
}

function shotRawResponse() {
  return JSON.stringify({
    schemaVersion: 'shot-planning.v1',
    aspectRatio: '16:9',
    durationSummary: { totalSeconds: 60 },
    shots: Array.from({ length: 4 }, (_, index) => ({
      shotId: `shot-${index + 1}`,
      ordinal: index + 1,
      sceneId: 'scene-1',
      entryRefs: ['entry-1'],
      durationSeconds: 15,
      shotSize: 'MS',
      cameraAngle: 'eye_level',
      cameraMovement: 'static',
      composition: '稳定的中景构图',
      action: '人物在雨夜中推进冲突。',
      characterFactRefs: [],
      propFactRefs: [],
      dialogueEntryRefs: [],
      assetVersionRefs: [],
      continuity: {
        transitionFromPrevious: index === 0 ? 'start' : 'cut',
        screenDirection: 'neutral',
        axisStrategy: index === 0 ? 'establish' : 'maintain',
        notes: '保持轴线与视线连续。',
      },
    })),
  });
}

function output(rawResponse = validRawResponse()) {
  return {
    model: { provider: 'synthetic', name: 'fixture-model' },
    parameters: { temperature: 0 },
    promptVersion: 'narrative-extraction.v1',
    rawResponse,
  };
}

function provider(generate) {
  return Object.freeze({ scope: 'configured-text', isAvailable: () => true, generate });
}

function uidFactory(start = 26100) {
  let next = start;
  return () => uid(next++);
}

const ownership = Object.freeze({ accepts() { return true; } });

test('narrative promise control does not execute inherited constructor or species accessors', () => {
  const asyncControlPath = require.resolve('../src/narrative/execution/asyncControl');
  const script = `
    'use strict';
    const control = require(${JSON.stringify(asyncControlPath)});
    const source = Promise.resolve('ok');
    let constructorReads = 0;
    let speciesReads = 0;
    Object.defineProperty(Promise.prototype, 'constructor', {
      configurable: true,
      get() { constructorReads += 1; throw new Error('constructor-sentinel'); },
    });
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      get() { speciesReads += 1; throw new Error('species-sentinel'); },
    });
    const main = (async () => {
      const settled = await control.settleNarrativeProviderPromise(source, 50);
      const rejected = control.rejectNarrativePromise(new Error('fixed'));
      try { await rejected; } catch (error) {
        if (error.message !== 'fixed') throw error;
      }
      process.stdout.write(JSON.stringify({ settled, constructorReads, speciesReads }));
    })();
    control.observeNarrativePromise(main, () => {}, (error) => {
      process.stderr.write(error.stack || error.message);
      process.exitCode = 1;
    });
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    settled: 'ok', constructorReads: 0, speciesReads: 0,
  });
});

test('narrative execution coalesces one provider call and persists pending review atomically', async (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const repositories = createV2Repositories(database);
  let resolveProvider;
  let calls = 0;
  const pending = new Promise((resolve) => { resolveProvider = resolve; });
  const service = createNarrativeExecutionService({
    repositories,
    provider: provider(() => {
      calls += 1;
      return pending;
    }),
    assetOwnership: ownership,
    createUid: uidFactory(),
    timeoutMs: 1000,
  });
  const value = request(ids);
  const first = service.execute(value);
  const second = service.execute({ ...value, assetVersions: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  resolveProvider(output());

  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.execution.state, 'succeeded');
  assert.equal(left.result.status, 'pending_review');
  assert.equal(left.result.currentReviewUid, null);
  assert.equal(right.execution.resultUid, left.execution.resultUid);
  assert.equal(database.prepare('SELECT count(*) AS count FROM narrative_results').get().count, 1);
  assert.equal(database.prepare('SELECT count(*) AS count FROM narrative_review_events').get().count, 0);
  assert.equal(service.get(value.operationUid).result.uid, left.result.uid);

  const replay = await service.execute(value);
  assert.equal(replay.result.uid, left.result.uid);
  assert.equal(calls, 1);
});

test('invalid or hostile provider output fails without persisting narrative evidence', async (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const repositories = createV2Repositories(database);
  let trapReads = 0;
  const hostile = new Proxy(output(), {
    ownKeys() {
      trapReads += 1;
      throw new Error('provider-output-sentinel');
    },
  });
  const service = createNarrativeExecutionService({
    repositories,
    provider: provider(() => hostile),
    assetOwnership: ownership,
    createUid: uidFactory(26200),
  });
  const value = request(ids, uid(26210));
  await assert.rejects(service.execute(value), {
    code: 'NARRATIVE_EXECUTION_OUTPUT_INVALID',
    message: 'Narrative execution failed',
  });
  assert.equal(trapReads, 0);
  assert.equal(repositories.narrativeExecutions.get(value.operationUid).state, 'failed');
  assert.equal(database.prepare('SELECT count(*) AS count FROM narrative_results').get().count, 0);

  let thenCalls = 0;
  const thenable = { ...output('{}'), then() { thenCalls += 1; } };
  const second = createNarrativeExecutionService({
    repositories,
    provider: provider(() => thenable),
    assetOwnership: ownership,
    createUid: uidFactory(26300),
  });
  await assert.rejects(second.execute(request(ids, uid(26310))), {
    code: 'NARRATIVE_EXECUTION_OUTPUT_INVALID',
  });
  assert.equal(thenCalls, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM narrative_results').get().count, 0);
});

test('provider rejection becomes durable submission-unknown and is never retried implicitly', async (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const repositories = createV2Repositories(database);
  let calls = 0;
  const service = createNarrativeExecutionService({
    repositories,
    provider: provider(() => {
      calls += 1;
      return Promise.reject(new Error('synthetic provider failure'));
    }),
    assetOwnership: ownership,
    createUid: uidFactory(26400),
  });
  const value = request(ids, uid(26410));
  await assert.rejects(service.execute(value), {
    code: 'NARRATIVE_EXECUTION_SUBMISSION_UNKNOWN',
  });
  assert.equal(repositories.narrativeExecutions.get(value.operationUid).state, 'submission_unknown');
  await assert.rejects(service.execute(value), {
    code: 'NARRATIVE_EXECUTION_SUBMISSION_UNKNOWN',
  });
  assert.equal(calls, 1);
});

test('missing or drifted trusted source fails before provider invocation and before reservation', async (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const repositories = createV2Repositories(database);
  let calls = 0;
  const service = createNarrativeExecutionService({
    repositories,
    provider: provider(() => {
      calls += 1;
      return output();
    }),
    assetOwnership: ownership,
    createUid: uidFactory(26500),
  });
  database.exec('DROP TRIGGER v2_source_blocks_immutable_content');
  database.prepare('UPDATE source_blocks SET text_sha256=? WHERE uid=?')
    .run('f'.repeat(64), ids.block);
  const value = request(ids, uid(26510));
  await assert.rejects(service.execute(value), {
    code: 'NARRATIVE_EXECUTION_SOURCE_STALE',
  });
  assert.equal(calls, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM narrative_task_executions').get().count, 0);
});

test('source drift during generation fails before result persistence and terminal reads revalidate source', async (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const repositories = createV2Repositories(database);
  let resolveProvider;
  const service = createNarrativeExecutionService({
    repositories,
    provider: provider(() => new Promise((resolve) => { resolveProvider = resolve; })),
    assetOwnership: ownership,
    createUid: uidFactory(26600),
    timeoutMs: 1000,
  });
  const value = request(ids, uid(26610));
  const pending = service.execute(value);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(repositories.narrativeExecutions.get(value.operationUid).state, 'reserved');

  const driftedText = '第一章：来源已漂移。';
  database.exec('DROP TRIGGER v2_source_blocks_immutable_content');
  database.prepare('UPDATE source_blocks SET text=?, text_sha256=? WHERE uid=?')
    .run(driftedText, sha256(driftedText), ids.block);
  resolveProvider(output());
  await assert.rejects(pending, { code: 'NARRATIVE_EXECUTION_SOURCE_STALE' });
  assert.equal(repositories.narrativeExecutions.get(value.operationUid).state, 'failed');
  assert.equal(database.prepare('SELECT count(*) AS count FROM narrative_results').get().count, 0);

  const secondDatabase = createMigratedV2Database(t);
  const secondIds = seedSelection(secondDatabase);
  const secondRepositories = createV2Repositories(secondDatabase);
  const secondService = createNarrativeExecutionService({
    repositories: secondRepositories,
    provider: provider(() => output()),
    assetOwnership: ownership,
    createUid: uidFactory(26700),
  });
  const secondRequest = request(secondIds, uid(26710));
  const completed = await secondService.execute(secondRequest);
  assert.equal(completed.execution.state, 'succeeded');
  secondDatabase.exec('DROP TRIGGER v2_source_blocks_immutable_content');
  secondDatabase.prepare('UPDATE source_blocks SET text=?, text_sha256=? WHERE uid=?')
    .run(driftedText, sha256(driftedText), secondIds.block);
  assert.throws(
    () => secondService.get(secondRequest.operationUid),
    { code: 'NARRATIVE_EXECUTION_SOURCE_STALE' },
  );
});

test('all four narrative stages rebuild and enforce the current approved chain', async (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const repositories = createV2Repositories(database);
  const rawByType = Object.freeze({
    extraction: validRawResponse(),
    adaptation: adaptationRawResponse(),
    script: scriptRawResponse(),
    shot: shotRawResponse(),
  });
  const service = createNarrativeExecutionService({
    repositories,
    provider: provider((command) => output(rawByType[command.resultType])),
    assetOwnership: ownership,
    createUid: uidFactory(27000),
  });
  const reviewService = createNarrativeReviewService({
    repositories,
    createUid: uidFactory(28000),
  });

  const extracted = await service.execute(request(ids, uid(27010)));
  const extraction = reviewService.reviewResult({
    resultUid: extracted.result.uid,
    decision: 'approve',
  });
  const adaptationRequest = {
    ...request(ids, uid(27011)),
    resultType: 'adaptation',
    upstreamResultUid: extraction.result.uid,
    upstreamResultHash: extraction.result.resultHash,
    upstreamEnvelopeHash: extraction.result.envelopeHash,
    upstreamApprovalRef: extraction.approval.reviewRef,
    durationBudget: { targetSeconds: 60, toleranceSeconds: 5 },
    style: { genre: '古装悬疑', tone: '紧张', audience: '成年观众' },
  };
  assert.doesNotThrow(() => createEpisodeAdaptationTask().complete({
    approvedExtraction: extraction.result.result.output,
    approval: extraction.approval,
    durationBudget: adaptationRequest.durationBudget,
    style: adaptationRequest.style,
    promptVersion: 'narrative-extraction.v1',
    model: { provider: 'synthetic', name: 'fixture-model' },
    parameters: { temperature: 0 },
    rawResponseRef: `response:v1:${uid(29999)}`,
    rawResponse: adaptationRawResponse(),
  }));
  const adapted = await service.execute(adaptationRequest);
  const adaptation = reviewService.reviewResult({
    resultUid: adapted.result.uid,
    decision: 'approve',
  });
  const scriptRequest = {
    ...request(ids, uid(27012)),
    resultType: 'script',
    upstreamResultUid: adaptation.result.uid,
    upstreamResultHash: adaptation.result.resultHash,
    upstreamEnvelopeHash: adaptation.result.envelopeHash,
    upstreamApprovalRef: adaptation.approval.reviewRef,
  };
  const scripted = await service.execute(scriptRequest);
  const script = reviewService.reviewResult({
    resultUid: scripted.result.uid,
    decision: 'approve',
  });
  const shotRequest = {
    ...request(ids, uid(27013)),
    resultType: 'shot',
    upstreamResultUid: script.result.uid,
    upstreamResultHash: script.result.resultHash,
    upstreamEnvelopeHash: script.result.envelopeHash,
    upstreamApprovalRef: script.approval.reviewRef,
  };
  const shot = await service.execute(shotRequest);

  assert.equal(shot.result.resultType, 'shot');
  assert.equal(shot.result.status, 'pending_review');
  assert.equal(database.prepare('SELECT count(*) AS count FROM narrative_task_executions').get().count, 4);
  assert.equal(database.prepare('SELECT count(*) AS count FROM narrative_results').get().count, 4);

  reviewService.reviewResult({
    resultUid: extraction.result.uid,
    decision: 'reject',
    comment: 'source approval changed',
  });
  const staleRequest = { ...scriptRequest, operationUid: uid(27014) };
  await assert.rejects(service.execute(staleRequest), {
    code: 'NARRATIVE_EXECUTION_SOURCE_STALE',
  });
  assert.equal(database.prepare('SELECT count(*) AS count FROM narrative_task_executions').get().count, 4);
});
