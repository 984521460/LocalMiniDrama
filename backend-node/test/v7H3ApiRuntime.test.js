'use strict';

const assert = require('node:assert/strict');
const Ajv2020 = require('ajv/dist/2020');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  H3ContractError,
  compileH3ShotPrompt,
  createMinimaxH3ApiService,
  normalizeH3GenerationSpec,
} = require('../src/h3');
const h3Routes = require('../src/routes/v2/h3');
const { createMigratedV2Database } = require('./helpers/v2RepositoryDatabase');

const DRAMA_UID = '74000000-0000-4000-8000-000000000000';
const OPERATION_UID = '74000000-0000-4000-8000-000000000004';
const SECRET = 'synthetic-h3-api-secret-never-return';
const apiTaskSchema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../schemas/v7/h3-api-task.schema.json'),
  'utf8',
));
const validateApiTask = new Ajv2020({ allErrors: true, strict: true }).compile(apiTaskSchema);

function generationSpec() {
  const prompt = compileH3ShotPrompt({
    dramaUid: DRAMA_UID,
    semanticShot: {
      shotId: 'shot-api', ordinal: 1, durationSeconds: 5,
      continuitySnapshotUid: '74000000-0000-4000-8000-000000000001',
      subjects: { description: 'A courier pauses beneath a station clock.', characters: [] },
      environment: {
        sceneId: 'station', description: 'A quiet station platform at blue hour.',
        scene: {
          sceneUid: '74000000-0000-4000-8000-000000000002',
          versionUid: '74000000-0000-4000-8000-000000000003',
        },
        props: [],
      },
      action: 'The courier looks up as the second hand reaches twelve.',
      camera: {
        shotSize: 'MS', cameraAngle: 'eye_level', cameraMovement: 'static',
        composition: 'The clock remains centered above the courier.',
      },
      lighting: {
        quality: 'soft', direction: 'side', colorTemperature: 'cool',
        description: 'Cool skylight separates the courier from the empty platform.',
      },
      continuity: {
        transitionFromPrevious: 'start', screenDirection: 'neutral',
        axisStrategy: 'establish', notes: 'The courier faces frame right.',
      },
    },
  });
  return normalizeH3GenerationSpec({
    mode: 't2v', prompt, width: 1344, height: 768,
    durationSeconds: 5, seed: 42, referenceImages: [],
  });
}

function seedApiConfig(database, {
  baseUrl = 'https://api.minimax.io',
  apiKey = SECRET,
} = {}) {
  const now = '2026-08-29T00:00:00.000Z';
  database.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model, priority,
       is_default, is_active, created_at, updated_at)
    VALUES ('video', 'minimax_h3', 'H3 API', ?, ?, ?, 100, 1, 1, ?, ?)
  `).run(baseUrl, apiKey, JSON.stringify(['MiniMax-H3']), now, now);
}

function seedDrama(database, dramaUid, title = 'Synthetic drama') {
  database.prepare(`
    INSERT INTO dramas (uid, title, created_at, updated_at)
    VALUES (?, ?, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')
  `).run(dramaUid, title);
}

function invalid(code) {
  return (error) => error instanceof H3ContractError && error.code === code;
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

test('production H3 API service submits the shared spec without exposing configuration', async (t) => {
  const database = createMigratedV2Database(t);
  seedApiConfig(database);
  const calls = [];
  const service = createMinimaxH3ApiService({
    database,
    timeoutMs: 100,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return new Response(JSON.stringify({ task_id: '424010985738629' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await service.submit(generationSpec(), OPERATION_UID);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    schemaVersion: 'h3-api-task.v1',
    provider: 'minimax-api',
    model: 'MiniMax-H3',
    taskId: '424010985738629',
    status: 'queued',
    outputUrl: null,
  });
  assert.equal(validateApiTask(result), true, JSON.stringify(validateApiTask.errors));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.minimax.io/v2/video_generation');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${SECRET}`);
  const outbound = JSON.parse(calls[0].options.body);
  assert.equal(outbound.model, 'MiniMax-H3');
  assert.equal(outbound.content[0].text, generationSpec().prompt.text);
  assert.doesNotMatch(JSON.stringify([result, outbound]), new RegExp(SECRET, 'u'));
});

test('production H3 API service maps only bounded query state and output URL', async (t) => {
  const database = createMigratedV2Database(t);
  seedApiConfig(database, { baseUrl: 'https://api.minimaxi.com' });
  const service = createMinimaxH3ApiService({
    database,
    timeoutMs: 100,
    async fetchImpl(url) {
      if (url === 'https://api.minimaxi.com/v2/video_generation') {
        return new Response(JSON.stringify({ task_id: '424010985738629' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      assert.equal(
        url,
        'https://api.minimaxi.com/v2/query/video_generation/424010985738629',
      );
      return new Response(JSON.stringify({
        task: {
          id: '424010985738629', model: 'MiniMax-H3', status: 'succeeded',
          content: { url: 'https://media.example.invalid/result.mp4?signature=synthetic' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  await service.submit(generationSpec(), OPERATION_UID);
  assert.deepEqual(JSON.parse(JSON.stringify(await service.query('424010985738629'))), {
    schemaVersion: 'h3-api-task.v1',
    provider: 'minimax-api',
    model: 'MiniMax-H3',
    taskId: '424010985738629',
    status: 'succeeded',
    outputUrl: 'https://media.example.invalid/result.mp4?signature=synthetic',
  });
});

test('H3 API output URL remains runtime and Schema canonical', async (t) => {
  const database = createMigratedV2Database(t);
  seedApiConfig(database);
  const service = createMinimaxH3ApiService({
    database,
    timeoutMs: 100,
    async fetchImpl(url) {
      if (url.endsWith('/v2/video_generation')) {
        return new Response(JSON.stringify({ task_id: 'uppercase-url-task' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        task: {
          id: 'uppercase-url-task', model: 'MiniMax-H3', status: 'succeeded',
          content: { url: 'HTTPS://media.example.invalid/result.mp4?signature=synthetic' },
        },
      }), { status: 200 });
    },
  });
  await service.submit(generationSpec(), '74000000-0000-4000-8000-000000000009');
  await assert.rejects(
    service.query('uppercase-url-task'),
    invalid('H3_API_RESPONSE_INVALID'),
  );
});

test('production H3 API service resolves only matching frozen media evidence', async (t) => {
  const database = createMigratedV2Database(t);
  seedApiConfig(database);
  seedDrama(database, DRAMA_UID);
  const assetUid = '74000000-0000-4000-8000-000000000010';
  const versionUid = '74000000-0000-4000-8000-000000000011';
  database.prepare(`
    INSERT INTO assets (uid, owner_type, owner_uid, asset_type, status)
    VALUES (?, 'drama', ?, 'image', 'ready')
  `).run(assetUid, DRAMA_UID);
  database.prepare(`
    INSERT INTO asset_versions
      (uid, asset_uid, storage_provider, logical_uri, relative_path, sha256,
       mime_type, width, height, status)
    VALUES (?, ?, 'local', ?, 'projects/drama/frame one.png', ?, 'image/png', 1344, 768, 'ready')
  `).run(versionUid, assetUid, `asset://${assetUid}/v1`, 'b'.repeat(64));
  const calls = [];
  const service = createMinimaxH3ApiService({
    database,
    storageBaseUrl: 'https://media.example.invalid/static/',
    timeoutMs: 100,
    async fetchImpl(_url, options) {
      calls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ task_id: '424010985738629' }), { status: 200 });
    },
  });
  const baseSpec = generationSpec();
  const imageSpec = normalizeH3GenerationSpec({
    mode: 'fl2va-first',
    prompt: baseSpec.prompt,
    width: baseSpec.width,
    height: baseSpec.height,
    durationSeconds: baseSpec.durationSeconds,
    seed: baseSpec.seed,
    referenceImages: [{
      ordinal: 1, role: 'first', dramaUid: DRAMA_UID,
      assetVersionUid: versionUid, sha256: 'b'.repeat(64),
      mimeType: 'image/png', width: 1344, height: 768,
    }],
  });
  await service.submit(imageSpec, OPERATION_UID);
  assert.equal(
    calls[0].content[1].image_url.url,
    'https://media.example.invalid/static/projects/drama/frame%20one.png',
  );

  database.prepare('UPDATE asset_versions SET sha256=? WHERE uid=?')
    .run('c'.repeat(64), versionUid);
  await assert.rejects(
    service.submit(imageSpec, '74000000-0000-4000-8000-000000000005'),
    invalid('H3_API_REQUEST_INVALID'),
  );
  assert.equal(calls.length, 1);
});

test('H3 API service rejects cross-drama image and audio before reservation or fetch', async (t) => {
  const database = createMigratedV2Database(t);
  seedApiConfig(database);
  seedDrama(database, DRAMA_UID);
  const otherDramaUid = '74000000-0000-4000-8000-000000000020';
  seedDrama(database, otherDramaUid, 'Other synthetic drama');
  const imageAssetUid = '74000000-0000-4000-8000-000000000021';
  const imageVersionUid = '74000000-0000-4000-8000-000000000022';
  const audioAssetUid = '74000000-0000-4000-8000-000000000023';
  const audioVersionUid = '74000000-0000-4000-8000-000000000024';
  database.prepare(`
    INSERT INTO assets (uid, owner_type, owner_uid, asset_type, status)
    VALUES (?, 'drama', ?, 'image', 'ready'),
           (?, 'drama', ?, 'audio', 'ready')
  `).run(imageAssetUid, otherDramaUid, audioAssetUid, otherDramaUid);
  database.prepare(`
    INSERT INTO asset_versions
      (uid, asset_uid, storage_provider, logical_uri, relative_path, sha256,
       mime_type, width, height, duration_ms, status)
    VALUES (?, ?, 'local', ?, 'projects/other/frame.png', ?,
            'image/png', 1344, 768, NULL, 'ready'),
           (?, ?, 'local', ?, 'projects/other/voice.wav', ?,
            'audio/wav', NULL, NULL, 5000, 'ready')
  `).run(
    imageVersionUid, imageAssetUid, `asset://${imageAssetUid}/v1`, 'd'.repeat(64),
    audioVersionUid, audioAssetUid, `asset://${audioAssetUid}/v1`, 'e'.repeat(64),
  );
  let fetchCalls = 0;
  const service = createMinimaxH3ApiService({
    database,
    storageBaseUrl: 'https://media.example.invalid/static/',
    timeoutMs: 100,
    async fetchImpl() {
      fetchCalls += 1;
      return new Response(JSON.stringify({ task_id: 'must-not-submit' }), { status: 200 });
    },
  });
  const baseSpec = generationSpec();
  const imageSpec = normalizeH3GenerationSpec({
    mode: 'fl2va-first', prompt: baseSpec.prompt,
    width: baseSpec.width, height: baseSpec.height,
    durationSeconds: baseSpec.durationSeconds, seed: baseSpec.seed,
    referenceImages: [{
      ordinal: 1, role: 'first', dramaUid: DRAMA_UID,
      assetVersionUid: imageVersionUid, sha256: 'd'.repeat(64),
      mimeType: 'image/png', width: 1344, height: 768,
    }],
  });
  const audioSpec = normalizeH3GenerationSpec({
    mode: 't2v', prompt: baseSpec.prompt,
    width: baseSpec.width, height: baseSpec.height,
    durationSeconds: baseSpec.durationSeconds, seed: baseSpec.seed,
    referenceImages: [],
    referenceAudio: {
      dramaUid: DRAMA_UID,
      assetVersionUid: audioVersionUid, sha256: 'e'.repeat(64),
      mimeType: 'audio/wav', durationMs: 5000,
    },
  });

  await assert.rejects(
    service.submit(imageSpec, '74000000-0000-4000-8000-000000000025'),
    invalid('H3_API_REQUEST_INVALID'),
  );
  await assert.rejects(
    service.submit(audioSpec, '74000000-0000-4000-8000-000000000026'),
    invalid('H3_API_REQUEST_INVALID'),
  );
  assert.equal(fetchCalls, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM h3_api_submissions').get().count, 0);
});

test('H3 API service rejects non-official origins, timeouts and hostile responses', async (t) => {
  const customDatabase = createMigratedV2Database(t);
  seedApiConfig(customDatabase, { baseUrl: 'https://proxy.example.invalid' });
  let calls = 0;
  const custom = createMinimaxH3ApiService({
    database: customDatabase,
    timeoutMs: 25,
    async fetchImpl() { calls += 1; return new Response('{}'); },
  });
  await assert.rejects(
    custom.submit(generationSpec(), OPERATION_UID),
    invalid('H3_API_UNAVAILABLE'),
  );
  assert.equal(calls, 0);

  const timeoutDatabase = createMigratedV2Database(t);
  seedApiConfig(timeoutDatabase);
  const timeout = createMinimaxH3ApiService({
    database: timeoutDatabase,
    timeoutMs: 10,
    fetchImpl() { return new Promise(() => {}); },
  });
  await assert.rejects(
    timeout.submit(generationSpec(), OPERATION_UID),
    invalid('H3_API_REQUEST_ABORTED'),
  );

  const hostileDatabase = createMigratedV2Database(t);
  seedApiConfig(hostileDatabase);
  let trapReads = 0;
  const hostileResponse = new Proxy({}, {
    getPrototypeOf() { trapReads += 1; throw new Error('synthetic-response-marker'); },
  });
  const hostile = createMinimaxH3ApiService({
    database: hostileDatabase,
    timeoutMs: 100,
    async fetchImpl() { return hostileResponse; },
  });
  await assert.rejects(
    hostile.submit(generationSpec(), OPERATION_UID),
    invalid('H3_API_RESPONSE_INVALID'),
  );
  assert.equal(trapReads, 0);
});

test('H3 API response body enforces its byte limit while streaming', async (t) => {
  const database = createMigratedV2Database(t);
  seedApiConfig(database);
  let cancelled = false;
  let emittedBytes = 0;
  const oversizedChunk = new Uint8Array(300 * 1024).fill(0x20);
  const service = createMinimaxH3ApiService({
    database,
    timeoutMs: 100,
    async fetchImpl() {
      return new Response(new ReadableStream({
        start(controller) {
          emittedBytes += oversizedChunk.byteLength;
          controller.enqueue(oversizedChunk);
        },
        cancel() { cancelled = true; },
      }), { status: 200 });
    },
  });

  await Promise.race([
    assert.rejects(
      service.submit(generationSpec(), '74000000-0000-4000-8000-000000000008'),
      invalid('H3_API_RESPONSE_INVALID'),
    ),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('bounded H3 response did not settle')),
      250,
    )),
  ]);
  assert.equal(cancelled, true);
  assert.ok(emittedBytes <= 600 * 1024);
});

test('H3 API submit persists an uncertain operation and never repeats the paid POST', async (t) => {
  const database = createMigratedV2Database(t);
  seedApiConfig(database);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 35));
    return new Response(JSON.stringify({ task_id: `accepted-${calls}` }), { status: 200 });
  };
  const firstService = createMinimaxH3ApiService({ database, timeoutMs: 10, fetchImpl });
  await assert.rejects(
    firstService.submit(generationSpec(), OPERATION_UID),
    invalid('H3_API_REQUEST_ABORTED'),
  );

  await assert.rejects(
    firstService.submit(generationSpec(), OPERATION_UID),
    invalid('H3_API_SUBMISSION_UNKNOWN'),
  );
  const restartedService = createMinimaxH3ApiService({ database, timeoutMs: 100, fetchImpl });
  await assert.rejects(
    restartedService.submit(generationSpec(), OPERATION_UID),
    invalid('H3_API_SUBMISSION_UNKNOWN'),
  );
  assert.equal(calls, 1);
});

test('H3 API accepted operation is idempotent and binds its request hash', async (t) => {
  const database = createMigratedV2Database(t);
  seedApiConfig(database);
  let calls = 0;
  const service = createMinimaxH3ApiService({
    database,
    timeoutMs: 100,
    async fetchImpl() {
      calls += 1;
      return new Response(JSON.stringify({ task_id: '424010985738629' }), { status: 200 });
    },
  });
  const first = await service.submit(generationSpec(), OPERATION_UID);
  const retry = await service.submit(generationSpec(), OPERATION_UID);
  assert.deepEqual(retry, first);
  assert.equal(calls, 1);

  const changed = { ...generationSpec(), durationSeconds: 6 };
  await assert.rejects(
    service.submit(changed, OPERATION_UID),
    invalid('H3_API_REQUEST_INVALID'),
  );
  assert.equal(calls, 1);
});

test('H3 API query refuses saved configuration drift without another provider call', async (t) => {
  const database = createMigratedV2Database(t);
  seedApiConfig(database);
  let calls = 0;
  const service = createMinimaxH3ApiService({
    database,
    timeoutMs: 100,
    async fetchImpl() {
      calls += 1;
      return new Response(JSON.stringify({ task_id: '424010985738629' }), { status: 200 });
    },
  });
  await service.submit(generationSpec(), OPERATION_UID);
  database.prepare(`
    UPDATE ai_service_configs
    SET api_key=?, updated_at='2026-08-29T00:00:01.000Z'
    WHERE service_type='video'
  `).run('synthetic-rotated-key');
  await assert.rejects(
    service.query('424010985738629'),
    invalid('H3_API_UNAVAILABLE'),
  );
  assert.equal(calls, 1);
});

test('H3 API reservation rows reject forged terminal state, replacement and deletion', (t) => {
  const database = createMigratedV2Database(t);
  const secondOperationUid = '74000000-0000-4000-8000-000000000007';
  const insert = database.prepare(`
    INSERT INTO h3_api_submissions
      (operation_uid, request_sha256, config_id, config_evidence_sha256,
       state, provider_task_id)
    VALUES (?, ?, 1, ?, ?, ?)
  `);
  assert.throws(() => insert.run(
    OPERATION_UID, 'a'.repeat(64), 'b'.repeat(64), 'accepted', 'forged-task',
  ));
  insert.run(OPERATION_UID, 'a'.repeat(64), 'b'.repeat(64), 'submitting', null);
  assert.throws(() => database.prepare(`
    INSERT OR REPLACE INTO h3_api_submissions
      (operation_uid, request_sha256, config_id, config_evidence_sha256,
       state, provider_task_id)
    VALUES (?, ?, 1, ?, 'submitting', NULL)
  `).run(OPERATION_UID, 'c'.repeat(64), 'd'.repeat(64)));
  database.prepare(`
    UPDATE h3_api_submissions
    SET state='accepted', provider_task_id='provider-task-a'
    WHERE operation_uid=?
  `).run(OPERATION_UID);
  insert.run(secondOperationUid, 'c'.repeat(64), 'd'.repeat(64), 'submitting', null);
  for (const recursiveTriggers of ['OFF', 'ON']) {
    database.pragma(`recursive_triggers = ${recursiveTriggers}`);
    assert.throws(() => database.prepare(`
      UPDATE OR REPLACE h3_api_submissions
      SET state='accepted', provider_task_id='provider-task-a'
      WHERE operation_uid=?
    `).run(secondOperationUid));
    assert.deepEqual(database.prepare(`
      SELECT operation_uid, state, provider_task_id
      FROM h3_api_submissions ORDER BY operation_uid
    `).all(), [
      {
        operation_uid: OPERATION_UID,
        state: 'accepted',
        provider_task_id: 'provider-task-a',
      },
      {
        operation_uid: secondOperationUid,
        state: 'submitting',
        provider_task_id: null,
      },
    ]);
  }
  assert.throws(() => database.prepare(
    'DELETE FROM h3_api_submissions WHERE operation_uid=?',
  ).run(OPERATION_UID));
  assert.deepEqual(database.prepare(`
    SELECT request_sha256, state FROM h3_api_submissions WHERE operation_uid=?
  `).get(OPERATION_UID), { request_sha256: 'a'.repeat(64), state: 'accepted' });
});

test('H3 API localhost routes expose only the public task projection', async (t) => {
  const database = createMigratedV2Database(t);
  const apiService = Object.freeze({
    async submit(_spec, operationUid) {
      assert.equal(operationUid, OPERATION_UID);
      return Object.freeze({
        schemaVersion: 'h3-api-task.v1', provider: 'minimax-api', model: 'MiniMax-H3',
        taskId: '424010985738629', status: 'queued', outputUrl: null,
      });
    },
    async query(taskId) {
      return Object.freeze({
        schemaVersion: 'h3-api-task.v1', provider: 'minimax-api', model: 'MiniMax-H3',
        taskId, status: 'running', outputUrl: null,
      });
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/v2', h3Routes({ error() {} }, database, { apiService }));
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const submitted = await fetch(`${base}/v2/h3/api/tasks`, {
    method: 'POST', headers: {
      'content-type': 'application/json',
      'idempotency-key': OPERATION_UID,
    },
    body: JSON.stringify(generationSpec()),
  });
  assert.equal(submitted.status, 200);
  const submitBody = await submitted.json();
  assert.equal(submitBody.data.taskId, '424010985738629');

  const queried = await fetch(`${base}/v2/h3/api/tasks/424010985738629`);
  assert.equal(queried.status, 200);
  const serialized = JSON.stringify([submitBody, await queried.json()]);
  assert.doesNotMatch(serialized, /authorization|credential|api[_-]?key|base[_-]?url|endpoint/i);
});

test('actual application wires the isolated H3 API service without a real provider call', async () => {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-h3-api-'));
  const configDir = path.join(tempRoot, 'configs');
  const databasePath = path.join(tempRoot, 'data', 'h3-api.sqlite').replace(/\\/gu, '/');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/gu, '/');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), [
    'app:',
    '  name: LocalMiniDrama-H3-API-E2E',
    '  version: 0.0.0-test',
    'server:',
    '  port: 0',
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
  const calls = [];
  try {
    process.chdir(tempRoot);
    const { createApp } = require('../src/app');
    const { closeDb } = require('../src/db');
    closeDatabase = closeDb;
    const { app, db } = createApp({
      h3Dependencies: {
        timeoutMs: 100,
        async fetchImpl(url, options) {
          calls.push({ url, options });
          return new Response(JSON.stringify({ task_id: '424010985738629' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    });
    seedApiConfig(db);
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    const missingKey = await fetch(
      `http://127.0.0.1:${server.address().port}/api/v1/v2/h3/api/tasks`,
      {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(generationSpec()),
      },
    );
    assert.equal(missingKey.status, 400);
    assert.equal(calls.length, 0);
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/v1/v2/h3/api/tasks`,
      {
        method: 'POST', headers: {
          'content-type': 'application/json',
          'idempotency-key': OPERATION_UID,
        },
        body: JSON.stringify(generationSpec()),
      },
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.taskId, '424010985738629');
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(SECRET, 'u'));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
