const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const { createV2Repositories, V2RepositoryConflictError } = require('../src/repositories/v2');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

const schemaPath = path.join(
  __dirname,
  '..',
  '..',
  'schemas',
  'v5',
  'character-version.schema.json',
);

function seedCharacters(database) {
  insertDrama(database, uid(10000));
  database.prepare("INSERT INTO characters (id, drama_id, name) VALUES (1, 1, 'Hero')").run();
  database.prepare("INSERT INTO characters (id, drama_id, name) VALUES (2, 1, 'Rival')").run();
  return {
    heroUid: database.prepare('SELECT uid FROM characters WHERE id = 1').pluck().get(),
    rivalUid: database.prepare('SELECT uid FROM characters WHERE id = 2').pluck().get(),
  };
}

function record(kind, index, characterUid, identityVersionUid, metadata, parentUid = null) {
  return {
    schemaVersion: '5.0',
    kind,
    uid: uid(index),
    characterUid,
    ...(kind === 'identity' ? {} : { identityVersionUid }),
    parentUid,
    metadata,
  };
}

test('migration eight creates four append-only character version layers', (t) => {
  const database = createMigratedV2Database(t);
  const names = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'character_%_versions'
    ORDER BY name
  `).pluck().all();
  assert.deepEqual(names, [
    'character_appearance_versions',
    'character_costume_versions',
    'character_identity_versions',
    'character_voice_versions',
  ]);
  assert.equal(
    database.prepare('SELECT max(version) FROM schema_migrations').pluck().get(),
    29,
  );
});

test('repository keeps identity, appearance, costume, and voice as exact immutable versions', (t) => {
  const database = createMigratedV2Database(t);
  const { heroUid } = seedCharacters(database);
  const versions = createV2Repositories(database).characterVersions;
  const identity = versions.create(record(
    'identity',
    10001,
    heroUid,
    null,
    {
      name: 'Hero identity v1',
      visualSignature: 'oval face and calm gaze',
      colorAnchors: ['#5b3a29', '#d4a574'],
    },
  ));
  const appearance = versions.create(record(
    'appearance',
    10002,
    heroUid,
    identity.uid,
    {
      name: 'Default appearance',
      description: 'short dark hair, no makeup',
      colorAnchors: ['#1f1b18'],
    },
  ));
  const costume = versions.create(record(
    'costume',
    10003,
    heroUid,
    identity.uid,
    {
      name: 'Street clothes',
      description: 'dark jacket and neutral shirt',
      colorAnchors: ['#20242a', '#d7d0c5'],
    },
  ));
  const voice = versions.create(record(
    'voice',
    10004,
    heroUid,
    identity.uid,
    { name: 'Mandarin calm', language: 'zh-CN', style: 'calm and restrained' },
  ));

  assert.deepEqual(versions.get('identity', identity.uid), identity);
  assert.deepEqual(versions.list('appearance', heroUid), [appearance]);
  assert.deepEqual(versions.list('costume', heroUid), [costume]);
  assert.deepEqual(versions.list('voice', heroUid), [voice]);
  assert.ok(Object.isFrozen(identity));
  assert.ok(Object.isFrozen(identity.metadata));

  assert.throws(
    () => database.prepare(`
      UPDATE character_identity_versions SET metadata_json = '{}' WHERE uid = ?
    `).run(identity.uid),
  );
  assert.throws(
    () => database.prepare('DELETE FROM character_costume_versions WHERE uid = ?').run(costume.uid),
  );
  assert.throws(
    () => database.prepare(`
      INSERT OR REPLACE INTO character_identity_versions
        (uid, character_uid, parent_uid, metadata_json)
      VALUES (?, ?, NULL, ?)
    `).run(identity.uid, heroUid, JSON.stringify({ name: 'replacement' })),
  );
});

test('repository preserves caller-provided version time evidence exactly', (t) => {
  const database = createMigratedV2Database(t);
  const { heroUid } = seedCharacters(database);
  const versions = createV2Repositories(database).characterVersions;
  const timestamped = record(
    'identity',
    10005,
    heroUid,
    null,
    {
      name: 'Historical identity',
      visualSignature: 'stable imported identity',
      colorAnchors: ['#223344'],
    },
  );
  timestamped.createdAtEpochMs = 0;

  const created = versions.create(timestamped);
  assert.equal(created.createdAtEpochMs, 0);
  assert.equal(
    database.prepare('SELECT created_at_epoch_ms FROM character_identity_versions WHERE uid = ?')
      .pluck().get(created.uid),
    0,
  );
});

test('costume changes preserve one character and cross-character references fail atomically', (t) => {
  const database = createMigratedV2Database(t);
  const { heroUid, rivalUid } = seedCharacters(database);
  const versions = createV2Repositories(database).characterVersions;
  const identity = versions.create(record(
    'identity', 10010, heroUid, null,
    { name: 'Hero identity', visualSignature: 'stable face', colorAnchors: ['#443322'] },
  ));
  const first = versions.create(record(
    'costume', 10011, heroUid, identity.uid,
    { name: 'Look A', description: 'first look', colorAnchors: ['#111111'] },
  ));
  const second = versions.create(record(
    'costume', 10012, heroUid, identity.uid,
    { name: 'Look B', description: 'second look', colorAnchors: ['#eeeeee'] },
    first.uid,
  ));

  assert.equal(database.prepare('SELECT count(*) FROM characters').pluck().get(), 2);
  assert.deepEqual(versions.list('costume', heroUid).map((item) => item.uid), [first.uid, second.uid]);
  assert.equal(second.parentUid, first.uid);

  assert.throws(
    () => versions.create(record(
      'appearance', 10013, rivalUid, identity.uid,
      { name: 'Invalid', description: 'cross character', colorAnchors: [] },
    )),
    (error) => error instanceof V2RepositoryConflictError,
  );
  assert.deepEqual(versions.list('appearance', rivalUid), []);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});

test('structural schema and runtime relation validation form the complete public contract', () => {
  const {
    createCharacterVersionRecord,
  } = require('../src/assets/characterVersions');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(schema.title, 'CharacterVersionStructuralRecordV5');
  assert.match(schema.$comment, /runtime relation validation/u);
  const identity = createCharacterVersionRecord(record(
    'identity',
    10020,
    uid(10021),
    null,
    { name: 'Identity', visualSignature: 'stable face', colorAnchors: ['#112233'] },
  ));
  assert.equal(validate(identity), true, JSON.stringify(validate.errors));
  assert.ok(Object.isFrozen(identity));
  assert.ok(Object.isFrozen(identity.metadata.colorAnchors));

  assert.throws(() => createCharacterVersionRecord({ ...identity, unexpected: true }));
  assert.throws(() => createCharacterVersionRecord({
    ...identity,
    kind: 'costume',
    identityVersionUid: undefined,
  }));
  const malformed = structuredClone(identity);
  malformed.metadata.colorAnchors = ['brown'];
  assert.equal(validate(malformed), false);

  const unicodeBoundary = createCharacterVersionRecord(record(
    'identity',
    10022,
    uid(10023),
    null,
    { name: '😀'.repeat(120), visualSignature: 'stable face', colorAnchors: [] },
  ));
  assert.equal(validate(unicodeBoundary), true, JSON.stringify(validate.errors));
  assert.throws(() => createCharacterVersionRecord(record(
    'identity',
    10024,
    uid(10025),
    null,
    { name: '😀'.repeat(121), visualSignature: 'stable face', colorAnchors: [] },
  )));

  const selfParent = structuredClone(identity);
  selfParent.parentUid = selfParent.uid;
  assert.equal(validate(selfParent), true, JSON.stringify(validate.errors));
  assert.throws(() => createCharacterVersionRecord(selfParent), /Character version input is invalid/);
});

test('database rejects malformed metadata before immutable rows can be created', (t) => {
  const database = createMigratedV2Database(t);
  const { heroUid } = seedCharacters(database);
  const versions = createV2Repositories(database).characterVersions;
  const identity = versions.create(record(
    'identity', 10040, heroUid, null,
    { name: 'Identity', visualSignature: 'stable face', colorAnchors: ['#112233'] },
  ));

  const identityInsert = database.prepare(`
    INSERT INTO character_identity_versions
      (uid, character_uid, parent_uid, metadata_json)
    VALUES (?, ?, NULL, ?)
  `);
  const childInserts = Object.fromEntries(['appearance', 'costume', 'voice'].map((kind) => [
    kind,
    database.prepare(`
      INSERT INTO character_${kind}_versions
        (uid, character_uid, identity_version_uid, parent_uid, metadata_json)
      VALUES (?, ?, ?, NULL, ?)
    `),
  ]));
  const invalidIdentity = [
    {},
    { name: 'Identity', visualSignature: 'stable face', colorAnchors: [], extra: true },
    { name: 7, visualSignature: 'stable face', colorAnchors: [] },
    { name: 'x'.repeat(121), visualSignature: 'stable face', colorAnchors: [] },
    { name: 'Identity', visualSignature: 'stable face', colorAnchors: ['#ABCDEF'] },
    { name: '\u00a0Identity', visualSignature: 'stable face', colorAnchors: [] },
    { name: 'Identity', visualSignature: 'stable\0face', colorAnchors: [] },
    { name: 'Identity', visualSignature: 'stable face', colorAnchors: ['#112233', '#112233'] },
    { name: 'Identity', visualSignature: 'stable face', colorAnchors: Array.from({ length: 17 }, (_, index) => `#${index.toString(16).padStart(6, '0')}`) },
  ];
  const invalidVisual = [
    {},
    { name: 'Look', description: 'bounded', colorAnchors: [], extra: true },
    { name: 'Look', description: false, colorAnchors: [] },
    { name: 'Look', description: 'x'.repeat(4001), colorAnchors: [] },
    { name: 'Look', description: 'bounded', colorAnchors: ['not-a-color'] },
    { name: 'Look', description: 'bounded\u3000', colorAnchors: [] },
  ];
  const invalidVoice = [
    {},
    { name: 'Voice', language: 'zh-CN', style: 'calm', extra: true },
    { name: 'Voice', language: 7, style: 'calm' },
    { name: 'Voice', language: 'zh-cn', style: 'calm' },
    { name: 'Voice', language: 'zh-CN', style: 'x'.repeat(1001) },
    { name: 'Voice', language: 'zh-CN', style: '\ufeffcalm' },
  ];

  let nextUid = 10041;
  for (const metadata of invalidIdentity) {
    assert.throws(() => identityInsert.run(uid(nextUid++), heroUid, JSON.stringify(metadata)));
  }
  for (const kind of ['appearance', 'costume']) {
    for (const metadata of invalidVisual) {
      assert.throws(() => childInserts[kind].run(
        uid(nextUid++), heroUid, identity.uid, JSON.stringify(metadata),
      ));
    }
  }
  for (const metadata of invalidVoice) {
    assert.throws(() => childInserts.voice.run(
      uid(nextUid++), heroUid, identity.uid, JSON.stringify(metadata),
    ));
  }
  assert.equal(database.prepare(`
    SELECT
      (SELECT count(*) FROM character_identity_versions)
      + (SELECT count(*) FROM character_appearance_versions)
      + (SELECT count(*) FROM character_costume_versions)
      + (SELECT count(*) FROM character_voice_versions)
  `).pluck().get(), 1);
});

test('runtime boundary never invokes accessors and persisted metadata drift fails closed', (t) => {
  const { createCharacterVersionRecord } = require('../src/assets/characterVersions');
  let reads = 0;
  const hostileMetadata = {};
  Object.defineProperty(hostileMetadata, 'name', {
    enumerable: true,
    get() {
      reads += 1;
      return 'leaked';
    },
  });
  Object.defineProperty(hostileMetadata, 'visualSignature', {
    enumerable: true,
    value: 'stable face',
  });
  Object.defineProperty(hostileMetadata, 'colorAnchors', {
    enumerable: true,
    value: ['#112233'],
  });
  assert.throws(() => createCharacterVersionRecord(record(
    'identity', 10030, uid(10031), null, hostileMetadata,
  )), /Character version input is invalid/);
  assert.equal(reads, 0);

  const hostileColors = ['#112233'];
  Object.defineProperty(hostileColors, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return '#445566';
    },
  });
  assert.throws(() => createCharacterVersionRecord(record(
    'identity', 10032, uid(10033), null,
    { name: 'Identity', visualSignature: 'stable face', colorAnchors: hostileColors },
  )), /Character version input is invalid/);
  assert.equal(reads, 0);

  const database = createMigratedV2Database(t);
  const { heroUid } = seedCharacters(database);
  const versions = createV2Repositories(database).characterVersions;
  const identity = versions.create(record(
    'identity', 10034, heroUid, null,
    { name: 'Identity', visualSignature: 'stable face', colorAnchors: ['#112233'] },
  ));
  database.exec('DROP TRIGGER v2_character_identity_versions_immutable_update');
  database.prepare(`
    UPDATE character_identity_versions SET metadata_json = '{"name":"incomplete"}' WHERE uid = ?
  `).run(identity.uid);
  assert.throws(
    () => versions.get('identity', identity.uid),
    (error) => error.code === 'V2_REPOSITORY_DATA_INVALID',
  );
});
