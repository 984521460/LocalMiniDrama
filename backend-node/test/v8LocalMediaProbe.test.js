'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const { createAssetVersionEvidence } = require('../src/assets/assetVersionEvidence');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const { runBoundedMediaProcess } = require('../src/media/boundedMediaProcess');
const { createLocalMediaProbe } = require('../src/media/localMediaProbe');
const { requireTrustedMediaProbeEvidence } = require('../src/media/mediaProbeEvidence');
const { uid } = require('./helpers/v8AudioFixture');

function versionEvidence(relativePath, bytes, overrides = {}) {
  return createAssetVersionEvidence({
    uid: overrides.uid ?? uid(1500),
    assetUid: overrides.assetUid ?? uid(1501),
    storageProvider: 'local',
    logicalUri: `asset://dramas/${uid(1)}/media/${uid(1500)}`,
    relativePath,
    sha256: overrides.sha256 ?? crypto.createHash('sha256').update(bytes).digest('hex'),
    mimeType: overrides.mimeType ?? 'video/mp4',
    width: Object.hasOwn(overrides, 'width') ? overrides.width : 320,
    height: Object.hasOwn(overrides, 'height') ? overrides.height : 180,
    durationMs: overrides.durationMs ?? 1000,
    parentUid: null,
    status: 'ready',
    createdAt: '2027-01-15T08:00:00.000Z',
  });
}

function ffprobePayload({
  duration = '1.000000', video = true, audio = true,
  formatName = video ? 'mov,mp4' : 'wav',
} = {}) {
  const streams = [];
  if (video) streams.push({
    codec_name: 'h264', codec_type: 'video', width: 320, height: 180,
    pix_fmt: 'yuv420p', avg_frame_rate: '24/1', time_base: '1/90000',
    sample_aspect_ratio: '1:1', display_aspect_ratio: '16:9', nb_read_frames: '24',
  });
  if (audio) streams.push({
    codec_name: 'aac', codec_type: 'audio', sample_fmt: 'fltp',
    sample_rate: '48000', channels: 2, channel_layout: 'stereo',
  });
  return JSON.stringify({ streams, format: { format_name: formatName, duration } });
}

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-p8-08-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('binds a local file hash to bounded ffprobe metadata and a full decode result', async (t) => {
  const root = createTempRoot(t);
  const bytes = Buffer.from('synthetic-video-bytes', 'utf8');
  fs.writeFileSync(path.join(root, 'clip.mp4'), bytes);
  const calls = [];
  const probe = createLocalMediaProbe({
    localRoot: root,
    ffprobePath: 'synthetic-ffprobe',
    ffmpegPath: 'synthetic-ffmpeg',
    timeoutMs: 100,
    runProcess: async (command, args) => {
      calls.push({ command, args });
      return command === 'synthetic-ffprobe'
        ? { exitCode: 0, stdout: ffprobePayload(), stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const evidence = await probe.inspect({
    schemaVersion: '8.0',
    uid: uid(1502),
    assetVersion: versionEvidence('clip.mp4', bytes),
    probedAtEpochMs: 1_800_000_800_000,
  });
  assert.deepEqual(requireTrustedMediaProbeEvidence(evidence), evidence);
  assert.equal(evidence.decoded, true);
  assert.equal(evidence.bytes, bytes.length);
  assert.equal(evidence.video.frameCount, 24);
  assert.equal(evidence.audio.sampleRateHz, 48_000);
  assert.deepEqual(calls.map((entry) => entry.command), ['synthetic-ffprobe', 'synthetic-ffmpeg']);
  assert.equal(JSON.stringify(evidence).includes(root), false);
});

test('fails before invoking a process on hash drift and rejects malformed process output', async (t) => {
  const root = createTempRoot(t);
  const bytes = Buffer.from('synthetic-video-bytes', 'utf8');
  fs.writeFileSync(path.join(root, 'clip.mp4'), bytes);
  let calls = 0;
  const base = {
    localRoot: root,
    ffprobePath: 'synthetic-ffprobe',
    ffmpegPath: 'synthetic-ffmpeg',
    timeoutMs: 50,
  };
  const wrongHash = createLocalMediaProbe({
    ...base,
    runProcess: async () => { calls += 1; return { exitCode: 0, stdout: '', stderr: '' }; },
  });
  await assert.rejects(() => wrongHash.inspect({
    schemaVersion: '8.0', uid: uid(1503),
    assetVersion: versionEvidence('clip.mp4', bytes, { sha256: '0'.repeat(64) }),
    probedAtEpochMs: 1_800_000_800_000,
  }));
  assert.equal(calls, 0);

  await assert.rejects(() => wrongHash.inspect({
    schemaVersion: '8.0', uid: 'not-a-uuid',
    assetVersion: versionEvidence('clip.mp4', bytes),
    probedAtEpochMs: 1_800_000_800_000,
  }));
  assert.equal(calls, 0);

  await assert.rejects(() => wrongHash.inspect({
    schemaVersion: '8.0', uid: uid(1510),
    assetVersion: versionEvidence('clip.bin', bytes, {
      uid: uid(1511), assetUid: uid(1512), mimeType: 'application/octet-stream',
      width: null, height: null,
    }),
    probedAtEpochMs: 1_800_000_800_000,
  }));
  assert.equal(calls, 0);

  const duplicateJson = createLocalMediaProbe({
    ...base,
    runProcess: async (command) => (command === 'synthetic-ffprobe'
      ? { exitCode: 0, stdout: '{"streams":[],"streams":[],"format":{}}', stderr: '' }
      : { exitCode: 0, stdout: '', stderr: '' }),
  });
  await assert.rejects(() => duplicateJson.inspect({
    schemaVersion: '8.0', uid: uid(1504), assetVersion: versionEvidence('clip.mp4', bytes),
    probedAtEpochMs: 1_800_000_800_000,
  }));
});

test('rejects a local file that changes between hash, probe and decode', async (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, 'clip.mp4');
  const bytes = Buffer.from('synthetic-video-bytes', 'utf8');
  fs.writeFileSync(file, bytes);
  let calls = 0;
  const probe = createLocalMediaProbe({
    localRoot: root, ffprobePath: 'probe', ffmpegPath: 'decode', timeoutMs: 100,
    runProcess: async (command) => {
      calls += 1;
      if (command === 'probe') {
        fs.writeFileSync(file, Buffer.from('changed-video-bytes!', 'utf8'));
        return { exitCode: 0, stdout: ffprobePayload(), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  await assert.rejects(() => probe.inspect({
    schemaVersion: '8.0', uid: uid(1513), assetVersion: versionEvidence('clip.mp4', bytes),
    probedAtEpochMs: 1_800_000_800_000,
  }));
  assert.equal(calls, 2);
});

test('rejects a linked storage root and nested junction before invoking a process', async (t) => {
  const target = createTempRoot(t);
  const wrapper = createTempRoot(t);
  const regularRoot = createTempRoot(t);
  const bytes = Buffer.from('synthetic-video-bytes', 'utf8');
  fs.writeFileSync(path.join(target, 'clip.mp4'), bytes);
  const linkedRoot = path.join(wrapper, 'linked-root');
  const nestedLink = path.join(regularRoot, 'linked');
  fs.symlinkSync(target, linkedRoot, 'junction');
  fs.symlinkSync(target, nestedLink, 'junction');
  let calls = 0;
  const config = {
    ffprobePath: 'probe', ffmpegPath: 'decode', timeoutMs: 100,
    runProcess: async () => {
      calls += 1;
      return { exitCode: 0, stdout: ffprobePayload(), stderr: '' };
    },
  };
  const input = (relativePath, number) => ({
    schemaVersion: '8.0', uid: uid(number),
    assetVersion: versionEvidence(relativePath, bytes, {
      uid: uid(number + 10), assetUid: uid(number + 20),
    }),
    probedAtEpochMs: 1_800_000_800_000,
  });

  await assert.rejects(() => createLocalMediaProbe({
    ...config, localRoot: linkedRoot,
  }).inspect(input('clip.mp4', 1520)));
  await assert.rejects(() => createLocalMediaProbe({
    ...config, localRoot: regularRoot,
  }).inspect(input('linked/clip.mp4', 1530)));
  assert.equal(calls, 0);
});

test('rejects a storage root replaced between hashing and final verification', async (t) => {
  const root = createTempRoot(t);
  const archivedRoot = `${root}-archived`;
  t.after(() => fs.rmSync(archivedRoot, { recursive: true, force: true }));
  const bytes = Buffer.from('synthetic-video-bytes', 'utf8');
  fs.writeFileSync(path.join(root, 'clip.mp4'), bytes);
  let calls = 0;
  const probe = createLocalMediaProbe({
    localRoot: root, ffprobePath: 'probe', ffmpegPath: 'decode', timeoutMs: 100,
    runProcess: async (command) => {
      calls += 1;
      if (command === 'probe') {
        fs.renameSync(root, archivedRoot);
        fs.mkdirSync(root);
        fs.writeFileSync(path.join(root, 'clip.mp4'), bytes);
        return { exitCode: 0, stdout: ffprobePayload(), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  await assert.rejects(() => probe.inspect({
    schemaVersion: '8.0', uid: uid(1540), assetVersion: versionEvidence('clip.mp4', bytes),
    probedAtEpochMs: 1_800_000_800_000,
  }));
  assert.equal(calls, 2);
});

test('probes a standalone local audio source without inventing a video stream', async (t) => {
  const root = createTempRoot(t);
  const bytes = Buffer.from('synthetic-audio-bytes', 'utf8');
  fs.writeFileSync(path.join(root, 'dialogue.wav'), bytes);
  const probe = createLocalMediaProbe({
    localRoot: root,
    ffprobePath: 'synthetic-ffprobe',
    ffmpegPath: 'synthetic-ffmpeg',
    timeoutMs: 100,
    runProcess: async (command) => (command === 'synthetic-ffprobe'
      ? { exitCode: 0, stdout: ffprobePayload({ video: false }), stderr: '' }
      : { exitCode: 0, stdout: '', stderr: '' }),
  });
  const evidence = await probe.inspect({
    schemaVersion: '8.0',
    uid: uid(1507),
    assetVersion: versionEvidence('dialogue.wav', bytes, {
      uid: uid(1508), assetUid: uid(1509), mimeType: 'audio/wav', width: null, height: null,
    }),
    probedAtEpochMs: 1_800_000_800_000,
  });
  assert.equal(evidence.mediaKind, 'audio');
  assert.equal(evidence.video, null);
  assert.equal(evidence.audio.codecName, 'aac');
  assert.deepEqual(evidence.formatNames, ['wav']);
});

test('bounds non-cooperative process promises and rejects hostile results without trap execution', async (t) => {
  const root = createTempRoot(t);
  const bytes = Buffer.from('synthetic-video-bytes', 'utf8');
  fs.writeFileSync(path.join(root, 'clip.mp4'), bytes);
  const input = {
    schemaVersion: '8.0', uid: uid(1505), assetVersion: versionEvidence('clip.mp4', bytes),
    probedAtEpochMs: 1_800_000_800_000,
  };
  const never = createLocalMediaProbe({
    localRoot: root, ffprobePath: 'probe', ffmpegPath: 'decode', timeoutMs: 20,
    runProcess: () => new Promise(() => {}),
  });
  await assert.rejects(() => never.inspect(input));

  let reads = 0;
  const hostileResult = new Proxy({}, {
    getPrototypeOf() { reads += 1; return Object.prototype; },
    ownKeys() { reads += 1; return []; },
    getOwnPropertyDescriptor() { reads += 1; return undefined; },
  });
  const hostile = createLocalMediaProbe({
    localRoot: root, ffprobePath: 'probe', ffmpegPath: 'decode', timeoutMs: 50,
    runProcess: async () => hostileResult,
  });
  await assert.rejects(() => hostile.inspect(input));
  assert.equal(reads, 0);
});

test('the default process runner enforces output and time limits', async () => {
  await assert.rejects(() => runBoundedMediaProcess(process.execPath, [
    '-e', 'process.stdout.write("x".repeat(1049600))',
  ], { timeoutMs: 5_000, maxOutputBytes: 1024 * 1024 }));
  await assert.rejects(() => runBoundedMediaProcess(process.execPath, [
    '-e', 'setInterval(() => {}, 1000)',
  ], { timeoutMs: 20, maxOutputBytes: 1024 * 1024 }));
});

test('the default runner never invokes inherited Promise constructor or species hooks', () => {
  const modulePath = path.resolve(__dirname, '../src/media/boundedMediaProcess.js');
  const script = `
    'use strict';
    const {
      executeBoundedMediaProcess,
      runBoundedMediaProcess,
    } = require(${JSON.stringify(modulePath)});
    const unhandled = [];
    process.on('unhandledRejection', () => unhandled.push('unhandled'));

    async function probe(kind) {
      let reads = 0;
      const target = kind === 'constructor' ? Promise.prototype : Promise;
      const key = kind === 'constructor' ? 'constructor' : Symbol.species;
      const original = Object.getOwnPropertyDescriptor(target, key);
      let pending;
      try {
        Object.defineProperty(target, key, {
          configurable: true,
          get() {
            reads += 1;
            throw new Error('synthetic promise hook');
          },
        });
        pending = executeBoundedMediaProcess(
          { runProcess: runBoundedMediaProcess, timeoutMs: 2_000 },
          process.execPath,
          ['-e', 'process.stdout.write("ok")'],
        );
      } finally {
        Object.defineProperty(target, key, original);
      }
      try {
        const result = await pending;
        return { reads, stdout: result.stdout };
      } catch (error) {
        return { reads, error: error && (error.code || error.message) };
      }
    }

    async function probeSubclass() {
      let constructions = 0;
      let speciesReads = 0;
      class SyntheticPromise extends Promise {
        constructor(executor) {
          constructions += 1;
          super(executor);
        }

        static get [Symbol.species]() {
          speciesReads += 1;
          throw new Error('synthetic subclass species');
        }
      }
      const result = await executeBoundedMediaProcess({
        timeoutMs: 100,
        runProcess: () => new SyntheticPromise((resolve) => setTimeout(() => resolve({
          exitCode: 0, stdout: 'subclass', stderr: '',
        }), 5)),
      }, 'unused', []);
      return { constructions, speciesReads, stdout: result.stdout };
    }

    async function probeOwnConstructor() {
      let reads = 0;
      const value = new Promise((resolve) => setTimeout(() => resolve({
        exitCode: 0, stdout: 'own-constructor', stderr: '',
      }), 5));
      Object.defineProperty(value, 'constructor', {
        configurable: true,
        get() {
          reads += 1;
          throw new Error('synthetic own constructor');
        },
      });
      const result = await executeBoundedMediaProcess({
        timeoutMs: 100,
        runProcess: () => value,
      }, 'unused', []);
      return { reads, stdout: result.stdout };
    }

    async function probeLateSettlement(kind) {
      try {
        await executeBoundedMediaProcess({
          timeoutMs: 5,
          runProcess: () => new Promise((resolve, reject) => setTimeout(() => {
            if (kind === 'reject') reject(new Error('synthetic late rejection'));
            else resolve({ exitCode: 0, stdout: 'late', stderr: '' });
          }, 30)),
        }, 'unused', []);
        return 'unexpected-success';
      } catch (error) {
        return error && error.code;
      }
    }

    (async () => {
      const constructor = await probe('constructor');
      const species = await probe('species');
      const subclass = await probeSubclass();
      const ownConstructor = await probeOwnConstructor();
      const lateReject = await probeLateSettlement('reject');
      const lateResolve = await probeLateSettlement('resolve');
      await new Promise((resolve) => setTimeout(resolve, 50));
      process.stdout.write(JSON.stringify({
        constructor, species, subclass, ownConstructor, lateReject, lateResolve, unhandled,
      }));
    })().catch((error) => {
      process.stderr.write(String(error && error.stack || error));
      process.exitCode = 1;
    });
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    constructor: { reads: 0, stdout: 'ok' },
    species: { reads: 0, stdout: 'ok' },
    subclass: { constructions: 1, speciesReads: 0, stdout: 'subclass' },
    ownConstructor: { reads: 0, stdout: 'own-constructor' },
    lateReject: 'MEDIA_PROBE_FAILED',
    lateResolve: 'MEDIA_PROBE_FAILED',
    unhandled: [],
  });
});

test('runs a real ffmpeg/ffprobe smoke and verifies decoded local bytes', async (t) => {
  const root = createTempRoot(t);
  const file = path.join(root, 'real.mp4');
  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();
  execFileSync(ffmpegPath, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-movflags', '+faststart', file,
  ], { windowsHide: true, stdio: 'pipe', timeout: 30_000 });
  const bytes = fs.readFileSync(file);
  const inspector = createLocalMediaProbe({ localRoot: root, ffmpegPath, ffprobePath });
  const evidence = await inspector.inspect({
    schemaVersion: '8.0', uid: uid(1506),
    assetVersion: versionEvidence('real.mp4', bytes),
    probedAtEpochMs: 1_800_000_800_000,
  });
  assert.equal(evidence.mediaKind, 'video');
  assert.equal(evidence.video.codecName, 'h264');
  assert.equal(evidence.audio.codecName, 'aac');
  assert.equal(evidence.decoded, true);
});
