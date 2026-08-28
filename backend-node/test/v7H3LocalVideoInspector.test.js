'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createH3TextToVideoWorkflowBundle, H3_PROFILE } = require('../src/h3');
const { createH3LocalVideoInspector } = require('../src/h3/localVideoInspector');
const { createRemoteOutputVerifier } = require('../src/remote/outputVerifier');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function probeJson(overrides = {}) {
  return JSON.stringify({
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        width: 608,
        height: 352,
        avg_frame_rate: '24/1',
        nb_read_frames: '39',
        duration: '1.625000',
        ...overrides,
      },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
    ],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '1.625000',
    },
  });
}

function expected() {
  return Object.freeze({ width: 608, height: 352, durationMs: 1625, frames: 39, fps: 24 });
}

function workflowValues(overrides = {}) {
  return {
    prompt: 'A rider crosses an open field while the camera pans beside the motion.',
    width: 608,
    height: 352,
    frames: 39,
    seed: 9,
    filenamePrefix: 'video/H3_contract',
    ...overrides,
  };
}

function testWorkspace(t) {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-h3-video-inspector-'));
  const localRelativePath = 'projects/fixture/assets/result.mp4';
  const absolutePath = path.join(localRoot, ...localRelativePath.split('/'));
  const bytes = Buffer.from('synthetic-local-h3-video');
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  t.after(() => fs.rmSync(localRoot, { recursive: true, force: true }));
  return Object.freeze({ localRoot, localRelativePath, bytes });
}

test('strict local H3 inspector binds local hash and bounded probe evidence', async (t) => {
  const workspace = testWorkspace(t);
  const calls = [];
  const inspector = createH3LocalVideoInspector({
    localRoot: workspace.localRoot,
    ffprobePath: 'synthetic-ffprobe',
    ffmpegPath: 'synthetic-ffmpeg',
    timeoutMs: 1000,
    async runProcess(command, args) {
      calls.push(Object.freeze({ command, args: [...args] }));
      return command === 'synthetic-ffprobe'
        ? { exitCode: 0, stdout: probeJson(), stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const measured = await inspector.inspect({
    localRelativePath: workspace.localRelativePath,
    expected: expected(),
    remoteSha256: sha256(workspace.bytes),
    remoteBytes: workspace.bytes.length,
  });
  assert.deepEqual(measured, {
    sha256: sha256(workspace.bytes),
    bytes: workspace.bytes.length,
    mimeType: 'video/mp4',
    width: 608,
    height: 352,
    durationMs: 1625,
    frames: 39,
    fps: 24,
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioStreams: 1,
    blackFrameRatio: 0,
    frozenFrameRatio: 0,
  });
  assert.equal(Object.isFrozen(measured), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.command), ['synthetic-ffprobe', 'synthetic-ffmpeg']);
  assert.equal(calls.every((call) => call.args.some((argument) => argument.endsWith('result.mp4'))), true);
});

test('strict local H3 inspector rejects metadata drift, timeout and path escape without leakage', async (t) => {
  const workspace = testWorkspace(t);
  const invalid = createH3LocalVideoInspector({
    localRoot: workspace.localRoot,
    ffprobePath: 'synthetic-ffprobe',
    ffmpegPath: 'synthetic-ffmpeg',
    timeoutMs: 1000,
    async runProcess(command) {
      return command === 'synthetic-ffprobe'
        ? { exitCode: 0, stdout: probeJson({ width: 1280 }), stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const input = {
    localRelativePath: workspace.localRelativePath,
    expected: expected(),
    remoteSha256: sha256(workspace.bytes),
    remoteBytes: workspace.bytes.length,
  };
  await assert.rejects(() => invalid.inspect(input), (error) => {
    assert.equal(error.code, 'H3_OUTPUT_INVALID');
    assert.equal(JSON.stringify(error).includes(workspace.localRoot), false);
    assert.equal(error.stack.includes(workspace.localRoot), false);
    return true;
  });
  await assert.rejects(() => invalid.inspect({ ...input, localRelativePath: '../private.mp4' }), {
    code: 'H3_OUTPUT_INVALID',
  });

  const hanging = createH3LocalVideoInspector({
    localRoot: workspace.localRoot,
    ffprobePath: 'synthetic-ffprobe',
    ffmpegPath: 'synthetic-ffmpeg',
    timeoutMs: 30,
    runProcess() { return new Promise(() => {}); },
  });
  await assert.rejects(() => hanging.inspect(input), { code: 'H3_OUTPUT_INVALID' });

  let thenCalls = 0;
  const thenable = createH3LocalVideoInspector({
    localRoot: workspace.localRoot,
    ffprobePath: 'synthetic-ffprobe',
    ffmpegPath: 'synthetic-ffmpeg',
    timeoutMs: 1000,
    runProcess() {
      return { then() { thenCalls += 1; } };
    },
  });
  await assert.rejects(() => thenable.inspect(input), { code: 'H3_OUTPUT_INVALID' });
  assert.equal(thenCalls, 0);
});

test('remote output verifier gates only the exact verified H3 T2V manifest/profile', async (t) => {
  const workspace = testWorkspace(t);
  let processCalls = 0;
  const inspector = createH3LocalVideoInspector({
    localRoot: workspace.localRoot,
    ffprobePath: 'synthetic-ffprobe',
    ffmpegPath: 'synthetic-ffmpeg',
    timeoutMs: 1000,
    async runProcess(command) {
      processCalls += 1;
      return command === 'synthetic-ffprobe'
        ? { exitCode: 0, stdout: probeJson(), stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const verifier = createRemoteOutputVerifier({ h3Inspector: inspector });
  const manifest = createH3TextToVideoWorkflowBundle().manifest;
  const planNode = {
    nodeType: 'shot.video',
    config: {
      profileUid: H3_PROFILE.uid,
      manifestUid: manifest.uid,
      width: 608,
      height: 352,
      durationMs: 1625,
      fps: 24,
      seed: 9,
    },
  };
  const verified = await verifier.verify({
    planNode,
    manifest,
    localRelativePath: workspace.localRelativePath,
    remoteSha256: sha256(workspace.bytes),
    remoteBytes: workspace.bytes.length,
    mimeType: 'video/mp4',
  });
  assert.equal(verified.width, 608);
  assert.equal(verified.height, 352);
  assert.equal(verified.durationMs, 1625);
  assert.equal(verified.measured.frames, 39);
  assert.equal(processCalls, 2);
  assert.equal(verifier.preflight({ planNode, manifest, values: workflowValues() }).frames, 39);

  for (const config of [
    { ...planNode.config, width: 2048, height: 2048 },
    { ...planNode.config, width: 600 },
    { ...planNode.config, width: 1376, height: 768 },
    { ...planNode.config, durationMs: 1667 },
    { ...planNode.config, durationMs: 15792 },
    { ...planNode.config, fps: 25 },
  ]) {
    assert.throws(() => verifier.preflight({
      planNode: { ...planNode, config },
      manifest,
      values: workflowValues({
        width: config.width,
        height: config.height,
        frames: Math.round((config.durationMs / 1000) * config.fps),
        seed: config.seed,
      }),
    }), { code: 'H3_OUTPUT_INVALID' });
  }
  assert.equal(processCalls, 2);

  for (const values of [
    workflowValues({ width: 2048 }),
    workflowValues({ height: 2048 }),
    workflowValues({ frames: 56 }),
    workflowValues({ seed: 10 }),
    { ...workflowValues(), extra: true },
  ]) {
    assert.throws(() => verifier.preflight({ planNode, manifest, values }), {
      code: 'H3_OUTPUT_INVALID',
    });
  }
  assert.equal(processCalls, 2);

  await assert.rejects(() => verifier.verify({
    planNode,
    manifest: { ...manifest, uid: crypto.randomUUID() },
    localRelativePath: workspace.localRelativePath,
    remoteSha256: sha256(workspace.bytes),
    remoteBytes: workspace.bytes.length,
    mimeType: 'video/mp4',
  }), { code: 'H3_OUTPUT_INVALID' });

  await assert.rejects(() => verifier.verify({
    planNode: { nodeType: 'shot.video', config: { manifestUid: manifest.uid } },
    manifest,
    localRelativePath: workspace.localRelativePath,
    remoteSha256: sha256(workspace.bytes),
    remoteBytes: workspace.bytes.length,
    mimeType: 'video/mp4',
  }), { code: 'H3_OUTPUT_INVALID' });

  const clonedH3Manifest = {
    ...manifest,
    uid: crypto.randomUUID(),
    manifestId: 'synthetic-cloned-h3',
  };
  await assert.rejects(() => verifier.verify({
    planNode: {
      nodeType: 'shot.video',
      config: { manifestUid: clonedH3Manifest.uid },
    },
    manifest: clonedH3Manifest,
    localRelativePath: 'missing-cloned-h3.mp4',
    remoteSha256: sha256(workspace.bytes),
    remoteBytes: workspace.bytes.length,
    mimeType: 'video/mp4',
  }), { code: 'H3_OUTPUT_INVALID' });

  assert.deepEqual(await verifier.verify({
    planNode: { nodeType: 'shot.video', config: {} },
    manifest: {
      uid: crypto.randomUUID(),
      manifestId: 'synthetic-generic-video',
      workflowSha256: 'a'.repeat(64),
      modelFamily: 'synthetic-generic',
    },
    localRelativePath: workspace.localRelativePath,
    remoteSha256: sha256(workspace.bytes),
    remoteBytes: workspace.bytes.length,
    mimeType: 'video/mp4',
  }), { width: null, height: null, durationMs: null, measured: null });
});
