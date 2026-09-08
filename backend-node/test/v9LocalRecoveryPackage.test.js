'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { readLocalRecoveryPackage } = require('../src/remoteAssets/localRecoveryPackage');
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function fixture() {
  const image = await sharp({ create: { width: 256, height: 256, channels: 3,
    background: '#123456' } }).png().toBuffer();
  const manifest = { schemaVersion: 'project-character-candidate-emergency-run.v1',
    runUid: uid(1), checkpoint: 'model.safetensors', width: 256, height: 256,
    sampler: 'euler', scheduler: 'normal', steps: 20, cfg: 6,
    items: ['甲', '乙'].map((name, i) => ({ slug: `hero-${i}`, name,
      operationUid: uid(i + 2), ordinal: 0, seed: i,
      promptSha256: 'a'.repeat(64), promptId: uid(i + 4), state: 'succeeded',
      filename: '0_00001_.png', subfolder: `character-candidates/${uid(i + 2)}`,
      type: 'output', bytes: image.length,
      sha256: createHash('sha256').update(image).digest('hex'),
      localPackageName: `hero-${i}-1.png`, verifiedWidth: 256, verifiedHeight: 256 })) };
  const pack = (value = manifest, extra = false) => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(value)));
    for (const item of manifest.items) zip.addFile(item.localPackageName, image);
    if (extra) zip.addFile('extra.png', image);
    return zip.toBuffer();
  };
  return { manifest, pack };
}

test('local package verifies actual PNG bytes and preserves distinct character ownership', async () => {
  const { pack } = await fixture();
  const result = await readLocalRecoveryPackage(pack());
  assert.deepEqual(result.items.map((i) => i.name), ['甲', '乙']);
  assert.equal(result.items.every((i) => Buffer.isBuffer(i.bytes)), true);
  assert.match(result.packageSha256, /^[a-f0-9]{64}$/u);
});

test('package rejects missing ownership, altered hashes, wrong paths and undeclared files', async () => {
  const { manifest, pack } = await fixture();
  for (const mutate of [
    (m) => { m.items[1].sha256 = 'b'.repeat(64); },
    (m) => { m.items[1].operationUid = m.items[0].operationUid; },
    (m) => { m.items[1].localPackageName = '../escape.png'; },
    (m) => { m.items[0].verifiedWidth = 512; },
    (m) => { m.items[0].state = 'running'; },
  ]) {
    const changed = structuredClone(manifest); mutate(changed);
    await assert.rejects(readLocalRecoveryPackage(pack(changed)), /package is invalid/u);
  }
  await assert.rejects(readLocalRecoveryPackage(pack(manifest, true)), /package is invalid/u);
  await assert.rejects(readLocalRecoveryPackage(Buffer.from('not a zip')), /package is invalid/u);
});
