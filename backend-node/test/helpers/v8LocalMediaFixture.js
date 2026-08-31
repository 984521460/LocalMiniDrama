'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { getFfmpegPath, getFfprobePath } = require('../../src/utils/ffmpegPath');
const { createTrustedMediaExportFixture } = require('./v8MediaExportFixture');
const { uid } = require('./v8AudioFixture');

function hashFile(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function mediaSource(root, relativePath, durationMs, width = null, height = null) {
  const absolute = path.join(root, ...relativePath.split('/'));
  return Object.freeze({
    relativePath,
    absolute,
    sha256: hashFile(absolute),
    durationMs,
    width,
    height,
    mimeType: width === null ? 'audio/flac' : 'video/mp4',
  });
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

async function createLocalMediaExportFixture(t, executionNumber = 1500, options = {}) {
  const ownsRoot = options.root === undefined;
  const root = ownsRoot
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'localminidrama-export-run-'))
    : path.resolve(options.root);
  if (ownsRoot) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  else fs.mkdirSync(root, { recursive: true });
  const workspaceRoot = path.join(root, '.media-export-work');
  fs.mkdirSync(workspaceRoot);
  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();
  const relative = Object.freeze({
    video1: 'videos/shot-1.mp4',
    video2: 'videos/shot-2.mp4',
    dialogue1: 'audio/dialogue-1.flac',
    dialogue2: 'audio/dialogue-2.flac',
    bgm: `projects/${uid(1)}/assets/bgm/${uid(1001)}/${uid(1002)}.flac`,
  });
  generateVideo(ffmpegPath, path.join(root, ...relative.video1.split('/')), 'red');
  generateVideo(ffmpegPath, path.join(root, ...relative.video2.split('/')), 'blue');
  generateAudio(ffmpegPath, path.join(root, ...relative.dialogue1.split('/')), 440, 0.75);
  generateAudio(ffmpegPath, path.join(root, ...relative.dialogue2.split('/')), 660, 0.75);
  generateAudio(ffmpegPath, path.join(root, ...relative.bgm.split('/')), 220, 1);
  const sources = Object.freeze({
    video: Object.freeze([
      mediaSource(root, relative.video1, 750, 608, 352),
      mediaSource(root, relative.video2, 750, 608, 352),
    ]),
    dialogue: Object.freeze([
      mediaSource(root, relative.dialogue1, 750),
      mediaSource(root, relative.dialogue2, 750),
    ]),
    bgm: mediaSource(root, relative.bgm, 1000),
  });
  const fixture = await createTrustedMediaExportFixture(
    { localRoot: root, ffmpegPath, ffprobePath }, sources, executionNumber,
  );
  return Object.freeze({ root, workspaceRoot, ffmpegPath, ffprobePath, sources, fixture });
}

module.exports = Object.freeze({ createLocalMediaExportFixture });
