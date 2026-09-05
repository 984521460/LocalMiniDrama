'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { MAX_IMAGE_BYTES } = require('./boundedImageSource');
const {
  remoteConnectionEvidenceSha256,
} = require('../../remote/connectionProfile');
const {
  OUTPUT_NODE_ID,
  buildRemoteComfyCharacterPrompt,
} = require('./remoteComfyWorkflow');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const FILE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMAND_KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'ordinal', 'prompt', 'promptSha256', 'width', 'height', 'seed',
]);
const ENABLED_PROFILE_KEYS = Object.freeze([
  'enabled', 'connectionUid', 'checkpointName', 'samplerName', 'scheduler', 'steps', 'cfg',
  'negativePrompt',
]);
const REQUIRED_NODE_TYPES = Object.freeze([
  'CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode',
  'SaveImage',
]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function exactOwnData(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) {
    throw new TypeError(`${label} is invalid`);
  }
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} is invalid`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function safeRelativeFile(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1
    || Buffer.byteLength(value, 'utf8') > 128 || value.startsWith('/') || value.endsWith('/')
    || value.includes('\\') || value.includes(':') || value.includes('\0')) return false;
  return value.split('/').every((segment) => (
    segment !== '.' && segment !== '..' && FILE_SEGMENT.test(segment)
  ));
}

function configuredProfile(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && !isProxy(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length === 1
      && descriptors.enabled?.enumerable
      && Object.hasOwn(descriptors.enabled, 'value')
      && descriptors.enabled.value === false
      && (Object.getPrototypeOf(value) === Object.prototype
        || Object.getPrototypeOf(value) === null)) {
      return Object.freeze({ enabled: false });
    }
  }
  const input = exactOwnData(value, ENABLED_PROFILE_KEYS, 'Remote ComfyUI character profile');
  if (input.enabled !== true || typeof input.connectionUid !== 'string'
    || !UUID_V4.test(input.connectionUid) || !safeRelativeFile(input.checkpointName)
    || typeof input.samplerName !== 'string' || !TOKEN.test(input.samplerName)
    || typeof input.scheduler !== 'string' || !TOKEN.test(input.scheduler)
    || !Number.isSafeInteger(input.steps) || input.steps < 1 || input.steps > 100
    || typeof input.cfg !== 'number' || !Number.isFinite(input.cfg)
    || input.cfg < 0 || input.cfg > 30
    || typeof input.negativePrompt !== 'string'
    || input.negativePrompt.includes('\0')
    || Buffer.byteLength(input.negativePrompt, 'utf8') > 16 * 1024) {
    throw new TypeError('Remote ComfyUI character profile is invalid');
  }
  return Object.freeze({
    enabled: true,
    connectionUid: input.connectionUid,
    checkpointName: input.checkpointName,
    samplerName: input.samplerName,
    scheduler: input.scheduler,
    steps: input.steps,
    cfg: input.cfg,
    negativePrompt: input.negativePrompt,
  });
}

function command(value) {
  const input = exactOwnData(value, COMMAND_KEYS, 'Character candidate generation command');
  if (input.schemaVersion !== 'character-candidate-generation-command.v1'
    || typeof input.operationUid !== 'string' || !UUID_V4.test(input.operationUid)
    || !Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > 3
    || typeof input.prompt !== 'string' || input.prompt.length < 1
    || input.prompt.includes('\0') || Buffer.byteLength(input.prompt, 'utf8') > 64 * 1024
    || typeof input.promptSha256 !== 'string' || !SHA256.test(input.promptSha256)
    || createHash('sha256').update(input.prompt, 'utf8').digest('hex') !== input.promptSha256
    || !Number.isSafeInteger(input.width) || input.width < 64 || input.width > 4096
    || !Number.isSafeInteger(input.height) || input.height < 64 || input.height > 4096
    || input.width % 8 !== 0 || input.height % 8 !== 0
    || !Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 4_294_967_295) {
    throw new TypeError('Character candidate generation command is invalid');
  }
  return Object.freeze(input);
}

function enabledDependencies(repository, gateway) {
  if (!repository || typeof repository !== 'object' || isProxy(repository)
    || typeof repository.getConnection !== 'function' || isProxy(repository.getConnection)
    || !gateway || typeof gateway !== 'object' || isProxy(gateway)) {
    throw new TypeError('Remote ComfyUI character provider dependencies are invalid');
  }
  if (typeof gateway.run !== 'function' || isProxy(gateway.run)) {
    throw new TypeError('Remote ComfyUI character provider dependencies are invalid');
  }
}

function currentConnection(repository, profile) {
  const connection = repository.getConnection(profile.connectionUid);
  if (connection.status !== 'ready' || connection.hostFingerprint === null) {
    throw new TypeError('Remote ComfyUI character provider is unavailable');
  }
  return Object.freeze({
    connection,
    evidenceSha256: remoteConnectionEvidenceSha256(connection),
  });
}

function assertRuntime(info, checkpointName) {
  if (!info || typeof info !== 'object' || Array.isArray(info) || isProxy(info)) {
    throw new TypeError('Remote ComfyUI image runtime is invalid');
  }
  for (const nodeType of REQUIRED_NODE_TYPES) {
    if (!Object.hasOwn(info, nodeType)) {
      throw new TypeError('Remote ComfyUI image runtime is unavailable');
    }
  }
  const choices = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  if (!Array.isArray(choices) || !choices.includes(checkpointName)) {
    throw new TypeError('Remote ComfyUI checkpoint is unavailable');
  }
}

function selectedOutput(state, input) {
  if (!state || state.state !== 'succeeded' || !Array.isArray(state.outputs)) {
    throw new TypeError('Remote ComfyUI image output is invalid');
  }
  const matches = state.outputs.filter((entry) => entry?.nodeId === OUTPUT_NODE_ID);
  const expectedSubfolder = `character-candidates/${input.operationUid}`;
  const expectedFileName = `${input.ordinal}_00001_.png`;
  if (matches.length !== 1 || matches[0].mediaKind !== 'image'
    || matches[0].storageType !== 'output'
    || matches[0].subfolder !== expectedSubfolder
    || matches[0].fileName !== expectedFileName) {
    throw new TypeError('Remote ComfyUI image output is invalid');
  }
  return matches[0];
}

function createRemoteComfyCharacterCandidateImageProvider({ repository, gateway, profile } = {}) {
  const configured = configuredProfile(profile);
  if (configured.enabled) enabledDependencies(repository, gateway);

  return Object.freeze({
    scope: 'configured-image',
    isAvailable() {
      if (!configured.enabled) return false;
      try {
        currentConnection(repository, configured);
        return true;
      } catch {
        return false;
      }
    },
    async generate(value) {
      if (!configured.enabled) throw new TypeError('Remote ComfyUI character provider is unavailable');
      const input = command(value);
      const current = currentConnection(repository, configured);
      const connectionUid = current.connection.uid;
      const evidenceSha256 = current.evidenceSha256;
      const prompt = buildRemoteComfyCharacterPrompt(input, configured);
      const bytes = await gateway.run(connectionUid, evidenceSha256, async (client) => {
        const info = await client.objectInfo();
        assertRuntime(info, configured.checkpointName);
        const submitted = await client.submitPrompt(prompt, { clientId: input.operationUid });
        const state = await client.waitForPrompt(
          submitted.promptId,
          Object.freeze({ timeoutMs: 300_000, pollIntervalMs: 1_000 }),
        );
        const output = selectedOutput(state, input);
        return client.downloadOutput({
          fileName: output.fileName,
          subfolder: output.subfolder,
          storageType: output.storageType,
        });
      });
      if (!Buffer.isBuffer(bytes) || isProxy(bytes) || Object.getPrototypeOf(bytes) !== Buffer.prototype
        || bytes.length < PNG_SIGNATURE.length || bytes.length > MAX_IMAGE_BYTES
        || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new TypeError('Remote ComfyUI image output is invalid');
      }
      return Object.freeze({
        provider: 'comfyui',
        model: configured.checkpointName,
        parameters: Object.freeze({
          adapter: 'remote-comfyui.v1',
          size: `${input.width}x${input.height}`,
          requestedSeed: input.seed,
          ordinal: input.ordinal,
          connectionUid,
          connectionEvidenceSha256: evidenceSha256,
          samplerName: configured.samplerName,
          scheduler: configured.scheduler,
          steps: configured.steps,
          cfg: configured.cfg,
          negativePromptSha256: createHash('sha256')
            .update(configured.negativePrompt, 'utf8').digest('hex'),
        }),
        bytes: Buffer.from(bytes),
      });
    },
  });
}

module.exports = Object.freeze({
  createRemoteComfyCharacterCandidateImageProvider,
});
