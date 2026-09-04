'use strict';

const { types: { isProxy } } = require('node:util');

const {
  canonicalUid,
  exactObject,
  fail,
  isAudioModeContractError,
  sha256,
} = require('./audioContract');

const INPUT_CODE = 'AUDIO_TTS_SUBMISSION_INVALID';
const DATA_CODE = 'AUDIO_TTS_SUBMISSION_DATA_INVALID';
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const PROVIDERS = Object.freeze(new Set(['openai-compatible', 'minimax']));
const STATES = Object.freeze(new Set(['submitting', 'received', 'submission_unknown']));
const MIME_TYPES = Object.freeze(new Set([
  'audio/aac', 'audio/flac', 'audio/mpeg', 'audio/wav', 'audio/x-wav',
]));
const SET_HAS = Set.prototype.has;
const RESPONSE_KEYS = Object.freeze(['sha256', 'bytes', 'mimeType']);

function captureMethod(target, name) {
  if (!target || typeof target !== 'object' || isProxy(target)) {
    throw new TypeError('Audio TTS submission store dependencies are invalid');
  }
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(target, name); } catch {
    throw new TypeError('Audio TTS submission store dependencies are invalid');
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')
    || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) {
    throw new TypeError('Audio TTS submission store dependencies are invalid');
  }
  return descriptor.value.bind(target);
}

function ordinal(value, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 999) fail(code);
  return value;
}

function epoch(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) {
    fail(DATA_CODE);
  }
  return value;
}

function provider(value, code) {
  if (typeof value !== 'string' || !Reflect.apply(SET_HAS, PROVIDERS, [value])) fail(code);
  return value;
}

function mimeType(value, code) {
  if (typeof value !== 'string' || !Reflect.apply(SET_HAS, MIME_TYPES, [value])) fail(code);
  return value;
}

function responseSummary(value, code = INPUT_CODE) {
  const input = exactObject(value, RESPONSE_KEYS, code);
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1
    || input.bytes > MAX_RESPONSE_BYTES) fail(code);
  return Object.freeze({
    sha256: sha256(input.sha256, code),
    bytes: input.bytes,
    mimeType: mimeType(input.mimeType, code),
  });
}

function expectedRequest(intent, requestOrdinal, code) {
  const requests = intent?.plan?.ttsRequests;
  if (!Array.isArray(requests) || intent.plan.mode !== 'independent_tts'
    || requestOrdinal >= requests.length) fail(code);
  const request = requests[requestOrdinal];
  if (!request || typeof request !== 'object') fail(code);
  return request;
}

function rowRecord(row, code = DATA_CODE) {
  const requestOrdinal = ordinal(row.request_ordinal, code);
  const dialogueDeliveryUid = canonicalUid(row.dialogue_delivery_uid, code);
  const intentUid = canonicalUid(row.intent_uid, code);
  const requestSha256 = sha256(row.request_sha256, code);
  const voiceProfileUid = canonicalUid(row.voice_profile_uid, code);
  const providerValue = provider(row.provider, code);
  const createdAtEpochMs = epoch(row.created_at_epoch_ms);
  const updatedAtEpochMs = epoch(row.updated_at_epoch_ms);
  if (updatedAtEpochMs < createdAtEpochMs) fail(code);
  if (!Reflect.apply(SET_HAS, STATES, [row.state])
  ) fail(code);
  let response = null;
  if (row.state === 'received') {
    response = responseSummary({
      sha256: row.response_sha256,
      bytes: row.response_bytes,
      mimeType: row.mime_type,
    }, code);
  } else if (row.response_sha256 !== null || row.response_bytes !== null
    || row.mime_type !== null) fail(code);
  return Object.freeze({
    schemaVersion: 'audio-tts-submission.v1',
    dialogueDeliveryUid,
    intentUid,
    requestOrdinal,
    requestSha256,
    voiceProfileUid,
    provider: providerValue,
    state: row.state,
    response,
    createdAtEpochMs,
    updatedAtEpochMs,
  });
}

function createAudioTtsSubmissionStore(database, options) {
  let audioModeIntents;
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options) || isProxy(options)
      || Object.getPrototypeOf(options) !== Object.prototype) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const keys = Reflect.ownKeys(descriptors);
    const descriptor = descriptors.audioModeIntents;
    if (keys.length !== 1 || keys[0] !== 'audioModeIntents'
      || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
    audioModeIntents = descriptor.value;
  } catch {
    throw new TypeError('Audio TTS submission store dependencies are invalid');
  }
  if (!database || typeof database.prepare !== 'function' || isProxy(database)) {
    throw new TypeError('Audio TTS submission store dependencies are invalid');
  }
  const loadIntent = captureMethod(audioModeIntents, 'getExecutionSource');
  let statements;
  function prepared() {
    if (statements) return statements;
    statements = Object.freeze({
      select: database.prepare(
        'SELECT * FROM audio_tts_submissions WHERE dialogue_delivery_uid=?',
      ),
      insert: database.prepare(`
        INSERT INTO audio_tts_submissions
          (dialogue_delivery_uid, intent_uid, request_ordinal, request_sha256,
           voice_profile_uid, provider, state)
        VALUES (?, ?, ?, ?, ?, ?, 'submitting')
      `),
      markUnknown: database.prepare(`
        UPDATE audio_tts_submissions
        SET state='submission_unknown', updated_at_epoch_ms=unixepoch('now') * 1000
        WHERE dialogue_delivery_uid=? AND state='submitting'
      `),
      markReceived: database.prepare(`
        UPDATE audio_tts_submissions
        SET state='received', response_sha256=?, response_bytes=?, mime_type=?,
            updated_at_epoch_ms=unixepoch('now') * 1000
        WHERE dialogue_delivery_uid=? AND state='submitting'
      `),
      recover: database.prepare(`
        UPDATE audio_tts_submissions
        SET state='submission_unknown', updated_at_epoch_ms=unixepoch('now') * 1000
        WHERE state='submitting'
      `),
    });
    return statements;
  }

  function persistedRecord(value) {
    const dialogueDeliveryUid = canonicalUid(value, INPUT_CODE);
    const row = prepared().select.get(dialogueDeliveryUid);
    if (!row) return null;
    return rowRecord(row);
  }

  function get(value) {
    const persisted = persistedRecord(value);
    if (!persisted) return null;
    validateCurrentSource(persisted);
    return persisted;
  }

  function validateCurrentSource(persisted) {
    let intent;
    try { intent = loadIntent(persisted.intentUid); } catch { return fail(DATA_CODE); }
    const request = expectedRequest(intent, persisted.requestOrdinal, DATA_CODE);
    if (intent.uid !== persisted.intentUid
      || request.dialogueDeliveryUid !== persisted.dialogueDeliveryUid
      || request.requestSha256 !== persisted.requestSha256
      || request.voiceProfileUid !== persisted.voiceProfileUid
      || request.provider !== persisted.provider) fail(DATA_CODE);
  }

  function requirePersistedRecord(value) {
    const record = persistedRecord(value);
    if (!record) fail(INPUT_CODE);
    return record;
  }

  const markReceivedTransaction = database.transaction((dialogueDeliveryUid, response) => {
    const current = requirePersistedRecord(dialogueDeliveryUid);
    try {
      validateCurrentSource(current);
    } catch {
      if (current.state !== 'submitting') fail(DATA_CODE);
      prepared().markUnknown.run(current.dialogueDeliveryUid);
      const unknown = requirePersistedRecord(current.dialogueDeliveryUid);
      if (unknown.state !== 'submission_unknown') fail(DATA_CODE);
      return Object.freeze({ sourceInvalid: true, submission: unknown });
    }
    if (current.state === 'received') {
      if (current.response.sha256 !== response.sha256
        || current.response.bytes !== response.bytes
        || current.response.mimeType !== response.mimeType) fail(INPUT_CODE);
      return Object.freeze({ sourceInvalid: false, submission: current });
    }
    if (current.state !== 'submitting') fail(INPUT_CODE);
    prepared().markReceived.run(
      response.sha256,
      response.bytes,
      response.mimeType,
      current.dialogueDeliveryUid,
    );
    const updated = requirePersistedRecord(current.dialogueDeliveryUid);
    if (updated.state !== 'received'
      || updated.response.sha256 !== response.sha256
      || updated.response.bytes !== response.bytes
      || updated.response.mimeType !== response.mimeType) fail(DATA_CODE);
    return Object.freeze({ sourceInvalid: false, submission: updated });
  });

  return Object.freeze({
    get,

    reserve(intentUidValue, requestOrdinalValue) {
      const intentUid = canonicalUid(intentUidValue, INPUT_CODE);
      const requestOrdinal = ordinal(requestOrdinalValue, INPUT_CODE);
      let intent;
      try { intent = loadIntent(intentUid); } catch { return fail(DATA_CODE); }
      const request = expectedRequest(intent, requestOrdinal, DATA_CODE);
      const existing = get(request.dialogueDeliveryUid);
      if (existing) {
        if (existing.intentUid !== intentUid || existing.requestOrdinal !== requestOrdinal
          || existing.requestSha256 !== request.requestSha256
          || existing.voiceProfileUid !== request.voiceProfileUid
          || existing.provider !== request.provider) fail(INPUT_CODE);
        return Object.freeze({ created: false, submission: existing });
      }
      try {
        prepared().insert.run(
          request.dialogueDeliveryUid,
          intentUid,
          requestOrdinal,
          request.requestSha256,
          request.voiceProfileUid,
          request.provider,
        );
      } catch {
        const raced = get(request.dialogueDeliveryUid);
        if (!raced || raced.intentUid !== intentUid || raced.requestOrdinal !== requestOrdinal
          || raced.requestSha256 !== request.requestSha256) fail(DATA_CODE);
        return Object.freeze({ created: false, submission: raced });
      }
      return Object.freeze({ created: true, submission: get(request.dialogueDeliveryUid) });
    },

    markUnknown(value) {
      const current = requirePersistedRecord(value);
      if (current.state === 'submission_unknown') return current;
      if (current.state !== 'submitting') fail(INPUT_CODE);
      try { prepared().markUnknown.run(current.dialogueDeliveryUid); } catch { return fail(DATA_CODE); }
      const updated = requirePersistedRecord(current.dialogueDeliveryUid);
      if (updated.state !== 'submission_unknown') fail(DATA_CODE);
      return updated;
    },

    markReceived(value, responseValue) {
      const dialogueDeliveryUid = canonicalUid(value, INPUT_CODE);
      const response = responseSummary(responseValue);
      let outcome;
      try {
        outcome = markReceivedTransaction.immediate(dialogueDeliveryUid, response);
      } catch (error) {
        if (isAudioModeContractError(error)) throw error;
        return fail(DATA_CODE);
      }
      if (outcome.sourceInvalid) fail('AUDIO_TTS_SUBMISSION_UNKNOWN');
      return outcome.submission;
    },

    recoverInterrupted() {
      try {
        return Object.freeze({ recoveredCount: prepared().recover.run().changes });
      } catch {
        return fail(DATA_CODE);
      }
    },
  });
}

module.exports = Object.freeze({
  MAX_RESPONSE_BYTES,
  createAudioTtsSubmissionStore,
});
