'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createSftpTransfer } = require('../src/remote/sftpTransfer');

test('a decodable synthetic MP4 survives single-stream transfer, local hash, ffprobe and decoding', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-sftp-playable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localRoot = path.join(root, 'local');
  fs.mkdirSync(localRoot);
  const source = path.join(root, 'source.mp4');
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x128:r=12',
    '-t', '1', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', source], { windowsHide: true });
  const bytes = fs.readFileSync(source);
  const digest = createHash('sha256').update(bytes).digest('hex');
  let received = 0;
  const sftp = {
    lstat(name, callback) {
      if (name.endsWith('/clip.mp4')) fs.lstat(source, callback);
      else callback(null, { isDirectory: () => true, isSymbolicLink: () => false });
    },
    realpath(name, callback) { callback(null, `/synthetic/${name}`); },
    createReadStream(_name, options) {
      const stream = fs.createReadStream(source, options);
      stream.on('data', (chunk) => { received += chunk.length; });
      return stream;
    },
    end() {},
  };
  const result = await createSftpTransfer({ localRoot }).downloadFile({
    session: { async sftp() { return sftp; } }, localRelativePath: 'clip.mp4',
    remoteWorkDir: 'jobs-root', taskUid: '00000000-0000-4000-8000-000000000111',
    relativePath: 'clip.mp4', expectedSha256: digest,
  });
  const output = path.join(localRoot, 'clip.mp4');
  assert.deepEqual(fs.readFileSync(output), bytes);
  assert.equal(result.sha256, digest);
  assert.equal(received, bytes.length);
  const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries',
    'stream=codec_name,width,height:format=duration', '-of', 'json', output], { encoding: 'utf8', windowsHide: true }));
  assert.equal(probe.streams[0].width, 128);
  assert.equal(probe.streams[0].height, 128);
  assert.equal(Number(probe.format.duration), 1);
  execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-'], { windowsHide: true });
});
