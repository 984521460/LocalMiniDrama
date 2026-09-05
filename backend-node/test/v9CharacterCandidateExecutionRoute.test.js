'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const express = require('express');

const {
  CharacterCandidateExecutionError,
} = require('../src/characterCandidates/execution');
const characterCandidateExecutionRoutes = require(
  '../src/routes/v2/characterCandidateExecutions'
);
const { postJSONWithTimeout } = require('../src/services/aiClient');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

function seed(database) {
  const dramaUid = uid(31100);
  const characterUid = uid(31101);
  insertDrama(database, dramaUid, 'Character candidate route fixture');
  database.prepare(`
    INSERT INTO characters
      (drama_id,name,description,personality,appearance,created_at,updated_at,uid)
    VALUES
      (1,'阿澜','本地合成角色','沉着','黑发青衣',
       '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',?)
  `).run(characterUid);
  return Object.freeze({ dramaUid, characterUid });
}

function request(ids, operationUid = uid(31110)) {
  return Object.freeze({
    schemaVersion: 'character-candidate-execution-request.v1',
    operationUid,
    dramaUid: ids.dramaUid,
    characterUid: ids.characterUid,
    extractionResultUid: uid(31102),
    characterFactId: 'character-alan',
    width: 512,
    height: 512,
    seed: 42,
  });
}

async function serverFor(t, database, runtime, log = Object.freeze({ error() {} })) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/v2', characterCandidateExecutionRoutes(database, log, runtime));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/v1/v2`;
}

test('candidate execution route exposes create and read without altering the request', async (t) => {
  const database = createMigratedV2Database(t);
  const ids = seed(database);
  const calls = [];
  const expected = Object.freeze({ execution: Object.freeze({ state: 'succeeded' }), batch: {} });
  const history = Object.freeze({
    schemaVersion: 'character-candidate-execution-history-page.v1',
    dramaUid: ids.dramaUid,
    characterUid: ids.characterUid,
    entries: Object.freeze([]),
    nextCursor: null,
  });
  const runtime = Object.freeze({
    async execute(value) { calls.push(value); return expected; },
    get(operationUid) { calls.push(operationUid); return expected; },
    listHistory(value) { calls.push(value); return history; },
  });
  const baseUrl = await serverFor(t, database, runtime);
  const body = request(ids);
  const created = await fetch(`${baseUrl}/dramas/1/characters/${ids.characterUid}/candidate-executions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const createdBody = await created.json();
  assert.equal(created.status, 200);
  assert.equal(createdBody.success, true);
  assert.deepEqual(calls[0], body);

  const read = await fetch(`${baseUrl}/character-candidate-executions/${body.operationUid}`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).data.execution.state, 'succeeded');
  assert.equal(calls[1], body.operationUid);

  const cursor = `1:${uid(31111)}`;
  const historyRead = await fetch(
    `${baseUrl}/dramas/1/characters/${ids.characterUid}/candidate-executions/history?cursor=${encodeURIComponent(cursor)}`,
  );
  assert.equal(historyRead.status, 200);
  assert.deepEqual((await historyRead.json()).data, history);
  assert.deepEqual(calls[2], {
    dramaUid: ids.dramaUid,
    characterUid: ids.characterUid,
    cursor,
  });
});

test('candidate execution route rejects path drift and unavailable runtime before execution', async (t) => {
  const database = createMigratedV2Database(t);
  const ids = seed(database);
  let calls = 0;
  const runtime = Object.freeze({
    execute() { calls += 1; },
    get() { calls += 1; },
    listHistory() { calls += 1; },
  });
  const baseUrl = await serverFor(t, database, runtime);
  const crossed = await fetch(`${baseUrl}/dramas/1/characters/${uid(31199)}/candidate-executions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request(ids)),
  });
  assert.equal(crossed.status, 400);
  assert.equal((await crossed.json()).error.code, 'CHARACTER_CANDIDATE_EXECUTION_INPUT_INVALID');
  assert.equal(calls, 0);

  const unavailableUrl = await serverFor(t, database, null);
  const unavailable = await fetch(
    `${unavailableUrl}/dramas/1/characters/${ids.characterUid}/candidate-executions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request(ids, uid(31111))),
    },
  );
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, 'CHARACTER_CANDIDATE_EXECUTION_UNAVAILABLE');

  const invalidRead = await fetch(`${baseUrl}/character-candidate-executions/not-a-uid`);
  assert.equal(invalidRead.status, 400);
  assert.equal(calls, 0);

  const invalidHistory = await fetch(
    `${baseUrl}/dramas/1/characters/${ids.characterUid}/candidate-executions/history?cursor=invalid`,
  );
  assert.equal(invalidHistory.status, 400);
  assert.equal(calls, 0);
});

test('candidate execution route returns fixed errors without logging provider details', async (t) => {
  const database = createMigratedV2Database(t);
  const ids = seed(database);
  const logs = [];
  const runtime = Object.freeze({
    execute() {
      throw new CharacterCandidateExecutionError(
        'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN',
      );
    },
    get() { throw new Error('synthetic-provider-secret'); },
  });
  const baseUrl = await serverFor(t, database, runtime, Object.freeze({
    error(event, details) { logs.push({ event, details }); },
  }));
  const created = await fetch(`${baseUrl}/dramas/1/characters/${ids.characterUid}/candidate-executions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request(ids)),
  });
  assert.equal(created.status, 409);
  const createdText = await created.text();
  assert.match(createdText, /CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN/u);
  assert.doesNotMatch(createdText, /provider|secret/iu);

  const read = await fetch(`${baseUrl}/character-candidate-executions/${uid(31110)}`);
  assert.equal(read.status, 500);
  const readText = await read.text();
  assert.doesNotMatch(readText, /synthetic-provider-secret/u);
  assert.deepEqual(logs, [{
    event: 'character-candidate-execution-get',
    details: { code: 'CHARACTER_CANDIDATE_EXECUTION_UNEXPECTED' },
  }]);
});

test('configured image transport rejects a response before it exceeds its byte budget', async (t) => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(Buffer.alloc(64, 0x61));
      res.write(Buffer.alloc(65, 0x62));
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    provider.listen(0, '127.0.0.1', resolve);
    provider.once('error', reject);
  });
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  await assert.rejects(
    postJSONWithTimeout(
      `http://127.0.0.1:${provider.address().port}/image`,
      {},
      {},
      1000,
      128,
    ),
    /exceeds byte limit/u,
  );
});
