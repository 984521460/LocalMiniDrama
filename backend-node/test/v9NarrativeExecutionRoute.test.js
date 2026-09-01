'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const http = require('node:http');
const test = require('node:test');

const express = require('express');

const {
  createConfiguredNarrativeTextProvider,
} = require('../src/narrative/execution');
const {
  createProductionNarrativeExecutionRuntime,
} = require('../src/narrative/execution/productionRuntime');
const narrativeExecutionRoutes = require('../src/routes/v2/narrativeExecutions');
const { postJSONStream } = require('../src/services/aiClient');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function seed(database) {
  const ids = Object.freeze({
    dramaId: 1,
    dramaUid: uid(29000),
    documentUid: uid(29001),
    blockUid: uid(29002),
    selectionUid: uid(29003),
  });
  const text = '本地生产路由只使用合成文本。';
  const digest = sha256(text);
  insertDrama(database, ids.dramaUid, 'Narrative route fixture');
  database.transaction(() => {
    database.prepare(`
      INSERT INTO source_documents
        (uid, drama_uid, source_type, original_name, encoding, content_sha256,
         full_text, block_count)
      VALUES (?, ?, 'txt', 'route.txt', 'utf-8', ?, ?, 1)
    `).run(ids.documentUid, ids.dramaUid, digest, text);
    database.prepare(`
      INSERT INTO source_blocks
        (uid, document_uid, ordinal, heading_path_json, char_start, char_end,
         text, text_sha256)
      VALUES (?, ?, 0, '[]', 0, ?, ?, ?)
    `).run(ids.blockUid, ids.documentUid, Array.from(text).length, text, digest);
    database.prepare(`
      INSERT INTO source_selections
        (uid, document_uid, start_block_uid, end_block_uid,
         start_offset, end_offset, selected_text_sha256)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(
      ids.selectionUid,
      ids.documentUid,
      ids.blockUid,
      ids.blockUid,
      Array.from(text).length,
      digest,
    );
  })();
  return ids;
}

function request(ids, operationUid = uid(29010)) {
  return {
    schemaVersion: 'narrative-execution-request.v1',
    operationUid,
    dramaUid: ids.dramaUid,
    sourceSelectionUid: ids.selectionUid,
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

function rawResponse() {
  return JSON.stringify({
    schemaVersion: 'novel-extraction.v1',
    characters: [], scenes: [], props: [], relationships: [], events: [], dialogue: [],
  });
}

async function withServer(t, database, runtime) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/v2', narrativeExecutionRoutes(
    database,
    Object.freeze({ error() {} }),
    runtime,
  ));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/v1/v2`;
}

async function syntheticTextProvider(t, rawResponseValue) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      calls.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: rawResponseValue } }],
      })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    calls,
  });
}

test('production narrative runtime is reachable through localhost without startup provider calls', async (t) => {
  const database = createMigratedV2Database(t);
  const ids = seed(database);
  const calls = [];
  let nextUid = 29100;
  const runtime = createProductionNarrativeExecutionRuntime({
    database,
    log: Object.freeze({ info() {}, warn() {}, error() {} }),
    dependencies: {
      createUid: () => uid(nextUid++),
      provider: {
        getConfigFromModelMap() { return { config: { id: 1 } }; },
        getDefaultConfig() { throw new Error('mapped config must win'); },
        generateText(db, log, type, userPrompt, systemPrompt, options) {
          calls.push({ type, userPrompt, systemPrompt, options });
          return Promise.resolve({
            model: { provider: 'synthetic', name: 'fixture-model' },
            parameters: { temperature: 0, maxTokens: 8192, jsonMode: true },
            promptVersion: options.prompt_version,
            rawResponse: rawResponse(),
          });
        },
      },
    },
  });
  assert.equal(calls.length, 0);
  const baseUrl = await withServer(t, database, runtime.narrativeTasks);
  const response = await fetch(`${baseUrl}/dramas/${ids.dramaId}/narrative-executions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request(ids)),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.execution.state, 'succeeded');
  assert.equal(body.data.result.status, 'pending_review');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'text');
  assert.equal(calls[0].options.return_metadata, true);
  assert.equal(calls[0].options.max_response_bytes, 16 * 1024 * 1024);
  assert.equal(calls[0].options.scene_key, 'narrative_extraction');
  assert.match(calls[0].userPrompt, /novel-extraction\.v1/u);
  assert.doesNotMatch(calls[0].userPrompt, /api[_-]?key|credential|bearer/iu);

  const read = await fetch(`${baseUrl}/narrative-executions/${request(ids).operationUid}`);
  const readBody = await read.json();
  assert.equal(read.status, 200);
  assert.equal(readBody.data.result.uid, body.data.result.uid);
});

test('production adapter uses the configured text model and persists only secret-free metadata', async (t) => {
  const database = createMigratedV2Database(t);
  const ids = seed(database);
  const provider = await syntheticTextProvider(t, rawResponse());
  const now = '2026-08-30T00:00:00.000Z';
  database.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model,
       default_model, endpoint, priority, is_default, is_active, settings,
       created_at, updated_at)
    VALUES
      ('text','synthetic-openai','local fixture',?,?,'["fixture-model"]',
       'fixture-model','/chat/completions',100,1,1,'{"max_tokens":8192}',?,?)
  `).run(provider.baseUrl, 'synthetic-local-only-key', now, now);

  let nextUid = 29200;
  const runtime = createProductionNarrativeExecutionRuntime({
    database,
    log: Object.freeze({ info() {}, warn() {}, error() {} }),
    dependencies: { createUid: () => uid(nextUid++) },
  });
  assert.equal(provider.calls.length, 0);
  const baseUrl = await withServer(t, database, runtime.narrativeTasks);
  const httpResponse = await fetch(`${baseUrl}/dramas/1/narrative-executions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request(ids, uid(29210))),
  });
  const body = await httpResponse.json();
  assert.equal(httpResponse.status, 200);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].authorization, 'Bearer synthetic-local-only-key');
  assert.equal(provider.calls[0].body.model, 'fixture-model');
  assert.equal(provider.calls[0].body.response_format.type, 'json_object');
  assert.match(provider.calls[0].body.messages[1].content, /novel-extraction\.v1/u);
  assert.deepEqual(body.data.result.result.model, {
    name: 'fixture-model', provider: 'synthetic-openai',
  });
  assert.equal(Object.hasOwn(body.data.result.result, 'rawResponse'), false);
  assert.equal(body.data.result.result.rawResponseSha256, sha256(rawResponse()));
});

test('configured text transport bounds both success and provider error response bodies', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/error' ? 500 : 200, {
      'content-type': req.url === '/error' ? 'text/plain' : 'text/event-stream',
    });
    res.end(Buffer.alloc(129, 0x61));
  });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(
    postJSONStream(`${baseUrl}/success`, {}, {}, 1000, null, 128),
    /exceeded the configured bound/u,
  );
  await assert.rejects(
    postJSONStream(`${baseUrl}/error`, {}, {}, 1000, null, 128),
    /exceeded the configured bound/u,
  );
});

test('configured prompt serialization does not execute inherited toJSON hooks', () => {
  let capturedPrompt = null;
  const configured = createConfiguredNarrativeTextProvider({
    database: Object.freeze({
      prepare() { return Object.freeze({ get() { return { available: 1 }; } }); },
    }),
    log: Object.freeze({ info() {}, warn() {}, error() {} }),
    dependencies: {
      getConfigFromModelMap() { return { config: { id: 1 } }; },
      getDefaultConfig() { return null; },
      generateText(database, log, type, userPrompt) {
        capturedPrompt = userPrompt;
        return Object.freeze({ ok: true });
      },
    },
  });
  const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  const stringifyDescriptor = Object.getOwnPropertyDescriptor(JSON, 'stringify');
  let reads = 0;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get() { reads += 1; throw new Error('object toJSON must not run'); },
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      get() { reads += 1; throw new Error('array toJSON must not run'); },
    });
    Object.defineProperty(JSON, 'stringify', {
      configurable: true,
      get() { reads += 1; throw new Error('JSON.stringify lookup must not run'); },
    });
    const result = configured.generate({
      schemaVersion: 'narrative-generation-command.v1',
      resultType: 'extraction',
      source: { documentUid: uid(1), blocks: [], selection: null },
      domain: null,
    });
    assert.deepEqual(result, { ok: true });
  } finally {
    if (objectDescriptor) Object.defineProperty(Object.prototype, 'toJSON', objectDescriptor);
    else delete Object.prototype.toJSON;
    if (arrayDescriptor) Object.defineProperty(Array.prototype, 'toJSON', arrayDescriptor);
    else delete Array.prototype.toJSON;
    Object.defineProperty(JSON, 'stringify', stringifyDescriptor);
  }
  assert.equal(reads, 0);
  assert.equal(JSON.parse(capturedPrompt).task, 'extraction');
});

test('route rejects cross-drama requests and fails explicitly when runtime is absent', async (t) => {
  const database = createMigratedV2Database(t);
  const ids = seed(database);
  let calls = 0;
  const baseUrl = await withServer(t, database, Object.freeze({
    execute() { calls += 1; },
    get() { calls += 1; },
  }));
  const crossed = await fetch(`${baseUrl}/dramas/${ids.dramaId}/narrative-executions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request(ids), dramaUid: uid(29999) }),
  });
  assert.equal(crossed.status, 400);
  assert.equal((await crossed.json()).error.code, 'NARRATIVE_EXECUTION_INPUT_INVALID');
  assert.equal(calls, 0);

  const unavailableUrl = await withServer(t, database, null);
  const unavailable = await fetch(`${unavailableUrl}/dramas/${ids.dramaId}/narrative-executions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request(ids, uid(29011))),
  });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, 'NARRATIVE_EXECUTION_UNAVAILABLE');
});
