'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createNarrativeReviewService } = require('../src/narrative/reviews');
const { createEpisodeAdaptationTask } = require('../src/narrative/tasks');
const {
  canonicalNarrativeExecutionRequest,
  narrativeExecutionRequestSha256,
} = require('../src/narrative/execution/request');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  createV2Repositories,
} = require('../src/repositories/v2');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function seedSelection(database) {
  const ids = Object.freeze({
    drama: uid(25000),
    document: uid(25001),
    block: uid(25002),
    selection: uid(25003),
  });
  insertDrama(database, ids.drama, 'Narrative execution fixture');
  database.transaction(() => {
    database.prepare(`
      INSERT INTO source_documents
        (uid, drama_uid, source_type, original_name, encoding, content_sha256,
         full_text, block_count)
      VALUES (?, ?, 'txt', 'chapter.txt', 'utf-8', ?, 'chapter', 1)
    `).run(ids.document, ids.drama, SHA_A);
    database.prepare(`
      INSERT INTO source_blocks
        (uid, document_uid, ordinal, heading_path_json, char_start, char_end,
         text, text_sha256)
      VALUES (?, ?, 0, '[]', 0, 7, 'chapter', ?)
    `).run(ids.block, ids.document, SHA_B);
    database.prepare(`
      INSERT INTO source_selections
        (uid, document_uid, start_block_uid, end_block_uid,
         start_offset, end_offset, selected_text_sha256)
      VALUES (?, ?, ?, ?, 0, 7, ?)
    `).run(ids.selection, ids.document, ids.block, ids.block, SHA_B);
  })();
  return ids;
}

function extractionRequest(ids, operationUid = uid(25010)) {
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

function extractionResult() {
  return {
    taskType: 'NovelExtractionTask',
    schemaVersion: 'novel-extraction.v1',
    promptVersion: 'narrative-execution-fixture.v1',
    inputHash: SHA_A,
    model: { provider: 'synthetic', name: 'fixture-model' },
    parameters: { temperature: 0 },
    rawResponseRef: `response:v1:${uid(25020)}`,
    rawResponseSha256: SHA_B,
    output: {
      schemaVersion: 'novel-extraction.v1',
      characters: [],
      scenes: [],
      props: [],
      relationships: [],
      events: [],
      dialogue: [],
    },
  };
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
      summary: '构造本地测试节拍。',
      rationale: '仅用于执行证据绑定回归。',
      factRefs: [],
    }],
  });
}

function createReviewService(repositories, start = 25100) {
  let next = start;
  return createNarrativeReviewService({
    repositories,
    createUid: () => uid(next++),
  });
}

test('narrative execution reservation is durable, idempotent, and replacement-safe', (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const repositories = createV2Repositories(database);
  const request = extractionRequest(ids);

  const first = repositories.narrativeExecutions.reserve(request, SHA_A);
  assert.equal(first.created, true);
  assert.equal(first.execution.state, 'reserved');
  const repeated = repositories.narrativeExecutions.reserve(request, SHA_A);
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.execution, first.execution);

  assert.throws(
    () => repositories.narrativeExecutions.reserve(
      { ...request, dramaUid: uid(25999) },
      SHA_A,
    ),
    V2RepositoryConflictError,
  );

  database.pragma('recursive_triggers = OFF');
  assert.throws(
    () => database.prepare(`
      INSERT OR REPLACE INTO narrative_task_executions
      SELECT * FROM narrative_task_executions WHERE operation_uid=?
    `).run(request.operationUid),
    /cannot be replaced/i,
  );
  assert.equal(database.prepare('SELECT count(*) AS count FROM narrative_task_executions').get().count, 1);

  const bad = extractionRequest(ids, uid(25011));
  assert.throws(() => database.prepare(`
    INSERT INTO narrative_task_executions
      (operation_uid, drama_uid, source_selection_uid, result_type,
       upstream_result_uid, upstream_result_hash, upstream_envelope_hash,
       upstream_review_uid, request_json, request_sha256, expected_input_hash, state)
    VALUES (?, ?, ?, 'extraction', NULL, NULL, NULL, NULL, ?, ?, ?, 'reserved')
  `).run(
    bad.operationUid,
    bad.dramaUid,
    bad.sourceSelectionUid,
    canonicalNarrativeExecutionRequest(bad),
    'f'.repeat(64),
    SHA_A,
  ), /narrative task execution invalid/i);
  assert.equal(database.prepare('SELECT count(*) AS count FROM narrative_task_executions').get().count, 1);
});

test('narrative execution completion stays readable across human review lifecycle changes', (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const repositories = createV2Repositories(database);
  const reviews = createReviewService(repositories);
  const request = extractionRequest(ids);
  repositories.narrativeExecutions.reserve(request, SHA_A);
  const result = reviews.recordResult({
    dramaUid: ids.drama,
    sourceSelectionUid: ids.selection,
    resultType: 'extraction',
    result: extractionResult(),
  });

  const completed = repositories.narrativeExecutions.complete(request.operationUid, result.uid);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.resultUid, result.uid);
  reviews.reviewResult({ resultUid: result.uid, decision: 'approve', comment: 'reviewed' });
  assert.equal(repositories.narrativeExecutions.get(request.operationUid).state, 'succeeded');
});

test('downstream reservations freeze the immutable approval event and hashes', (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const repositories = createV2Repositories(database);
  const reviews = createReviewService(repositories, 25200);
  const result = reviews.recordResult({
    dramaUid: ids.drama,
    sourceSelectionUid: ids.selection,
    resultType: 'extraction',
    result: extractionResult(),
  });
  const approved = reviews.reviewResult({ resultUid: result.uid, decision: 'approve' });
  const request = {
    schemaVersion: 'narrative-execution-request.v1',
    operationUid: uid(25210),
    dramaUid: ids.drama,
    sourceSelectionUid: ids.selection,
    resultType: 'adaptation',
    upstreamResultUid: approved.result.uid,
    upstreamResultHash: approved.result.resultHash,
    upstreamEnvelopeHash: approved.result.envelopeHash,
    upstreamApprovalRef: approved.approval.reviewRef,
    durationBudget: { targetSeconds: 60, toleranceSeconds: 5 },
    style: { genre: '古装悬疑', tone: '紧张', audience: '成年观众' },
    assetVersions: [],
  };
  const expected = createEpisodeAdaptationTask().complete({
    approvedExtraction: approved.result.result.output,
    approval: approved.approval,
    durationBudget: request.durationBudget,
    style: request.style,
    promptVersion: 'narrative-adaptation.v1',
    model: { provider: 'synthetic', name: 'fixture-model' },
    parameters: { temperature: 0 },
    rawResponseRef: `response:v1:${uid(25213)}`,
    rawResponse: adaptationRawResponse(),
  });
  const reserved = repositories.narrativeExecutions.reserve(
    request,
    expected.inputHash,
  ).execution;
  assert.equal(reserved.requestSha256, narrativeExecutionRequestSha256(request));

  const mismatched = createEpisodeAdaptationTask().complete({
    approvedExtraction: approved.result.result.output,
    approval: approved.approval,
    durationBudget: request.durationBudget,
    style: { ...request.style, genre: '都市悬疑' },
    promptVersion: 'narrative-adaptation.v1',
    model: { provider: 'synthetic', name: 'fixture-model' },
    parameters: { temperature: 0 },
    rawResponseRef: `response:v1:${uid(25212)}`,
    rawResponse: adaptationRawResponse(),
  });
  const mismatchedRecord = reviews.recordResult({
    dramaUid: ids.drama,
    sourceSelectionUid: ids.selection,
    resultType: 'adaptation',
    upstreamResultUid: approved.result.uid,
    result: mismatched,
  });
  assert.throws(
    () => repositories.narrativeExecutions.complete(request.operationUid, mismatchedRecord.uid),
    V2RepositoryConflictError,
  );
  database.exec('DROP TRIGGER v2_narrative_task_executions_validate_update');
  database.prepare(`
    UPDATE narrative_task_executions
    SET state='succeeded', result_uid=?, updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=?
  `).run(mismatchedRecord.uid, request.operationUid);
  assert.throws(
    () => repositories.narrativeExecutions.get(request.operationUid),
    V2RepositoryDataError,
  );

  reviews.reviewResult({ resultUid: result.uid, decision: 'reject', comment: 're-review' });
  assert.throws(
    () => repositories.narrativeExecutions.get(request.operationUid),
    V2RepositoryDataError,
  );

  const forged = { ...request, operationUid: uid(25211), upstreamResultHash: 'c'.repeat(64) };
  assert.throws(
    () => repositories.narrativeExecutions.reserve(forged, expected.inputHash),
    V2RepositoryConflictError,
  );
  assert.equal(database.prepare('SELECT count(*) AS count FROM narrative_task_executions').get().count, 1);
});

test('terminal transitions, recovery, and readback drift fail closed', (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const repositories = createV2Repositories(database);
  const failed = extractionRequest(ids, uid(25300));
  const interrupted = extractionRequest(ids, uid(25301));
  repositories.narrativeExecutions.reserve(failed, SHA_A);
  repositories.narrativeExecutions.reserve(interrupted, SHA_A);

  assert.equal(
    repositories.narrativeExecutions.fail(
      failed.operationUid,
      'NARRATIVE_EXECUTION_PROVIDER_FAILED',
    ).state,
    'failed',
  );
  assert.throws(
    () => repositories.narrativeExecutions.complete(failed.operationUid, uid(25310)),
    V2RepositoryConflictError,
  );
  assert.deepEqual(repositories.narrativeExecutions.recoverInterrupted(), { recoveredCount: 1 });
  assert.equal(repositories.narrativeExecutions.get(interrupted.operationUid).state, 'submission_unknown');

  database.exec('DROP TRIGGER v2_narrative_task_executions_validate_update');
  database.prepare(`
    UPDATE narrative_task_executions SET request_sha256=? WHERE operation_uid=?
  `).run('d'.repeat(64), failed.operationUid);
  assert.throws(
    () => repositories.narrativeExecutions.get(failed.operationUid),
    V2RepositoryDataError,
  );
  assert.throws(
    () => database.prepare('DELETE FROM narrative_task_executions WHERE operation_uid=?')
      .run(interrupted.operationUid),
    /append-only/i,
  );
});
