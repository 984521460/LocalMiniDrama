const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const {
  assertBgmLicenseExportEligible,
  createBgmLicense,
} = require('../src/audio/bgmLicense');
const {
  createLocalBgmProvider,
} = require('../src/audio/localBgmProvider');
const {
  assertBgmTrackExportReady,
  createBgmTrack,
  parseBgmTrack,
} = require('../src/audio/bgmTrack');
const { LocalStorageProvider } = require('../src/adapters/v2/storage');
const {
  createV2Repositories,
  V2RepositoryDataError,
} = require('../src/repositories/v2');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

const DRAMA_UID = uid(85000);

function createLicense(overrides = {}) {
  return {
    schemaVersion: 'bgm-license.v1',
    uid: uid(85001),
    basis: 'licensed',
    attestationKind: 'user-attestation',
    commercialUseAllowed: true,
    derivativesAllowed: true,
    attributionRequired: false,
    attributionText: null,
    attestedAtEpochMs: 100,
    ...overrides,
  };
}

function createTempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-bgm-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(child) : [child];
  });
}

function importRequest(overrides = {}) {
  return {
    uid: uid(85003),
    dramaUid: DRAMA_UID,
    assetUid: uid(85004),
    assetVersionUid: uid(85005),
    title: 'Opening theme',
    license: createLicense(),
    bytes: Buffer.from('ID3\x04\x00\x00synthetic-audio-fixture'),
    createdAtEpochMs: 101,
    ...overrides,
  };
}

function createProvider(t, database, overrides = {}) {
  const projectRoot = createTempDirectory(t);
  const storageProvider = new LocalStorageProvider({ projectRoot });
  const repositories = createV2Repositories(database);
  const provider = createLocalBgmProvider({
    storageProvider,
    repositories,
    inspectAudio() {
      return Object.freeze({ mimeType: 'audio/mpeg', durationMs: 60_000 });
    },
    ...overrides,
  });
  return { projectRoot, provider, repositories, storageProvider };
}

test('migration thirteen installs immutable BGM license evidence and public schemas match runtime', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'BGM contract drama');
  assert.equal(database.prepare('SELECT max(version) FROM schema_migrations').pluck().get(), 14);
  assert.equal(database.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='bgm_tracks'").pluck().get(), 1);
  assert.equal(database.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='bgm_licenses'").pluck().get(), 1);
  assert.throws(() => database.transaction(() => database.prepare(`
    INSERT INTO bgm_licenses (
      uid,track_uid,schema_version,basis,attestation_kind,commercial_use_allowed,
      derivatives_allowed,attribution_required,attribution_text,attested_at_epoch_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    uid(85990), uid(85991), 'bgm-license.v1', 'licensed', 'user-attestation',
    1, 1, 0, null, 100,
  ))());
  assert.equal(database.prepare('SELECT count(*) FROM bgm_licenses').pluck().get(), 0);

  const { provider } = createProvider(t, database);
  const track = await provider.importTrack(importRequest());
  assert.equal(database.prepare('SELECT count(*) FROM bgm_licenses').pluck().get(), 1);
  const license = createBgmLicense(createLicense());
  assert.deepEqual(assertBgmLicenseExportEligible(license), license);
  assert.deepEqual(parseBgmTrack(JSON.parse(JSON.stringify(track))), track);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const licenseSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../schemas/v8/bgm-license.schema.json'), 'utf8'));
  const trackSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../schemas/v8/bgm-track.schema.json'), 'utf8'));
  const validateLicense = ajv.compile(licenseSchema);
  const validateTrack = ajv.compile(trackSchema);
  assert.equal(validateLicense(license), true);
  assert.equal(validateTrack(track), true);
  assert.equal(validateLicense({ ...license, attestationKind: 'provider-verified' }), false);
  assert.equal(validateTrack({
    ...track,
    assetVersion: { ...track.assetVersion, relativePath: track.assetVersion.relativePath.replace(/\.mp3$/u, '.wav') },
  }), false);
  assert.equal(validateTrack({ ...track, title: 'C:\\Users\\private\\track.mp3' }), false);
});

test('local BgmProvider imports bytes through a locator and binds exact ready AssetVersion evidence', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'BGM import drama');
  const { provider, repositories, storageProvider } = createProvider(t, database);
  const request = importRequest();
  const track = await provider.importTrack(request);

  assert.equal(track.sourceKind, 'local-import');
  assert.equal(track.providerId, 'local-library');
  assert.equal(track.assetVersion.assetUid, request.assetUid);
  assert.equal(track.assetVersion.mimeType, 'audio/mpeg');
  assert.equal(track.assetVersion.durationMs, 60_000);
  assert.equal(track.assetVersion.logicalUri, `asset://dramas/${DRAMA_UID}/bgm/${request.assetUid}/${request.assetVersionUid}`);
  assert.match(track.assetVersion.relativePath, /^projects\/[0-9a-f-]+\/assets\/bgm\/[0-9a-f-]+\/[0-9a-f-]+\.mp3$/u);
  assert.equal((await storageProvider.read({
    storageProvider: track.assetVersion.storageProvider,
    logicalUri: track.assetVersion.logicalUri,
    relativePath: track.assetVersion.relativePath,
  })).equals(request.bytes), true);
  assert.deepEqual(repositories.bgmTracks.get(track.uid), track);
  assert.deepEqual(repositories.bgmTracks.listByDrama(DRAMA_UID), [track]);
  assert.equal(JSON.stringify(track.license).includes('projects/'), false);
  assert.equal(JSON.stringify(track.license).includes('\\'), false);
  assert.ok(Object.isFrozen(track));
  assert.ok(Object.isFrozen(track.assetVersion));
  assert.ok(Object.isFrozen(track.license));
});

test('BGM licenses without export rights, evidence, or safe attribution fail closed', () => {
  assert.throws(() => assertBgmLicenseExportEligible(createBgmLicense(createLicense({
    commercialUseAllowed: false,
  }))));
  assert.throws(() => createBgmLicense(createLicense({ attestationKind: 'provider-verified' })));
  assert.throws(() => createBgmLicense(createLicense({
    attributionRequired: true,
    attributionText: 'C:\\Users\\private\\license.txt',
  })));
  assert.throws(() => createBgmLicense(createLicense({
    attributionRequired: true,
    attributionText: 'Bearer synthetic-secret-token',
  })));
});

test('BGM persistence rejects replacement and revalidates live media evidence after trigger loss', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'BGM persistence drama');
  const { provider, repositories } = createProvider(t, database);
  const track = await provider.importTrack(importRequest());

  assert.throws(() => database.prepare('UPDATE bgm_tracks SET title=? WHERE uid=?').run('Changed', track.uid));
  assert.throws(() => database.prepare('DELETE FROM bgm_tracks WHERE uid=?').run(track.uid));
  assert.throws(() => database.prepare(`
    INSERT OR REPLACE INTO bgm_tracks SELECT * FROM bgm_tracks WHERE uid=?
  `).run(track.uid));

  database.exec('DROP TRIGGER v2_bgm_asset_versions_frozen');
  database.prepare('UPDATE asset_versions SET sha256=? WHERE uid=?').run('d'.repeat(64), track.assetVersion.uid);
  assert.throws(() => repositories.bgmTracks.get(track.uid), V2RepositoryDataError);
});

test('one license identity is permanently bound to one immutable track', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'BGM license identity drama');
  const { provider, repositories } = createProvider(t, database);
  const first = await provider.importTrack(importRequest());
  await assert.rejects(() => provider.importTrack(importRequest({
    uid: uid(85006),
    assetUid: uid(85007),
    assetVersionUid: uid(85008),
  })));

  await assert.rejects(() => provider.importTrack(importRequest({
    uid: uid(85009),
    assetUid: uid(85010),
    assetVersionUid: uid(85011),
    license: createLicense({ basis: 'public-domain' }),
  })));
  assert.equal(database.prepare('SELECT count(*) FROM bgm_tracks').pluck().get(), 1);
  assert.equal(database.prepare('SELECT count(*) FROM assets').pluck().get(), 1);
  assert.equal(database.prepare('SELECT count(*) FROM bgm_licenses').pluck().get(), 1);
  database.pragma('recursive_triggers = OFF');
  assert.throws(() => database.prepare(`
    INSERT OR REPLACE INTO bgm_licenses SELECT * FROM bgm_licenses WHERE uid=?
  `).run(first.license.uid));
  assert.deepEqual(repositories.bgmTracks.get(first.uid), first);
});

test('a single non-exportable license cannot be promoted by drifting its track snapshot', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'BGM license drift drama');
  const { provider, repositories } = createProvider(t, database);
  const track = await provider.importTrack(importRequest({
    license: createLicense({
      commercialUseAllowed: false,
      derivativesAllowed: false,
    }),
  }));
  assert.throws(() => assertBgmTrackExportReady(track), (error) => (
    error.code === 'BGM_LICENSE_NOT_EXPORTABLE'
  ));

  database.exec('DROP TRIGGER v2_bgm_tracks_immutable_update');
  database.prepare(`
    UPDATE bgm_tracks
    SET commercial_use_allowed=1,derivatives_allowed=1
    WHERE uid=?
  `).run(track.uid);
  assert.throws(() => repositories.bgmTracks.get(track.uid), V2RepositoryDataError);
});

test('a license fact drift is rejected even when its track snapshot remains intact', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'BGM license fact drift drama');
  const { provider, repositories } = createProvider(t, database);
  const track = await provider.importTrack(importRequest({
    license: createLicense({
      commercialUseAllowed: false,
      derivativesAllowed: false,
    }),
  }));

  database.exec('DROP TRIGGER v2_bgm_licenses_immutable_update');
  database.prepare(`
    UPDATE bgm_licenses
    SET commercial_use_allowed=1,derivatives_allowed=1
    WHERE uid=?
  `).run(track.license.uid);
  assert.throws(() => repositories.bgmTracks.get(track.uid), V2RepositoryDataError);
  assert.throws(() => repositories.bgmTracks.listByDrama(DRAMA_UID), V2RepositoryDataError);
});

test('a non-exportable track cannot be rebound to another valid exportable license', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'BGM license binding drama');
  const { provider, repositories } = createProvider(t, database);
  const first = await provider.importTrack(importRequest({
    license: createLicense({
      commercialUseAllowed: false,
      derivativesAllowed: false,
    }),
  }));
  const second = await provider.importTrack(importRequest({
    uid: uid(85012),
    assetUid: uid(85013),
    assetVersionUid: uid(85014),
    license: createLicense({ uid: uid(85015) }),
  }));

  database.exec('DROP TRIGGER v2_bgm_tracks_immutable_update');
  database.prepare(`
    UPDATE bgm_tracks
    SET license_uid=?,license_basis=?,commercial_use_allowed=?,derivatives_allowed=?,
        attribution_required=?,attribution_text=?,license_attested_at_epoch_ms=?
    WHERE uid=?
  `).run(
    second.license.uid,
    second.license.basis,
    Number(second.license.commercialUseAllowed),
    Number(second.license.derivativesAllowed),
    Number(second.license.attributionRequired),
    second.license.attributionText,
    second.license.attestedAtEpochMs,
    first.uid,
  );
  assert.throws(() => repositories.bgmTracks.get(first.uid), V2RepositoryDataError);
});

test('failed persistence cleans the newly written local object without exposing paths', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'BGM cleanup drama');
  const projectRoot = createTempDirectory(t);
  const storageProvider = new LocalStorageProvider({ projectRoot });
  const provider = createLocalBgmProvider({
    storageProvider,
    repositories: Object.freeze({
      withTransaction() {
        throw new Error('synthetic persistence failure with private path');
      },
    }),
    inspectAudio() {
      return Object.freeze({ mimeType: 'audio/mpeg', durationMs: 1_000 });
    },
  });

  let error;
  await provider.importTrack(importRequest()).catch((value) => { error = value; });
  assert.equal(error.code, 'BGM_IMPORT_FAILED');
  assert.equal(error.message.includes(projectRoot), false);
  assert.equal(JSON.stringify(error).includes(projectRoot), false);
  assert.deepEqual(listFiles(projectRoot), []);
});

test('local import rejects absolute-path fields, Proxies, and accessor data before side effects', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, DRAMA_UID, 'BGM hostile input drama');
  let inspectorCalls = 0;
  const { projectRoot, provider } = createProvider(t, database, {
    inspectAudio() {
      inspectorCalls += 1;
      return Object.freeze({ mimeType: 'audio/mpeg', durationMs: 1_000 });
    },
  });

  await assert.rejects(() => provider.importTrack({
    ...importRequest(),
    sourcePath: 'C:\\Users\\private\\track.mp3',
  }));

  let proxyReads = 0;
  const bytes = new Proxy(Buffer.from('ID3fixture'), {
    get() {
      proxyReads += 1;
      throw new Error('proxy sentinel');
    },
  });
  await assert.rejects(() => provider.importTrack(importRequest({ bytes })));

  let titleReads = 0;
  const request = importRequest();
  Object.defineProperty(request, 'title', {
    enumerable: true,
    get() {
      titleReads += 1;
      return 'Hidden title';
    },
  });
  await assert.rejects(() => provider.importTrack(request));

  let requestProxyReads = 0;
  const requestProxy = new Proxy(importRequest(), {
    ownKeys() {
      requestProxyReads += 1;
      throw new Error('request proxy sentinel');
    },
  });
  await assert.rejects(() => provider.importTrack(requestProxy));

  let licenseProxyReads = 0;
  const licenseProxy = new Proxy(createLicense(), {
    ownKeys() {
      licenseProxyReads += 1;
      throw new Error('license proxy sentinel');
    },
  });
  await assert.rejects(() => provider.importTrack(importRequest({ license: licenseProxy })));

  if (typeof SharedArrayBuffer === 'function') {
    await assert.rejects(() => provider.importTrack(importRequest({
      bytes: Buffer.from(new SharedArrayBuffer(16)),
    })));
  }
  assert.equal(proxyReads, 0);
  assert.equal(titleReads, 0);
  assert.equal(requestProxyReads, 0);
  assert.equal(licenseProxyReads, 0);
  assert.equal(inspectorCalls, 0);
  assert.deepEqual(fs.readdirSync(projectRoot), []);
});

test('standalone track creation refuses missing license source and non-audio evidence', () => {
  const evidence = {
    uid: uid(85005),
    assetUid: uid(85004),
    storageProvider: 'local',
    logicalUri: `asset://dramas/${DRAMA_UID}/bgm/${uid(85004)}/${uid(85005)}`,
    relativePath: `projects/${DRAMA_UID}/assets/bgm/${uid(85004)}/${uid(85005)}.mp3`,
    sha256: 'a'.repeat(64),
    mimeType: 'audio/mpeg',
    width: null,
    height: null,
    durationMs: 1_000,
    parentUid: null,
    status: 'ready',
    createdAt: '2026-08-29T00:00:00.000Z',
  };
  const track = createBgmTrack({
    schemaVersion: 'bgm-track.v1',
    uid: uid(85003),
    dramaUid: DRAMA_UID,
    title: 'Fixture track',
    sourceKind: 'local-import',
    providerId: 'local-library',
    assetVersion: evidence,
    license: createLicense(),
    createdAtEpochMs: 101,
  });
  assert.equal(track.assetVersion.sha256, 'a'.repeat(64));
  assert.deepEqual(assertBgmTrackExportReady(track), track);
  assert.throws(() => createBgmTrack({ ...track, license: null }));
  assert.throws(() => assertBgmTrackExportReady({
    ...track,
    license: createLicense({ commercialUseAllowed: false }),
  }));
  assert.throws(() => createBgmTrack({
    ...track,
    assetVersion: { ...evidence, mimeType: 'image/png', durationMs: null, width: 100, height: 100 },
  }));
});
