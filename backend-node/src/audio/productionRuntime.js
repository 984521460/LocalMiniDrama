'use strict';

const { types: { isProxy } } = require('node:util');

const { WindowsCredentialVault } = require('../adapters/v2/credentials');
const { LocalStorageProvider } = require('../adapters/v2/storage');
const { createLocalMediaProbe } = require('../media/localMediaProbe');
const {
  createAudioTtsOutputRepository,
} = require('../repositories/v2/audioTtsOutputRepository');
const { createV2Repositories } = require('../repositories/v2');
const {
  MAX_AUDIO_BYTES,
  createAudioTtsExecutionService,
} = require('./audioTtsExecutionService');
const { createTtsProviderClient } = require('./ttsProviderClient');

const DEPENDENCY_KEYS = Object.freeze([
  'credentialVault', 'ttsClient', 'mediaProbe', 'executionGate', 'timeoutMs', 'nowEpochMs',
]);

function includes(values, expected) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function dependencies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Production audio TTS runtime dependencies are invalid');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError('Production audio TTS runtime dependencies are invalid');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Production audio TTS runtime dependencies are invalid');
  }
  const keys = Reflect.ownKeys(descriptors);
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] !== 'string' || !includes(DEPENDENCY_KEYS, keys[index])) {
      throw new TypeError('Production audio TTS runtime dependencies are invalid');
    }
  }
  const output = Object.create(null);
  for (let index = 0; index < DEPENDENCY_KEYS.length; index += 1) {
    const key = DEPENDENCY_KEYS[index];
    const descriptor = descriptors[key];
    if (!descriptor) continue;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Production audio TTS runtime dependencies are invalid');
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function createProductionAudioTtsRuntime({ database, localRoot, dependencies: value = {} } = {}) {
  const configured = dependencies(value);
  const repositories = createV2Repositories(database);
  const storageProvider = new LocalStorageProvider({ projectRoot: localRoot });
  const outputs = createAudioTtsOutputRepository({ database, repositories });
  const timeoutMs = configured.timeoutMs ?? 60_000;
  const service = createAudioTtsExecutionService({
    repositories,
    submissions: repositories.audioTtsSubmissions,
    outputs,
    vault: configured.credentialVault ?? new WindowsCredentialVault(),
    client: configured.ttsClient ?? createTtsProviderClient(),
    storageProvider,
    mediaProbe: configured.mediaProbe ?? createLocalMediaProbe({
      localRoot,
      maxFileBytes: MAX_AUDIO_BYTES,
    }),
    timeoutMs,
    nowEpochMs: configured.nowEpochMs ?? Date.now,
  });
  const executionGate = configured.executionGate ?? repositories.mvpBenchmarkExecutionGate;
  const executionGateMethod = !isProxy(executionGate)
    ? Object.getOwnPropertyDescriptor(
      executionGate,
      'assertAudioIntentExecutionOpen',
    )?.value
    : null;
  if (typeof executionGateMethod !== 'function' || isProxy(executionGateMethod)) {
    throw new TypeError('Production audio TTS runtime dependencies are invalid');
  }
  const guardedService = Object.freeze({
    execute(intentUid, dramaUid, executionPermit) {
      Reflect.apply(executionGateMethod, executionGate, [intentUid, executionPermit]);
      return service.execute(intentUid, dramaUid);
    },
    get(intentUid, dramaUid) {
      return service.get(intentUid, dramaUid);
    },
  });
  return Object.freeze({
    audioTts: Object.freeze({ outputs, service: guardedService }),
    audio: Object.freeze({ tts: guardedService }),
  });
}

module.exports = Object.freeze({ createProductionAudioTtsRuntime });
