'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectLocalRecoveryItem } = require('../src/remoteAssets/localRecoveryItem');
const uid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const relativePath = `characters/${uid(1)}/local-recoveries/${uid(2)}/0.png`;
const legacy = { ordinal: 0, assetUid: uid(3), assetVersionUid: uid(4), relativePath,
  sha256: 'a'.repeat(64), byteLength: 12, width: 256, height: 256,
  originalName: 'source.png', originalSha256: 'b'.repeat(64) };

test('exact v36 item gains a deterministic URI without mutating stored evidence', () => {
  const projected = projectLocalRecoveryItem(legacy, uid(1), uid(2), 0);
  assert.equal(projected.logicalUri, `asset://${relativePath}`);
  assert.equal(Object.hasOwn(legacy, 'logicalUri'), false);
  assert.deepEqual(projectLocalRecoveryItem(projected, uid(1), uid(2), 0), projected);
});

for (const invalid of [
  { ...legacy, logicalUri: null }, { ...legacy, logicalUri: `asset://wrong/${relativePath}` },
  { ...legacy, relativePath: '../escape.png' }, { ...legacy, unexpected: true },
  { ...legacy, ordinal: 1 }, { ...legacy, byteLength: -1 },
  { ...legacy, sha256: 'invalid' },
]) {
  test('v36 compatibility rejects corrupted or unrecognized item evidence', () => {
    assert.throws(() => projectLocalRecoveryItem(invalid, uid(1), uid(2), 0));
  });
}

test('v36 compatibility does not invoke hostile getters', () => {
  const item = { ...legacy };
  Object.defineProperty(item, 'logicalUri', { enumerable: true, get() { assert.fail('getter executed'); } });
  assert.throws(() => projectLocalRecoveryItem(item, uid(1), uid(2), 0), /item is invalid/);
});
