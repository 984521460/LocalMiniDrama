'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Ajv = require('ajv/dist/2020');
const express = require('express');

const scriptSchema = require('../../schemas/v3/script-formatting.schema.json');
const shotSchema = require('../../schemas/v3/shot-planning.schema.json');
const {
  createProductionNarrativeExecutionRuntime,
} = require('../src/narrative/execution/productionRuntime');
const narrativeExecutionRoutes = require('../src/routes/v2/narrativeExecutions');
const narrativeReviewRoutes = require('../src/routes/v2/narrativeReviews');
const {
  createRainAdaptationOutput,
  createRainExtractionOutput,
  createRainScriptOutput,
  createRainShotOutput,
  setupRainBeforeClearSource,
  uidFactory,
} = require('./fixtures/narrative/rainBeforeClearSource');
const { uid } = require('./helpers/v2RepositoryDatabase');

const ajv = new Ajv({ allErrors: true, strict: true });
const validateScriptSchema = ajv.compile(scriptSchema);
const validateShotSchema = ajv.compile(shotSchema);

function request(current, operationUid, resultType, upstream = null) {
  return {
    schemaVersion: 'narrative-execution-request.v1',
    operationUid,
    dramaUid: current.dramaUid,
    sourceSelectionUid: current.selection.selection.uid,
    resultType,
    upstreamResultUid: upstream?.result.uid || null,
    upstreamResultHash: upstream?.result.resultHash || null,
    upstreamEnvelopeHash: upstream?.result.envelopeHash || null,
    upstreamApprovalRef: upstream?.approval.reviewRef || null,
    durationBudget: resultType === 'adaptation'
      ? { targetSeconds: 60, toleranceSeconds: 5 } : null,
    style: resultType === 'adaptation'
      ? { genre: '悬疑漫剧', tone: '紧张', audience: '大众' } : null,
    assetVersions: [],
  };
}

async function jsonRequest(url, method, value) {
  const response = await fetch(url, {
    method,
    ...(value === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    }),
  });
  return Object.freeze({ response, body: await response.json() });
}

async function createServer(t, current, outputForScene) {
  const calls = [];
  const runtime = createProductionNarrativeExecutionRuntime({
    database: current.database,
    log: Object.freeze({ info() {}, warn() {}, error() {} }),
    dependencies: {
      createUid: uidFactory(211000),
      provider: {
        getConfigFromModelMap() { return { config: { id: 1 } }; },
        getDefaultConfig() { throw new Error('mapped fixture config must win'); },
        generateText(database, log, type, userPrompt, systemPrompt, options) {
          calls.push(Object.freeze({ type, userPrompt, systemPrompt, options }));
          return Promise.resolve(Object.freeze({
            model: Object.freeze({ provider: 'synthetic', name: 'fixture-model' }),
            parameters: Object.freeze({ temperature: 0, maxTokens: 8192, jsonMode: true }),
            promptVersion: options.prompt_version,
            rawResponse: JSON.stringify(outputForScene(options.scene_key)),
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
    { createUid: uidFactory(212000) },
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

async function execute(server, current, value) {
  return jsonRequest(
    `${server.baseUrl}/dramas/${current.dramaId}/narrative-executions`,
    'POST',
    value,
  );
}

async function approve(server, result) {
  const reviewed = await jsonRequest(
    `${server.baseUrl}/narrative-results/${result.uid}/reviews`,
    'POST',
    { decision: 'approve' },
  );
  assert.equal(reviewed.response.status, 201, JSON.stringify(reviewed.body));
  return reviewed.body.data;
}

async function executeAndApprove(server, current, value) {
  const generated = await execute(server, current, value);
  assert.equal(generated.response.status, 200, JSON.stringify(generated.body));
  assert.equal(generated.body.data.result.status, 'pending_review');
  const approved = await approve(server, generated.body.data.result);
  return Object.freeze({ approved, generated, request: value });
}

function validOutputs(current) {
  return Object.freeze({
    narrative_extraction: createRainExtractionOutput(current.imported.blocks),
    narrative_adaptation: createRainAdaptationOutput(),
    narrative_script: createRainScriptOutput(),
    narrative_shot: createRainShotOutput(),
  });
}

async function prepareApprovedAdaptation(t, start, outputOverride = {}) {
  const current = setupRainBeforeClearSource(t, start);
  const outputs = { ...validOutputs(current), ...outputOverride };
  const server = await createServer(t, current, (sceneKey) => outputs[sceneKey]);
  const extraction = await executeAndApprove(
    server,
    current,
    request(current, uid(start + 100), 'extraction'),
  );
  const adaptation = await executeAndApprove(
    server,
    current,
    request(current, uid(start + 101), 'adaptation', extraction.approved),
  );
  return Object.freeze({ current, outputs, server, extraction, adaptation });
}

test('the production chain persists Schema-valid structured script and shot results', async (t) => {
  const fixture = await prepareApprovedAdaptation(t, 210000);
  const script = await executeAndApprove(
    fixture.server,
    fixture.current,
    request(fixture.current, uid(210102), 'script', fixture.adaptation.approved),
  );
  const shotRequest = request(fixture.current, uid(210103), 'shot', script.approved);
  const shot = await execute(fixture.server, fixture.current, shotRequest);
  assert.equal(shot.response.status, 200, JSON.stringify(shot.body));
  assert.equal(shot.body.data.result.status, 'pending_review');

  const scriptOutput = script.generated.body.data.result.result.output;
  const shotOutput = shot.body.data.result.result.output;
  assert.equal(validateScriptSchema(scriptOutput), true, JSON.stringify(validateScriptSchema.errors));
  assert.equal(validateShotSchema(shotOutput), true, JSON.stringify(validateShotSchema.errors));
  assert.equal(scriptOutput.durationSummary.totalSeconds, 60);
  assert.equal(scriptOutput.scenes.length, 2);
  assert.equal(shotOutput.durationSummary.totalSeconds, 60);
  assert.equal(shotOutput.shots.length, 5);
  assert.deepEqual(shotOutput.shots.map((item) => item.ordinal), [1, 2, 3, 4, 5]);
  assert.deepEqual(fixture.server.calls.map((call) => call.options.scene_key), [
    'narrative_extraction', 'narrative_adaptation', 'narrative_script', 'narrative_shot',
  ]);

  const replayedScript = await execute(fixture.server, fixture.current, script.request);
  const replayedShot = await execute(fixture.server, fixture.current, shotRequest);
  assert.equal(replayedScript.body.data.result.uid, script.generated.body.data.result.uid);
  assert.equal(replayedShot.body.data.result.uid, shot.body.data.result.uid);
  assert.equal(fixture.server.calls.length, 4);
  const reopenedShot = await jsonRequest(
    `${fixture.server.baseUrl}/narrative-executions/${shotRequest.operationUid}`,
    'GET',
  );
  assert.deepEqual(reopenedShot.body.data.result.result.output, shotOutput);
  assert.equal(fixture.current.database.prepare(
    'SELECT count(*) AS count FROM narrative_task_executions',
  ).get().count, 4);
  assert.equal(fixture.current.database.prepare(
    'SELECT count(*) AS count FROM narrative_results',
  ).get().count, 4);
});

test('script and shot Schema violations never become narrative results', async (t) => {
  await t.test('script extra field', async (subtest) => {
    const invalidScript = structuredClone(createRainScriptOutput());
    invalidScript.unexpected = true;
    const fixture = await prepareApprovedAdaptation(subtest, 213000, {
      narrative_script: invalidScript,
    });
    const generated = await execute(
      fixture.server,
      fixture.current,
      request(fixture.current, uid(213102), 'script', fixture.adaptation.approved),
    );
    assert.equal(generated.response.status, 422);
    assert.equal(generated.body.error.code, 'NARRATIVE_EXECUTION_OUTPUT_INVALID');
    assert.equal(fixture.current.database.prepare(
      "SELECT count(*) AS count FROM narrative_results WHERE result_type='script'",
    ).get().count, 0);
  });

  await t.test('shot cardinality', async (subtest) => {
    const invalidShot = structuredClone(createRainShotOutput());
    invalidShot.shots = invalidShot.shots.slice(0, 3);
    const fixture = await prepareApprovedAdaptation(subtest, 216000, {
      narrative_shot: invalidShot,
    });
    const script = await executeAndApprove(
      fixture.server,
      fixture.current,
      request(fixture.current, uid(216102), 'script', fixture.adaptation.approved),
    );
    const generated = await execute(
      fixture.server,
      fixture.current,
      request(fixture.current, uid(216103), 'shot', script.approved),
    );
    assert.equal(generated.response.status, 422);
    assert.equal(generated.body.error.code, 'NARRATIVE_EXECUTION_OUTPUT_INVALID');
    assert.equal(fixture.current.database.prepare(
      "SELECT count(*) AS count FROM narrative_results WHERE result_type='shot'",
    ).get().count, 0);
  });
});

test('current source drift blocks structured shot generation before the provider call', async (t) => {
  const fixture = await prepareApprovedAdaptation(t, 219000);
  const script = await executeAndApprove(
    fixture.server,
    fixture.current,
    request(fixture.current, uid(219102), 'script', fixture.adaptation.approved),
  );
  fixture.current.database.exec('DROP TRIGGER v2_source_documents_immutable_evidence');
  fixture.current.database.prepare('UPDATE source_documents SET content_sha256=? WHERE uid=?')
    .run('e'.repeat(64), fixture.current.imported.document.uid);
  const rejected = await execute(
    fixture.server,
    fixture.current,
    request(fixture.current, uid(219103), 'shot', script.approved),
  );
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, 'NARRATIVE_EXECUTION_SOURCE_STALE');
  assert.equal(fixture.server.calls.length, 3);
  assert.equal(fixture.current.database.prepare(
    "SELECT count(*) AS count FROM narrative_results WHERE result_type='shot'",
  ).get().count, 0);
});
