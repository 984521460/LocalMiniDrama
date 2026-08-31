'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const {
  createAudioTtsSubmissionStore,
} = require('../src/audio/audioTtsSubmissionStore');
const {
  MINIMAX_ENDPOINT,
  OPENAI_ENDPOINT,
  createTtsProviderClient,
} = require('../src/audio/ttsProviderClient');
const { isAudioModeContractError } = require('../src/audio/audioContract');
const {
  createAudioModeIntentFixture,
} = require('./helpers/v9AudioModeIntentFixture');

function errorCode(code) {
  return (error) => isAudioModeContractError(error) && error.code === code;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function storeFixture(t, options) {
  const fixture = createAudioModeIntentFixture(t, options);
  const intent = fixture.repositories.audioModeIntents.prepare(fixture.request);
  const store = createAudioTtsSubmissionStore(fixture.fixture.database, {
    audioModeIntents: fixture.repositories.audioModeIntents,
  });
  return { ...fixture, intent, store, database: fixture.fixture.database };
}

test('migration eighteen reserves each TTS request before execution and keeps identity immutable', (t) => {
  const { database, intent, store } = storeFixture(t);
  assert.equal(database.prepare('SELECT max(version) FROM schema_migrations').pluck().get(), 18);
  assert.equal(database.prepare(`
    SELECT count(*) FROM sqlite_schema
    WHERE type='table' AND name='audio_tts_submissions'
  `).pluck().get(), 1);

  const first = store.reserve(intent.uid, 0);
  assert.equal(first.created, true);
  assert.deepEqual(first.submission, {
    schemaVersion: 'audio-tts-submission.v1',
    dialogueDeliveryUid: intent.plan.ttsRequests[0].dialogueDeliveryUid,
    intentUid: intent.uid,
    requestOrdinal: 0,
    requestSha256: intent.plan.ttsRequests[0].requestSha256,
    voiceProfileUid: intent.plan.ttsRequests[0].voiceProfileUid,
    provider: 'openai-compatible',
    state: 'submitting',
    response: null,
    createdAtEpochMs: first.submission.createdAtEpochMs,
    updatedAtEpochMs: first.submission.updatedAtEpochMs,
  });
  assert.equal(store.reserve(intent.uid, 0).created, false);
  assert.throws(
    () => database.prepare('DELETE FROM audio_tts_submissions').run(),
    /append-only/u,
  );
  assert.throws(
    () => database.prepare(`
      UPDATE OR REPLACE audio_tts_submissions SET request_sha256=?
      WHERE dialogue_delivery_uid=?
    `).run('f'.repeat(64), first.submission.dialogueDeliveryUid),
    /transition is invalid/u,
  );
  assert.throws(
    () => database.prepare('DELETE FROM audio_mode_intents WHERE uid=?').run(intent.uid),
    /FOREIGN KEY/u,
  );
});

test('TTS submission summaries transition once and startup recovery marks only interrupted calls unknown', (t) => {
  const first = storeFixture(t);
  const reserved = first.store.reserve(first.intent.uid, 0).submission;
  assert.deepEqual(first.store.recoverInterrupted(), { recoveredCount: 1 });
  assert.equal(first.store.get(reserved.dialogueDeliveryUid).state, 'submission_unknown');
  assert.deepEqual(first.store.recoverInterrupted(), { recoveredCount: 0 });
  assert.throws(
    () => first.store.markReceived(reserved.dialogueDeliveryUid, {
      sha256: 'a'.repeat(64), bytes: 4, mimeType: 'audio/wav',
    }),
    errorCode('AUDIO_TTS_SUBMISSION_INVALID'),
  );

  const second = storeFixture(t, { provider: 'minimax' });
  const current = second.store.reserve(second.intent.uid, 0).submission;
  const response = { sha256: 'b'.repeat(64), bytes: 1024, mimeType: 'audio/wav' };
  const received = second.store.markReceived(current.dialogueDeliveryUid, response);
  assert.equal(received.state, 'received');
  assert.deepEqual(received.response, response);
  assert.deepEqual(second.store.markReceived(current.dialogueDeliveryUid, response), received);
  assert.deepEqual(second.store.recoverInterrupted(), { recoveredCount: 0 });
  assert.throws(
    () => second.store.markUnknown(current.dialogueDeliveryUid),
    errorCode('AUDIO_TTS_SUBMISSION_INVALID'),
  );
});

test('database rejects forged, replacement and non-intent TTS reservations under conflict algorithms', (t) => {
  const { database, intent, store } = storeFixture(t);
  const request = intent.plan.ttsRequests[0];
  store.reserve(intent.uid, 0);
  const row = {
    dialogueDeliveryUid: request.dialogueDeliveryUid,
    intentUid: intent.uid,
    requestOrdinal: 0,
    requestSha256: request.requestSha256,
    voiceProfileUid: request.voiceProfileUid,
    provider: request.provider,
  };
  const sql = (algorithm) => database.prepare(`
    INSERT ${algorithm} INTO audio_tts_submissions
      (dialogue_delivery_uid,intent_uid,request_ordinal,request_sha256,
       voice_profile_uid,provider,state)
    VALUES
      (@dialogueDeliveryUid,@intentUid,@requestOrdinal,@requestSha256,
       @voiceProfileUid,@provider,'submitting')
  `);
  for (const algorithm of ['', 'OR IGNORE', 'OR FAIL', 'OR REPLACE']) {
    assert.throws(() => sql(algorithm).run(row));
  }
  assert.throws(() => sql('').run({ ...row, dialogueDeliveryUid: row.intentUid }));
  const timeFixture = storeFixture(t);
  const timeRequest = timeFixture.intent.plan.ttsRequests[0];
  assert.throws(() => timeFixture.database.prepare(`
    INSERT INTO audio_tts_submissions
      (dialogue_delivery_uid,intent_uid,request_ordinal,request_sha256,
       voice_profile_uid,provider,state,created_at_epoch_ms,updated_at_epoch_ms)
    VALUES
      (@dialogueDeliveryUid,@intentUid,@requestOrdinal,@requestSha256,
       @voiceProfileUid,@provider,'submitting',1,1)
  `).run({
    dialogueDeliveryUid: timeRequest.dialogueDeliveryUid,
    intentUid: timeFixture.intent.uid,
    requestOrdinal: 0,
    requestSha256: timeRequest.requestSha256,
    voiceProfileUid: timeRequest.voiceProfileUid,
    provider: timeRequest.provider,
  }));
  assert.equal(database.prepare('SELECT count(*) FROM audio_tts_submissions').pluck().get(), 1);
});

test('official OpenAI TTS transport sends the exact secret-free request and returns bounded audio', async (t) => {
  const { intent } = storeFixture(t);
  const calls = [];
  const audio = Buffer.from('synthetic-wav-bytes');
  const client = createTtsProviderClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(audio, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    },
    timeoutMs: 1000,
    maxAudioBytes: 1024,
  });
  const secret = Buffer.from('synthetic-openai-key');
  const result = await client.generate(intent.plan.ttsRequests[0], secret);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, OPENAI_ENDPOINT);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-openai-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: 'gpt-4o-mini-tts',
    input: intent.plan.ttsRequests[0].text,
    voice: 'alloy',
    response_format: 'wav',
    speed: 1,
    instructions: 'fearful',
  });
  assert.equal(result.provider, 'openai-compatible');
  assert.equal(result.requestSha256, intent.plan.ttsRequests[0].requestSha256);
  assert.equal(result.mimeType, 'audio/wav');
  assert.deepEqual(result.audio, audio);
  assert.equal(secret.toString('utf8'), 'synthetic-openai-key');
  assert.equal(JSON.stringify(result).includes('synthetic-openai-key'), false);
});

test('official MiniMax TTS transport parses bounded lowercase hex audio without exposing credentials', async (t) => {
  const { intent } = storeFixture(t, { provider: 'minimax' });
  const audio = Buffer.from('synthetic-minimax-wav');
  let request;
  const client = createTtsProviderClient({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        data: { audio: audio.toString('hex'), status: 2 },
        base_resp: { status_code: 0, status_msg: 'success' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    timeoutMs: 1000,
    maxAudioBytes: 1024,
  });
  const result = await client.generate(
    intent.plan.ttsRequests[0],
    Buffer.from('synthetic-minimax-key'),
  );
  assert.equal(request.url, MINIMAX_ENDPOINT);
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'speech-02-hd',
    text: intent.plan.ttsRequests[0].text,
    stream: false,
    voice_setting: {
      voice_id: 'female-shaonv', speed: 1, vol: 1, pitch: 0, emotion: 'fearful',
    },
    audio_setting: { sample_rate: 44100, bitrate: 128000, format: 'wav', channel: 1 },
  });
  assert.deepEqual(result.audio, audio);
});

test('TTS transport fails closed on timeout, oversized response and hostile response objects', async (t) => {
  const { intent } = storeFixture(t);
  const request = intent.plan.ttsRequests[0];
  const secret = () => Buffer.from('synthetic-provider-key');
  const timeoutClient = createTtsProviderClient({
    fetchImpl: () => new Promise(() => {}),
    timeoutMs: 10,
    maxAudioBytes: 1024,
  });
  await assert.rejects(
    timeoutClient.generate(request, secret()),
    errorCode('AUDIO_TTS_REQUEST_ABORTED'),
  );

  let cancelled = false;
  const oversized = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1025)); },
    cancel() { cancelled = true; },
  });
  const oversizedClient = createTtsProviderClient({
    fetchImpl: async () => new Response(oversized, { status: 200 }),
    timeoutMs: 1000,
    maxAudioBytes: 1024,
  });
  await assert.rejects(
    oversizedClient.generate(request, secret()),
    errorCode('AUDIO_TTS_RESPONSE_INVALID'),
  );
  assert.equal(cancelled, true);

  let proxyReads = 0;
  const hostile = new Proxy(new Response(Buffer.from('x')), {
    get(target, property, receiver) {
      proxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
    getPrototypeOf(target) {
      proxyReads += 1;
      return Reflect.getPrototypeOf(target);
    },
  });
  const hostileClient = createTtsProviderClient({
    fetchImpl: () => hostile,
    timeoutMs: 1000,
    maxAudioBytes: 1024,
  });
  await assert.rejects(
    hostileClient.generate(request, secret()),
    errorCode('AUDIO_TTS_SUBMISSION_UNKNOWN'),
  );
  assert.equal(proxyReads, 0);
});

test('received response summaries bind the actual audio digest without retaining bytes in SQLite', (t) => {
  const { database, intent, store } = storeFixture(t);
  const audio = Buffer.from('durable-stage-placeholder');
  const submission = store.reserve(intent.uid, 0).submission;
  store.markReceived(submission.dialogueDeliveryUid, {
    sha256: sha256(audio),
    bytes: audio.length,
    mimeType: 'audio/wav',
  });
  const row = database.prepare('SELECT * FROM audio_tts_submissions').get();
  assert.equal(row.response_sha256, sha256(audio));
  assert.equal(row.response_bytes, audio.length);
  assert.equal(row.mime_type, 'audio/wav');
  assert.equal(Object.values(row).some((value) => Buffer.isBuffer(value)), false);
  assert.equal(JSON.stringify(row).includes(audio.toString('utf8')), false);
});

test('an in-flight success becomes unknown atomically when its source intent is unreadable', (t) => {
  const { database, intent, store } = storeFixture(t);
  const submission = store.reserve(intent.uid, 0).submission;
  database.exec('DROP TRIGGER v2_audio_mode_intents_immutable_update');
  database.prepare('UPDATE audio_mode_intents SET plan_sha256=? WHERE uid=?')
    .run('f'.repeat(64), intent.uid);
  assert.throws(
    () => store.get(submission.dialogueDeliveryUid),
    errorCode('AUDIO_TTS_SUBMISSION_DATA_INVALID'),
  );
  assert.throws(
    () => store.markReceived(submission.dialogueDeliveryUid, {
      sha256: 'a'.repeat(64), bytes: 32, mimeType: 'audio/wav',
    }),
    errorCode('AUDIO_TTS_SUBMISSION_UNKNOWN'),
  );
  assert.equal(store.markUnknown(submission.dialogueDeliveryUid).state, 'submission_unknown');
  assert.equal(database.prepare(`
    SELECT state FROM audio_tts_submissions WHERE dialogue_delivery_uid=?
  `).pluck().get(submission.dialogueDeliveryUid), 'submission_unknown');
});

test('TTS transport does not read inherited Promise constructor or custom thenables', (t) => {
  const { intent } = storeFixture(t);
  const modulePath = path.resolve(__dirname, '../src/audio/ttsProviderClient.js');
  const script = String.raw`
    const modulePath = process.argv[1];
    const request = JSON.parse(process.argv[2]);
    const { createTtsProviderClient } = require(modulePath);
    const define = Object.defineProperty;
    const descriptor = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor');
    const nativeThen = Object.getOwnPropertyDescriptor(Promise.prototype, 'then').value;
    let constructorReads = 0;
    let thenReads = 0;
    const response = new Response(Buffer.from('synthetic-audio'), { status: 200 });
    const valid = createTtsProviderClient({
      fetchImpl: () => new Promise((resolve) => queueMicrotask(() => {
        define(Promise.prototype, 'constructor', descriptor);
        resolve(response);
      })),
      timeoutMs: 1000,
      maxAudioBytes: 1024,
    });
    define(Promise.prototype, 'constructor', {
      configurable: true,
      get() { constructorReads += 1; return Promise; },
    });
    const first = valid.generate(request, Buffer.from('synthetic-key'));
    Reflect.apply(nativeThen, first, [
      () => {
        const invalid = createTtsProviderClient({
          fetchImpl: () => {
            const value = {};
            define(value, 'then', { get() { thenReads += 1; return () => {}; } });
            return value;
          },
          timeoutMs: 1000,
          maxAudioBytes: 1024,
        });
        const second = invalid.generate(request, Buffer.from('synthetic-key'));
        Reflect.apply(nativeThen, second, [
          () => process.exitCode = 2,
          () => process.stdout.write(JSON.stringify({ constructorReads, thenReads })),
        ]);
      },
      () => process.exitCode = 3,
    ]);
  `;
  const child = spawnSync(process.execPath, [
    '-e', script, modulePath, JSON.stringify(intent.plan.ttsRequests[0]),
  ], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { constructorReads: 0, thenReads: 0 });
});

test('TTS transport serializes internal request records without inherited toJSON access', (t) => {
  const { intent } = storeFixture(t);
  const modulePath = path.resolve(__dirname, '../src/audio/ttsProviderClient.js');
  const script = String.raw`
    const modulePath = process.argv[1];
    const request = JSON.parse(process.argv[2]);
    const { createTtsProviderClient } = require(modulePath);
    const nativeThen = Object.getOwnPropertyDescriptor(Promise.prototype, 'then').value;
    const response = new Response(Buffer.from('synthetic-audio'), { status: 200 });
    let reads = 0;
    let requestBody = null;
    const client = createTtsProviderClient({
      fetchImpl: (_url, options) => {
        requestBody = options.body;
        return Promise.resolve(response);
      },
      timeoutMs: 1000,
      maxAudioBytes: 1024,
    });
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get() { reads += 1; throw new Error('prototype toJSON must not run'); },
    });
    const pending = client.generate(request, Buffer.from('synthetic-key'));
    Reflect.apply(nativeThen, pending, [
      () => {
        delete Object.prototype.toJSON;
        process.stdout.write(JSON.stringify({ reads, requestBody }));
      },
      () => {
        delete Object.prototype.toJSON;
        process.exitCode = 2;
      },
    ]);
  `;
  const child = spawnSync(process.execPath, [
    '-e', script, modulePath, JSON.stringify(intent.plan.ttsRequests[0]),
  ], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.reads, 0);
  assert.equal(JSON.parse(result.requestBody).input, intent.plan.ttsRequests[0].text);
});
