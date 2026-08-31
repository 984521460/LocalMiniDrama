'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { WindowsCredentialVault } = require('../adapters/v2/credentials');
const { LocalStorageProvider } = require('../adapters/v2/storage');
const { createAssetVersionEvidence } = require('../assets/assetVersionEvidence');
const { snapshotBuffer } = require('../integrations/comfyui/byteSnapshot');
const { parseMediaProbeEvidenceRecord } = require('../media/mediaProbeEvidence');
const {
  canonicalUid,
  exactObject,
  fail,
  isAudioModeContractError,
} = require('./audioContract');
const { settleTtsPromise } = require('./ttsAsyncControl');

const INPUT_CODE = 'AUDIO_TTS_EXECUTION_INPUT_INVALID';
const DATA_CODE = 'AUDIO_TTS_EXECUTION_DATA_INVALID';
const FAILED_CODE = 'AUDIO_TTS_EXECUTION_FAILED';
const CONFIG_KEYS = Object.freeze([
  'repositories', 'submissions', 'outputs', 'vault', 'client', 'storageProvider',
  'mediaProbe', 'timeoutMs', 'nowEpochMs',
]);
const RESPONSE_KEYS = Object.freeze([
  'schemaVersion', 'provider', 'requestSha256', 'mimeType', 'audio',
]);
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_SECRET_BYTES = 8192;
const DEFINE_PROPERTY = Object.defineProperty;
const FUNCTION_BIND = Function.prototype.bind;
const GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const REGEXP_TEST = RegExp.prototype.test;
const STRING_TRIM = String.prototype.trim;
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill;
const STORAGE_EXISTS = LocalStorageProvider.prototype.exists;
const STORAGE_READ_BOUNDED = LocalStorageProvider.prototype.readBounded;
const STORAGE_WRITE = LocalStorageProvider.prototype.write;
const VAULT_READ = WindowsCredentialVault.prototype.read;

function append(target, value) {
  Reflect.apply(DEFINE_PROPERTY, Object, [target, String(target.length), {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  }]);
}

function ownValue(value, name) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || isProxy(value)) {
    fail(INPUT_CODE);
  }
  let descriptor;
  try {
    descriptor = Reflect.apply(GET_OWN_PROPERTY_DESCRIPTOR, Object, [value, name]);
  } catch {
    return fail(INPUT_CODE);
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(INPUT_CODE);
  return descriptor.value;
}

function exactMethod(value, name, trustedPrototype, trustedMethod) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || isProxy(value)) {
    fail(INPUT_CODE);
  }
  let descriptor;
  let prototype;
  try {
    descriptor = Reflect.apply(GET_OWN_PROPERTY_DESCRIPTOR, Object, [value, name]);
    prototype = Reflect.apply(GET_PROTOTYPE_OF, Object, [value]);
  } catch {
    return fail(INPUT_CODE);
  }
  if (descriptor) {
    if (!Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) fail(INPUT_CODE);
    return Reflect.apply(FUNCTION_BIND, descriptor.value, [value]);
  }
  if (trustedPrototype && prototype === trustedPrototype && typeof trustedMethod === 'function') {
    return Reflect.apply(FUNCTION_BIND, trustedMethod, [value]);
  }
  return fail(INPUT_CODE);
}

function configuration(value) {
  try {
    const input = exactObject(value, CONFIG_KEYS, INPUT_CODE);
    const audioModeIntents = ownValue(input.repositories, 'audioModeIntents');
    const voiceProfiles = ownValue(input.repositories, 'voiceProfiles');
    if (!audioModeIntents || !voiceProfiles
      || isProxy(input.storageProvider)
      || Reflect.apply(GET_PROTOTYPE_OF, Object, [input.storageProvider])
        !== LocalStorageProvider.prototype
      || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 10
      || input.timeoutMs > 300_000 || typeof input.nowEpochMs !== 'function'
      || isProxy(input.nowEpochMs)) fail(INPUT_CODE);
    return Object.freeze({
      ...input,
      loadIntent: exactMethod(audioModeIntents, 'get'),
      loadProfile: exactMethod(voiceProfiles, 'get'),
      reserve: exactMethod(input.submissions, 'reserve'),
      getSubmission: exactMethod(input.submissions, 'get'),
      markUnknown: exactMethod(input.submissions, 'markUnknown'),
      markReceived: exactMethod(input.submissions, 'markReceived'),
      getOutput: exactMethod(input.outputs, 'get'),
      deriveReservation: exactMethod(input.outputs, 'reservation'),
      finalize: exactMethod(input.outputs, 'finalize'),
      readCredential: exactMethod(
        input.vault, 'read', WindowsCredentialVault.prototype, VAULT_READ,
      ),
      generate: exactMethod(input.client, 'generate'),
      inspect: exactMethod(input.mediaProbe, 'inspect'),
    });
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(INPUT_CODE);
  }
}

function responseRecord(value, request) {
  try {
    const input = exactObject(value, RESPONSE_KEYS, FAILED_CODE);
    if (input.schemaVersion !== 'tts-provider-response.v1'
      || input.provider !== request.provider
      || input.requestSha256 !== request.requestSha256
      || input.mimeType !== 'audio/wav') fail(FAILED_CODE);
    const audio = snapshotBuffer(
      input.audio,
      MAX_AUDIO_BYTES,
      () => fail(FAILED_CODE),
    );
    if (audio.length < 1) fail(FAILED_CODE);
    return Object.freeze({
      audio,
      summary: Object.freeze({
        sha256: createHash('sha256').update(audio).digest('hex'),
        bytes: audio.length,
        mimeType: input.mimeType,
      }),
    });
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(FAILED_CODE);
  }
}

function credentialBuffer(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_SECRET_BYTES
    || value !== Reflect.apply(STRING_TRIM, value, [])
    || Reflect.apply(REGEXP_TEST, /[\u0000-\u0020\u007f]/u, [value])) {
    fail('AUDIO_TTS_PROVIDER_UNAVAILABLE');
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length < 1 || bytes.length > MAX_SECRET_BYTES) {
    Reflect.apply(TYPED_ARRAY_FILL, bytes, [0]);
    fail('AUDIO_TTS_PROVIDER_UNAVAILABLE');
  }
  return bytes;
}

function provisionalVersion(reservation, summary) {
  return createAssetVersionEvidence({
    uid: reservation.assetVersionUid,
    assetUid: reservation.assetUid,
    storageProvider: reservation.locator.storageProvider,
    logicalUri: reservation.locator.logicalUri,
    relativePath: reservation.locator.relativePath,
    sha256: summary.sha256,
    mimeType: summary.mimeType,
    width: null,
    height: null,
    durationMs: null,
    parentUid: null,
    status: 'ready',
    createdAt: '1970-01-01T00:00:00.000Z',
  });
}

function createAudioTtsExecutionService(value) {
  const config = configuration(value);

  function expectedDrama(valueToCheck) {
    return valueToCheck === undefined ? null : canonicalUid(valueToCheck, INPUT_CODE);
  }

  function requireDrama(actual, expected) {
    if (expected !== null && actual !== expected) fail('AUDIO_TTS_EXECUTION_NOT_FOUND');
  }

  async function readAndProbe(reservation, submission) {
    let bytes;
    try {
      bytes = snapshotBuffer(
        await settleTtsPromise(
          Reflect.apply(STORAGE_READ_BOUNDED, config.storageProvider, [
            reservation.locator, MAX_AUDIO_BYTES,
          ]),
          { timeoutMs: config.timeoutMs },
        ),
        MAX_AUDIO_BYTES,
        () => fail(FAILED_CODE),
      );
      const summary = submission.response ?? Object.freeze({
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        mimeType: 'audio/wav',
      });
      if (summary.bytes !== bytes.length
        || summary.sha256 !== createHash('sha256').update(bytes).digest('hex')
        || summary.mimeType !== 'audio/wav') fail(DATA_CODE);
      let probe;
      try {
        probe = parseMediaProbeEvidenceRecord(await settleTtsPromise(config.inspect({
          schemaVersion: '8.0',
          uid: reservation.assetVersionUid,
          assetVersion: provisionalVersion(reservation, summary),
          probedAtEpochMs: config.nowEpochMs(),
        }), { timeoutMs: config.timeoutMs }));
      } catch {
        return fail(FAILED_CODE);
      }
      if (probe.assetUid !== reservation.assetUid
        || probe.assetVersionUid !== reservation.assetVersionUid
        || probe.assetVersionSha256 !== summary.sha256
        || probe.relativePathSha256
          !== createHash('sha256').update(reservation.locator.relativePath).digest('hex')
        || probe.mimeType !== summary.mimeType || probe.mediaKind !== 'audio'
        || probe.bytes !== summary.bytes || probe.video !== null || probe.audio === null
        || probe.decoded !== true) fail(DATA_CODE);
      return Object.freeze({ summary, probe });
    } catch (error) {
      if (isAudioModeContractError(error)) throw error;
      return fail(FAILED_CODE);
    } finally {
      if (bytes) Reflect.apply(TYPED_ARRAY_FILL, bytes, [0]);
    }
  }

  async function validateCompleted(record) {
    const { evidence } = record;
    for (let index = 0; index < evidence.ttsOutputs.length; index += 1) {
      const output = evidence.ttsOutputs[index];
      const reservation = Object.freeze({
        assetUid: output.audioAsset.uid,
        assetVersionUid: output.audioVersionEvidence.uid,
        locator: Object.freeze({
          storageProvider: output.audioVersionEvidence.storageProvider,
          logicalUri: output.audioVersionEvidence.logicalUri,
          relativePath: output.audioVersionEvidence.relativePath,
        }),
      });
      const observed = await readAndProbe(reservation, Object.freeze({ response: null }));
      if (observed.summary.sha256 !== output.audioVersionEvidence.sha256
        || observed.summary.mimeType !== output.audioVersionEvidence.mimeType
        || observed.probe.durationMs !== output.audioVersionEvidence.durationMs) fail(DATA_CODE);
    }
    return record;
  }

  function execute(intentUidValue, expectedDramaUidValue) {
    const pending = (async () => {
      const intentUid = canonicalUid(intentUidValue, INPUT_CODE);
      const expectedDramaUid = expectedDrama(expectedDramaUidValue);
      const completed = config.getOutput(intentUid);
      if (completed) {
        requireDrama(completed.dramaUid, expectedDramaUid);
        return validateCompleted(completed);
      }
      let intent = config.loadIntent(intentUid);
      requireDrama(intent.dramaUid, expectedDramaUid);
      const preparedOutputs = [];
      for (let index = 0; index < intent.plan.ttsRequests.length; index += 1) {
        const request = intent.plan.ttsRequests[index];
        const reservation = config.deriveReservation(intent, index);
        const profile = config.loadProfile(request.voiceProfileUid);
        if (profile.uid !== request.voiceProfileUid || profile.dramaUid !== intent.dramaUid
          || profile.provider !== request.provider || profile.model !== request.model
          || profile.voiceKey !== request.voiceKey) fail(DATA_CODE);
        let reserved;
        let credential;
        try {
          const existingSubmission = config.getSubmission(request.dialogueDeliveryUid);
          if (existingSubmission === null) {
            const secret = await settleTtsPromise(config.readCredential(profile.credentialRef), {
              timeoutMs: config.timeoutMs,
            });
            credential = credentialBuffer(secret);
          }
          reserved = config.reserve(intent.uid, index);
          let submission = reserved.submission;
          if (reserved.created) {
            if (!credential) fail(DATA_CODE);
            const alreadyExists = await settleTtsPromise(
              Reflect.apply(STORAGE_EXISTS, config.storageProvider, [reservation.locator]),
              { timeoutMs: config.timeoutMs },
            );
            if (alreadyExists) {
              submission = config.markUnknown(submission.dialogueDeliveryUid);
              fail(DATA_CODE);
            }
            let generated;
            try {
              generated = responseRecord(
                await settleTtsPromise(config.generate(request, credential), {
                  timeoutMs: config.timeoutMs,
                }),
                request,
              );
              await settleTtsPromise(
                Reflect.apply(STORAGE_WRITE, config.storageProvider, [
                  reservation.locator, generated.audio,
                ]),
                { timeoutMs: config.timeoutMs },
              );
              const observed = await readAndProbe(reservation, Object.freeze({
                response: generated.summary,
              }));
              submission = config.markReceived(
                submission.dialogueDeliveryUid,
                observed.summary,
              );
            } catch (error) {
              try { submission = config.markUnknown(submission.dialogueDeliveryUid); } catch { /* fixed */ }
              if (isAudioModeContractError(error)) throw error;
              return fail(FAILED_CODE);
            } finally {
              if (generated?.audio) Reflect.apply(TYPED_ARRAY_FILL, generated.audio, [0]);
            }
          } else if (submission.state === 'submitting') {
            fail('AUDIO_TTS_EXECUTION_IN_PROGRESS');
          }
          if (submission.state === 'submission_unknown') {
            const exists = await settleTtsPromise(
              Reflect.apply(STORAGE_EXISTS, config.storageProvider, [reservation.locator]),
              { timeoutMs: config.timeoutMs },
            );
            if (!exists) fail('AUDIO_TTS_SUBMISSION_UNKNOWN');
          } else if (submission.state !== 'received') fail(DATA_CODE);
          const observed = await readAndProbe(reservation, submission);
          append(preparedOutputs, Object.freeze({
            reservation,
            submission,
            probe: observed.probe,
          }));
        } finally {
          if (credential) Reflect.apply(TYPED_ARRAY_FILL, credential, [0]);
        }
      }
      intent = config.loadIntent(intent.uid);
      requireDrama(intent.dramaUid, expectedDramaUid);
      return config.finalize(intent, preparedOutputs);
    })();
    return settleTtsPromise(pending);
  }

  function get(intentUidValue, expectedDramaUidValue) {
    const pending = (async () => {
      const intentUid = canonicalUid(intentUidValue, INPUT_CODE);
      const expectedDramaUid = expectedDrama(expectedDramaUidValue);
      const completed = config.getOutput(intentUid);
      if (!completed) return null;
      requireDrama(completed.dramaUid, expectedDramaUid);
      return validateCompleted(completed);
    })();
    return settleTtsPromise(pending);
  }

  return Object.freeze({ execute, get });
}

module.exports = Object.freeze({ MAX_AUDIO_BYTES, createAudioTtsExecutionService });
