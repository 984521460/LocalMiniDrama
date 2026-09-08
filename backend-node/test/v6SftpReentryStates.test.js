'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { acquireDownloadOwnership } = require('../src/remote/downloadOwnership');
const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
assert.equal(dead.status, 0);
assert.throws(() => process.kill(dead.pid, 0), { code: 'ESRCH' });

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-reentry-states-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const temporary = path.join(root, '.output.bin.part');
  const token = randomUUID();
  const metadata = { binding: 'a'.repeat(64), pid: dead.pid, token, ...options };
  const lock = `${temporary}.lock`;
  fs.writeFileSync(lock, JSON.stringify(metadata));
  return { root, temporary, lock, metadata, prior: `${temporary}.${token}`,
    pending: `${lock}.${metadata.pid}.${token}.pending`,
    input: { target: path.join(root, 'output.bin'), temporary,
      privateFile: `${temporary}.${randomUUID()}`, binding: 'a'.repeat(64), allowResume: true } };
}

for (const state of ['no-data', 'private', 'linked-pair', 'partial', 'copy-prefix']) {
  for (const publishedMetadataPair of [false, true]) {
    test(`recovery state ${state}, metadata-pair=${publishedMetadataPair} has an idempotent successor`, async (t) => {
      const f = fixture(t);
      if (publishedMetadataPair) fs.linkSync(f.lock, f.pending);
      if (['private', 'linked-pair'].includes(state)) fs.writeFileSync(f.prior, 'abcdef');
      if (state === 'linked-pair') fs.linkSync(f.prior, f.temporary);
      if (['partial', 'copy-prefix'].includes(state)) fs.writeFileSync(f.temporary, 'abcdef');
      if (state === 'copy-prefix') fs.writeFileSync(f.prior, 'abc');
      const lease = await acquireDownloadOwnership(f.input);
      await lease.release();
      assert.equal(fs.existsSync(f.prior), false);
      assert.equal(fs.existsSync(f.pending), false);
      assert.equal(fs.existsSync(f.lock), false);
      if (state !== 'no-data') {
        assert.equal(fs.readFileSync(f.temporary, 'utf8'), 'abcdef');
        assert.equal(fs.statSync(f.temporary).nlink, 1);
      }
      const again = await acquireDownloadOwnership(f.input);
      await again.release();
      if (state !== 'no-data') assert.equal(fs.readFileSync(f.temporary, 'utf8'), 'abcdef');
    });
  }
}

for (const state of ['wrong-inode', 'unknown-link', 'third-link', 'partial-link', 'symlink', 'unrelated-prefix', 'active-owner', 'wrong-binding', 'metadata-unknown-link']) {
  test(`recovery refuses ${state} without changing external file bytes`, async (t) => {
    const f = fixture(t, state === 'active-owner' ? { pid: process.pid }
      : state === 'wrong-binding' ? { binding: 'b'.repeat(64) } : {});
    const outsideDir = path.join(f.root, 'outside');
    fs.mkdirSync(outsideDir);
    const outside = path.join(outsideDir, 'keep.bin');
    fs.writeFileSync(outside, 'outside');
    fs.writeFileSync(f.prior, 'abcdef');
    if (state === 'unknown-link') fs.linkSync(f.prior, path.join(outsideDir, 'private-alias'));
    if (state === 'wrong-inode') {
      fs.linkSync(f.prior, path.join(outsideDir, 'private-alias'));
      fs.linkSync(outside, f.temporary);
    }
    if (state === 'third-link') {
      fs.linkSync(f.prior, f.temporary);
      fs.linkSync(f.prior, path.join(outsideDir, 'third-alias'));
    }
    if (state === 'partial-link') fs.linkSync(outside, f.temporary);
    if (state === 'symlink') fs.symlinkSync(outsideDir, f.temporary, 'junction');
    if (state === 'unrelated-prefix') fs.writeFileSync(f.temporary, 'xyzxyz');
    if (state === 'metadata-unknown-link') fs.linkSync(f.lock, path.join(outsideDir, 'unknown-lock-link'));
    await assert.rejects(acquireDownloadOwnership(f.input));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
    assert.equal(fs.readFileSync(f.prior, 'utf8'), 'abcdef');
    assert.equal(fs.readFileSync(f.lock, 'utf8'), JSON.stringify(f.metadata));
  });
}
