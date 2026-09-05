'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createComfyUiClient, isComfyUiClientError } = require('../src/integrations/comfyui/client');
const { createManagedComfyGateway } = require('../src/remote/managedComfyGateway');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const {
  createRemoteComfyCharacterCandidateImageProvider,
} = require('../src/characterCandidates/execution/remoteComfyImageProvider');
const {
  remoteComfyProfileFromConfig,
} = require('../src/characterCandidates/execution/remoteComfyConfig');
const {
  createProductionCharacterCandidateExecutionRuntime,
} = require('../src/characterCandidates/execution/productionRuntime');
const { createMigratedV2Database } = require('./helpers/v2RepositoryDatabase');

const CONNECTION_UID = '10000000-0000-4000-8000-000000000001';
const OPERATION_UID = '10000000-0000-4000-8000-000000000002';
const CHECKPOINT = 'checkpoints/portrait.safetensors';
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('synthetic-png-output'),
]);

function profile() {
  return {
    enabled: true,
    connectionUid: CONNECTION_UID,
    checkpointName: CHECKPOINT,
    samplerName: 'euler_ancestral',
    scheduler: 'normal',
    steps: 28,
    cfg: 6.5,
    negativePrompt: 'text, watermark, duplicate person',
  };
}

function connection(overrides = {}) {
  return {
    uid: CONNECTION_UID,
    name: 'Synthetic remote GPU',
    host: 'gpu.example.test',
    port: 22,
    username: 'worker',
    hostFingerprint: `SHA256:${'A'.repeat(43)}`,
    credentialRef: 'credential:v1:10000000-0000-4000-8000-000000000003',
    status: 'ready',
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    authMethod: 'password',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
    environmentReport: null,
    environmentCheckedAtEpochMs: null,
    stateVersion: 1,
    ...overrides,
  };
}

function command(overrides = {}) {
  const prompt = 'single character portrait';
  return {
    schemaVersion: 'character-candidate-generation-command.v1',
    operationUid: OPERATION_UID,
    ordinal: 2,
    prompt,
    promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
    width: 1024,
    height: 1024,
    seed: 123456,
    ...overrides,
  };
}

function objectInfo() {
  return {
    CheckpointLoaderSimple: {
      input: { required: { ckpt_name: [[CHECKPOINT, 'another.safetensors'], {}] } },
    },
    CLIPTextEncode: {},
    EmptyLatentImage: {},
    KSampler: {},
    VAEDecode: {},
    SaveImage: {},
  };
}

test('remote ComfyUI character provider is fail-closed until explicitly configured', () => {
  const provider = createRemoteComfyCharacterCandidateImageProvider({
    repository: { getConnection() { throw new Error('must not read'); } },
    gateway: {},
    profile: { enabled: false },
  });

  assert.equal(provider.scope, 'configured-image');
  assert.equal(provider.isAvailable(), false);
});

test('remote ComfyUI configuration selects the backend without inventing missing settings', () => {
  assert.deepEqual(remoteComfyProfileFromConfig({ app: { name: 'test' } }), null);
  assert.deepEqual(remoteComfyProfileFromConfig({
    app: { name: 'test' },
    character_candidates: {
      image_provider: 'remote-comfyui',
      remote_comfyui: { enabled: false },
    },
  }), { enabled: false });
  assert.deepEqual(remoteComfyProfileFromConfig({
    app: { name: 'test' },
    character_candidates: {
      image_provider: 'remote-comfyui',
      remote_comfyui: {
        enabled: true,
        connection_uid: CONNECTION_UID,
        checkpoint_name: CHECKPOINT,
        sampler_name: 'euler_ancestral',
        scheduler: 'normal',
        steps: 28,
        cfg: 6.5,
        negative_prompt: 'text',
      },
    },
  }), {
    enabled: true,
    connectionUid: CONNECTION_UID,
    checkpointName: CHECKPOINT,
    samplerName: 'euler_ancestral',
    scheduler: 'normal',
    steps: 28,
    cfg: 6.5,
    negativePrompt: 'text',
  });
  assert.throws(() => remoteComfyProfileFromConfig({
    app: { name: 'test' },
    character_candidates: {
      image_provider: 'remote-comfyui',
      remote_comfyui: { enabled: true },
    },
  }), /configuration is invalid/u);
});

test('production character runtime selects the remote provider while keeping it disabled fail-closed', (t) => {
  const database = createMigratedV2Database(t);
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-comfy-character-runtime-'));
  t.after(() => fs.rmSync(localRoot, { recursive: true, force: true }));
  const runtime = createProductionCharacterCandidateExecutionRuntime({
    database,
    localRoot,
    dependencies: {
      remoteComfyUi: {
        repository: {},
        gateway: {},
        profile: { enabled: false },
      },
    },
  });
  assert.equal(runtime.characterCandidates.isAvailable(), false);
});

test('remote ComfyUI character provider submits one standard workflow and seals remote evidence', async () => {
  const current = connection();
  const evidenceSha256 = remoteConnectionEvidenceSha256(current);
  const calls = [];
  const imageBytes = PNG_BYTES;
  const provider = createRemoteComfyCharacterCandidateImageProvider({
    repository: { getConnection(uid) { assert.equal(uid, CONNECTION_UID); return current; } },
    gateway: {
      async run(uid, evidence, operation) {
        assert.deepEqual([uid, evidence], [CONNECTION_UID, evidenceSha256]);
        return operation({
          async objectInfo() {
            calls.push('objectInfo');
            return objectInfo();
          },
          async submitPrompt(prompt, options) {
            calls.push('submitPrompt');
            assert.equal(options.clientId, OPERATION_UID);
            assert.equal(prompt[1].inputs.ckpt_name, CHECKPOINT);
            assert.equal(prompt[2].inputs.text, 'single character portrait');
            assert.equal(prompt[3].inputs.text, profile().negativePrompt);
            assert.equal(prompt[5].inputs.seed, 123456);
            assert.equal(prompt[7].inputs.filename_prefix, `${'character-candidates'}/${OPERATION_UID}/2`);
            return { promptId: 'remote-character-prompt-1' };
          },
          async waitForPrompt(promptId, options) {
            calls.push('waitForPrompt');
            assert.equal(promptId, 'remote-character-prompt-1');
            assert.deepEqual(options, { timeoutMs: 300_000, pollIntervalMs: 1_000 });
            return {
              promptId,
              state: 'succeeded',
              outputs: [{
                nodeId: '7',
                mediaKind: 'image',
                fileName: '2_00001_.png',
                subfolder: `character-candidates/${OPERATION_UID}`,
                storageType: 'output',
              }],
            };
          },
          async downloadOutput(output) {
            calls.push('downloadOutput');
            assert.deepEqual(output, {
              fileName: '2_00001_.png',
              subfolder: `character-candidates/${OPERATION_UID}`,
              storageType: 'output',
            });
            return imageBytes;
          },
        });
      },
    },
    profile: profile(),
  });

  assert.equal(provider.isAvailable(), true);
  const output = await provider.generate(command());
  assert.deepEqual(calls, ['objectInfo', 'submitPrompt', 'waitForPrompt', 'downloadOutput']);
  assert.equal(output.provider, 'comfyui');
  assert.equal(output.model, CHECKPOINT);
  assert.deepEqual(output.parameters, {
    adapter: 'remote-comfyui.v1',
    size: '1024x1024',
    requestedSeed: 123456,
    ordinal: 2,
    connectionUid: CONNECTION_UID,
    connectionEvidenceSha256: evidenceSha256,
    samplerName: 'euler_ancestral',
    scheduler: 'normal',
    steps: 28,
    cfg: 6.5,
    negativePromptSha256: createHash('sha256')
      .update(profile().negativePrompt, 'utf8').digest('hex'),
  });
  assert.deepEqual(output.bytes, imageBytes);
  assert.notEqual(output.bytes, imageBytes);
});

test('remote ComfyUI character provider rejects stale connections, missing models, and ambiguous outputs', async () => {
  const changedProvider = createRemoteComfyCharacterCandidateImageProvider({
    repository: { getConnection() { return connection({ status: 'changed' }); } },
    gateway: { run() {} },
    profile: profile(),
  });
  assert.equal(changedProvider.isAvailable(), false);
  await assert.rejects(changedProvider.generate(command()), /provider is unavailable/u);

  let submitted = 0;
  const missingModel = createRemoteComfyCharacterCandidateImageProvider({
    repository: { getConnection() { return connection(); } },
    gateway: {
      async run(_uid, _evidence, operation) {
        return operation({
          async objectInfo() {
            const info = objectInfo();
            info.CheckpointLoaderSimple.input.required.ckpt_name[0] = ['other.safetensors'];
            return info;
          },
          async submitPrompt() { submitted += 1; },
        });
      },
    },
    profile: profile(),
  });
  await assert.rejects(missingModel.generate(command()), /checkpoint is unavailable/u);
  assert.equal(submitted, 0);

  let downloaded = 0;
  const ambiguous = createRemoteComfyCharacterCandidateImageProvider({
    repository: { getConnection() { return connection(); } },
    gateway: {
      async run(_uid, _evidence, operation) {
        return operation({
          async objectInfo() { return objectInfo(); },
          async submitPrompt() { return { promptId: 'ambiguous' }; },
          async waitForPrompt() {
            return {
              state: 'succeeded',
              outputs: [0, 1].map((index) => ({
                nodeId: '7', mediaKind: 'image', fileName: `portrait_${index}.png`,
                subfolder: '', storageType: 'output',
              })),
            };
          },
          async downloadOutput() { downloaded += 1; },
        });
      },
    },
    profile: profile(),
  });
  await assert.rejects(ambiguous.generate(command()), /output is invalid/u);
  assert.equal(downloaded, 0);
});

test('remote ComfyUI character provider binds output ownership and verifies PNG bytes', async () => {
  function providerFor(output, bytes, onDownload = () => {}) {
    return createRemoteComfyCharacterCandidateImageProvider({
      repository: { getConnection() { return connection(); } },
      gateway: {
        async run(_uid, _evidence, operation) {
          return operation({
            async objectInfo() { return objectInfo(); },
            async submitPrompt() { return { promptId: 'bound-output' }; },
            async waitForPrompt() {
              return { state: 'succeeded', outputs: [output] };
            },
            async downloadOutput() {
              onDownload();
              return bytes;
            },
          });
        },
      },
      profile: profile(),
    });
  }

  let downloads = 0;
  const wrongFolder = providerFor({
    nodeId: '7', mediaKind: 'image', fileName: '2_00001_.png',
    subfolder: 'character-candidates/another-operation', storageType: 'output',
  }, PNG_BYTES, () => { downloads += 1; });
  await assert.rejects(wrongFolder.generate(command()), /output is invalid/u);
  assert.equal(downloads, 0);

  const wrongOrdinal = providerFor({
    nodeId: '7', mediaKind: 'image', fileName: '3_00001_.png',
    subfolder: `character-candidates/${OPERATION_UID}`, storageType: 'output',
  }, PNG_BYTES, () => { downloads += 1; });
  await assert.rejects(wrongOrdinal.generate(command()), /output is invalid/u);
  assert.equal(downloads, 0);

  const mislabeledBytes = providerFor({
    nodeId: '7', mediaKind: 'image', fileName: '2_00001_.png',
    subfolder: `character-candidates/${OPERATION_UID}`, storageType: 'output',
  }, Buffer.from('not-a-png'), () => { downloads += 1; });
  await assert.rejects(mislabeledBytes.generate(command()), /output is invalid/u);
  assert.equal(downloads, 1);
});

test('ComfyUI client downloads only a validated bounded output descriptor', async () => {
  const calls = [];
  const bytes = Buffer.from('bounded-image');
  const client = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    maxUploadBytes: bytes.length,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(bytes, { status: 200 });
    },
  });
  const downloaded = await client.downloadOutput({
    fileName: 'portrait_01.png',
    subfolder: 'character-candidates/operation-1',
    storageType: 'output',
  });
  assert.deepEqual(downloaded, bytes);
  assert.notEqual(downloaded, bytes);
  const requested = new URL(calls[0].url);
  assert.equal(requested.pathname, '/view');
  assert.equal(requested.searchParams.get('filename'), 'portrait_01.png');
  assert.equal(requested.searchParams.get('subfolder'), 'character-candidates/operation-1');
  assert.equal(requested.searchParams.get('type'), 'output');
  assert.equal(calls[0].options.redirect, 'error');

  assert.throws(() => client.downloadOutput({
    fileName: '../escape.png', subfolder: '', storageType: 'output',
  }), /input is invalid/u);
  assert.equal(calls.length, 1);

  const missing = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    fetchImpl: async () => new Response('', { status: 404 }),
  });
  await assert.rejects(missing.downloadOutput({
    fileName: 'missing.png', subfolder: '', storageType: 'output',
  }), (error) => isComfyUiClientError(error) && error.code === 'COMFY_DOWNLOAD_FAILED');

  const oversized = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    fetchImpl: async () => new Response(Buffer.alloc(16 * 1024 * 1024 + 1, 1), { status: 200 }),
  });
  await assert.rejects(oversized.downloadOutput({
    fileName: 'oversized.png', subfolder: '', storageType: 'output',
  }), (error) => isComfyUiClientError(error) && error.code === 'COMFY_RESPONSE_INVALID');
});

test('managed ComfyUI gateway runs a complete image operation inside one pinned connection session', async () => {
  const current = connection();
  const evidence = remoteConnectionEvidenceSha256(current);
  const closed = [];
  const gateway = createManagedComfyGateway({
    sessionService: {
      async openSession(uid, expectedEvidence) {
        assert.deepEqual([uid, expectedEvidence], [CONNECTION_UID, evidence]);
        return {
          connection: current,
          session: { async close() { closed.push('session'); } },
        };
      },
    },
    tunnelManager: {
      async open({ remotePort }) {
        assert.equal(remotePort, 8188);
        return {
          host: '127.0.0.1',
          port: 18188,
          origin: 'http://127.0.0.1:18188',
          async close() { closed.push('tunnel'); },
        };
      },
    },
    clientFactory: ({ baseUrl }) => ({
      async downloadOutput(output) {
        assert.equal(baseUrl, 'http://127.0.0.1:18188');
        assert.equal(output.fileName, 'portrait.png');
        return Buffer.from('image');
      },
    }),
  });
  assert.deepEqual(await gateway.run(CONNECTION_UID, evidence, (client) => client.downloadOutput({
    fileName: 'portrait.png', subfolder: '', storageType: 'output',
  })), Buffer.from('image'));
  assert.deepEqual(closed, ['tunnel', 'session']);
});
