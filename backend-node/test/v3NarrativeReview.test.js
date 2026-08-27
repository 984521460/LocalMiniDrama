const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const express = require('express');

const { createNarrativeReviewService } = require('../src/narrative/reviews');
const { createV2Repositories } = require('../src/repositories/v2');
const narrativeReviewRoutes = require('../src/routes/v2/narrativeReviews');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const TASKS = Object.freeze({
  extraction: Object.freeze({ taskType: 'NovelExtractionTask', schemaVersion: 'novel-extraction.v1' }),
  adaptation: Object.freeze({ taskType: 'EpisodeAdaptationTask', schemaVersion: 'episode-adaptation.v1' }),
  script: Object.freeze({ taskType: 'ScriptFormattingTask', schemaVersion: 'script-formatting.v1' }),
  shot: Object.freeze({ taskType: 'ShotPlanningTask', schemaVersion: 'shot-planning.v1' }),
});

function seedSelection(database) {
  const ids = Object.freeze({
    drama: uid(3000),
    document: uid(3001),
    block: uid(3002),
    selection: uid(3003),
  });
  insertDrama(database, ids.drama, 'Narrative review drama');
  database.transaction(() => {
    database.prepare(`
      INSERT INTO source_documents
        (uid, drama_uid, source_type, original_name, encoding, content_sha256, full_text, block_count)
      VALUES (?, ?, 'txt', 'fixture.txt', 'utf-8', ?, 'fixture', 1)
    `).run(ids.document, ids.drama, SHA_A);
    database.prepare(`
      INSERT INTO source_blocks
        (uid, document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256)
      VALUES (?, ?, 0, '[]', 0, 7, 'fixture', ?)
    `).run(ids.block, ids.document, SHA_B);
    database.prepare(`
      INSERT INTO source_selections
        (uid, document_uid, start_block_uid, end_block_uid, start_offset, end_offset, selected_text_sha256)
      VALUES (?, ?, ?, ?, 0, 7, ?)
    `).run(ids.selection, ids.document, ids.block, ids.block, SHA_B);
  })();
  return ids;
}

function createUidFactory(start = 3100) {
  let next = start;
  return () => uid(next++);
}

function taskResult(type, audit = {}) {
  const outputs = {
    extraction: {
      schemaVersion: 'novel-extraction.v1',
      characters: [], scenes: [], props: [], relationships: [], events: [], dialogue: [],
    },
    adaptation: {
      schemaVersion: 'episode-adaptation.v1',
      durationSummary: { targetSeconds: 60, toleranceSeconds: 0, totalSeconds: 60 },
      beats: ['hook', 'setup', 'escalation', 'climax', 'cliffhanger'].map((kind, index) => ({
        beatId: `beat-${index + 1}`,
        kind,
        summary: `${kind} summary`,
        classification: 'fact',
        inferenceRationale: null,
        estimatedDurationSeconds: 12,
        factRefs: ['fact-a'],
        adaptationDecisionRefs: [],
      })),
      adaptationDecisions: [],
    },
    script: {
      schemaVersion: 'script-formatting.v1',
      durationSummary: { totalSeconds: 60 },
      scenes: [{
        sceneId: 'scene-1', ordinal: 1,
        heading: { interiorExterior: 'UNKNOWN', location: 'Courtyard', time: 'Night' },
        purpose: 'Confrontation', sceneFactRef: null,
        characterFactRefs: [], propFactRefs: [],
        beatRefs: ['beat-1'], adaptationDecisionRefs: ['decision-a'],
        estimatedDurationSeconds: 60,
        entries: [{
          entryId: 'entry-1', type: 'action', text: 'They confront each other.',
          characterFactRefs: [], propFactRefs: [], beatRefs: ['beat-1'],
          adaptationDecisionRefs: [], durationSeconds: 60,
        }],
      }],
    },
    shot: {
      schemaVersion: 'shot-planning.v1', aspectRatio: '16:9',
      durationSummary: { totalSeconds: 60 },
      shots: Array.from({ length: 4 }, (_, index) => ({
        shotId: `shot-${index + 1}`, ordinal: index + 1, sceneId: 'scene-1',
        entryRefs: ['entry-1'], durationSeconds: 15, shotSize: 'MS',
        cameraAngle: 'eye_level', cameraMovement: 'static',
        composition: 'Balanced two shot', action: 'The confrontation continues.',
        characterFactRefs: [], propFactRefs: [], dialogueEntryRefs: [], assetVersionRefs: [],
        continuity: {
          transitionFromPrevious: index === 0 ? 'start' : 'cut',
          screenDirection: 'neutral', axisStrategy: index === 0 ? 'establish' : 'maintain',
          notes: 'Maintain eyeline.',
        },
      })),
    },
  };
  return {
    taskType: TASKS[type].taskType,
    schemaVersion: TASKS[type].schemaVersion,
    promptVersion: 'fixture-prompt.v1',
    inputHash: SHA_A,
    model: { provider: 'synthetic', name: 'fixture-model' },
    parameters: { temperature: 0 },
    rawResponseRef: `response:v1:${uid(3999)}`,
    rawResponseSha256: SHA_B,
    ...audit,
    output: outputs[type],
  };
}

function recordAndApprove(service, ids, type, upstream) {
  const audit = {};
  if (type === 'adaptation') {
    audit.upstreamResultHash = upstream.result.resultHash;
    audit.approvalRef = upstream.approval.reviewRef;
    audit.durationBudget = { targetSeconds: 60, toleranceSeconds: 0 };
    audit.style = { genre: 'drama', tone: 'tense', audience: 'general' };
  } else if (type === 'script') {
    audit.upstreamExtractionHash = upstream.extraction.result.resultHash;
    audit.upstreamAdaptationHash = upstream.adaptation.result.resultHash;
    audit.extractionApprovalRef = upstream.extraction.approval.reviewRef;
    audit.adaptationApprovalRef = upstream.adaptation.approval.reviewRef;
  } else if (type === 'shot') {
    audit.upstreamScriptHash = upstream.result.resultHash;
    audit.scriptApprovalRef = upstream.approval.reviewRef;
    audit.assetCatalogHash = SHA_A;
  }
  const result = service.recordResult({
    dramaUid: ids.drama,
    sourceSelectionUid: ids.selection,
    resultType: type,
    ...(upstream?.result ? { upstreamResultUid: upstream.result.uid } : {}),
    ...(type === 'script' ? { upstreamResultUid: upstream.adaptation.result.uid } : {}),
    result: taskResult(type, audit),
  });
  const reviewed = service.reviewResult({ resultUid: result.uid, decision: 'approve', comment: `${type} approved` });
  return reviewed;
}

function createApprovedChain(database, ids, start = 3600) {
  const service = createNarrativeReviewService({
    repositories: createV2Repositories(database),
    createUid: createUidFactory(start),
  });
  const extraction = recordAndApprove(service, ids, 'extraction');
  const adaptation = recordAndApprove(service, ids, 'adaptation', extraction);
  const script = recordAndApprove(service, ids, 'script', { extraction, adaptation });
  const shot = recordAndApprove(service, ids, 'shot', script);
  return Object.freeze({ service, extraction, adaptation, script, shot });
}

function replaceApprovalWithRawSql(database, reviewedResult, reviewUid) {
  database.prepare(`
    INSERT INTO narrative_review_events
      (uid, result_uid, decision, result_hash, envelope_hash, comment)
    VALUES (?, ?, 'approve', ?, ?, 'synthetic raw approval')
  `).run(
    reviewUid,
    reviewedResult.result.uid,
    reviewedResult.result.resultHash,
    reviewedResult.result.envelopeHash,
  );
  database.prepare(`
    UPDATE narrative_results
    SET status = 'approved', current_review_uid = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = ?
  `).run(reviewUid, reviewedResult.result.uid);
}

test('migration creates append-only narrative result and review tables at version five', (t) => {
  const database = createMigratedV2Database(t);
  assert.deepEqual(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'narrative_%' ORDER BY name").all(),
    [
      { name: 'narrative_results' },
      { name: 'narrative_review_events' },
      { name: 'narrative_stale_events' },
    ],
  );
  assert.equal(database.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 5);
});

test('service records and approves the four-result chain with immutable review evidence', (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const service = createNarrativeReviewService({
    repositories: createV2Repositories(database),
    createUid: createUidFactory(),
  });

  const extraction = recordAndApprove(service, ids, 'extraction');
  const adaptation = recordAndApprove(service, ids, 'adaptation', extraction);
  const script = recordAndApprove(service, ids, 'script', { extraction, adaptation });
  const shot = recordAndApprove(service, ids, 'shot', script);

  assert.deepEqual(service.listForDrama(1).map((item) => item.resultType), [
    'extraction', 'adaptation', 'script', 'shot',
  ]);
  const detail = service.getResult(shot.result.uid);
  assert.equal(detail.result.status, 'approved');
  assert.equal(detail.reviews.length, 1);
  assert.deepEqual(service.requireApproved(shot.result.uid, 'shot').approval, shot.approval);
  assert.match(shot.approval.reviewRef, /^review:v1:[0-9a-f-]{36}$/u);

  assert.throws(
    () => database.prepare("UPDATE narrative_results SET result_json = '{}' WHERE uid = ?").run(shot.result.uid),
    /immutable/i,
  );
  assert.throws(
    () => database.prepare('DELETE FROM narrative_review_events WHERE uid = ?').run(detail.reviews[0].uid),
    /append-only/i,
  );

  service.reviewResult({ resultUid: adaptation.result.uid, decision: 'reject', comment: 'replace adaptation' });
  assert.equal(service.getResult(script.result.uid).result.status, 'stale');
  assert.equal(service.getResult(shot.result.uid).result.status, 'stale');
  assert.throws(() => service.requireApproved(shot.result.uid, 'shot'), {
    code: 'NARRATIVE_REVIEW_STALE',
  });
});

test('unapproved, rejected, stale, or ancestor-invalid results cannot enter downstream work', (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const service = createNarrativeReviewService({
    repositories: createV2Repositories(database),
    createUid: createUidFactory(3200),
  });
  const extraction = service.recordResult({
    dramaUid: ids.drama,
    sourceSelectionUid: ids.selection,
    resultType: 'extraction',
    result: taskResult('extraction'),
  });
  assert.throws(() => service.requireApproved(extraction.uid), { code: 'NARRATIVE_REVIEW_NOT_APPROVED' });
  assert.throws(
    () => service.recordResult({
      dramaUid: ids.drama,
      sourceSelectionUid: ids.selection,
      resultType: 'adaptation',
      upstreamResultUid: extraction.uid,
      result: taskResult('adaptation', {
        upstreamResultHash: SHA_A,
        approvalRef: `review:v1:${uid(3900)}`,
        durationBudget: { targetSeconds: 60, toleranceSeconds: 0 },
        style: { genre: 'drama', tone: 'tense', audience: 'general' },
      }),
    }),
    { code: 'NARRATIVE_REVIEW_NOT_APPROVED' },
  );

  const approvedExtraction = service.reviewResult({ resultUid: extraction.uid, decision: 'approve' });
  const adaptation = recordAndApprove(service, ids, 'adaptation', approvedExtraction);
  service.reviewResult({ resultUid: extraction.uid, decision: 'reject', comment: 'fact needs correction' });
  assert.throws(() => service.requireApproved(adaptation.result.uid), { code: 'NARRATIVE_REVIEW_STALE' });

  const reapprovedExtraction = service.reviewResult({
    resultUid: extraction.uid,
    decision: 'approve',
    comment: 'new approval decision',
  });
  assert.notEqual(reapprovedExtraction.approval.reviewRef, approvedExtraction.approval.reviewRef);
  assert.throws(() => service.requireApproved(adaptation.result.uid), { code: 'NARRATIVE_REVIEW_STALE' });

  database.prepare("UPDATE narrative_results SET status = 'stale' WHERE uid = ?").run(adaptation.result.uid);
  assert.throws(() => service.requireApproved(adaptation.result.uid), { code: 'NARRATIVE_REVIEW_STALE' });
  assert.throws(
    () => service.reviewResult({ resultUid: adaptation.result.uid, decision: 'approve' }),
    { code: 'NARRATIVE_REVIEW_STALE' },
  );
});

test('database review-state transitions recursively stale every approved descendant', (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const chain = createApprovedChain(database, ids, 3600);

  replaceApprovalWithRawSql(database, chain.extraction, uid(3699));

  const states = database.prepare(`
    SELECT uid, status, current_review_uid
    FROM narrative_results
    WHERE uid IN (?, ?, ?)
    ORDER BY CASE uid WHEN ? THEN 1 WHEN ? THEN 2 ELSE 3 END
  `).all(
    chain.adaptation.result.uid,
    chain.script.result.uid,
    chain.shot.result.uid,
    chain.adaptation.result.uid,
    chain.script.result.uid,
  );
  assert.deepEqual(states, [
    { uid: chain.adaptation.result.uid, status: 'stale', current_review_uid: null },
    { uid: chain.script.result.uid, status: 'stale', current_review_uid: null },
    { uid: chain.shot.result.uid, status: 'stale', current_review_uid: null },
  ]);
});

test('service fails closed on approved descendants whose ancestor audit binding changed', (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const chain = createApprovedChain(database, ids, 3700);

  database.exec('DROP TRIGGER v2_narrative_results_stale_descendants');
  replaceApprovalWithRawSql(database, chain.extraction, uid(3799));

  assert.throws(() => chain.service.listForDrama(1), {
    code: 'NARRATIVE_REVIEW_NOT_APPROVED',
  });
  assert.throws(() => chain.service.getResult(chain.shot.result.uid), {
    code: 'NARRATIVE_REVIEW_NOT_APPROVED',
  });
  assert.throws(
    () => chain.service.reviewResult({ resultUid: chain.shot.result.uid, decision: 'approve' }),
    { code: 'NARRATIVE_REVIEW_NOT_APPROVED' },
  );
});

test('service rejects malformed identities, task mismatches, hostile JSON, and forged audit links', (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const service = createNarrativeReviewService({
    repositories: createV2Repositories(database),
    createUid: createUidFactory(3300),
  });
  assert.throws(() => service.getResult('not-a-uuid'), { code: 'NARRATIVE_REVIEW_INPUT_INVALID' });
  assert.throws(
    () => service.recordResult({
      dramaUid: ids.drama,
      sourceSelectionUid: ids.selection,
      resultType: 'shot',
      result: taskResult('extraction'),
    }),
    { code: 'NARRATIVE_REVIEW_INPUT_INVALID' },
  );
  const hostile = taskResult('extraction');
  Object.defineProperty(hostile, 'output', { enumerable: true, get() { throw new Error('must not run'); } });
  assert.throws(
    () => service.recordResult({
      dramaUid: ids.drama,
      sourceSelectionUid: ids.selection,
      resultType: 'extraction',
      result: hostile,
    }),
    { code: 'NARRATIVE_REVIEW_INPUT_INVALID' },
  );

  const pending = service.recordResult({
    dramaUid: ids.drama,
    sourceSelectionUid: ids.selection,
    resultType: 'extraction',
    result: taskResult('extraction'),
  });
  for (const [index, conflictPolicy] of ['', 'OR IGNORE', 'OR FAIL', 'OR REPLACE'].entries()) {
    assert.throws(
      () => database.prepare(`
        INSERT ${conflictPolicy} INTO narrative_results
          (uid, drama_uid, source_selection_uid, result_type, task_type, schema_version,
           input_hash, result_hash, envelope_hash, result_json, upstream_result_uid,
           status, current_review_uid)
        SELECT ?, drama_uid, source_selection_uid, result_type, task_type, schema_version,
          input_hash, result_hash, envelope_hash, result_json, upstream_result_uid,
          'approved', ?
        FROM narrative_results WHERE uid = ?
      `).run(uid(3390 + index), uid(3380 + index), pending.uid),
      /pending/i,
    );
  }

  database.exec('DROP TRIGGER v2_narrative_results_require_initial_pending_state');
  database.prepare(`
    INSERT INTO narrative_results
      (uid, drama_uid, source_selection_uid, result_type, task_type, schema_version,
       input_hash, result_hash, envelope_hash, result_json, upstream_result_uid,
       status, current_review_uid)
    SELECT ?, drama_uid, source_selection_uid, result_type, task_type, schema_version,
      input_hash, result_hash, envelope_hash, result_json, upstream_result_uid,
      'approved', ?
    FROM narrative_results WHERE uid = ?
  `).run(uid(3392), uid(3393), pending.uid);
  assert.throws(() => service.listForDrama(1), { code: 'NARRATIVE_REVIEW_DATA_INVALID' });
});

test('localhost API lists review evidence and records approve/reject decisions without a public result writer', async (t) => {
  const database = createMigratedV2Database(t);
  const ids = seedSelection(database);
  const repositories = createV2Repositories(database);
  const service = createNarrativeReviewService({ repositories, createUid: createUidFactory(3400) });
  const result = service.recordResult({
    dramaUid: ids.drama,
    sourceSelectionUid: ids.selection,
    resultType: 'extraction',
    result: taskResult('extraction'),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/v2', narrativeReviewRoutes(database, { error() {} }, { createUid: createUidFactory(3500) }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/api/v1/v2`;

  const listResponse = await fetch(`${base}/dramas/1/narrative-results`);
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json()).data[0].uid, result.uid);

  const reviewResponse = await fetch(`${base}/narrative-results/${result.uid}/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', comment: 'evidence checked' }),
  });
  assert.equal(reviewResponse.status, 201);
  assert.equal((await reviewResponse.json()).data.approval.status, 'approved');

  const detailResponse = await fetch(`${base}/narrative-results/${result.uid}`);
  assert.equal(detailResponse.status, 200);
  assert.equal((await detailResponse.json()).data.reviews.length, 1);

  const noWriter = await fetch(`${base}/narrative-results`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(noWriter.status, 404);
});
