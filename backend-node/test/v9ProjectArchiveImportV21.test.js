'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  RECORD_NAMES,
} = require('../src/adapters/v2/zip/manifest');
const {
  STRUCTURED_RECORD_SPECS,
  createProjectArchiveV21StructuredData,
} = require('../src/adapters/v2/zip/projectArchiveV21StructuredData');
const {
  LEGACY_RECORD_SPECS,
  createProjectArchiveV21LegacyData,
} = require('../src/adapters/v2/compat/projectArchiveV21LegacyData');
const {
  projectProjectArchiveV21PortableField,
} = require('../src/adapters/v2/zip/projectArchiveV21PortableBindings');
const {
  createProjectManifestV21,
} = require('../src/adapters/v2/zip/manifestV21');
const {
  createProjectArchiveV21MediaCollector,
} = require('../src/adapters/v2/zip/projectArchiveV21MediaClosure');
const {
  createProjectArchiveV21ImportService,
} = require('../src/services/projectArchiveV21ImportService');
const { createProjectImportMediaStaging } = require('../src/services/projectImportMediaStaging');
const { createV2Repositories } = require('../src/repositories/v2');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

const EXPORTED_AT = '2026-08-30T00:00:00.000Z';
const DRAMA_UID = uid(94000);

function emptyRecordSet(names) {
  return Object.fromEntries(names.map((name) => [name, []]));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createStorage(t, label = 'archive-v21-import') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const root = path.join(parent, 'storage');
  t.after(() => fs.rmSync(parent, { force: true, recursive: true }));
  return root;
}

function createCompleteDatabase(t) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrationsAndEnsure(database);
  t.after(() => database.close());
  return database;
}

function legacyDrama(dramaUid = DRAMA_UID) {
  const records = emptyRecordSet(Object.keys(LEGACY_RECORD_SPECS));
  records.dramas.push({
    id: 1,
    uid: dramaUid,
    title: 'Archive 2.1 import fixture',
    description: null,
    genre: null,
    style: null,
    tags: null,
    thumbnail: null,
    total_episodes: 0,
    total_duration: 0,
    status: 'draft',
    metadata: {},
    created_at: EXPORTED_AT,
    updated_at: EXPORTED_AT,
    deleted_at: null,
  });
  return records;
}

function mediaBundle(bytes = Buffer.from('archive-v21-import-media')) {
  const contentHash = sha256(bytes);
  const versionUid = uid(94002);
  const assetUid = uid(94001);
  const archivePath = `v2/media/sha256/${contentHash.slice(0, 2)}/${contentHash}`;
  const relativePath = 'projects/archive-v21/videos/final.mp4';
  const records = emptyRecordSet(RECORD_NAMES);
  records.assets.push({
    uid: assetUid,
    owner_type: 'drama',
    owner_uid: DRAMA_UID,
    asset_type: 'video',
    current_version_uid: versionUid,
    status: 'ready',
    created_at: EXPORTED_AT,
    updated_at: EXPORTED_AT,
  });
  records.assetVersions.push({
    uid: versionUid,
    asset_uid: assetUid,
    storage_provider: 'local',
    logical_uri: 'asset://projects/archive-v21/final.mp4',
    relative_path: relativePath,
    sha256: contentHash,
    mime_type: 'video/mp4',
    width: 608,
    height: 352,
    duration_ms: 1625,
    parent_uid: null,
    status: 'ready',
    created_at: EXPORTED_AT,
  });
  const manifest = createProjectManifestV21({
    legacyProjectVersion: '1.0.0',
    exportedAt: EXPORTED_AT,
    project: { dramaUid: DRAMA_UID, characters: [], scenes: [], props: [], episodes: [] },
    records,
    structuredRecords: emptyRecordSet(Object.keys(STRUCTURED_RECORD_SPECS)),
    legacyRecords: legacyDrama(),
    mediaBindings: [{
      asset_version_uid: versionUid,
      binding_state: 'content_addressed',
      archive_path: archivePath,
      byte_length: bytes.length,
      sha256: contentHash,
    }],
    portableBindings: [],
  });
  return {
    assetUid,
    bytes,
    files: new Map([[archivePath, bytes]]),
    manifest,
    relativePath,
    versionUid,
  };
}

function seedVoiceSource(t) {
  const database = createCompleteDatabase(t);
  insertDrama(database, DRAMA_UID, 'Portable voice source');
  database.prepare("INSERT INTO characters (id, drama_id, name, sort_order) VALUES (1, 1, 'Hero', 0)").run();
  const characterUid = database.prepare('SELECT uid FROM characters WHERE id=1').pluck().get();
  const repositories = createV2Repositories(database);
  const identity = repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'identity',
    uid: uid(94010),
    characterUid,
    parentUid: null,
    metadata: {
      name: 'Hero identity',
      visualSignature: 'stable hero identity',
      colorAnchors: ['#112233'],
    },
    createdAtEpochMs: 0,
  });
  const voice = repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'voice',
    uid: uid(94011),
    characterUid,
    identityVersionUid: identity.uid,
    parentUid: null,
    metadata: { name: 'Mandarin calm', language: 'zh-CN', style: 'calm' },
    createdAtEpochMs: 0,
  });
  const profile = repositories.voiceProfiles.create({
    schemaVersion: '8.0',
    uid: uid(94012),
    dramaUid: DRAMA_UID,
    characterUid,
    characterVoiceVersionUid: voice.uid,
    parentUid: null,
    revision: 1,
    provider: 'openai-compatible',
    model: 'gpt-4o-mini-tts',
    voiceKey: 'alloy',
    credentialRef: `credential:v1:${uid(94013)}`,
    sourceKind: 'provider-preset',
    status: 'ready',
    defaultEmotion: 'neutral',
    emotionMap: {
      neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
      fearful: 'fearful', surprised: 'surprised',
    },
    minimumSpeedPermille: 500,
    defaultSpeedPermille: 1000,
    maximumSpeedPermille: 2000,
    createdAtEpochMs: 1,
  });
  const snapshot = repositories.projectArchives.exportSnapshot(1);
  const structuredRecords = createProjectArchiveV21StructuredData(database).exportForDrama(DRAMA_UID);
  const legacyRecords = createProjectArchiveV21LegacyData(database).exportForDrama(DRAMA_UID);
  const directBinding = projectProjectArchiveV21PortableField(
    'voice_profiles',
    'credential_ref',
    `credential:v1:${uid(94013)}`,
  );
  const manifest = createProjectManifestV21({
    legacyProjectVersion: '1.0.0',
    exportedAt: EXPORTED_AT,
    project: snapshot.project,
    records: snapshot.records,
    structuredRecords,
    legacyRecords,
    mediaBindings: createProjectArchiveV21MediaCollector(path.dirname(createStorage(t, 'empty-media-root')))
      .collect(snapshot.records.assetVersions).bindings,
    portableBindings: [{
      table: 'voice_profiles',
      row_uid: profile.uid,
      column: 'credential_ref',
      portable_field: directBinding,
    }],
  });
  return { characterUid, manifest, profileUid: profile.uid };
}

function count(database, table) {
  return database.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
}

function onlyStagedFile(storageRoot) {
  const pending = [path.join(storageRoot, '.project-import-staging')];
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filename);
      else if (entry.isFile()) files.push(filename);
    }
  }
  assert.equal(files.length, 1);
  return files[0];
}

function mediaMutationFactory({ afterWrite = null, afterPromote = null } = {}) {
  return (storageRoot) => {
    const media = createProjectImportMediaStaging(storageRoot);
    return Object.freeze({
      writeExact(input) {
        const result = media.writeExact(input);
        afterWrite?.(storageRoot);
        return result;
      },
      promote() {
        media.promote();
        afterPromote?.(storageRoot);
      },
      assertCommitReady: media.assertCommitReady,
      rollback: media.rollback,
      complete: media.complete,
    });
  };
}

test('imports validated 2.1 data and exact content-addressed media into a clean database', (t) => {
  const database = createCompleteDatabase(t);
  const storageRoot = createStorage(t);
  const bundle = mediaBundle();
  const service = createProjectArchiveV21ImportService();
  const result = service.importBundle({
    database,
    storageRoot,
    manifest: bundle.manifest,
    files: bundle.files,
  });

  assert.equal(result.dramaUid, DRAMA_UID);
  assert.equal(count(database, 'dramas'), 1);
  assert.equal(count(database, 'assets'), 1);
  assert.equal(count(database, 'asset_versions'), 1);
  assert.equal(database.prepare('SELECT relative_path FROM asset_versions WHERE uid=?').pluck().get(bundle.versionUid), bundle.relativePath);
  assert.deepEqual(fs.readFileSync(path.join(storageRoot, ...bundle.relativePath.split('/'))), bundle.bytes);
  assert.equal(fs.existsSync(path.join(storageRoot, '.project-import-staging')), false);
});

test('validates the complete bundle before creating storage or database state', (t) => {
  const database = createCompleteDatabase(t);
  const storageRoot = createStorage(t, 'invalid-before-side-effect');
  const bundle = mediaBundle();
  const files = new Map(bundle.files);
  files.set(bundle.manifest.mediaBindings[0].archive_path, Buffer.from('changed'));

  assert.throws(() => createProjectArchiveV21ImportService().importBundle({
    database, storageRoot, manifest: bundle.manifest, files,
  }), (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID');
  assert.equal(fs.existsSync(storageRoot), false);
  assert.equal(count(database, 'dramas'), 0);
});

test('dry-runs database constraints before creating storage state', (t) => {
  const database = createCompleteDatabase(t);
  const storageRoot = createStorage(t, 'database-preflight');
  const bundle = mediaBundle();
  const records = {
    ...bundle.manifest.records,
    assets: bundle.manifest.records.assets.map((asset) => ({ ...asset, status: 'active' })),
  };
  const manifest = createProjectManifestV21({
    legacyProjectVersion: bundle.manifest.legacyProjectVersion,
    exportedAt: bundle.manifest.exportedAt,
    project: bundle.manifest.project,
    records,
    structuredRecords: bundle.manifest.structuredRecords,
    legacyRecords: bundle.manifest.legacyRecords,
    mediaBindings: bundle.manifest.mediaBindings,
    portableBindings: bundle.manifest.portableBindings,
  });

  assert.throws(() => createProjectArchiveV21ImportService().importBundle({
    database, storageRoot, manifest, files: bundle.files,
  }), (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID');
  assert.equal(fs.existsSync(storageRoot), false);
  assert.equal(count(database, 'dramas'), 0);
});

test('rolls back database rows and staged media when exact target installation fails', (t) => {
  const database = createCompleteDatabase(t);
  const storageRoot = createStorage(t, 'media-conflict');
  const bundle = mediaBundle();
  const target = path.join(storageRoot, ...bundle.relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'existing');

  assert.throws(() => createProjectArchiveV21ImportService().importBundle({
    database, storageRoot, manifest: bundle.manifest, files: bundle.files,
  }), (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID');
  assert.equal(count(database, 'dramas'), 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing');
  assert.equal(fs.existsSync(path.join(storageRoot, '.project-import-staging')), false);
});

for (const drift of [
  {
    name: 'same-size staged content drift',
    factory: mediaMutationFactory({
      afterWrite(storageRoot) {
        const filename = onlyStagedFile(storageRoot);
        fs.writeFileSync(filename, Buffer.alloc(fs.statSync(filename).size, 0x78));
      },
    }),
  },
  {
    name: 'staged size drift',
    factory: mediaMutationFactory({
      afterWrite(storageRoot) {
        fs.appendFileSync(onlyStagedFile(storageRoot), Buffer.from('x'));
      },
    }),
  },
  {
    name: 'installed content drift before commit',
    factory: mediaMutationFactory({
      afterPromote(storageRoot) {
        const target = path.join(storageRoot, ...mediaBundle().relativePath.split('/'));
        fs.writeFileSync(target, Buffer.alloc(fs.statSync(target).size, 0x79));
      },
    }),
  },
]) {
  test(`rejects ${drift.name} and rolls both domains back`, (t) => {
    const database = createCompleteDatabase(t);
    const storageRoot = createStorage(t, `media-${drift.name.replaceAll(' ', '-')}`);
    const bundle = mediaBundle();
    const service = createProjectArchiveV21ImportService({ mediaStagingFactory: drift.factory });

    assert.throws(() => service.importBundle({
      database, storageRoot, manifest: bundle.manifest, files: bundle.files,
    }), (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID');
    assert.equal(count(database, 'dramas'), 0);
    assert.equal(fs.existsSync(path.join(storageRoot, ...bundle.relativePath.split('/'))), false);
    assert.equal(fs.existsSync(path.join(storageRoot, '.project-import-staging')), false);
  });
}

test('rejects a same-inode mutation of an already-read region during final commit verification', (t) => {
  const database = createCompleteDatabase(t);
  const storageRoot = createStorage(t, 'media-read-window-drift');
  const bundle = mediaBundle(Buffer.alloc(128 * 1024, 0x41));
  const service = createProjectArchiveV21ImportService({
    mediaStagingFactory(root) {
      const media = createProjectImportMediaStaging(root);
      return Object.freeze({
        writeExact: media.writeExact,
        promote: media.promote,
        assertCommitReady() {
          const originalReadSync = fs.readSync;
          let readCount = 0;
          fs.readSync = function readSyncWithMutation(...args) {
            readCount += 1;
            if (readCount === 2) {
              const target = path.join(root, ...bundle.relativePath.split('/'));
              const handle = fs.openSync(target, 'r+');
              try {
                fs.writeSync(handle, Buffer.from([0x42]), 0, 1, 0);
                fs.fsyncSync(handle);
              } finally {
                fs.closeSync(handle);
              }
            }
            return Reflect.apply(originalReadSync, fs, args);
          };
          try {
            media.assertCommitReady();
          } finally {
            fs.readSync = originalReadSync;
          }
        },
        rollback: media.rollback,
        complete: media.complete,
      });
    },
  });

  assert.throws(() => service.importBundle({
    database, storageRoot, manifest: bundle.manifest, files: bundle.files,
  }), (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID');
  assert.equal(count(database, 'dramas'), 0);
  assert.equal(fs.existsSync(path.join(storageRoot, ...bundle.relativePath.split('/'))), false);
  assert.equal(fs.existsSync(path.join(storageRoot, '.project-import-staging')), false);
  assert.deepEqual(fs.existsSync(storageRoot) ? fs.readdirSync(storageRoot) : [], []);
});

test('removes promoted media when a deferred database commit fails and restores triggers', (t) => {
  const database = createCompleteDatabase(t);
  const storageRoot = createStorage(t, 'commit-failure');
  const bundle = mediaBundle();
  database.exec(`
    CREATE TABLE synthetic_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE synthetic_child(
      parent_id INTEGER REFERENCES synthetic_parent(id) DEFERRABLE INITIALLY DEFERRED
    );
  `);
  const baseFactory = require('../src/repositories/v2/projectArchiveV21ImportRepository')
    .createProjectArchiveV21ImportRepository;
  const service = createProjectArchiveV21ImportService({
    repositoryFactory(db) {
      const repository = baseFactory(db);
      return Object.freeze({
        assertImportable: repository.assertImportable,
        importManifest: repository.importManifest,
        assertCommitReady(manifest) {
          repository.assertCommitReady(manifest);
          db.prepare('INSERT INTO synthetic_child(parent_id) VALUES (1)').run();
        },
      });
    },
  });
  const triggerCount = database.prepare("SELECT count(*) FROM sqlite_schema WHERE type='trigger'").pluck().get();

  assert.throws(() => service.importBundle({
    database, storageRoot, manifest: bundle.manifest, files: bundle.files,
  }), (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID');
  assert.equal(count(database, 'dramas'), 0);
  assert.equal(fs.existsSync(path.join(storageRoot, ...bundle.relativePath.split('/'))), false);
  assert.equal(fs.existsSync(path.join(storageRoot, '.project-import-staging')), false);
  assert.equal(database.prepare("SELECT count(*) FROM sqlite_schema WHERE type='trigger'").pluck().get(), triggerCount);
});

test('persists portable bindings without Vault data and keeps imported voice profiles non-executable', (t) => {
  const source = seedVoiceSource(t);
  const database = createCompleteDatabase(t);
  const storageRoot = createStorage(t, 'portable-voice');
  const result = createProjectArchiveV21ImportService().importBundle({
    database,
    storageRoot,
    manifest: source.manifest,
    files: new Map(),
  });

  assert.equal(result.dramaUid, DRAMA_UID);
  const binding = database.prepare(`
    SELECT binding_state,marker_count,portable_value_json
    FROM project_archive_v21_portable_bindings
    WHERE table_name='voice_profiles' AND row_uid=? AND column_name='credential_ref'
  `).get(source.profileUid);
  assert.deepEqual(binding, {
    binding_state: 'needs_rebind',
    marker_count: 1,
    portable_value_json: null,
  });
  assert.equal(count(database, 'voice_profiles'), 1);
  assert.equal(database.prepare('SELECT archive_binding_state FROM voice_profiles WHERE uid=?')
    .pluck().get(source.profileUid), 'needs_rebind');
  assert.throws(
    () => createV2Repositories(database).voiceProfiles.get(source.profileUid),
    (error) => error?.code === 'V2_REPOSITORY_DATA_INVALID' && !JSON.stringify(error).includes('credential:v1'),
  );
  database.exec('DROP TRIGGER v2_project_archive_portable_bindings_immutable_delete');
  database.prepare('DELETE FROM project_archive_v21_portable_bindings WHERE row_uid=?')
    .run(source.profileUid);
  assert.throws(
    () => createV2Repositories(database).voiceProfiles.get(source.profileUid),
    (error) => error?.code === 'V2_REPOSITORY_DATA_INVALID',
  );
});
