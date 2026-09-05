'use strict';

const { types: { isProxy } } = require('node:util');

function ownData(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} is invalid`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function remoteComfyProfileFromConfig(config) {
  const root = ownData(config, 'Application configuration');
  if (!Object.hasOwn(root, 'character_candidates')) return null;
  const section = ownData(root.character_candidates, 'Character candidate configuration');
  const keys = Object.keys(section);
  if (keys.some((key) => key !== 'image_provider' && key !== 'remote_comfyui')
    || typeof section.image_provider !== 'string') {
    throw new TypeError('Character candidate configuration is invalid');
  }
  if (section.image_provider === 'configured-image') {
    if (Object.hasOwn(section, 'remote_comfyui')) {
      ownData(section.remote_comfyui, 'Remote ComfyUI character configuration');
    }
    return null;
  }
  if (section.image_provider !== 'remote-comfyui'
    || !Object.hasOwn(section, 'remote_comfyui')) {
    throw new TypeError('Character candidate configuration is invalid');
  }
  const remote = ownData(section.remote_comfyui, 'Remote ComfyUI character configuration');
  if (remote.enabled !== true) {
    if (remote.enabled !== false || Object.keys(remote).length !== 1) {
      throw new TypeError('Remote ComfyUI character configuration is invalid');
    }
    return Object.freeze({ enabled: false });
  }
  const expected = [
    'enabled', 'connection_uid', 'checkpoint_name', 'sampler_name', 'scheduler', 'steps',
    'cfg', 'negative_prompt',
  ];
  if (Object.keys(remote).length !== expected.length
    || expected.some((key) => !Object.hasOwn(remote, key))) {
    throw new TypeError('Remote ComfyUI character configuration is invalid');
  }
  return Object.freeze({
    enabled: true,
    connectionUid: remote.connection_uid,
    checkpointName: remote.checkpoint_name,
    samplerName: remote.sampler_name,
    scheduler: remote.scheduler,
    steps: remote.steps,
    cfg: remote.cfg,
    negativePrompt: remote.negative_prompt,
  });
}

module.exports = Object.freeze({ remoteComfyProfileFromConfig });
