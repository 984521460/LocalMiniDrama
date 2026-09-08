'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { createSftpTransfer } = require('../src/remote/sftpTransfer');
const uid = '00000000-0000-4000-8000-000000000111';
const hash = (body) => createHash('sha256').update(body).digest('hex');

function fixture(t, chunks, { size = 8, mtime = () => 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-sftp-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localRoot = path.join(root, 'local');
  fs.mkdirSync(localRoot);
  fs.mkdirSync(path.join(localRoot, 'downloads'));
  let statsRead = 0;
  const sftp = {
    lstat(name, callback) {
      callback(null, name.endsWith('/output.bin')
        ? { size, mtime: mtime(++statsRead), isFile: () => true, isSymbolicLink: () => false }
        : { isDirectory: () => true, isSymbolicLink: () => false });
    },
    realpath(name, callback) { callback(null, `/sandbox/${name}`); },
    createReadStream() { return Readable.from(typeof chunks === 'function' ? chunks() : chunks); },
    end() {},
  };
  return { root, localRoot, sftp,
    partial: path.join(localRoot, 'downloads', '.output.bin.part'),
    request: { session: { async sftp() { return sftp; } }, localRelativePath: 'downloads/output.bin',
      remoteWorkDir: 'work', taskUid: uid, relativePath: 'output.bin',
      expectedSha256: hash(Buffer.alloc(size, 0x61)), taskScope: 'character-candidates', maxBytes: size },
  };
}

for (const [name, chunks, prefix] of [
  ['single oversized chunk', [Buffer.alloc(65536)], null],
  ['multiple chunks', [Buffer.alloc(4), Buffer.alloc(5)], null],
  ['resumed overflow', [Buffer.alloc(5)], Buffer.alloc(4)],
]) {
  test(`SFTP bounded receive rejects ${name} and discards unsafe partial`, async (t) => {
    const f = fixture(t, chunks);
    if (prefix) fs.writeFileSync(f.partial, prefix);
    await assert.rejects(createSftpTransfer(f).downloadScopedFile(f.request));
    assert.equal(fs.existsSync(f.partial), false);
    assert.deepEqual(fs.readdirSync(path.dirname(f.partial)), []);
  });
}

for (const mtime of [() => undefined, (call) => call]) {
  test('SFTP requires stable ssh2 mtime evidence for unknown-hash output', async (t) => {
    const f = fixture(t, [Buffer.alloc(8)], { mtime });
    await assert.rejects(createSftpTransfer(f).downloadScopedFile({ ...f.request, expectedSha256: null }));
    assert.deepEqual(fs.readdirSync(path.dirname(f.partial)), []);
  });
}

test('SFTP refuses hard-linked partial before writing either linked name', async (t) => {
  const f = fixture(t, [Buffer.alloc(4)]);
  const outside = path.join(f.root, 'outside.bin');
  fs.writeFileSync(outside, 'safe');
  fs.linkSync(outside, f.partial);
  await assert.rejects(createSftpTransfer(f).downloadScopedFile(f.request));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'safe');
});

test('SFTP detects replaced partial and never writes through the replacement', async (t) => {
  const f = fixture(t, [Buffer.alloc(4)]);
  fs.writeFileSync(f.partial, 'aaaa');
  const outside = path.join(f.root, 'outside.bin');
  fs.writeFileSync(outside, 'safe');
  const originalOpen = fs.promises.open;
  t.after(() => { fs.promises.open = originalOpen; });
  fs.promises.open = async (name, flags, ...rest) => {
    if (name === f.partial && flags === 'r') {
      fs.unlinkSync(f.partial);
      fs.linkSync(outside, f.partial);
    }
    return originalOpen(name, flags, ...rest);
  };
  await assert.rejects(createSftpTransfer(f).downloadScopedFile(f.request));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'safe');
});

test('SFTP same-target active download excludes a second transfer instance', async (t) => {
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, async function* chunks() {
    started();
    await gate;
    yield Buffer.alloc(8, 0x61);
  });
  const first = createSftpTransfer(f).downloadScopedFile(f.request);
  await ready;
  await assert.rejects(createSftpTransfer(f).downloadScopedFile(f.request), { code: 'SFTP_TRANSFER_CONFLICT' });
  release();
  assert.equal((await first).bytes, 8);
});
