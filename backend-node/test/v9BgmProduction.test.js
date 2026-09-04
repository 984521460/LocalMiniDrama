'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const { createBgmImportService } = require('../src/audio/bgmImportService');
const { createProductionBgmRuntime } = require('../src/audio/bgmProductionRuntime');
const bgmTrackRoutes = require('../src/routes/v2/bgmTracks');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

const DRAMA_UID = uid(99700);

function pcmWav(durationMs = 250) {
  const sampleRate = 48_000;
  const channels = 2;
  const bitsPerSample = 16;
  const frames = Math.round(sampleRate * durationMs / 1000);
  const dataBytes = frames * channels * bitsPerSample / 8;
  const output = Buffer.alloc(44 + dataBytes);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  output.writeUInt16LE(channels * bitsPerSample / 8, 32);
  output.writeUInt16LE(bitsPerSample, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(dataBytes, 40);
  return output;
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-bgm-production-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function uidSequence(start = 99710) {
  let current = start;
  return () => uid(current++);
}

function request(overrides = {}) {
  return {
    dramaUid: DRAMA_UID,
    title: 'MVP licensed score',
    mimeType: 'audio/wav',
    licenseBasis: 'licensed',
    commercialUseAllowed: true,
    derivativesAllowed: true,
    bytes: pcmWav(),
    ...overrides,
  };
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

test('production BGM runtime fully decodes local audio and returns a secret-free library view', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'BGM production drama');
  const runtime = createProductionBgmRuntime({
    database,
    localRoot: tempRoot(t),
    dependencies: { createUid: uidSequence(), nowEpochMs: () => 1_800_000_000_000 },
  });

  const created = await runtime.bgm.service.importTrack(request());
  assert.deepEqual(created, {
    schemaVersion: 'bgm-library-track.v1',
    uid: uid(99710),
    dramaUid: DRAMA_UID,
    title: 'MVP licensed score',
    mimeType: 'audio/wav',
    durationMs: 250,
    license: {
      basis: 'licensed',
      commercialUseAllowed: true,
      derivativesAllowed: true,
    },
    exportEligible: true,
    createdAtEpochMs: 1_800_000_000_000,
  });
  assert.deepEqual(runtime.bgm.service.listByDrama(DRAMA_UID), [created]);
  assert.equal(JSON.stringify(created).includes('relativePath'), false);
  assert.equal(JSON.stringify(created).includes('credential'), false);
  assert.equal(database.prepare('SELECT count(*) FROM bgm_tracks').pluck().get(), 1);
  assert.equal(database.prepare('SELECT count(*) FROM asset_versions').pluck().get(), 1);

  await assert.rejects(() => runtime.bgm.service.importTrack(request({
    title: 'Invalid media', bytes: Buffer.from('not-audio'),
  })));
  await assert.rejects(() => runtime.bgm.service.importTrack(request({
    title: 'Mislabeled media', mimeType: 'audio/mpeg',
  })));
  assert.equal(database.prepare('SELECT count(*) FROM bgm_tracks').pluck().get(), 1);
  assert.equal(database.prepare('SELECT count(*) FROM asset_versions').pluck().get(), 1);
});

test('successful provider completion has no fallible post-commit repository read', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'BGM atomic response drama');
  const createUid = uidSequence(99720);
  let postCommitReads = 0;
  const service = createBgmImportService({
    database,
    createUid,
    nowEpochMs: () => 1_800_000_050_000,
    provider: Object.freeze({
      async importTrack(input) {
        return Object.freeze({
          schemaVersion: 'bgm-track.v1',
          uid: input.uid,
          dramaUid: input.dramaUid,
          title: input.title,
          sourceKind: 'local-import',
          providerId: 'local-library',
          assetVersion: Object.freeze({
            uid: input.assetVersionUid,
            assetUid: input.assetUid,
            storageProvider: 'local',
            logicalUri: `asset://dramas/${input.dramaUid}/bgm/${input.assetUid}/${input.assetVersionUid}`,
            relativePath: `projects/${input.dramaUid}/assets/bgm/${input.assetUid}/${input.assetVersionUid}.wav`,
            sha256: createHash('sha256').update(input.bytes).digest('hex'),
            mimeType: input.mimeType,
            width: null,
            height: null,
            durationMs: 250,
            parentUid: null,
            status: 'ready',
            createdAt: new Date(input.createdAtEpochMs).toISOString(),
          }),
          license: Object.freeze(input.license),
          createdAtEpochMs: input.createdAtEpochMs,
        });
      },
    }),
    repository: Object.freeze({
      get() {
        postCommitReads += 1;
        throw new Error('synthetic post-commit read must not run');
      },
      listByDrama() { return Object.freeze([]); },
    }),
  });

  const created = await service.importTrack(request());
  assert.equal(created.uid, uid(99720));
  assert.equal(created.exportEligible, true);
  assert.equal(postCommitReads, 0);
});

test('multipart BGM routes bind the drama, cap fields, and preserve explicit license facts', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'BGM route drama');
  const runtime = createProductionBgmRuntime({
    database,
    localRoot: tempRoot(t),
    dependencies: { createUid: uidSequence(99730), nowEpochMs: () => 1_800_000_100_000 },
  });
  const app = express();
  app.use('/v2', bgmTrackRoutes(null, runtime.bgm, database));
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const form = new FormData();
  form.append('title', 'Licensed route score');
  form.append('license_basis', 'user-owned');
  form.append('commercial_use_allowed', 'true');
  form.append('derivatives_allowed', 'true');
  form.append('file', new Blob([pcmWav(300)], { type: 'audio/wav' }), 'score.wav');
  const imported = await fetch(`${base}/v2/dramas/${DRAMA_UID}/bgm-tracks`, {
    method: 'POST', body: form,
  });
  assert.equal(imported.status, 201);
  const importedBody = await imported.json();
  assert.equal(importedBody.success, true);
  assert.equal(importedBody.data.dramaUid, DRAMA_UID);
  assert.equal(importedBody.data.durationMs, 300);
  assert.equal(importedBody.data.license.basis, 'user-owned');
  assert.equal(importedBody.data.exportEligible, true);

  const listed = await fetch(`${base}/v2/dramas/${DRAMA_UID}/bgm-tracks`);
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.deepEqual(listedBody.data, [importedBody.data]);

  const denied = new FormData();
  denied.append('title', 'No derivative rights');
  denied.append('license_basis', 'licensed');
  denied.append('commercial_use_allowed', 'true');
  denied.append('derivatives_allowed', 'false');
  denied.append('file', new Blob([pcmWav()], { type: 'audio/wav' }), 'denied.wav');
  const deniedResponse = await fetch(`${base}/v2/dramas/${DRAMA_UID}/bgm-tracks`, {
    method: 'POST', body: denied,
  });
  assert.equal(deniedResponse.status, 201);
  const deniedBody = await deniedResponse.json();
  assert.equal(deniedBody.data.exportEligible, false);
  assert.equal(database.prepare('SELECT count(*) FROM bgm_tracks').pluck().get(), 2);

  const invalidBoolean = new FormData();
  invalidBoolean.append('title', 'Ambiguous rights');
  invalidBoolean.append('license_basis', 'licensed');
  invalidBoolean.append('commercial_use_allowed', 'TRUE');
  invalidBoolean.append('derivatives_allowed', 'true');
  invalidBoolean.append('file', new Blob([pcmWav()], { type: 'audio/wav' }), 'invalid.wav');
  const invalidBooleanResponse = await fetch(`${base}/v2/dramas/${DRAMA_UID}/bgm-tracks`, {
    method: 'POST', body: invalidBoolean,
  });
  assert.equal(invalidBooleanResponse.status, 400);
  assert.equal(database.prepare('SELECT count(*) FROM bgm_tracks').pluck().get(), 2);

  const wrongDrama = await fetch(`${base}/v2/dramas/${uid(99999)}/bgm-tracks`);
  assert.equal(wrongDrama.status, 404);
});

test('public BGM library schema accepts only the compact export-eligibility projection', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'BGM schema drama');
  const runtime = createProductionBgmRuntime({
    database,
    localRoot: tempRoot(t),
    dependencies: { createUid: uidSequence(99750), nowEpochMs: () => 1_800_000_200_000 },
  });
  const created = await runtime.bgm.service.importTrack(request());
  const schema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../schemas/v9/bgm-library-track.schema.json'), 'utf8',
  ));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(created), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...created, exportEligible: false }), false);
  assert.equal(validate({ ...created, relativePath: 'projects/private/score.wav' }), false);
});

test('actual application composition exposes the local BGM import route without external calls', async (t) => {
  const originalCwd = process.cwd();
  const root = tempRoot(t);
  const configDir = path.join(root, 'configs');
  const databasePath = path.join(root, 'data', 'bgm.sqlite').replace(/\\/gu, '/');
  const storagePath = path.join(root, 'storage').replace(/\\/gu, '/');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), [
    'app:',
    '  name: LocalMiniDrama-BGM-E2E',
    '  version: 0.0.0-test',
    'server:',
    '  port: 0',
    '  host: 127.0.0.1',
    '  insecure_tls: false',
    'database:',
    '  type: sqlite',
    `  path: "${databasePath}"`,
    'storage:',
    `  local_path: "${storagePath}"`,
    '',
  ].join('\n'), 'utf8');

  let server;
  let closeDatabase = () => {};
  try {
    process.chdir(root);
    const { createApp } = require('../src/app');
    const { closeDb } = require('../src/db');
    closeDatabase = closeDb;
    const created = createApp({
      bgmDependencies: {
        createUid: uidSequence(99770),
        nowEpochMs: () => 1_800_000_300_000,
      },
    });
    await created.startupRecoveryPromise;
    insertDrama(created.db, DRAMA_UID, 'BGM actual application drama');
    server = await new Promise((resolve, reject) => {
      const instance = created.app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });

    const form = new FormData();
    form.append('title', 'Application score');
    form.append('license_basis', 'user-owned');
    form.append('commercial_use_allowed', 'true');
    form.append('derivatives_allowed', 'true');
    form.append('file', new Blob([pcmWav(200)], { type: 'audio/wav' }), 'application.wav');
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/v1/v2/dramas/${DRAMA_UID}/bgm-tracks`,
      { method: 'POST', body: form },
    );
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.data.durationMs, 200);
    assert.equal(body.data.exportEligible, true);
    assert.equal(typeof created.runtime.bgm.service.importTrack, 'function');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    process.chdir(originalCwd);
  }
});
