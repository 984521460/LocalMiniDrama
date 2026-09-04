'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const { LocalStorageProvider } = require('../src/adapters/v2/storage');
const { createAudioTtsExecutionService } = require('../src/audio/audioTtsExecutionService');
const {
  createAudioTtsOutputRepository,
} = require('../src/repositories/v2/audioTtsOutputRepository');
const { createLocalMediaProbe } = require('../src/media/localMediaProbe');
const audioTtsExecutionRoutes = require('../src/routes/v2/audioTtsExecution');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const { createWorkflowRunService } = require('../src/workflows');
const { createAudioModeIntentFixture } = require('./helpers/v9AudioModeIntentFixture');
const { createMvpBenchmarkSessionFixture } = require('./helpers/v9MvpBenchmarkSessionFixture');
const { uid } = require('./helpers/v2RepositoryDatabase');
const audioExecutionEvidenceSchema = require('../../schemas/v8/audio-execution-evidence.schema.json');
const h3GenerationSpecSchema = require('../../schemas/v7/h3-generation-spec.schema.json');
const h3VideoEvidenceSchema = require('../../schemas/v7/h3-video-evidence.schema.json');
const audioTtsExecutionRecordSchema = require('../../schemas/v9/audio-tts-execution-record.schema.json');

function syntheticWav(root) {
  const filename = path.join(root, 'provider-response.wav');
  execFileSync(getFfmpegPath(), [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000:duration=0.4',
    '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', filename,
  ]);
  return fs.readFileSync(filename);
}

function writeOversizeSparseFile(storageProvider, locator) {
  const filename = storageProvider.resolve(locator);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const descriptor = fs.openSync(filename, 'wx');
  try {
    fs.ftruncateSync(descriptor, (16 * 1024 * 1024) + 1);
  } finally {
    fs.closeSync(descriptor);
  }
}

function createExecutionFixture(t, options = {}) {
  const current = options.sourceFixture ?? createAudioModeIntentFixture(t);
  const intent = options.sourceFixture
    ? current.audioIntent
    : current.repositories.audioModeIntents.prepare(current.request);
  const database = current.fixture?.database ?? current.database;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localminidrama-audio-tts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const audio = syntheticWav(root);
  const calls = { vault: 0, provider: 0 };
  const storageProvider = new LocalStorageProvider({ projectRoot: root });
  const outputs = createAudioTtsOutputRepository({
    database,
    repositories: current.repositories,
  });
  const service = createAudioTtsExecutionService({
    repositories: current.repositories,
    submissions: current.repositories.audioTtsSubmissions,
    outputs,
    vault: {
      async read(ref) {
        calls.vault += 1;
        assert.equal(ref, current.profile.credentialRef);
        if (options.readCredential) return options.readCredential(ref);
        return 'synthetic-credential-value';
      },
    },
    client: {
      async generate(request, credential) {
        calls.provider += 1;
        assert.deepEqual(request, intent.plan.ttsRequests[0]);
        assert.equal(Buffer.from(credential).toString('utf8'), 'synthetic-credential-value');
        if (options.generate) return options.generate(request, credential, audio);
        return Object.freeze({
          schemaVersion: 'tts-provider-response.v1',
          provider: request.provider,
          requestSha256: request.requestSha256,
          mimeType: 'audio/wav',
          audio: Buffer.from(audio),
        });
      },
    },
    storageProvider,
    mediaProbe: options.mediaProbe ?? createLocalMediaProbe({
      localRoot: root,
      ffmpegPath: getFfmpegPath(),
      ffprobePath: getFfprobePath(),
    }),
    timeoutMs: 30_000,
    nowEpochMs: Date.now,
  });
  return Object.freeze({ ...current, audio, calls, intent, outputs, root, service, storageProvider });
}

test('local TTS execution seals decoded audio and is idempotent without a second paid call', async (t) => {
  const current = createExecutionFixture(t);
  const first = await current.service.execute(current.intent.uid);

  assert.equal(first.schemaVersion, 'audio-tts-execution-record.v1');
  assert.equal(first.intentUid, current.intent.uid);
  assert.equal(first.dramaUid, current.intent.dramaUid);
  assert.equal(first.evidence.ttsOutputs.length, 1);
  assert.equal(first.evidence.ttsOutputs[0].audioVersionEvidence.mimeType, 'audio/wav');
  assert.ok(first.evidence.ttsOutputs[0].audioVersionEvidence.durationMs > 0);
  const validate = new Ajv2020({ allErrors: true, strict: true })
    .addSchema(h3GenerationSpecSchema)
    .addSchema(h3VideoEvidenceSchema)
    .addSchema(audioExecutionEvidenceSchema)
    .compile(audioTtsExecutionRecordSchema);
  assert.equal(validate(first), true, JSON.stringify(validate.errors));
  assert.deepEqual(current.calls, { vault: 1, provider: 1 });

  const persisted = current.service.getPersisted(current.intent.uid, current.intent.dramaUid);
  assert.deepEqual(persisted, first);
  assert.deepEqual(current.calls, { vault: 1, provider: 1 });

  const reservation = current.outputs.reservation(current.intent, 0);
  assert.deepEqual(await current.storageProvider.read(reservation.locator), current.audio);
  assert.equal(
    current.fixture.database.prepare('SELECT count(*) FROM audio_tts_outputs').pluck().get(),
    1,
  );
  assert.equal(
    current.fixture.database.prepare('SELECT count(*) FROM audio_tts_execution_evidence').pluck().get(),
    1,
  );
  const run = current.repositories.runs.getWorkflowWithNodes(current.intent.workflowRunUid);
  assert.equal(run.run.status, 'succeeded');
  assert.equal(run.nodes.find((node) => node.uid === current.intent.nodeRunUid).status, 'succeeded');

  const second = await current.service.execute(current.intent.uid);
  assert.deepEqual(second, first);
  assert.deepEqual(current.calls, { vault: 1, provider: 1 });
  assert.doesNotMatch(JSON.stringify(first), /synthetic-credential-value/u);
  assert.equal(
    current.fixture.database.serialize().includes(Buffer.from('synthetic-credential-value')),
    false,
  );
});

test('local TTS execution completes its queued node after earlier workflow work has started', async (t) => {
  const current = createExecutionFixture(t);
  current.repositories.runs.transitionWorkflowStatus({
    uid: current.intent.workflowRunUid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });

  const completed = await current.service.execute(
    current.intent.uid,
    current.intent.dramaUid,
  );

  assert.equal(completed.intentUid, current.intent.uid);
  assert.deepEqual(current.calls, { vault: 1, provider: 1 });
  const aggregate = current.repositories.runs.getWorkflowWithNodes(
    current.intent.workflowRunUid,
  );
  assert.equal(aggregate.run.status, 'succeeded');
  assert.equal(
    aggregate.nodes.find((node) => node.uid === current.intent.nodeRunUid).status,
    'succeeded',
  );
});

test('the real TTS sink closes a benchmark workflow after its four H3 nodes succeed', async (t) => {
  const source = createMvpBenchmarkSessionFixture(t);
  const current = createExecutionFixture(t, { sourceFixture: source });
  current.repositories.runs.transitionWorkflowStatus({
    uid: current.intent.workflowRunUid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  for (let index = 0; index < current.h3Intents.length; index += 1) {
    const intent = current.h3Intents[index];
    const task = current.repositories.remote.getFormalTask(intent.taskUid);
    const nodeRunUid = task.idempotencyKey.slice('remote-task:v1:'.length);
    current.repositories.runs.transitionNodeStatus({
      uid: nodeRunUid,
      expectedStatus: 'queued',
      nextStatus: 'running',
      inputSnapshot: { remoteTaskUid: task.uid },
    });
    current.repositories.runs.transitionNodeStatus({
      uid: nodeRunUid,
      expectedStatus: 'running',
      nextStatus: 'succeeded',
      output: { assetVersionUid: intent.parentVersionUid, remoteTaskUid: task.uid },
    });
  }

  const completed = await current.service.execute(
    current.intent.uid,
    current.intent.dramaUid,
  );
  const aggregate = current.repositories.runs.getWorkflowWithNodes(
    current.intent.workflowRunUid,
  );

  assert.equal(completed.intentUid, current.intent.uid);
  assert.deepEqual(current.calls, { vault: 1, provider: 1 });
  assert.equal(aggregate.run.status, 'succeeded');
  assert.equal(aggregate.nodes.length, 5);
  assert.ok(aggregate.nodes.every((node) => node.status === 'succeeded'));
});

test('a terminal workflow rejects TTS before credential or provider access', async (t) => {
  const current = createExecutionFixture(t);
  createWorkflowRunService({
    repositories: current.repositories,
    createUid: () => uid(97500),
  }).cancelRun({ runUid: current.intent.workflowRunUid });

  await assert.rejects(
    () => current.service.execute(current.intent.uid, current.intent.dramaUid),
    { code: 'V2_REPOSITORY_DATA_INVALID' },
  );

  assert.deepEqual(current.calls, { vault: 0, provider: 0 });
  assert.equal(current.outputs.get(current.intent.uid), null);
  assert.equal(
    current.fixture.database.prepare('SELECT count(*) FROM audio_tts_submissions').pluck().get(),
    0,
  );
});

test('unknown TTS submission never retries a paid call and can finalize from its deterministic file', async (t) => {
  const missing = createExecutionFixture(t);
  const request = missing.intent.plan.ttsRequests[0];
  missing.repositories.audioTtsSubmissions.reserve(missing.intent.uid, 0);
  missing.repositories.audioTtsSubmissions.markUnknown(request.dialogueDeliveryUid);
  await assert.rejects(
    () => missing.service.execute(missing.intent.uid),
    { code: 'AUDIO_TTS_SUBMISSION_UNKNOWN' },
  );
  assert.deepEqual(missing.calls, { vault: 0, provider: 0 });
  assert.equal(missing.outputs.get(missing.intent.uid), null);
  assert.equal(
    missing.repositories.runs.getWorkflow(missing.intent.workflowRunUid).status,
    'queued',
  );

  const recovered = createExecutionFixture(t);
  const recoveredRequest = recovered.intent.plan.ttsRequests[0];
  recovered.repositories.audioTtsSubmissions.reserve(recovered.intent.uid, 0);
  recovered.repositories.audioTtsSubmissions.markUnknown(recoveredRequest.dialogueDeliveryUid);
  const reservation = recovered.outputs.reservation(recovered.intent, 0);
  await recovered.storageProvider.write(reservation.locator, recovered.audio);

  const result = await recovered.service.execute(recovered.intent.uid);
  assert.equal(result.evidence.ttsOutputs.length, 1);
  assert.deepEqual(recovered.calls, { vault: 0, provider: 0 });
  assert.equal(
    recovered.fixture.database.prepare(`
      SELECT state FROM audio_tts_submissions WHERE dialogue_delivery_uid=?
    `).pluck().get(recoveredRequest.dialogueDeliveryUid),
    'submission_unknown',
  );
  assert.equal(
    recovered.repositories.runs.getWorkflow(recovered.intent.workflowRunUid).status,
    'succeeded',
  );
});

test('oversize unknown and completed local audio fail before probe, provider, or database seal', async (t) => {
  let unknownProbeCalls = 0;
  const unknown = createExecutionFixture(t, {
    mediaProbe: Object.freeze({
      inspect() { unknownProbeCalls += 1; throw new Error('synthetic unexpected probe'); },
    }),
  });
  const unknownRequest = unknown.intent.plan.ttsRequests[0];
  unknown.repositories.audioTtsSubmissions.reserve(unknown.intent.uid, 0);
  unknown.repositories.audioTtsSubmissions.markUnknown(unknownRequest.dialogueDeliveryUid);
  const unknownReservation = unknown.outputs.reservation(unknown.intent, 0);
  writeOversizeSparseFile(unknown.storageProvider, unknownReservation.locator);
  await assert.rejects(
    () => unknown.service.execute(unknown.intent.uid),
    { code: 'AUDIO_TTS_EXECUTION_FAILED' },
  );
  assert.equal(unknownProbeCalls, 0);
  assert.deepEqual(unknown.calls, { vault: 0, provider: 0 });
  assert.equal(unknown.outputs.get(unknown.intent.uid), null);
  assert.equal(
    unknown.fixture.database.prepare('SELECT count(*) FROM audio_tts_execution_evidence')
      .pluck().get(),
    0,
  );

  const completed = createExecutionFixture(t);
  await completed.service.execute(completed.intent.uid);
  const completedReservation = completed.outputs.reservation(completed.intent, 0);
  const completedFilename = completed.storageProvider.resolve(completedReservation.locator);
  fs.unlinkSync(completedFilename);
  writeOversizeSparseFile(completed.storageProvider, completedReservation.locator);
  let completedProbeCalls = 0;
  const readOnlyService = createAudioTtsExecutionService({
    repositories: completed.repositories,
    submissions: completed.repositories.audioTtsSubmissions,
    outputs: completed.outputs,
    vault: Object.freeze({ read() { throw new Error('synthetic unexpected vault read'); } }),
    client: Object.freeze({ generate() { throw new Error('synthetic unexpected provider call'); } }),
    storageProvider: completed.storageProvider,
    mediaProbe: Object.freeze({
      inspect() { completedProbeCalls += 1; throw new Error('synthetic unexpected probe'); },
    }),
    timeoutMs: 30_000,
    nowEpochMs: Date.now,
  });
  const persistedWithoutMedia = readOnlyService.getPersisted(
    completed.intent.uid,
    completed.intent.dramaUid,
  );
  assert.equal(persistedWithoutMedia.intentUid, completed.intent.uid);
  assert.equal(completedProbeCalls, 0);
  await assert.rejects(
    () => readOnlyService.get(completed.intent.uid),
    { code: 'AUDIO_TTS_EXECUTION_FAILED' },
  );
  assert.equal(completedProbeCalls, 0);
  assert.deepEqual(completed.calls, { vault: 1, provider: 1 });
  assert.equal(
    completed.fixture.database.prepare('SELECT count(*) FROM audio_tts_execution_evidence')
      .pluck().get(),
    1,
  );
});

test('concurrent execution observes the durable submitting claim and never duplicates a paid call', async (t) => {
  let releaseProvider;
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const gate = new Promise((resolve) => { releaseProvider = resolve; });
  const current = createExecutionFixture(t, {
    async generate(request, credential, audio) {
      providerStarted();
      await gate;
      return Object.freeze({
        schemaVersion: 'tts-provider-response.v1',
        provider: request.provider,
        requestSha256: request.requestSha256,
        mimeType: 'audio/wav',
        audio: Buffer.from(audio),
      });
    },
  });

  const first = current.service.execute(current.intent.uid);
  await started;
  await assert.rejects(
    () => current.service.execute(current.intent.uid),
    { code: 'AUDIO_TTS_EXECUTION_IN_PROGRESS' },
  );
  releaseProvider();
  const completed = await first;
  assert.equal(completed.intentUid, current.intent.uid);
  assert.deepEqual(current.calls, { vault: 1, provider: 1 });
});

test('localhost execution route returns the revalidated local TTS record', async (t) => {
  const current = createExecutionFixture(t);
  const app = express();
  app.use('/v2', audioTtsExecutionRoutes(
    Object.freeze({ error() {} }),
    Object.freeze({ service: current.service, outputs: current.outputs }),
  ));
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/v2/dramas/${current.intent.dramaUid}`
    + `/audio-tts-executions/${current.intent.uid}`;

  const wrongDrama = await fetch(
    `http://127.0.0.1:${port}/v2/dramas/00000000-0000-4000-8000-000000000001`
      + `/audio-tts-executions/${current.intent.uid}/execute`,
    { method: 'POST' },
  );
  assert.equal(wrongDrama.status, 404);
  assert.deepEqual(current.calls, { vault: 0, provider: 0 });

  const executeResponse = await fetch(`${base}/execute`, { method: 'POST' });
  const executeBody = await executeResponse.json();
  assert.equal(executeResponse.status, 200);
  assert.equal(executeBody.success, true);
  assert.equal(executeBody.data.intentUid, current.intent.uid);

  const getResponse = await fetch(base);
  const getBody = await getResponse.json();
  assert.equal(getResponse.status, 200);
  assert.deepEqual(getBody.data, executeBody.data);
  assert.deepEqual(current.calls, { vault: 1, provider: 1 });

  const wrongDramaGet = await fetch(
    `http://127.0.0.1:${port}/v2/dramas/00000000-0000-4000-8000-000000000001`
      + `/audio-tts-executions/${current.intent.uid}`,
  );
  assert.equal(wrongDramaGet.status, 404);
});

test('a failed final database seal is recoverable without repeating the provider request', async (t) => {
  const current = createExecutionFixture(t);
  const reservation = current.outputs.reservation(current.intent, 0);
  current.fixture.database.exec(`
    CREATE TRIGGER synthetic_audio_tts_execution_failure
    BEFORE INSERT ON audio_tts_execution_evidence
    BEGIN
      SELECT RAISE(ABORT, 'synthetic execution seal failure');
    END
  `);

  await assert.rejects(
    () => current.service.execute(current.intent.uid),
    { code: 'AUDIO_TTS_EXECUTION_DATA_INVALID' },
  );
  assert.deepEqual(current.calls, { vault: 1, provider: 1 });
  assert.equal(await current.storageProvider.exists(reservation.locator), true);
  assert.equal(
    current.fixture.database.prepare('SELECT state FROM audio_tts_submissions').pluck().get(),
    'received',
  );
  assert.equal(
    current.fixture.database.prepare('SELECT count(*) FROM audio_tts_outputs').pluck().get(),
    0,
  );
  assert.equal(
    current.fixture.database.prepare('SELECT count(*) FROM assets WHERE uid=?')
      .pluck().get(reservation.assetUid),
    0,
  );
  assert.equal(
    current.fixture.database.prepare('SELECT count(*) FROM asset_versions WHERE uid=?')
      .pluck().get(reservation.assetVersionUid),
    0,
  );
  assert.equal(current.repositories.runs.getWorkflow(current.intent.workflowRunUid).status, 'queued');

  current.fixture.database.exec('DROP TRIGGER synthetic_audio_tts_execution_failure');
  const recovered = await current.service.execute(current.intent.uid);
  assert.equal(recovered.evidence.ttsOutputs.length, 1);
  assert.deepEqual(current.calls, { vault: 1, provider: 1 });
  assert.equal(current.repositories.runs.getWorkflow(current.intent.workflowRunUid).status, 'succeeded');
});

test('TTS output seals reject replacement and reads fail closed after persisted drift', async (t) => {
  const current = createExecutionFixture(t);
  await current.service.execute(current.intent.uid);
  const outputRow = current.fixture.database.prepare('SELECT * FROM audio_tts_outputs').get();
  const evidenceRow = current.fixture.database.prepare(
    'SELECT * FROM audio_tts_execution_evidence',
  ).get();

  assert.throws(
    () => current.fixture.database.prepare(`
      UPDATE audio_tts_outputs SET response_sha256=? WHERE dialogue_delivery_uid=?
    `).run('f'.repeat(64), outputRow.dialogue_delivery_uid),
    /audio TTS outputs are immutable/u,
  );
  assert.throws(
    () => current.fixture.database.prepare('DELETE FROM audio_tts_execution_evidence').run(),
    /audio TTS execution evidence is append-only/u,
  );
  current.fixture.database.pragma('recursive_triggers = OFF');
  const outputColumns = Object.keys(outputRow).join(',');
  const outputValues = Object.keys(outputRow).map((key) => `@${key}`).join(',');
  assert.throws(
    () => current.fixture.database.prepare(`
      INSERT OR REPLACE INTO audio_tts_outputs (${outputColumns}) VALUES (${outputValues})
    `).run(outputRow),
    /audio TTS outputs cannot be replaced/u,
  );
  assert.equal(
    current.fixture.database.prepare('SELECT count(*) FROM audio_tts_outputs').pluck().get(),
    1,
  );

  current.fixture.database.exec('DROP TRIGGER v2_audio_tts_outputs_immutable_update');
  current.fixture.database.prepare(`
    UPDATE audio_tts_outputs SET response_sha256=? WHERE dialogue_delivery_uid=?
  `).run('f'.repeat(64), outputRow.dialogue_delivery_uid);
  assert.throws(
    () => current.outputs.get(current.intent.uid),
    { code: 'AUDIO_TTS_EXECUTION_DATA_INVALID' },
  );
  assert.equal(evidenceRow.intent_uid, current.intent.uid);

  current.fixture.database.exec(`
    DROP TRIGGER v2_audio_tts_execution_evidence_reject_delete;
    DELETE FROM audio_tts_execution_evidence;
    DROP TRIGGER v2_audio_tts_outputs_reject_delete;
    DROP TRIGGER v2_audio_tts_outputs_reject_replacement;
    DELETE FROM audio_tts_outputs;
  `);
  const currentSecond = current.fixture.database
    .prepare("SELECT unixepoch('now') * 1000").pluck().get();
  const insertOutput = current.fixture.database.prepare(`
    INSERT INTO audio_tts_outputs (${outputColumns}) VALUES (${outputValues})
  `);
  assert.throws(
    () => insertOutput.run({ ...outputRow, created_at_epoch_ms: currentSecond - 2000 }),
    /audio TTS output is invalid/u,
  );
  assert.equal(
    insertOutput.run({ ...outputRow, created_at_epoch_ms: currentSecond - 1000 }).changes,
    1,
  );
});

test('completed TTS reads revalidate the terminal workflow node evidence', async (t) => {
  const current = createExecutionFixture(t);
  await current.service.execute(current.intent.uid);
  current.fixture.database.exec('DROP TRIGGER v2_node_runs_freeze_execution_data');
  current.fixture.database.prepare('UPDATE node_runs SET output_json=? WHERE uid=?')
    .run('{}', current.intent.nodeRunUid);
  assert.throws(
    () => current.outputs.get(current.intent.uid),
    { code: 'AUDIO_TTS_EXECUTION_DATA_INVALID' },
  );
  await assert.rejects(
    () => current.service.get(current.intent.uid),
    { code: 'AUDIO_TTS_EXECUTION_DATA_INVALID' },
  );
});

test('completed TTS reads reject coordinated execution-envelope identity drift', async (t) => {
  const current = createExecutionFixture(t);
  await current.service.execute(current.intent.uid);
  const otherDramaUid = '00000000-0000-4000-8000-00000000f019';
  current.fixture.database.prepare('INSERT INTO dramas (title, uid) VALUES (?, ?)')
    .run('Synthetic unrelated drama', otherDramaUid);
  current.fixture.database.exec('DROP TRIGGER v2_audio_tts_execution_evidence_immutable_update');
  current.fixture.database.prepare(`
    UPDATE audio_tts_execution_evidence SET drama_uid=? WHERE intent_uid=?
  `).run(otherDramaUid, current.intent.uid);
  assert.throws(
    () => current.outputs.get(current.intent.uid),
    { code: 'AUDIO_TTS_EXECUTION_DATA_INVALID' },
  );
  await assert.rejects(
    () => current.service.get(current.intent.uid),
    { code: 'AUDIO_TTS_EXECUTION_DATA_INVALID' },
  );
});

test('hostile media probe results fail closed without executing traps or sealing assets', async (t) => {
  let proxyReads = 0;
  const proxied = createExecutionFixture(t, {
    mediaProbe: Object.freeze({
      inspect() {
        return new Proxy({}, {
          get() { proxyReads += 1; throw new Error('synthetic proxy trap'); },
          ownKeys() { proxyReads += 1; throw new Error('synthetic proxy trap'); },
        });
      },
    }),
  });
  await assert.rejects(
    () => proxied.service.execute(proxied.intent.uid),
    { code: 'AUDIO_TTS_EXECUTION_FAILED' },
  );
  assert.equal(proxyReads, 0);
  assert.deepEqual(proxied.calls, { vault: 1, provider: 1 });
  assert.equal(
    proxied.fixture.database.prepare('SELECT count(*) FROM audio_tts_outputs').pluck().get(),
    0,
  );
  assert.equal(
    proxied.fixture.database.prepare('SELECT count(*) FROM assets WHERE uid=?').pluck()
      .get(proxied.outputs.reservation(proxied.intent, 0).assetUid),
    0,
  );
});

test('TTS execution contracts do not invoke polluted inherited collection hooks', async (t) => {
  const current = createExecutionFixture(t);
  const completed = await current.service.execute(current.intent.uid);
  const payload = Buffer.from(JSON.stringify({
    intent: current.intent,
    evidence: completed.evidence,
    root: current.root,
  }), 'utf8').toString('base64');
  const script = String.raw`
    const root = process.argv[1];
    const payload = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
    const { canonicalJson } = require(root + '/src/audio/audioContract');
    const {
      parsePersistedAudioExecutionEvidence,
    } = require(root + '/src/audio/audioExecutionEvidence');
    const { createAudioTtsExecutionService } = require(root + '/src/audio/audioTtsExecutionService');
    const { outputReservation } = require(root + '/src/repositories/v2/audioTtsOutputRepository');
    const { LocalStorageProvider } = require(root + '/src/adapters/v2/storage');
    const { WindowsCredentialVault } = require(root + '/src/adapters/v2/credentials');
    const define = Object.defineProperty;
    const descriptor = Object.getOwnPropertyDescriptor;
    const hooks = [
      [Array.prototype, 'map'], [Array.prototype, 'push'], [Array.prototype, 'find'],
      [Array.prototype, 'every'], [Array.prototype, 'some'], [Array.prototype, 'includes'],
      [Array.prototype, Symbol.iterator], [Map.prototype, 'get'], [Map.prototype, 'set'],
      [Map.prototype, 'size'], [Map.prototype, 'keys'], [Set.prototype, 'has'],
      [Set.prototype, 'add'], [Set.prototype, 'size'], [WeakSet.prototype, 'has'],
      [WeakSet.prototype, 'add'], [String.prototype, 'trim'],
      [String.prototype, 'normalize'], [String.prototype, 'toLowerCase'],
      [String.prototype, 'codePointAt'], [String.prototype, Symbol.iterator],
      [RegExp.prototype, 'test'], [Function.prototype, 'bind'],
      [Object.prototype, 'toJSON'],
    ];
    const originals = [];
    for (let index = 0; index < hooks.length; index += 1) {
      define(originals, String(index), {
        configurable: true,
        enumerable: true,
        writable: true,
        value: descriptor(hooks[index][0], hooks[index][1]),
      });
    }
    const storageProvider = new LocalStorageProvider({ projectRoot: payload.root });
    const repository = Object.freeze({
      get() { return null; },
      getExecutionSource() { return null; },
    });
    const repositories = Object.freeze({
      audioModeIntents: repository,
      voiceProfiles: repository,
    });
    const methods = Object.freeze({
      get() { return null; }, reserve() {}, markUnknown() {}, markReceived() {},
    });
    const outputs = Object.freeze({ get() { return null; }, reservation() {}, finalize() {} });
    const vault = new WindowsCredentialVault({
      bridge: Object.freeze({ read() { return null; } }),
    });
    const client = Object.freeze({ generate() {} });
    const mediaProbe = Object.freeze({ inspect() {} });
    let reads = 0;
    let totalReads = 0;
    const readsByHook = Object.create(null);
    let reservation;
    let parsed;
    const phases = Object.create(null);
    function resetReads() {
      reads = 0;
      for (let index = 0; index < hooks.length; index += 1) readsByHook[String(index)] = 0;
    }
    function capture(name) {
      const snapshot = Object.create(null);
      for (let index = 0; index < hooks.length; index += 1) {
        if (readsByHook[String(index)] > 0) snapshot[String(index)] = readsByHook[String(index)];
      }
      phases[name] = snapshot;
    }
    try {
      for (let index = 0; index < hooks.length; index += 1) {
        const original = originals[index];
        define(hooks[index][0], hooks[index][1], {
          configurable: true,
          get() {
            reads += 1;
            totalReads += 1;
            readsByHook[String(index)] = (readsByHook[String(index)] || 0) + 1;
            if (original && Object.hasOwn(original, 'value')) return original.value;
            return undefined;
          },
        });
      }
      resetReads();
      reservation = outputReservation(payload.intent, 0);
      capture('reservation');
      resetReads();
      parsed = parsePersistedAudioExecutionEvidence(payload.evidence, payload.intent.plan);
      capture('parse');
      resetReads();
      canonicalJson(parsed);
      capture('json');
      resetReads();
      createAudioTtsExecutionService({
        repositories,
        submissions: methods,
        outputs,
        vault,
        client,
        storageProvider,
        mediaProbe,
        timeoutMs: 1000,
        nowEpochMs: Date.now,
      });
      capture('service');
    } finally {
      for (let index = 0; index < hooks.length; index += 1) {
        const original = originals[index];
        if (original) define(hooks[index][0], hooks[index][1], original);
        else delete hooks[index][0][hooks[index][1]];
      }
    }
    process.stdout.write(JSON.stringify({
      reads: totalReads,
      readsByHook,
      phases,
      assetUid: reservation.assetUid,
      parsed: parsed.executionSha256,
    }));
  `;
  const child = spawnSync(process.execPath, ['-e', script, path.join(__dirname, '..'), payload], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.reads, 0, JSON.stringify(result.phases));
  assert.equal(result.assetUid, completed.evidence.ttsOutputs[0].audioAsset.uid);
  assert.equal(result.parsed, completed.evidence.executionSha256);
});

test('actual application wires local TTS execution with synthetic-only dependencies', async (t) => {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localminidrama-audio-app-'));
  const configDir = path.join(tempRoot, 'configs');
  const databasePath = path.join(tempRoot, 'data', 'audio.sqlite').replace(/\\/gu, '/');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/gu, '/');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), [
    'app:',
    '  name: LocalMiniDrama-Audio-TTS-E2E',
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

  const audio = syntheticWav(tempRoot);
  const calls = { vault: 0, provider: 0 };
  let server;
  let closeDatabase = () => {};
  try {
    process.chdir(tempRoot);
    const { createApp } = require('../src/app');
    const { closeDb } = require('../src/db');
    closeDatabase = closeDb;
    const created = createApp({
      audioTtsDependencies: {
        credentialVault: Object.freeze({
          async read() {
            calls.vault += 1;
            return 'synthetic-app-credential';
          },
        }),
        ttsClient: Object.freeze({
          async generate(request, credential) {
            calls.provider += 1;
            assert.equal(Buffer.from(credential).toString('utf8'), 'synthetic-app-credential');
            return Object.freeze({
              schemaVersion: 'tts-provider-response.v1',
              provider: request.provider,
              requestSha256: request.requestSha256,
              mimeType: 'audio/wav',
              audio: Buffer.from(audio),
            });
          },
        }),
        timeoutMs: 30_000,
      },
    });
    await created.startupRecoveryPromise;
    const seeded = createAudioModeIntentFixture(t, { database: created.db });
    const intent = seeded.repositories.audioModeIntents.prepare(seeded.request);
    server = await new Promise((resolve, reject) => {
      const instance = created.app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/v1/v2/dramas/${intent.dramaUid}`
        + `/audio-tts-executions/${intent.uid}/execute`,
      { method: 'POST' },
    );
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data.intentUid, intent.uid);
    assert.equal(body.data.evidence.ttsOutputs.length, 1);
    assert.deepEqual(calls, { vault: 1, provider: 1 });
    assert.equal(
      created.db.prepare('SELECT count(*) FROM audio_tts_execution_evidence').pluck().get(),
      1,
    );
    assert.equal(
      seeded.repositories.runs.getWorkflow(intent.workflowRunUid).status,
      'succeeded',
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
