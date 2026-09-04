'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const AdmZip = require('adm-zip');
const Ajv2020 = require('ajv/dist/2020');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { readProjectArchive } = require('../src/adapters/v2/zip/archiveReader');
const { parseProjectManifestV21 } = require('../src/adapters/v2/zip/manifestV21');
const { PROJECT_ARCHIVE_CATALOG } = require('../src/adapters/v2/zip/projectArchiveCatalog');
const projectZipService = require('../src/services/projectZipService');
const {
  seedProjectArchiveV21RoundTripFixture,
} = require('./helpers/v9ProjectArchiveV21RoundTripFixture');

const fixtureProject = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'minimal-project', 'project.json'),
  'utf8',
);
const baseManifestSchema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../schemas/v2/project-archive-manifest.schema.json'),
  'utf8',
));
const manifestV21Schema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../schemas/v2/project-archive-manifest-v2.1.schema.json'),
  'utf8',
));

function createDatabase(t) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrationsAndEnsure(database);
  t.after(() => database.close());
  return database;
}

function createStorage(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

function createV1Zip() {
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(fixtureProject, 'utf8'));
  return zip.toBuffer();
}

const quietLog = Object.freeze({ info() {}, error() {} });

function normalizedManifest(value) {
  const normalized = structuredClone(value);
  delete normalized.exportedAt;
  return normalized;
}

test('production export defaults to a strict minimal 2.1 archive', (t) => {
  const database = createDatabase(t);
  const storage = createStorage(t, 'archive-v21-production-export');
  const imported = projectZipService.importDrama(
    database,
    { storage: { local_path: storage } },
    quietLog,
    createV1Zip(),
  );

  const exported = projectZipService.exportDrama(
    database,
    { storage: { local_path: storage } },
    quietLog,
    imported.drama_id,
  );
  const archive = readProjectArchive(exported.buffer);
  const manifest = parseProjectManifestV21(archive.manifestData);

  assert.equal(manifest.schemaVersion, '2.1.0');
  assert.deepEqual(
    new AdmZip(exported.buffer).getEntries().map((entry) => entry.entryName).sort(),
    ['project.json', 'v2/manifest.json'],
  );
  assert.equal(archive.files.size, 0);

  const preE3Zip = new AdmZip(exported.buffer);
  const preE3Manifest = JSON.parse(preE3Zip.readAsText('v2/manifest.json'));
  delete preE3Manifest.structuredRecords.characterCandidateExecutions;
  delete preE3Manifest.structuredRecords.characterCandidateExecutionItems;
  delete preE3Manifest.structuredRecords.characterReferencePackageExecutions;
  preE3Zip.updateFile(
    'v2/manifest.json',
    Buffer.from(JSON.stringify(preE3Manifest, null, 2), 'utf8'),
  );
  const preE3Target = createDatabase(t);
  const preE3Storage = createStorage(t, 'archive-v21-pre-e3-target');
  const preE3Imported = projectZipService.importDrama(
    preE3Target,
    { storage: { local_path: preE3Storage } },
    quietLog,
    preE3Zip.toBuffer(),
  );
  const normalizedPreE3 = readProjectArchive(projectZipService.exportDrama(
    preE3Target,
    { storage: { local_path: preE3Storage } },
    quietLog,
    preE3Imported.drama_id,
  ).buffer).manifestData;
  assert.deepEqual(normalizedPreE3.structuredRecords.characterCandidateExecutions, []);
  assert.deepEqual(normalizedPreE3.structuredRecords.characterCandidateExecutionItems, []);
  assert.deepEqual(normalizedPreE3.structuredRecords.characterReferencePackageExecutions, []);

  let trapReads = 0;
  const hostileDramaId = new Proxy({}, {
    get() {
      trapReads += 1;
      throw new Error('drama-id-trap');
    },
  });
  for (const dramaId of [hostileDramaId, '1e0', 0, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => projectZipService.exportDrama(
        database, { storage: { local_path: storage } }, quietLog, dramaId,
      ),
      (error) => error.code === 'PROJECT_ARCHIVE_INVALID'
        && !JSON.stringify(error).includes('drama-id-trap'),
    );
  }
  assert.equal(trapReads, 0);
});

test('post-commit logging failure cannot turn a successful 2.1 import into a reported failure', (t) => {
  const source = createDatabase(t);
  const sourceStorage = createStorage(t, 'archive-v21-post-commit-source');
  const legacy = projectZipService.importDrama(
    source,
    { storage: { local_path: sourceStorage } },
    quietLog,
    createV1Zip(),
  );
  const exported = projectZipService.exportDrama(
    source,
    { storage: { local_path: sourceStorage } },
    quietLog,
    legacy.drama_id,
  );

  const target = createDatabase(t);
  const targetStorage = createStorage(t, 'archive-v21-post-commit-target');
  const imported = projectZipService.importDrama(
    target,
    { storage: { local_path: targetStorage } },
    Object.freeze({
      info() { throw new Error('synthetic-post-commit-log-failure'); },
      error() {},
    }),
    exported.buffer,
  );

  assert.deepEqual(imported, { drama_id: legacy.drama_id, title: legacy.title });
  assert.equal(target.prepare('SELECT count(*) FROM dramas').pluck().get(), 1);
});

test('a complete migrated project round-trips through a clean database as normalized 2.1', async (t) => {
  const source = createDatabase(t);
  const sourceStorage = createStorage(t, 'archive-v21-round-trip-source');
  const fixture = await seedProjectArchiveV21RoundTripFixture(t, source, sourceStorage);
  const firstExport = projectZipService.exportDrama(
    source,
    { storage: { local_path: sourceStorage } },
    quietLog,
    source.prepare('SELECT id FROM dramas WHERE uid=?').pluck().get(fixture.dramaUid),
  );
  const firstArchive = readProjectArchive(firstExport.buffer);
  const firstManifest = parseProjectManifestV21(firstArchive.manifestData);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(baseManifestSchema);
  const validateSchema = ajv.compile(manifestV21Schema);
  assert.equal(validateSchema(firstManifest), true, JSON.stringify(validateSchema.errors));
  const schemaExtra = structuredClone(firstManifest);
  schemaExtra.unexpected = true;
  assert.equal(validateSchema(schemaExtra), false);
  const schemaMissingGroup = structuredClone(firstManifest);
  delete schemaMissingGroup.structuredRecords.narrativeResults;
  assert.equal(validateSchema(schemaMissingGroup), false);
  const schemaPreE3 = structuredClone(firstManifest);
  delete schemaPreE3.structuredRecords.characterCandidateExecutions;
  delete schemaPreE3.structuredRecords.characterCandidateExecutionItems;
  delete schemaPreE3.structuredRecords.characterReferencePackageExecutions;
  assert.equal(validateSchema(schemaPreE3), true, JSON.stringify(validateSchema.errors));
  const schemaMediaExtra = structuredClone(firstManifest);
  schemaMediaExtra.mediaBindings[0].unexpected = true;
  assert.equal(validateSchema(schemaMediaExtra), false);
  const schemaPortableExtra = structuredClone(firstManifest);
  schemaPortableExtra.portableBindings[0].portable_field.unexpected = true;
  assert.equal(validateSchema(schemaPortableExtra), false);
  const narrativeNode = firstManifest.records.canvasNodes.find(
    (row) => row.domain_ref_type === 'narrative_result',
  );
  assert.ok(narrativeNode);
  assert.ok(firstManifest.structuredRecords.narrativeResults.some(
    (row) => row.uid === narrativeNode.domain_ref_uid,
  ));
  const missingNarrativeBinding = structuredClone(firstManifest);
  missingNarrativeBinding.structuredRecords.narrativeResults = (
    missingNarrativeBinding.structuredRecords.narrativeResults.filter(
      (row) => row.uid !== narrativeNode.domain_ref_uid,
    )
  );
  assert.throws(
    () => parseProjectManifestV21(missingNarrativeBinding),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
  const narrativeNodeTypes = Object.freeze({
    'story.facts': 'extraction',
    'episode.adaptation': 'adaptation',
    'script.structured': 'script',
    'shot.plan': 'shot',
  });
  for (const [nodeType, resultType] of Object.entries(narrativeNodeTypes)) {
    const mismatchedNarrativeBinding = structuredClone(firstManifest);
    const canvasNode = mismatchedNarrativeBinding.records.canvasNodes.find(
      (row) => row.node_type === nodeType,
    );
    const wrongResult = mismatchedNarrativeBinding.structuredRecords.narrativeResults.find(
      (row) => row.result_type !== resultType,
    );
    assert.ok(canvasNode);
    assert.ok(wrongResult);
    canvasNode.domain_ref_type = 'narrative_result';
    canvasNode.domain_ref_uid = wrongResult.uid;
    assert.throws(
      () => parseProjectManifestV21(mismatchedNarrativeBinding),
      (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
    );
  }
  const invalidNarrativeNode = structuredClone(firstManifest);
  const videoNode = invalidNarrativeNode.records.canvasNodes.find(
    (row) => row.node_type === 'shot.video',
  );
  assert.ok(videoNode);
  videoNode.domain_ref_type = 'narrative_result';
  videoNode.domain_ref_uid = narrativeNode.domain_ref_uid;
  assert.throws(
    () => parseProjectManifestV21(invalidNarrativeNode),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );

  for (const [name, rows] of Object.entries(firstManifest.structuredRecords)) {
    if (name === 'characterCandidateExecutions'
      || name === 'characterCandidateExecutionItems'
      || name === 'characterReferencePackageExecutions') {
      assert.deepEqual(rows, [], `structured ${name} is an optional production extension`);
    } else {
      assert.ok(rows.length > 0, `structured ${name} should be represented`);
    }
  }
  for (const [name, rows] of Object.entries(firstManifest.legacyRecords)) {
    assert.ok(rows.length > 0, `legacy ${name} should be represented`);
  }
  const emptyCurrentRecordGroups = Object.entries(firstManifest.records)
    .filter(([, rows]) => !Array.isArray(rows) || rows.length === 0)
    .map(([name]) => name);
  assert.deepEqual(
    emptyCurrentRecordGroups,
    [],
    `current record groups should all be represented: ${emptyCurrentRecordGroups.join(', ')}`,
  );
  for (const table of PROJECT_ARCHIVE_CATALOG.requiredV21Tables) {
    assert.equal(
      source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").pluck().get(table),
      1,
      `${table} should exist in the fully migrated source database`,
    );
  }
  assert.ok(firstManifest.mediaBindings.length > 0);
  assert.ok(firstManifest.portableBindings.length >= 5);
  const serialized = JSON.stringify(firstManifest);
  assert.equal(serialized.includes(fixture.credentialRef), false);
  assert.doesNotMatch(serialized, /credential:v1:|remote_tasks|h3_api_submissions|h3_generation_intents/u);

  const target = createDatabase(t);
  const targetStorage = createStorage(t, 'archive-v21-round-trip-target');
  const imported = projectZipService.importDrama(
    target,
    { storage: { local_path: targetStorage } },
    quietLog,
    firstExport.buffer,
  );
  const secondExport = projectZipService.exportDrama(
    target,
    { storage: { local_path: targetStorage } },
    quietLog,
    imported.drama_id,
  );
  const secondArchive = readProjectArchive(secondExport.buffer);
  const secondManifest = parseProjectManifestV21(secondArchive.manifestData);

  assert.deepEqual(normalizedManifest(secondManifest), normalizedManifest(firstManifest));
  assert.deepEqual(
    [...secondArchive.files.keys()].sort(),
    [...firstArchive.files.keys()].sort(),
  );
  for (const [archivePath, bytes] of firstArchive.files) {
    assert.deepEqual(secondArchive.files.get(archivePath), bytes);
  }
  assert.equal(
    target.prepare('SELECT count(*) FROM project_archive_v21_portable_bindings').pluck().get(),
    firstManifest.portableBindings.length,
  );
  assert.equal(target.prepare('SELECT count(*) FROM remote_tasks').pluck().get(), 0);
  assert.equal(target.prepare('SELECT count(*) FROM h3_api_submissions').pluck().get(), 0);
  assert.equal(target.prepare('SELECT count(*) FROM h3_generation_intents').pluck().get(), 0);
  assert.equal(target.prepare('SELECT count(*) FROM mvp_benchmark_sessions').pluck().get(), 0);
});
