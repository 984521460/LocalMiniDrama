'use strict';

const { types: { isProxy } } = require('node:util');

const { snapshotBuffer } = require('../integrations/comfyui/byteSnapshot');
const { parseStrictJson } = require('../security/strictJson');
const { registerKnownLogSecrets } = require('../utils/redactSecrets');
const {
  fail,
  isAudioModeContractError,
} = require('./audioContract');
const { parseAudioTtsRequestRecord } = require('./audioMode');
const { settleTtsPromise } = require('./ttsAsyncControl');
const { readBoundedTtsResponse } = require('./ttsResponseBody');

const CONFIG_KEYS = Object.freeze(['fetchImpl', 'timeoutMs', 'maxAudioBytes']);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 8192;
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/audio/speech';
const MINIMAX_ENDPOINT = 'https://api.minimaxi.com/v1/t2a_v2';
const RESPONSE_OK_GETTER = Object.getOwnPropertyDescriptor(Response.prototype, 'ok').get;
const RESPONSE_STATUS_GETTER = Object.getOwnPropertyDescriptor(Response.prototype, 'status').get;
const RESPONSE_BODY_GETTER = Object.getOwnPropertyDescriptor(Response.prototype, 'body').get;
const TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const BUFFER_TO_STRING = Buffer.prototype.toString;
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill;
const STRING_TRIM = String.prototype.trim;
const REGEXP_TEST = RegExp.prototype.test;
const JSON_STRINGIFY = JSON.stringify;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;

function exactConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError();
  }
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null) || keys.length !== CONFIG_KEYS.length) {
    throw new TypeError();
  }
  const output = Object.create(null);
  for (let index = 0; index < CONFIG_KEYS.length; index += 1) {
    const key = CONFIG_KEYS[index];
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
    output[key] = descriptor.value;
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] !== 'string' || !Object.hasOwn(output, keys[index])) throw new TypeError();
  }
  return output;
}

function configuration(value) {
  let input;
  try { input = exactConfiguration(value); } catch {
    throw new TypeError('TTS provider client configuration is invalid');
  }
  if (typeof input.fetchImpl !== 'function' || isProxy(input.fetchImpl)
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 10
    || input.timeoutMs > 300_000
    || !Number.isSafeInteger(input.maxAudioBytes) || input.maxAudioBytes < 1
    || input.maxAudioBytes > DEFAULT_MAX_AUDIO_BYTES) {
    throw new TypeError('TTS provider client configuration is invalid');
  }
  return Object.freeze(input);
}

function credential(value) {
  const bytes = snapshotBuffer(
    value,
    MAX_CREDENTIAL_BYTES,
    () => new TypeError('TTS credential is invalid'),
  );
  let text;
  try { text = Reflect.apply(TEXT_DECODER_DECODE, UTF8_DECODER, [bytes]); } catch {
    Reflect.apply(TYPED_ARRAY_FILL, bytes, [0]);
    fail('AUDIO_TTS_PROVIDER_UNAVAILABLE');
  }
  if (text.length < 1 || text.length > MAX_CREDENTIAL_BYTES
    || text !== Reflect.apply(STRING_TRIM, text, [])
    || Reflect.apply(REGEXP_TEST, /[\u0000-\u0020\u007f]/u, [text])) {
    Reflect.apply(TYPED_ARRAY_FILL, bytes, [0]);
    fail('AUDIO_TTS_PROVIDER_UNAVAILABLE');
  }
  registerKnownLogSecrets(text);
  return Object.freeze({ bytes, text });
}

function adaptResponse(value) {
  if (!value || typeof value !== 'object' || isProxy(value)) {
    fail('AUDIO_TTS_RESPONSE_INVALID');
  }
  try {
    if (Object.getPrototypeOf(value) !== Response.prototype) {
      fail('AUDIO_TTS_RESPONSE_INVALID');
    }
    return Object.freeze({
      ok: RESPONSE_OK_GETTER.call(value),
      status: RESPONSE_STATUS_GETTER.call(value),
      body: RESPONSE_BODY_GETTER.call(value),
    });
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail('AUDIO_TTS_RESPONSE_INVALID');
  }
}

function providerRequest(request) {
  if (request.provider === 'openai-compatible') {
    const body = Object.create(null);
    body.model = request.model;
    body.input = request.text;
    body.voice = request.voiceKey;
    body.response_format = 'wav';
    body.speed = request.speedPermille / 1000;
    if (request.model === 'gpt-4o-mini-tts') body.instructions = request.providerEmotion;
    return Object.freeze({ endpoint: OPENAI_ENDPOINT, body: Object.freeze(body), mimeType: 'audio/wav' });
  }
  if (request.provider === 'minimax') {
    const voiceSetting = Object.create(null);
    voiceSetting.voice_id = request.voiceKey;
    voiceSetting.speed = request.speedPermille / 1000;
    voiceSetting.vol = 1;
    voiceSetting.pitch = 0;
    voiceSetting.emotion = request.providerEmotion;
    Object.freeze(voiceSetting);
    const audioSetting = Object.create(null);
    audioSetting.sample_rate = 44100;
    audioSetting.bitrate = 128000;
    audioSetting.format = 'wav';
    audioSetting.channel = 1;
    Object.freeze(audioSetting);
    const body = Object.create(null);
    body.model = request.model;
    body.text = request.text;
    body.stream = false;
    body.voice_setting = voiceSetting;
    body.audio_setting = audioSetting;
    return Object.freeze({
      endpoint: MINIMAX_ENDPOINT,
      body: Object.freeze(body),
      mimeType: 'audio/wav',
    });
  }
  return fail('AUDIO_TTS_SUBMISSION_INVALID');
}

function ownDataProperty(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('AUDIO_TTS_RESPONSE_INVALID');
  }
  try {
    const prototype = Reflect.apply(GET_PROTOTYPE_OF, Object, [value]);
    const descriptor = Reflect.apply(GET_OWN_PROPERTY_DESCRIPTOR, Object, [value, key]);
    if ((prototype !== Object.prototype && prototype !== null)
      || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('AUDIO_TTS_RESPONSE_INVALID');
    }
    return descriptor.value;
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail('AUDIO_TTS_RESPONSE_INVALID');
  }
}

function minimaxAudio(bytes, maximumBytes) {
  let payload;
  try {
    payload = parseStrictJson(
      Reflect.apply(BUFFER_TO_STRING, bytes, ['utf8']),
      maximumBytes * 2 + 256 * 1024,
    );
  } catch {
    return fail('AUDIO_TTS_RESPONSE_INVALID');
  }
  const base = ownDataProperty(payload, 'base_resp');
  const data = ownDataProperty(payload, 'data');
  const statusCode = ownDataProperty(base, 'status_code');
  const value = ownDataProperty(data, 'audio');
  if (statusCode !== 0 || typeof value !== 'string'
    || value.length < 2 || value.length > maximumBytes * 2
    || value.length % 2 !== 0 || Reflect.apply(REGEXP_TEST, /[^0-9a-f]/u, [value])) {
    fail('AUDIO_TTS_RESPONSE_INVALID');
  }
  const audio = Buffer.from(value, 'hex');
  if (audio.length < 1 || audio.length > maximumBytes
    || Reflect.apply(BUFFER_TO_STRING, audio, ['hex']) !== value) {
    fail('AUDIO_TTS_RESPONSE_INVALID');
  }
  return audio;
}

function createTtsProviderClient(value = {
  fetchImpl: globalThis.fetch,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxAudioBytes: DEFAULT_MAX_AUDIO_BYTES,
}) {
  const config = configuration(value);

  function generate(requestValue, credentialValue) {
    const pending = (async () => {
      let request;
      try { request = parseAudioTtsRequestRecord(requestValue); } catch {
        return fail('AUDIO_TTS_SUBMISSION_INVALID');
      }
      const secret = credential(credentialValue);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const prepared = providerRequest(request);
        let response;
        try {
          const headers = Object.create(null);
          headers.Accept = request.provider === 'minimax' ? 'application/json' : 'audio/wav';
          headers.Authorization = `Bearer ${secret.text}`;
          headers['Content-Type'] = 'application/json';
          Object.freeze(headers);
          const fetchOptions = Object.create(null);
          fetchOptions.method = 'POST';
          fetchOptions.redirect = 'error';
          fetchOptions.signal = controller.signal;
          fetchOptions.headers = headers;
          fetchOptions.body = Reflect.apply(JSON_STRINGIFY, JSON, [prepared.body]);
          Object.freeze(fetchOptions);
          const fetchPending = Reflect.apply(config.fetchImpl, undefined, [
            prepared.endpoint,
            fetchOptions,
          ]);
          response = adaptResponse(await settleTtsPromise(fetchPending, {
            signal: controller.signal,
            timeoutMs: config.timeoutMs,
            onTimeout: () => controller.abort(),
          }));
        } catch {
          if (controller.signal.aborted) fail('AUDIO_TTS_REQUEST_ABORTED');
          return fail('AUDIO_TTS_SUBMISSION_UNKNOWN');
        }
        const responseLimit = request.provider === 'minimax'
          ? config.maxAudioBytes * 2 + 256 * 1024
          : config.maxAudioBytes;
        const body = await readBoundedTtsResponse(response.body, controller.signal, responseLimit);
        if (!response.ok || response.status < 200 || response.status > 299) {
          fail('AUDIO_TTS_PROVIDER_REJECTED');
        }
        const audio = request.provider === 'minimax'
          ? minimaxAudio(body, config.maxAudioBytes)
          : body;
        if (audio.length < 1 || audio.length > config.maxAudioBytes) {
          fail('AUDIO_TTS_RESPONSE_INVALID');
        }
        return Object.freeze({
          schemaVersion: 'tts-provider-response.v1',
          provider: request.provider,
          requestSha256: request.requestSha256,
          mimeType: prepared.mimeType,
          audio: Buffer.from(audio),
        });
      } finally {
        clearTimeout(timer);
        Reflect.apply(TYPED_ARRAY_FILL, secret.bytes, [0]);
      }
    })();
    return settleTtsPromise(pending);
  }

  return Object.freeze({ generate });
}

module.exports = Object.freeze({
  DEFAULT_MAX_AUDIO_BYTES,
  DEFAULT_TIMEOUT_MS,
  OPENAI_ENDPOINT,
  MINIMAX_ENDPOINT,
  createTtsProviderClient,
});
