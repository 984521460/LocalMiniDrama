const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const {
  CHARACTER_REFERENCE_ITEM_KINDS,
  createCharacterReferencePackage,
} = require('../src/assets/characterReferencePackage');
const { createCharacterCandidateBatch } = require('../src/assets/characterCandidateBatch');
const {
  createV2Repositories,
  V2RepositoryConflictError,
  V2RepositoryDataError,
} = require('../src/repositories/v2');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

function sha(value) {
  return value.toString(16).padStart(64, '0');
}

function seedCharacter(database) {
  insertDrama(database, uid(15000), 'Reference package drama');
  database.prepare("INSERT INTO characters (id, drama_id, name) VALUES (1, 1, 'Hero')").run();
  return database.prepare('SELECT uid FROM characters WHERE id = 1').pluck().get();
}

function addImageAsset(
  repositories,
  characterUid,
  assetIndex,
  logicalUri,
  relativePath,
  assetType = 'character_reference',
) {
  const assetUid = uid(assetIndex);
  const assetVersionUid = uid(assetIndex + 1);
  repositories.assets.create({
    uid: assetUid,
    ownerType: 'character',
    ownerUid: characterUid,
    assetType,
    status: 'draft',
  });
  repositories.assets.addVersion({
    uid: assetVersionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri,
    relativePath,
    sha256: sha(assetIndex),
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    durationMs: null,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  return assetVersionUid;
}

function appendCandidateBatch(repositories, characterUid, batchUid, offset) {
  const request = {
    schemaVersion: '5.0',
    batchUid,
    characterUid,
    promptSemanticUid: uid(15010),
    profileUid: uid(15011),
    manifestUid: uid(15012),
    width: 1024,
    height: 1024,
    seed: 42,
    candidateCount: 4,
  };
  const candidates = Array.from({ length: 4 }, (_, ordinal) => {
    const logicalUri = `asset://characters/${characterUid}/candidate-batches/${batchUid}/${ordinal}`;
    return {
      uid: uid(offset + ordinal * 3 + 2),
      ordinal,
      assetVersionUid: addImageAsset(
        repositories,
        characterUid,
        offset + ordinal * 3,
        logicalUri,
        `characters/${characterUid}/candidates/${batchUid}/${ordinal}.png`,
        'character_candidate',
      ),
      logicalUri,
      mediaType: 'image/png',
      width: 1024,
      height: 1024,
      contentSha256: sha(offset + ordinal * 3),
      presentation: 'single_portrait',
    };
  });
  const batch = createCharacterCandidateBatch(request, { candidates });
  repositories.characterCandidates.appendBatch(batch);
  return batch;
}

function seedLockedIdentity(repositories, characterUid, offset = 15100) {
  const batch = appendCandidateBatch(repositories, characterUid, uid(offset), offset + 10);
  const identity = repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'identity',
    uid: uid(offset + 30),
    characterUid,
    parentUid: null,
    metadata: {
      name: 'Hero identity',
      visualSignature: 'oval face, straight dark hair, amber eyes',
      colorAnchors: ['#1f2937', '#d6a77a'],
    },
    createdAtEpochMs: 0,
  });
  const appearance = repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'appearance',
    uid: uid(offset + 31),
    characterUid,
    identityVersionUid: identity.uid,
    parentUid: null,
    metadata: {
      name: 'Default appearance',
      description: 'Oval face, straight dark hair, amber eyes, athletic build.',
      colorAnchors: ['#1f2937', '#d6a77a', '#7c2d12'],
    },
    createdAtEpochMs: 0,
  });
  const costume = repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'costume',
    uid: uid(offset + 32),
    characterUid,
    identityVersionUid: identity.uid,
    parentUid: null,
    metadata: {
      name: 'Default costume',
      description: 'Charcoal jacket, cream shirt, dark trousers.',
      colorAnchors: ['#232323', '#f5f0df'],
    },
    createdAtEpochMs: 0,
  });
  const lock = repositories.characterCandidates.lock({
    eventUid: uid(offset + 33),
    characterUid,
    candidateUid: batch.candidates[0].uid,
    identityVersionUid: identity.uid,
    expectedStateVersion: 0,
    changedAtEpochMs: 0,
  });
  return { appearance, batch, costume, identity, lock };
}

function createPackageInput(repositories, characterUid, fixture, packageIndex, assetOffset) {
  const packageUid = uid(packageIndex);
  const items = CHARACTER_REFERENCE_ITEM_KINDS.map((kind, ordinal) => ({
    uid: uid(assetOffset + ordinal * 3 + 2),
    ordinal,
    kind,
    assetVersionUid: addImageAsset(
      repositories,
      characterUid,
      assetOffset + ordinal * 3,
      `asset://characters/${characterUid}/reference-packages/${packageUid}/${kind}`,
      `characters/${characterUid}/reference-packages/${packageUid}/${kind}.png`,
    ),
  }));
  return {
    packageUid,
    characterUid,
    appearanceVersionUid: fixture.appearance.uid,
    costumeVersionUid: fixture.costume.uid,
    expectedLockStateVersion: fixture.lock.stateVersion,
    createdAtEpochMs: packageIndex,
    items,
  };
}

test('migration eight installs append-only character reference package tables', (t) => {
  const database = createMigratedV2Database(t);
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'character_reference_packages', 'character_reference_package_items'
    ) ORDER BY name
  `).pluck().all();
  assert.deepEqual(tables, [
    'character_reference_package_items',
    'character_reference_packages',
  ]);
});

test('reference package contract requires every planned view, expression, and concrete asset version', () => {
  const characterUid = uid(15000);
  const packageUid = uid(15200);
  const value = {
    schemaVersion: '5.0',
    packageUid,
    characterUid,
    identityVersionUid: uid(15130),
    candidateUid: uid(15112),
    lockEventUid: uid(15133),
    lockStateVersion: 1,
    appearanceVersion: {
      uid: uid(15131),
      name: 'Default appearance',
      description: 'Structured appearance description.',
      colorAnchors: ['#112233'],
    },
    defaultCostumeVersion: {
      uid: uid(15132),
      name: 'Default costume',
      description: 'Structured costume description.',
      colorAnchors: ['#445566'],
    },
    items: CHARACTER_REFERENCE_ITEM_KINDS.map((kind, ordinal) => ({
      uid: uid(15300 + ordinal),
      ordinal,
      kind,
      assetVersionUid: uid(15400 + ordinal),
      logicalUri: `asset://characters/${characterUid}/reference-packages/${packageUid}/${kind}`,
      mediaType: 'image/png',
      width: 1024,
      height: 1024,
      contentSha256: sha(ordinal + 1),
    })),
    createdAtEpochMs: 0,
  };
  const record = createCharacterReferencePackage(value);
  assert.deepEqual(record.items.map((item) => item.kind), CHARACTER_REFERENCE_ITEM_KINDS);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.items));
  assert.throws(() => createCharacterReferencePackage({
    ...value,
    items: value.items.slice(0, -1),
  }), /Character reference package input is invalid/);
  assert.throws(() => createCharacterReferencePackage({
    ...value,
    items: value.items.map((item, index) => index === 1 ? { ...item, kind: value.items[0].kind } : item),
  }), /Character reference package input is invalid/);
});

test('locked identity reference packages append without overwriting prior packages', (t) => {
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  const repositories = createV2Repositories(database);
  const fixture = seedLockedIdentity(repositories, characterUid);
  const firstInput = createPackageInput(repositories, characterUid, fixture, 15200, 15300);
  const secondInput = createPackageInput(repositories, characterUid, fixture, 15201, 15400);

  const first = repositories.characterReferencePackages.create(firstInput);
  const second = repositories.characterReferencePackages.create(secondInput);
  assert.equal(first.items.length, 10);
  assert.equal(first.identityVersionUid, fixture.identity.uid);
  assert.deepEqual(first.appearanceVersion.colorAnchors, fixture.appearance.metadata.colorAnchors);
  assert.equal(first.defaultCostumeVersion.uid, fixture.costume.uid);
  assert.doesNotMatch(
    JSON.stringify(first),
    /storageProvider|relativePath|assetCreatedAt|assetUpdatedAt|parentUid/,
  );
  assert.deepEqual(
    repositories.characterReferencePackages.list(characterUid).map((item) => item.packageUid),
    [first.packageUid, second.packageUid],
  );
  assert.throws(() => repositories.characterReferencePackages.create(firstInput), V2RepositoryConflictError);
  assert.equal(repositories.characterReferencePackages.get(first.packageUid).packageUid, first.packageUid);
});

test('reference packages fail closed for incomplete state and freeze package media evidence', (t) => {
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  const repositories = createV2Repositories(database);
  const fixture = seedLockedIdentity(repositories, characterUid);
  const input = createPackageInput(repositories, characterUid, fixture, 15500, 15600);
  const packageRecord = repositories.characterReferencePackages.create(input);
  const firstVersionUid = packageRecord.items[0].assetVersionUid;
  const firstAssetUid = database.prepare('SELECT asset_uid FROM asset_versions WHERE uid = ?')
    .pluck().get(firstVersionUid);

  assert.throws(() => database.prepare(`
    UPDATE character_reference_packages SET created_at_epoch_ms = 1 WHERE uid = ?
  `).run(packageRecord.packageUid));
  assert.throws(() => database.prepare(`
    DELETE FROM character_reference_package_items WHERE package_uid = ?
  `).run(packageRecord.packageUid));
  assert.throws(() => database.prepare(`
    UPDATE asset_versions SET relative_path = 'relocated/reference.png' WHERE uid = ?
  `).run(firstVersionUid));
  assert.throws(() => database.prepare(`
    UPDATE assets SET status = 'archived' WHERE uid = ?
  `).run(firstAssetUid));

  database.exec('DROP TRIGGER v2_character_reference_asset_versions_frozen');
  database.prepare(`UPDATE asset_versions SET relative_path = 'relocated/reference.png' WHERE uid = ?`)
    .run(firstVersionUid);
  assert.throws(
    () => repositories.characterReferencePackages.get(packageRecord.packageUid),
    V2RepositoryDataError,
  );
});

test('unlocked or cross-owner reference inputs fail before any package evidence commits', (t) => {
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  database.prepare("INSERT INTO characters (id, drama_id, name) VALUES (2, 1, 'Rival')").run();
  const rivalUid = database.prepare('SELECT uid FROM characters WHERE id = 2').pluck().get();
  const repositories = createV2Repositories(database);
  const fixture = seedLockedIdentity(repositories, characterUid, 16000);
  const unlockedInput = createPackageInput(repositories, characterUid, fixture, 16100, 16200);
  repositories.characterCandidates.unlock({
    eventUid: uid(16034),
    characterUid,
    candidateUid: fixture.batch.candidates[0].uid,
    identityVersionUid: fixture.identity.uid,
    expectedStateVersion: fixture.lock.stateVersion,
    changedAtEpochMs: 1,
  });
  assert.throws(
    () => repositories.characterReferencePackages.create(unlockedInput),
    /Character reference package input is invalid/,
  );
  assert.equal(database.prepare('SELECT count(*) FROM character_reference_packages').pluck().get(), 0);
  assert.equal(database.prepare('SELECT count(*) FROM character_reference_package_items').pluck().get(), 0);

  const relock = repositories.characterCandidates.lock({
    eventUid: uid(16035),
    characterUid,
    candidateUid: fixture.batch.candidates[0].uid,
    identityVersionUid: fixture.identity.uid,
    expectedStateVersion: 2,
    changedAtEpochMs: 2,
  });
  const crossInput = createPackageInput(
    repositories,
    characterUid,
    { ...fixture, lock: relock },
    16400,
    16500,
  );
  const crossKind = crossInput.items[5].kind;
  const crossUri = `asset://characters/${rivalUid}/reference-packages/${crossInput.packageUid}/${crossKind}`;
  const crossAssetVersionUid = addImageAsset(
    repositories,
    rivalUid,
    16600,
    crossUri,
    `characters/${rivalUid}/reference-packages/${crossInput.packageUid}/${crossKind}.png`,
  );
  assert.throws(() => repositories.characterReferencePackages.create({
    ...crossInput,
    items: crossInput.items.map((item, index) => index === 5
      ? { ...item, assetVersionUid: crossAssetVersionUid }
      : item),
  }));
  assert.equal(database.prepare('SELECT count(*) FROM character_reference_packages').pluck().get(), 0);
  assert.equal(database.prepare('SELECT count(*) FROM character_reference_package_items').pluck().get(), 0);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});

test('localhost reference package routes create and list immutable package DTOs', async (t) => {
  const referenceRoutes = require('../src/routes/v2/characterReferencePackages');
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  const repositories = createV2Repositories(database);
  const fixture = seedLockedIdentity(repositories, characterUid);
  const source = createPackageInput(repositories, characterUid, fixture, 15700, 15800);
  const itemUids = source.items.map((item) => item.uid);
  let itemIndex = 0;
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use(referenceRoutes(null, {
    createPackageUid: () => source.packageUid,
    createItemUid: () => itemUids[itemIndex++],
    nowEpochMs: () => source.createdAtEpochMs,
  }, database));
  const server = await new Promise((resolve) => {
    const active = app.listen(0, '127.0.0.1', () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const body = {
    appearance_version_uid: source.appearanceVersionUid,
    costume_version_uid: source.costumeVersionUid,
    expected_lock_state_version: source.expectedLockStateVersion,
    items: source.items.map((item) => ({
      kind: item.kind,
      asset_version_uid: item.assetVersionUid,
    })),
  };

  const createdResponse = await fetch(`${origin}/characters/${characterUid}/reference-packages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).data;
  assert.equal(created.packageUid, source.packageUid);
  assert.equal(created.items.length, 10);

  const listResponse = await fetch(`${origin}/characters/${characterUid}/reference-packages`);
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()).data;
  assert.deepEqual(listed.map((item) => item.packageUid), [source.packageUid]);
});

test('reference package JSON Schema matches the strict runtime record', () => {
  const schemaPath = path.resolve(__dirname, '../../schemas/v5/character-reference-package.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const characterUid = uid(15000);
  const packageUid = uid(15900);
  const record = createCharacterReferencePackage({
    schemaVersion: '5.0',
    packageUid,
    characterUid,
    identityVersionUid: uid(15901),
    candidateUid: uid(15902),
    lockEventUid: uid(15903),
    lockStateVersion: 1,
    appearanceVersion: {
      uid: uid(15904), name: 'Appearance', description: 'Description', colorAnchors: ['#112233'],
    },
    defaultCostumeVersion: {
      uid: uid(15905), name: 'Costume', description: 'Description', colorAnchors: ['#445566'],
    },
    items: CHARACTER_REFERENCE_ITEM_KINDS.map((kind, ordinal) => ({
      uid: uid(15910 + ordinal),
      ordinal,
      kind,
      assetVersionUid: uid(15930 + ordinal),
      logicalUri: `asset://characters/${characterUid}/reference-packages/${packageUid}/${kind}`,
      mediaType: 'image/png',
      width: 1024,
      height: 1024,
      contentSha256: sha(ordinal + 20),
    })),
    createdAtEpochMs: 0,
  });
  assert.equal(validate(record), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...record, items: record.items.slice(1) }), false);
});
