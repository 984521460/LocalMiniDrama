'use strict';

const { types: { isProxy } } = require('node:util');

const imageClient = require('../../services/imageClient');
const { createBoundedImageSourceReader } = require('./boundedImageSource');

const VERSION = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const NOOP_LOG = Object.freeze({ info() {}, warn() {}, error() {} });
const COMMAND_KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'ordinal', 'prompt', 'promptSha256', 'width', 'height', 'seed',
]);

function exactCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Character candidate generation command is invalid');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError('Character candidate generation command is invalid');
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== COMMAND_KEYS.length) {
    throw new TypeError('Character candidate generation command is invalid');
  }
  const output = Object.create(null);
  for (let index = 0; index < COMMAND_KEYS.length; index += 1) {
    const key = COMMAND_KEYS[index];
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Character candidate generation command is invalid');
    }
    output[key] = descriptor.value;
  }
  if (output.schemaVersion !== 'character-candidate-generation-command.v1'
    || typeof output.prompt !== 'string' || Buffer.byteLength(output.prompt, 'utf8') > 64 * 1024
    || typeof output.promptSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(output.promptSha256)
    || !Number.isSafeInteger(output.ordinal) || output.ordinal < 0 || output.ordinal > 3
    || !Number.isSafeInteger(output.width) || !Number.isSafeInteger(output.height)
    || !Number.isSafeInteger(output.seed)) {
    throw new TypeError('Character candidate generation command is invalid');
  }
  return output;
}

function token(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || !VERSION.test(value.toLowerCase())) {
    throw new TypeError('Configured image provider metadata is invalid');
  }
  return value;
}

function selectedModel(config) {
  const models = Array.isArray(config.model) ? config.model : [config.model];
  if (typeof config.default_model === 'string') {
    for (let index = 0; index < models.length; index += 1) {
      if (models[index] === config.default_model) return token(config.default_model);
    }
  }
  return token(models[0]);
}

function imageUrl(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || isProxy(result)) {
    throw new TypeError('Configured image provider response is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(result);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 1 || typeof keys[0] !== 'string') {
    throw new TypeError('Configured image provider response is invalid');
  }
  const descriptor = descriptors[keys[0]];
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
    || keys[0] !== 'image_url' || typeof descriptor.value !== 'string') {
    throw new TypeError('Configured image provider response is invalid');
  }
  return descriptor.value;
}

function createConfiguredCharacterCandidateImageProvider({ database, dependencies = {} } = {}) {
  const callImageApi = dependencies.callImageApi || imageClient.callImageApi;
  const getDefaultImageConfig = dependencies.getDefaultImageConfig
    || imageClient.getDefaultImageConfig;
  const readImageSource = dependencies.readImageSource || createBoundedImageSourceReader();
  if (!database || typeof database.prepare !== 'function'
    || typeof callImageApi !== 'function' || typeof getDefaultImageConfig !== 'function'
    || typeof readImageSource !== 'function') {
    throw new TypeError('Configured image provider dependencies are invalid');
  }
  return Object.freeze({
    scope: 'configured-image',
    isAvailable() {
      try {
        return database.prepare(`
          SELECT 1 AS available FROM ai_service_configs
          WHERE service_type='image' AND deleted_at IS NULL AND is_active=1
          LIMIT 1
        `).get()?.available === 1;
      } catch {
        return false;
      }
    },
    async generate(value) {
      const command = exactCommand(value);
      const config = getDefaultImageConfig(database, undefined, undefined, 'image');
      if (!config || !config.is_active) throw new TypeError('Configured image provider is unavailable');
      const provider = token(String(config.provider || '').toLowerCase());
      const model = selectedModel(config);
      const size = `${command.width}x${command.height}`;
      const result = await callImageApi(database, NOOP_LOG, {
        prompt: command.prompt,
        size,
        quality: 'standard',
        drama_id: 0,
        image_type: 'character_candidate',
        image_gen_id: command.operationUid,
        imageServiceType: 'image',
        seed: command.seed,
      });
      const source = await readImageSource(imageUrl(result));
      return Object.freeze({
        provider,
        model,
        parameters: Object.freeze({
          adapter: 'configured-image.v1',
          size,
          requestedSeed: command.seed,
          ordinal: command.ordinal,
        }),
        bytes: source.bytes,
      });
    },
  });
}

module.exports = Object.freeze({ createConfiguredCharacterCandidateImageProvider });
