'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const { createLocalMediaExporter } = require('../src/media/localMediaExporter');
const { parseMediaExportReceiptRecord } = require('../src/media/mediaExportReceipt');
const { runBoundedMediaProcess } = require('../src/media/boundedMediaProcess');
const { assertFastStartMp4 } = require('../src/media/mp4FastStart');
const { createTrustedMediaExportFixture } = require('./helpers/v8MediaExportFixture');
const { uid } = require('./helpers/v8AudioFixture');

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function mediaSource(
  root, relativePath, durationMs, width = null, height = null,
  mimeType = width === null ? 'audio/flac' : 'video/mp4',
) {
  const absolute = path.join(root, ...relativePath.split('/'));
  return {
    relativePath,
    absolute,
    sha256: hashFile(absolute),
    durationMs,
    width,
    height,
    mimeType,
  };
}

function generateVideo(ffmpegPath, target, color) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync(ffmpegPath, [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', `color=c=${color}:s=608x352:r=24:d=0.75`,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24',
    '-video_track_timescale', '90000', '-movflags', '+faststart', target,
  ]);
}

function generateAudio(ffmpegPath, target, frequency, durationSeconds) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync(ffmpegPath, [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=${durationSeconds}`,
    '-ac', '2', '-ar', '48000', '-c:a', 'flac', target,
  ]);
}

async function realFixture(t, executionNumber = 1500) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localminidrama-export-'));
  if (process.env.LOCALMINIDRAMA_KEEP_MEDIA_EXPORT_SMOKE === '1') {
    process.stdout.write(`# media-export-smoke-root=${root}\n`);
  } else {
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  }
  const workspaceRoot = path.join(root, '.media-export-work');
  fs.mkdirSync(workspaceRoot);
  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();
  const paths = {
    video1: path.join(root, 'videos', 'shot-1.mp4'),
    video2: path.join(root, 'videos', 'shot-2.mp4'),
    dialogue1: path.join(root, 'audio', 'dialogue-1.flac'),
    dialogue2: path.join(root, 'audio', 'dialogue-2.flac'),
    bgm: path.join(root, 'projects', uid(1), 'assets', 'bgm', uid(1001), `${uid(1002)}.flac`),
  };
  generateVideo(ffmpegPath, paths.video1, 'red');
  generateVideo(ffmpegPath, paths.video2, 'blue');
  generateAudio(ffmpegPath, paths.dialogue1, 440, 0.75);
  generateAudio(ffmpegPath, paths.dialogue2, 660, 0.75);
  generateAudio(ffmpegPath, paths.bgm, 220, 1);
  const sources = {
    video: [
      mediaSource(root, 'videos/shot-1.mp4', 750, 608, 352),
      mediaSource(root, 'videos/shot-2.mp4', 750, 608, 352),
    ],
    dialogue: [
      mediaSource(root, 'audio/dialogue-1.flac', 750),
      mediaSource(root, 'audio/dialogue-2.flac', 750),
    ],
    bgm: mediaSource(
      root, `projects/${uid(1)}/assets/bgm/${uid(1001)}/${uid(1002)}.flac`, 1000,
    ),
  };
  const fixture = await createTrustedMediaExportFixture(
    { localRoot: root, ffmpegPath, ffprobePath }, sources, executionNumber,
  );
  return { root, workspaceRoot, ffmpegPath, ffprobePath, paths, sources, fixture };
}

test('exports a real 1080p faststart MP4 with mixed audio and burned ASS subtitles', async (t) => {
  const value = await realFixture(t);
  let processCalls = 0;
  const exporter = createLocalMediaExporter({
    localRoot: value.root,
    workspaceRoot: value.workspaceRoot,
    ffmpegPath: value.ffmpegPath,
    ffprobePath: value.ffprobePath,
    timeoutMs: 300_000,
    runProcess(command, args, options) {
      processCalls += 1;
      return runBoundedMediaProcess(command, args, options);
    },
  });
  const receipt = await exporter.export({
    schemaVersion: '8.0',
    executionPlan: value.fixture.executionPlan,
    completedAtEpochMs: value.fixture.executionPlan.createdAtEpochMs + 1,
  });
  const output = path.join(value.root, ...receipt.output.relativePath.split('/'));

  assert.equal(fs.existsSync(output), true);
  assert.equal(receipt.output.bytes, fs.statSync(output).size);
  assert.equal(receipt.output.video.width, 1920);
  assert.equal(receipt.output.video.height, 1080);
  assert.equal(receipt.output.video.frameCount, 36);
  assert.equal(receipt.output.audio.sampleRateHz, 48000);
  assert.equal(receipt.output.fastStart, true);
  assert.deepEqual(parseMediaExportReceiptRecord(JSON.parse(JSON.stringify(receipt))), receipt);

  const candidate = path.join(
    value.workspaceRoot, value.fixture.executionPlan.uid, 'final-candidate.mp4',
  );
  assert.equal(fs.existsSync(candidate), false);
  assert.equal(fs.statSync(output).nlink, 1);
  fs.writeFileSync(candidate, Buffer.from('post-success-diagnostic-copy', 'utf8'));
  assert.equal(hashFile(output), receipt.output.sha256);

  const completedCalls = processCalls;
  await assert.rejects(() => exporter.export({
    schemaVersion: '8.0',
    executionPlan: value.fixture.executionPlan,
    completedAtEpochMs: value.fixture.executionPlan.createdAtEpochMs + 2,
  }), (error) => error.code === 'MEDIA_EXPORT_FAILED');
  assert.equal(processCalls, completedCalls);
  assert.equal(hashFile(output), receipt.output.sha256);
});

test('source hash drift fails before FFmpeg and never creates a final output', async (t) => {
  const value = await realFixture(t, 1501);
  fs.appendFileSync(value.paths.video1, Buffer.from('drift'));
  let calls = 0;
  const exporter = createLocalMediaExporter({
    localRoot: value.root,
    workspaceRoot: value.workspaceRoot,
    ffmpegPath: value.ffmpegPath,
    ffprobePath: value.ffprobePath,
    runProcess: async () => {
      calls += 1;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  await assert.rejects(() => exporter.export({
    schemaVersion: '8.0',
    executionPlan: value.fixture.executionPlan,
    completedAtEpochMs: value.fixture.executionPlan.createdAtEpochMs + 1,
  }), (error) => error.code === 'MEDIA_EXPORT_FAILED');
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(
    value.root, ...value.fixture.executionPlan.outputRelativePath.split('/'),
  )), false);
});

test('a failed FFmpeg process leaves a task workspace but no successful output', async (t) => {
  const value = await realFixture(t, 1502);
  const exporter = createLocalMediaExporter({
    localRoot: value.root,
    workspaceRoot: value.workspaceRoot,
    ffmpegPath: 'synthetic-ffmpeg',
    ffprobePath: 'synthetic-ffprobe',
    runProcess: async () => ({ exitCode: 1, stdout: '', stderr: 'synthetic failure' }),
  });
  await assert.rejects(() => exporter.export({
    schemaVersion: '8.0',
    executionPlan: value.fixture.executionPlan,
    completedAtEpochMs: value.fixture.executionPlan.createdAtEpochMs + 1,
  }), (error) => error.code === 'MEDIA_EXPORT_FAILED'
    && !JSON.stringify(error).includes(value.root));
  assert.equal(fs.existsSync(path.join(value.workspaceRoot, value.fixture.executionPlan.uid)), true);
  assert.equal(fs.existsSync(path.join(
    value.root, ...value.fixture.executionPlan.outputRelativePath.split('/'),
  )), false);
});

test('a failed final-path revalidation restores the candidate and removes the installed output', async (t) => {
  const value = await realFixture(t, 1503);
  const exporter = createLocalMediaExporter({
    localRoot: value.root,
    workspaceRoot: value.workspaceRoot,
    ffmpegPath: value.ffmpegPath,
    ffprobePath: value.ffprobePath,
    timeoutMs: 300_000,
    runProcess(command, args, options) {
      const inspectedPath = args.at(-1);
      if (command === value.ffprobePath
        && typeof inspectedPath === 'string'
        && path.resolve(inspectedPath) === path.join(
          value.root, ...value.fixture.executionPlan.outputRelativePath.split('/'),
        )) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'synthetic final failure' });
      }
      return runBoundedMediaProcess(command, args, options);
    },
  });
  await assert.rejects(() => exporter.export({
    schemaVersion: '8.0',
    executionPlan: value.fixture.executionPlan,
    completedAtEpochMs: value.fixture.executionPlan.createdAtEpochMs + 1,
  }), (error) => error.code === 'MEDIA_EXPORT_OUTPUT_INVALID');
  const candidate = path.join(
    value.workspaceRoot, value.fixture.executionPlan.uid, 'final-candidate.mp4',
  );
  const output = path.join(
    value.root, ...value.fixture.executionPlan.outputRelativePath.split('/'),
  );
  assert.equal(fs.existsSync(candidate), true);
  assert.equal(fs.statSync(candidate).nlink, 1);
  assert.equal(fs.existsSync(output), false);
});

test('faststart verification rejects MP4 files whose moov atom follows media data', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localminidrama-atoms-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function atom(type) {
    const value = Buffer.alloc(8);
    value.writeUInt32BE(8, 0);
    value.write(type, 4, 4, 'ascii');
    return value;
  }
  const valid = path.join(root, 'valid.mp4');
  const invalid = path.join(root, 'invalid.mp4');
  fs.writeFileSync(valid, Buffer.concat([atom('ftyp'), atom('moov'), atom('mdat')]));
  fs.writeFileSync(invalid, Buffer.concat([atom('ftyp'), atom('mdat'), atom('moov')]));
  assert.equal(await assertFastStartMp4(valid, 1024), true);
  await assert.rejects(() => assertFastStartMp4(invalid, 1024),
    (error) => error.code === 'MEDIA_EXPORT_OUTPUT_INVALID');
});
