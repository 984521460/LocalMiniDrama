'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRemoteComfyCharacterCandidateImageProvider } = require('../src/characterCandidates/execution/remoteComfyImageProvider');
const uid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fixture(overrides = {}) {
  const output = { nodeId: '7', mediaKind: 'image', fileName: '2_00002_.png',
    subfolder: `character-candidates/${uid(2)}`, storageType: 'output', ...overrides };
  const downloaded = [];
  const connection = { uid: uid(1), name: 'synthetic', host: 'gpu.example.test', port: 22,
    username: 'worker', hostFingerprint: `SHA256:${'A'.repeat(43)}`, credentialRef: `credential:v1:${uid(3)}`,
    status: 'ready', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    authMethod: 'password', comfyHost: '127.0.0.1', comfyPort: 8188, remoteWorkDir: 'ai-drama-studio',
    environmentReport: null, environmentCheckedAtEpochMs: null, stateVersion: 1 };
  const provider = createRemoteComfyCharacterCandidateImageProvider({
    repository: { getConnection: () => connection },
    profile: { enabled: true, connectionUid: uid(1), checkpointName: 'portrait.safetensors',
      samplerName: 'euler', scheduler: 'normal', steps: 20, cfg: 6, negativePrompt: '' },
    gateway: { async run(_uid, _evidence, operation) { return operation({
      async objectInfo() { return { CheckpointLoaderSimple: { input: { required: {
        ckpt_name: [['portrait.safetensors']],
      } } }, CLIPTextEncode: {}, EmptyLatentImage: {}, KSampler: {}, VAEDecode: {}, SaveImage: {} }; },
      async submitPrompt() { return { promptId: 'synthetic-prompt' }; },
      async waitForPrompt() { return { state: 'succeeded', outputs: [output] }; },
      async downloadOutput(value) {
        downloaded.push(value);
        return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      },
    }); } },
  });
  return { provider, downloaded, command: { schemaVersion: 'character-candidate-generation-command.v1',
    operationUid: uid(2), ordinal: 2, prompt: 'synthetic portrait',
    promptSha256: createHash('sha256').update('synthetic portrait').digest('hex'), width: 256, height: 256, seed: 1 } };
}

test('Comfy history counter 00002 is downloaded from the authorized output node and task folder', async () => {
  const f = fixture();
  await f.provider.generate(f.command);
  assert.equal(f.downloaded[0].fileName, '2_00002_.png');
});

for (const invalid of [
  { fileName: '../2_00002_.png' }, { fileName: '3_00002_.png' },
  { fileName: '2_00002_.png/escape' }, { nodeId: '8' },
  { subfolder: `character-candidates/${uid(4)}` }, { storageType: 'temp' },
]) {
  test(`Comfy output ownership rejects ${JSON.stringify(invalid)}`, async () => {
    const f = fixture(invalid);
    await assert.rejects(f.provider.generate(f.command));
    assert.equal(f.downloaded.length, 0);
  });
}
