'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');

const remoteAssetRecoveryRoutes = require('../src/routes/v2/remoteAssetRecoveries');
const { LocalPackageImportError } = require('../src/remoteAssets/localPackageImportService');
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
    async importPackage(input, bytes) {
      assert.equal(input.characterUid, characterUid);
      assert.equal(bytes.toString(), 'fixture-zip');
      return { uid: uid(590) };
    },
    async listPackages(dramaUidValue, characterUidValue) {
      assert.equal(dramaUidValue, dramaUid);
      assert.equal(characterUidValue, characterUid);
      return [];
    },
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
  const form = new FormData();
  form.append('package', new Blob(['fixture-zip']), 'fixture.zip');
  form.append('extractionResultUid', uid(503));
  form.append('characterFactId', 'character-alan');
  const imported = await fetch(`${base}/dramas/1/characters/${characterUid}/local-recovery-packages`, {
    method: 'POST', body: form,
  });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).data.record.uid, uid(590));
  const packages = await fetch(`${base}/dramas/1/characters/${characterUid}/local-recovery-packages`);
  assert.equal(packages.status, 200);
  assert.deepEqual((await packages.json()).data.records, []);

  runtime.importPackage = async () => {
    throw new LocalPackageImportError('LOCAL_PACKAGE_IMPORT_CONFLICT');
  };
  const conflictForm = new FormData();
  conflictForm.append('package', new Blob(['fixture-zip']), 'fixture.zip');
  conflictForm.append('extractionResultUid', uid(503));
  conflictForm.append('characterFactId', 'character-alan');
  const conflict = await fetch(`${base}/dramas/1/characters/${characterUid}/local-recovery-packages`, {
    method: 'POST', body: conflictForm,
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'LOCAL_PACKAGE_IMPORT_CONFLICT');

  const extraForm = new FormData();
  extraForm.append('package', new Blob(['fixture-zip']), 'fixture.zip');
  extraForm.append('extractionResultUid', uid(503));
  extraForm.append('characterFactId', 'character-alan');
  extraForm.append('unexpected', 'value');
  const extra = await fetch(`${base}/dramas/1/characters/${characterUid}/local-recovery-packages`, {
    method: 'POST', body: extraForm,
  });
  assert.equal(extra.status, 400);
  assert.equal((await extra.json()).error.code, 'LOCAL_PACKAGE_IMPORT_INPUT_INVALID');
});
