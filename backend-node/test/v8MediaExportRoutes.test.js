'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const mediaExportRoutes = require('../src/routes/v2/mediaExports');
const { createMigratedV2Database, insertDrama, uid } = require('./helpers/v2RepositoryDatabase');

async function localhost(t, router) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/v1/v2', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/v1/v2`;
}

function queuedRun(dramaUid) {
  return Object.freeze({
    schemaVersion: 'media-export-run.v1',
    uid: uid(91001),
    dramaUid,
    workflowRunUid: uid(91002),
    sourceNodeRunUid: uid(91003),
    executionPlanSha256: 'a'.repeat(64),
    status: 'queued',
    outputAssetUid: null,
    outputAssetVersionUid: null,
    output: null,
    errorCode: null,
    createdAt: '2026-08-30T02:00:00.000Z',
    startedAt: null,
    completedAt: null,
  });
}

test('P8-10 localhost routes accept only an opaque node identity and resolved drama', async (t) => {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(91000);
  insertDrama(database, dramaUid, 'Route media export drama');
  let calls = 0;
  const service = {
    get(runUid, expectedDramaUid) {
      assert.equal(runUid, uid(91001));
      assert.equal(expectedDramaUid, dramaUid);
      return queuedRun(dramaUid);
    },
    listByDrama(expectedDramaUid) {
      assert.equal(expectedDramaUid, dramaUid);
      return [queuedRun(dramaUid)];
    },
    async start(input, expectedDramaUid) {
      calls += 1;
      assert.deepEqual(input, { nodeRunUid: uid(91003) });
      assert.equal(expectedDramaUid, dramaUid);
      return queuedRun(dramaUid);
    },
  };
  const base = await localhost(t, mediaExportRoutes(null, { service }, database));

  const started = await fetch(`${base}/dramas/1/media-exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ node_run_uid: uid(91003) }),
  });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).data.sourceNodeRunUid, uid(91003));
  assert.equal(calls, 1);

  const hostile = await fetch(`${base}/dramas/1/media-exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ node_run_uid: uid(91003), execution_plan: {} }),
  });
  assert.equal(hostile.status, 400);
  assert.equal((await hostile.json()).error.code, 'MEDIA_EXPORT_RUN_INPUT_INVALID');
  assert.equal(calls, 1);

  const listed = await fetch(`${base}/dramas/1/media-exports`);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).data.length, 1);
  const read = await fetch(`${base}/dramas/1/media-exports/${uid(91001)}`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).data.dramaUid, dramaUid);
  const malformed = await fetch(`${base}/dramas/1/media-exports/not-a-uuid`);
  assert.equal(malformed.status, 400);
});

test('P8-10 route remains explicitly unavailable without production runtime', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(91010), 'Unavailable route drama');
  const base = await localhost(t, mediaExportRoutes(null, null, database));
  const result = await fetch(`${base}/dramas/1/media-exports`);
  assert.equal(result.status, 503);
  assert.equal((await result.json()).error.code, 'MEDIA_EXPORT_UNAVAILABLE');
});
