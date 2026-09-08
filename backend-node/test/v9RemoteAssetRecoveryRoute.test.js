'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');

const remoteAssetRecoveryRoutes = require('../src/routes/v2/remoteAssetRecoveries');
const { createMigratedV2Database, insertDrama, uid } = require('./helpers/v2RepositoryDatabase');

async function listen(t, database, runtime) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/v2', remoteAssetRecoveryRoutes(database, { error() {} }, runtime));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/v1/v2`;
}

test('remote asset recovery route binds legacy drama and character paths to the request', async (t) => {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(500);
  const characterUid = uid(501);
  insertDrama(database, dramaUid, 'Recovery route');
  const calls = [];
  const expected = { recovery: { state: 'succeeded', quarantineStatus: 'unapproved' } };
  const runtime = {
    async execute(value) { calls.push(['execute', value]); return expected; },
    async get(value) { calls.push(['get', value]); return expected; },
    async list(value) {
      calls.push(['list', value]);
      return { schemaVersion: 'remote-asset-recovery-list.v1', ...value, recoveries: [] };
    },
  };
  const base = await listen(t, database, runtime);
  const body = {
    schemaVersion: 'remote-asset-recovery-request.v1',
    operationUid: uid(502),
    dramaUid,
    characterUid,
    extractionResultUid: uid(503),
    characterFactId: 'character-alan',
    connectionUid: uid(504),
    connectionEvidenceSha256: 'a'.repeat(64),
    remoteTaskUid: uid(505),
  };
  const created = await fetch(`${base}/dramas/1/characters/${characterUid}/remote-asset-recoveries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(created.status, 200);
  assert.deepEqual((await created.json()).data, expected);
  const listed = await fetch(`${base}/dramas/1/characters/${characterUid}/remote-asset-recoveries`);
  assert.equal(listed.status, 200);
  const read = await fetch(`${base}/remote-asset-recoveries/${body.operationUid}`);
  assert.equal(read.status, 200);
  assert.deepEqual(calls, [
    ['execute', body],
    ['list', { dramaUid, characterUid }],
    ['get', body.operationUid],
  ]);

  const drifted = await fetch(`${base}/dramas/1/characters/${uid(599)}/remote-asset-recoveries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(drifted.status, 400);
  assert.equal((await drifted.json()).error.code, 'REMOTE_ASSET_RECOVERY_INPUT_INVALID');
});
