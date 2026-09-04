'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');

const {
  createProductionNarrativeExecutionRuntime,
} = require('../src/narrative/execution/productionRuntime');
const narrativeExecutionRoutes = require('../src/routes/v2/narrativeExecutions');
const narrativeReviewRoutes = require('../src/routes/v2/narrativeReviews');
const {
  selectedTextForSourceSelection,
} = require('../src/narrative/sourceDocuments/evidenceValidator');
const {
  createRainAdaptationOutput,
  createRainExtractionOutput,
  setupRainBeforeClearSource,
  sha256,
  uidFactory,
} = require('./fixtures/narrative/rainBeforeClearSource');
const { uid } = require('./helpers/v2RepositoryDatabase');

function executionRequest(current, operationUid, overrides = {}) {
  return {
    schemaVersion: 'narrative-execution-request.v1',
    operationUid,
    dramaUid: current.dramaUid,
    sourceSelectionUid: current.selection.selection.uid,
    resultType: overrides.resultType || 'extraction',
    upstreamResultUid: overrides.upstreamResultUid ?? null,
    upstreamResultHash: overrides.upstreamResultHash ?? null,
    upstreamEnvelopeHash: overrides.upstreamEnvelopeHash ?? null,
    upstreamApprovalRef: overrides.upstreamApprovalRef ?? null,
    durationBudget: overrides.durationBudget ?? null,
    style: overrides.style ?? null,
    assetVersions: [],
  };
}

async function postJson(url, value) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  return Object.freeze({ response, body: await response.json() });
}

async function createServer(t, current, providerOutput) {
  const calls = [];
  const runtime = createProductionNarrativeExecutionRuntime({
    database: current.database,
    log: Object.freeze({ info() {}, warn() {}, error() {} }),
    dependencies: {
      createUid: uidFactory(191000),
      provider: {
        getConfigFromModelMap() { return { config: { id: 1 } }; },
        getDefaultConfig() { throw new Error('mapped fixture config must win'); },
        generateText(database, log, type, userPrompt, systemPrompt, options) {
          calls.push(Object.freeze({ type, userPrompt, systemPrompt, options }));
          const rawResponse = providerOutput(options.scene_key);
          return Promise.resolve(Object.freeze({
            model: Object.freeze({ provider: 'synthetic', name: 'fixture-model' }),
            parameters: Object.freeze({ temperature: 0, maxTokens: 8192, jsonMode: true }),
            promptVersion: options.prompt_version,
            rawResponse: JSON.stringify(rawResponse),
          }));
        },
      },
    },
  });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const log = Object.freeze({ info() {}, warn() {}, error() {} });
  app.use('/api/v1/v2', narrativeExecutionRoutes(
    current.database,
    log,
    runtime.narrativeTasks,
  ));
  app.use('/api/v1/v2', narrativeReviewRoutes(
    current.database,
    log,
    { createUid: uidFactory(192000) },
  ));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return Object.freeze({
    calls,
    baseUrl: `http://127.0.0.1:${server.address().port}/api/v1/v2`,
  });
}

async function extractAndApprove(current, server, operationUid) {
  const extracted = await postJson(
    `${server.baseUrl}/dramas/${current.dramaId}/narrative-executions`,
    executionRequest(current, operationUid),
  );
  assert.equal(extracted.response.status, 200, JSON.stringify(extracted.body));
  assert.equal(extracted.body.success, true);
  const reviewed = await postJson(
    `${server.baseUrl}/narrative-results/${extracted.body.data.result.uid}/reviews`,
    { decision: 'approve' },
  );
  assert.equal(reviewed.response.status, 201);
  return reviewed.body.data;
}

function adaptationRequest(current, operationUid, approved, overrides = {}) {
  return executionRequest(current, operationUid, {
    resultType: 'adaptation',
    upstreamResultUid: approved.result.uid,
    upstreamResultHash: approved.result.resultHash,
    upstreamEnvelopeHash: approved.result.envelopeHash,
    upstreamApprovalRef: approved.approval.reviewRef,
    durationBudget: overrides.durationBudget || { targetSeconds: 60, toleranceSeconds: 5 },
    style: overrides.style || { genre: '悬疑漫剧', tone: '紧张', audience: '大众' },
  });
}

function replaceSelectedSourceCharacter(current) {
  const selection = current.repositories.sources.getSelection(current.selection.selection.uid);
  const blocks = current.repositories.sources.listBlocks(current.imported.document.uid);
  const selectedIndex = blocks.findIndex((block) => block.uid === selection.startBlockUid);
  assert.notEqual(selectedIndex, -1);
  const points = Array.from(blocks[selectedIndex].text);
  assert.ok(selection.startOffset < points.length);
  points[selection.startOffset] = points[selection.startOffset] === '改' ? '变' : '改';
  const changedText = points.join('');
  const changedBlocks = blocks.map((block, index) => (index === selectedIndex ? {
    ...block,
    text: changedText,
    textSha256: sha256(changedText),
  } : block));
  const fullText = changedBlocks.map((block) => block.text).join('');
  const selectedText = selectedTextForSourceSelection(changedBlocks, selection);

  current.database.exec(`
    DROP TRIGGER v2_source_documents_immutable_evidence;
    DROP TRIGGER v2_source_blocks_immutable_content;
    DROP TRIGGER v2_source_selections_immutable_evidence;
  `);
  current.database.transaction(() => {
    current.database.prepare('UPDATE source_blocks SET text=?, text_sha256=? WHERE uid=?')
      .run(changedText, sha256(changedText), blocks[selectedIndex].uid);
    current.database.prepare('UPDATE source_documents SET full_text=?, content_sha256=? WHERE uid=?')
      .run(fullText, sha256(fullText), current.imported.document.uid);
    current.database.prepare('UPDATE source_selections SET selected_text_sha256=? WHERE uid=?')
      .run(sha256(selectedText), selection.uid);
  })();
}

test('the production narrative chain generates and reopens one exact one-minute beat plan', async (t) => {
  const current = setupRainBeforeClearSource(t, 190000);
  const server = await createServer(t, current, (sceneKey) => {
    if (sceneKey === 'narrative_extraction') {
      return createRainExtractionOutput(current.imported.blocks);
    }
    if (sceneKey === 'narrative_adaptation') return createRainAdaptationOutput();
    throw new Error('unexpected narrative task');
  });
  const approved = await extractAndApprove(current, server, uid(193000));
  const request = adaptationRequest(current, uid(193001), approved);
  const generated = await postJson(
    `${server.baseUrl}/dramas/${current.dramaId}/narrative-executions`,
    request,
  );
  assert.equal(generated.response.status, 200);
  assert.equal(generated.body.success, true);
  assert.equal(generated.body.data.execution.state, 'succeeded');
  assert.equal(generated.body.data.result.status, 'pending_review');
  const output = generated.body.data.result.result.output;
  assert.deepEqual(output.durationSummary, {
    targetSeconds: 60,
    toleranceSeconds: 5,
    totalSeconds: 60,
  });
  assert.deepEqual(output.beats.map((beat) => beat.kind), [
    'hook', 'setup', 'escalation', 'climax', 'cliffhanger',
  ]);
  assert.deepEqual(output.beats.map((beat) => beat.classification), [
    'fact', 'inference', 'adaptation', 'adaptation', 'adaptation',
  ]);
  assert.equal(
    output.beats.reduce((sum, beat) => sum + beat.estimatedDurationSeconds, 0),
    60,
  );
  assert.equal(output.adaptationDecisions.length, 1);
  assert.deepEqual(server.calls.map((call) => call.options.scene_key), [
    'narrative_extraction', 'narrative_adaptation',
  ]);
  const providerPrompt = JSON.parse(server.calls[1].userPrompt);
  assert.equal(providerPrompt.task, 'adaptation');
  assert.deepEqual(providerPrompt.input.domain.durationBudget, {
    targetSeconds: 60,
    toleranceSeconds: 5,
  });
  assert.ok(providerPrompt.input.domain.approvedExtraction.events.some(
    (event) => event.factId === 'event-restore-power',
  ));

  const retried = await postJson(
    `${server.baseUrl}/dramas/${current.dramaId}/narrative-executions`,
    request,
  );
  assert.equal(retried.response.status, 200);
  assert.equal(retried.body.data.result.uid, generated.body.data.result.uid);
  assert.equal(server.calls.length, 2);
  const reopened = await fetch(
    `${server.baseUrl}/narrative-executions/${request.operationUid}`,
  ).then((response) => response.json());
  assert.equal(reopened.data.result.uid, generated.body.data.result.uid);
  assert.deepEqual(reopened.data.result.result.output.beats, output.beats);
  const comparison = await fetch(
    `${server.baseUrl}/narrative-results/${generated.body.data.result.uid}/adaptation-comparison`,
  ).then((response) => response.json());
  assert.equal(comparison.success, true);
  assert.equal(comparison.data.durationSummary.totalSeconds, 60);
  assert.equal(comparison.data.beats.length, 5);
  assert.equal(current.database.prepare(
    'SELECT count(*) AS count FROM narrative_task_executions',
  ).get().count, 2);
  assert.equal(current.database.prepare(
    'SELECT count(*) AS count FROM narrative_results',
  ).get().count, 2);
});

test('invalid budgets and out-of-budget provider output cannot create an adaptation result', async (t) => {
  const current = setupRainBeforeClearSource(t, 194000);
  const invalidAdaptation = structuredClone(createRainAdaptationOutput());
  invalidAdaptation.beats[4].estimatedDurationSeconds = 25;
  invalidAdaptation.durationSummary.totalSeconds = 75;
  const server = await createServer(t, current, (sceneKey) => (
    sceneKey === 'narrative_extraction'
      ? createRainExtractionOutput(current.imported.blocks)
      : invalidAdaptation
  ));
  const approved = await extractAndApprove(current, server, uid(195000));
  const badBudget = adaptationRequest(current, uid(195001), approved, {
    durationBudget: { targetSeconds: 44, toleranceSeconds: 5 },
  });
  const rejectedBudget = await postJson(
    `${server.baseUrl}/dramas/${current.dramaId}/narrative-executions`,
    badBudget,
  );
  assert.equal(rejectedBudget.response.status, 400);
  assert.equal(rejectedBudget.body.error.code, 'NARRATIVE_EXECUTION_INPUT_INVALID');
  assert.equal(server.calls.length, 1);

  const rejectedOutput = await postJson(
    `${server.baseUrl}/dramas/${current.dramaId}/narrative-executions`,
    adaptationRequest(current, uid(195002), approved),
  );
  assert.equal(rejectedOutput.response.status, 422);
  assert.equal(rejectedOutput.body.error.code, 'NARRATIVE_EXECUTION_OUTPUT_INVALID');
  assert.equal(server.calls.length, 2);
  assert.equal(current.database.prepare(
    "SELECT count(*) AS count FROM narrative_results WHERE result_type='adaptation'",
  ).get().count, 0);
  assert.deepEqual(current.database.prepare(`
    SELECT state, error_code AS errorCode
    FROM narrative_task_executions
    WHERE operation_uid=?
  `).get(uid(195002)), {
    state: 'failed',
    errorCode: 'NARRATIVE_EXECUTION_OUTPUT_INVALID',
  });
});

test('current source drift blocks one-minute adaptation before a provider call', async (t) => {
  const current = setupRainBeforeClearSource(t, 196000);
  const server = await createServer(t, current, (sceneKey) => (
    sceneKey === 'narrative_extraction'
      ? createRainExtractionOutput(current.imported.blocks)
      : createRainAdaptationOutput()
  ));
  const approved = await extractAndApprove(current, server, uid(197000));
  current.database.exec('DROP TRIGGER v2_source_documents_immutable_evidence');
  current.database.prepare('UPDATE source_documents SET content_sha256=? WHERE uid=?')
    .run('f'.repeat(64), current.imported.document.uid);
  const rejected = await postJson(
    `${server.baseUrl}/dramas/${current.dramaId}/narrative-executions`,
    adaptationRequest(current, uid(197001), approved),
  );
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, 'NARRATIVE_EXECUTION_SOURCE_STALE');
  assert.equal(server.calls.length, 1);
  assert.equal(current.database.prepare(
    "SELECT count(*) AS count FROM narrative_results WHERE result_type='adaptation'",
  ).get().count, 0);
});

test('a coherently rewritten selection cannot reuse an approval from the prior source', async (t) => {
  const current = setupRainBeforeClearSource(t, 198000);
  const server = await createServer(t, current, (sceneKey) => (
    sceneKey === 'narrative_extraction'
      ? createRainExtractionOutput(current.imported.blocks)
      : createRainAdaptationOutput()
  ));
  const approved = await extractAndApprove(current, server, uid(199000));
  replaceSelectedSourceCharacter(current);
  const rejected = await postJson(
    `${server.baseUrl}/dramas/${current.dramaId}/narrative-executions`,
    adaptationRequest(current, uid(199001), approved),
  );
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, 'NARRATIVE_EXECUTION_SOURCE_STALE');
  assert.equal(server.calls.length, 1);
  assert.equal(current.database.prepare(
    "SELECT count(*) AS count FROM narrative_results WHERE result_type='adaptation'",
  ).get().count, 0);
});
