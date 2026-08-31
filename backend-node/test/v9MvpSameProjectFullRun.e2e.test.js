'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const { readProjectArchive } = require('../src/adapters/v2/zip/archiveReader');
const { parseProjectManifestV21 } = require('../src/adapters/v2/zip/manifestV21');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const projectZipService = require('../src/services/projectZipService');
const {
  seedProjectArchiveV21RoundTripFixture,
} = require('./helpers/v9ProjectArchiveV21RoundTripFixture');

const quietLog = Object.freeze({ info() {}, error() {} });

function createDatabase(t) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrationsAndEnsure(database);
  t.after(() => database.close());
  return database;
}

function createStorage(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function normalizedManifest(value) {
  const normalized = structuredClone(value);
  delete normalized.exportedAt;
  return normalized;
}

test('one synthetic project binds persisted evidence, a real local 1080p export, and clean 2.1 round-trip', async (t) => {
  const source = createDatabase(t);
  const sourceStorage = createStorage(t, 'p9-09c-same-project-source');
  const fixture = await seedProjectArchiveV21RoundTripFixture(t, source, sourceStorage);
  const { fullRun } = fixture;

  const run = fixture.repositories.runs.getWorkflowWithNodes(
    fullRun.executionPlan.workflowRunUid,
  );
  assert.equal(run.run.workflowUid, fullRun.workflowUid);
  assert.equal(run.run.status, 'succeeded');
  assert.equal(run.nodes.length, 8);
  assert.ok(run.nodes.every((node) => node.status === 'succeeded'));
  for (const [nodeType, output] of Object.entries(fullRun.materializedOutputs)) {
    const planNode = run.run.graphSnapshot.snapshot.nodes.find(
      (node) => node.nodeType === nodeType,
    );
    const nodeRun = run.nodes.find((node) => node.nodeUid === planNode.uid);
    assert.equal(JSON.stringify(nodeRun.output), JSON.stringify(output));
  }
  const exportNode = run.run.graphSnapshot.snapshot.nodes.find(
    (node) => node.nodeType === 'export.final',
  );
  const exportNodeRun = run.nodes.find((node) => node.nodeUid === exportNode.uid);
  assert.equal(exportNodeRun.uid, fullRun.exportNodeRunUid);
  assert.deepEqual(exportNodeRun.output, {
    schemaVersion: 'media-export-node-output.v1',
    executionPlan: fullRun.executionPlan,
  });

  const mediaRun = fullRun.mediaExportRun;
  assert.equal(mediaRun.uid, fullRun.executionPlan.uid);
  assert.equal(mediaRun.dramaUid, fixture.dramaUid);
  assert.equal(mediaRun.workflowRunUid, run.run.uid);
  assert.equal(mediaRun.status, 'succeeded');
  assert.equal(mediaRun.output.width, 1920);
  assert.equal(mediaRun.output.height, 1080);
  assert.equal(mediaRun.output.videoCodec, 'h264');
  assert.ok(mediaRun.output.durationMs > 0);
  assert.ok(mediaRun.output.bytes > 0);

  const finalVersion = fixture.repositories.assets.getVersion(mediaRun.outputAssetVersionUid);
  const finalAsset = fixture.repositories.assets.get(mediaRun.outputAssetUid);
  assert.equal(finalAsset.ownerType, 'drama');
  assert.equal(finalAsset.ownerUid, fixture.dramaUid);
  assert.equal(finalAsset.assetType, 'final_video');
  assert.equal(finalAsset.status, 'ready');
  assert.equal(finalAsset.currentVersionUid, finalVersion.uid);
  assert.equal(finalVersion.status, 'ready');
  assert.equal(finalVersion.sha256, mediaRun.output.sha256);
  assert.equal(finalVersion.width, 1920);
  assert.equal(finalVersion.height, 1080);
  const finalPath = path.join(sourceStorage, ...finalVersion.relativePath.split('/'));
  assert.equal(fs.statSync(finalPath).size, mediaRun.output.bytes);
  assert.equal(sha256File(finalPath), mediaRun.output.sha256);

  const sourceDramaId = source.prepare('SELECT id FROM dramas WHERE uid=?').pluck()
    .get(fixture.dramaUid);
  const firstExport = projectZipService.exportDrama(
    source,
    { storage: { local_path: sourceStorage } },
    quietLog,
    sourceDramaId,
  );
  const firstArchive = readProjectArchive(firstExport.buffer);
  const firstManifest = parseProjectManifestV21(firstArchive.manifestData);
  assert.ok(firstManifest.records.workflowRuns.some((row) => row.uid === run.run.uid));
  assert.ok(firstManifest.records.exportRuns.some((row) => row.uid === mediaRun.uid));
  assert.ok(firstManifest.records.assetVersions.some((row) => row.uid === finalVersion.uid));
  const finalBinding = firstManifest.mediaBindings.find(
    (binding) => binding.asset_version_uid === finalVersion.uid,
  );
  assert.ok(finalBinding);
  assert.equal(finalBinding.sha256, finalVersion.sha256);
  assert.equal(sha256File(finalPath), finalBinding.sha256);
  assert.deepEqual(firstArchive.files.get(finalBinding.archive_path), fs.readFileSync(finalPath));
  const serialized = JSON.stringify(firstManifest);
  assert.equal(serialized.includes(fixture.credentialRef), false);
  assert.doesNotMatch(serialized, /credential:v1:/u);

  const target = createDatabase(t);
  const targetStorage = createStorage(t, 'p9-09c-same-project-target');
  const imported = projectZipService.importDrama(
    target,
    { storage: { local_path: targetStorage } },
    quietLog,
    firstExport.buffer,
  );
  const importedVersion = target.prepare('SELECT * FROM asset_versions WHERE uid=?')
    .get(finalVersion.uid);
  assert.equal(importedVersion.sha256, finalVersion.sha256);
  assert.equal(importedVersion.width, 1920);
  assert.equal(importedVersion.height, 1080);
  const importedPath = path.join(targetStorage, ...importedVersion.relative_path.split('/'));
  assert.equal(sha256File(importedPath), finalVersion.sha256);
  const importedRun = target.prepare('SELECT status FROM workflow_runs WHERE uid=?')
    .pluck().get(run.run.uid);
  const importedMediaRun = target.prepare('SELECT status FROM export_runs WHERE uid=?')
    .pluck().get(mediaRun.uid);
  assert.equal(importedRun, 'succeeded');
  assert.equal(importedMediaRun, 'succeeded');

  const secondExport = projectZipService.exportDrama(
    target,
    { storage: { local_path: targetStorage } },
    quietLog,
    imported.drama_id,
  );
  const secondArchive = readProjectArchive(secondExport.buffer);
  const secondManifest = parseProjectManifestV21(secondArchive.manifestData);
  assert.deepEqual(normalizedManifest(secondManifest), normalizedManifest(firstManifest));
  assert.deepEqual([...secondArchive.files.keys()].sort(), [...firstArchive.files.keys()].sort());
  for (const [archivePath, bytes] of firstArchive.files) {
    assert.deepEqual(secondArchive.files.get(archivePath), bytes);
  }

  assert.equal(source.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(source.pragma('foreign_key_check'), []);
  assert.equal(target.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(target.pragma('foreign_key_check'), []);
});
