const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const {
  V2RepositoryConflictError,
  V2RepositoryNotFoundError,
  createV2Repositories,
} = require('../src/repositories/v2');
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
  'scene-prop-version.schema.json',
);

function seedOwners(database) {
  insertDrama(database, uid(11000));
  database.prepare("INSERT INTO scenes (id, drama_id, location) VALUES (1, 1, 'Rooftop')").run();
  database.prepare("INSERT INTO scenes (id, drama_id, location) VALUES (2, 1, 'Alley')").run();
  database.prepare("INSERT INTO props (id, drama_id, name) VALUES (1, 1, 'Umbrella')").run();
  database.prepare("INSERT INTO props (id, drama_id, name) VALUES (2, 1, 'Letter')").run();
  return {
    sceneUid: database.prepare('SELECT uid FROM scenes WHERE id = 1').pluck().get(),
    otherSceneUid: database.prepare('SELECT uid FROM scenes WHERE id = 2').pluck().get(),
    propUid: database.prepare('SELECT uid FROM props WHERE id = 1').pluck().get(),
    otherPropUid: database.prepare('SELECT uid FROM props WHERE id = 2').pluck().get(),
  };
}

function version(kind, index, ownerUid, metadata, {
  parentUid = null,
  state = 'ready',
  createdAtEpochMs,
} = {}) {
  return {
    schemaVersion: '5.0',
    kind,
    uid: uid(index),
    ...(kind === 'scene' ? { sceneUid: ownerUid } : { propUid: ownerUid }),
    parentUid,
    state,
    metadata,
    ...(createdAtEpochMs === undefined ? {} : { createdAtEpochMs }),
  };
}

const sceneMetadata = Object.freeze({
  name: 'Rainy rooftop',
  visualDescription: 'wet concrete, distant skyline, restrained practical details',
  lighting: 'cool dusk backlight with warm doorway spill',
  colorAnchors: ['#334455', '#d08a52'],
});

const propMetadata = Object.freeze({
  name: 'Black umbrella',
  visualDescription: 'matte black canopy with a worn wooden handle',
  colorAnchors: ['#17191c', '#6f4c35'],
});

test('migration eight creates append-only scene and prop version tables', (t) => {
  const database = createMigratedV2Database(t);
  assert.deepEqual(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('scene_versions', 'prop_versions')
    ORDER BY name
  `).pluck().all(), ['prop_versions', 'scene_versions']);
  assert.equal(database.prepare('SELECT max(version) FROM schema_migrations').pluck().get(), 27);
});

test('repository appends owner-bound scene and prop versions and resolves only ready references', (t) => {
  const database = createMigratedV2Database(t);
  const owners = seedOwners(database);
  const versions = createV2Repositories(database).scenePropVersions;
  const firstScene = versions.create(version('scene', 11001, owners.sceneUid, sceneMetadata, {
    createdAtEpochMs: 0,
  }));
  const nextScene = versions.create(version('scene', 11002, owners.sceneUid, {
    ...sceneMetadata,
    name: 'Rainy rooftop after impact',
  }, { parentUid: firstScene.uid }));
  const draftProp = versions.create(version('prop', 11003, owners.propUid, propMetadata, {
    state: 'draft',
  }));
  const retiredProp = versions.create(version('prop', 11004, owners.propUid, {
    ...propMetadata,
    name: 'Retired umbrella',
  }, { state: 'retired' }));

  assert.equal(firstScene.createdAtEpochMs, 0);
  assert.deepEqual(versions.list('scene', owners.sceneUid).map((item) => item.uid), [
    firstScene.uid,
    nextScene.uid,
  ]);
  assert.deepEqual(
    versions.requireReferenceable('scene', nextScene.uid, owners.sceneUid),
    nextScene,
  );
  assert.throws(
    () => versions.requireReferenceable('prop', draftProp.uid, owners.propUid),
    (error) => error instanceof V2RepositoryConflictError,
  );
  assert.throws(
    () => versions.requireReferenceable('prop', retiredProp.uid, owners.propUid),
    (error) => error instanceof V2RepositoryConflictError,
  );
  assert.throws(
    () => versions.requireReferenceable('scene', nextScene.uid, owners.otherSceneUid),
    (error) => error instanceof V2RepositoryConflictError,
  );
  assert.throws(
    () => versions.requireReferenceable('scene', uid(11999), owners.sceneUid),
    (error) => error instanceof V2RepositoryNotFoundError,
  );
});

test('scene and prop version runtime records match the structural schema and reject hostile input', () => {
  const { createScenePropVersionRecord } = require('../src/assets/scenePropVersions');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const scene = createScenePropVersionRecord(version(
    'scene', 11010, uid(11011), sceneMetadata,
  ));
  const prop = createScenePropVersionRecord(version(
    'prop', 11012, uid(11013), propMetadata,
  ));
  assert.equal(validate(scene), true, JSON.stringify(validate.errors));
  assert.equal(validate(prop), true, JSON.stringify(validate.errors));
  assert.ok(Object.isFrozen(scene));
  assert.ok(Object.isFrozen(scene.metadata));
  assert.ok(Object.isFrozen(scene.metadata.colorAnchors));

  assert.throws(() => createScenePropVersionRecord({ ...scene, propUid: uid(11014) }));
  assert.throws(() => createScenePropVersionRecord({ ...prop, state: 'locked' }));
  const selfParent = structuredClone(scene);
  selfParent.parentUid = selfParent.uid;
  assert.equal(validate(selfParent), true, JSON.stringify(validate.errors));
  assert.throws(() => createScenePropVersionRecord(selfParent));

  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'name', {
    enumerable: true,
    get() {
      reads += 1;
      return 'unsafe';
    },
  });
  Object.defineProperties(hostile, {
    visualDescription: { enumerable: true, value: 'bounded' },
    colorAnchors: { enumerable: true, value: [] },
  });
  assert.throws(() => createScenePropVersionRecord(version(
    'prop', 11015, uid(11016), hostile,
  )));
  assert.equal(reads, 0);

  const sparseColors = new Array(1);
  assert.throws(() => createScenePropVersionRecord(version(
    'prop', 11017, uid(11018), { ...propMetadata, colorAnchors: sparseColors },
  )));
  const hostileColors = ['#112233'];
  Object.defineProperty(hostileColors, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return '#445566';
    },
  });
  assert.throws(() => createScenePropVersionRecord(version(
    'prop', 11019, uid(11020), { ...propMetadata, colorAnchors: hostileColors },
  )));
  assert.equal(reads, 0);
});

test('database rejects invalid ownership, metadata, replacement, mutation, and deletion atomically', (t) => {
  const database = createMigratedV2Database(t);
  const owners = seedOwners(database);
  const versions = createV2Repositories(database).scenePropVersions;
  const scene = versions.create(version('scene', 11020, owners.sceneUid, sceneMetadata));
  const prop = versions.create(version('prop', 11021, owners.propUid, propMetadata));

  assert.throws(() => versions.create(version(
    'scene', 11022, owners.otherSceneUid, sceneMetadata, { parentUid: scene.uid },
  )), (error) => error instanceof V2RepositoryConflictError);
  assert.throws(() => versions.create(version(
    'prop', 11023, owners.otherPropUid, propMetadata, { parentUid: prop.uid },
  )), (error) => error instanceof V2RepositoryConflictError);

  assert.throws(() => database.prepare(`
    INSERT INTO scene_versions (uid, scene_uid, parent_uid, state, metadata_json)
    VALUES (?, ?, NULL, 'ready', '{}')
  `).run(uid(11024), owners.sceneUid));
  assert.throws(() => database.prepare(`
    INSERT INTO prop_versions (uid, prop_uid, parent_uid, state, metadata_json)
    VALUES (?, ?, NULL, 'ready', ?)
  `).run(uid(11025), owners.propUid, JSON.stringify({
    ...propMetadata,
    colorAnchors: ['#ABCDEF'],
  })));
  assert.throws(() => database.prepare(`
    INSERT OR REPLACE INTO scene_versions
      (uid, scene_uid, parent_uid, state, metadata_json)
    VALUES (?, ?, NULL, 'ready', ?)
  `).run(scene.uid, owners.sceneUid, JSON.stringify(sceneMetadata)));
  assert.throws(() => database.prepare(
    "UPDATE scene_versions SET state = 'retired' WHERE uid = ?",
  ).run(scene.uid));
  assert.throws(() => database.prepare('DELETE FROM prop_versions WHERE uid = ?').run(prop.uid));
  assert.equal(database.prepare('SELECT count(*) FROM scene_versions').pluck().get(), 1);
  assert.equal(database.prepare('SELECT count(*) FROM prop_versions').pluck().get(), 1);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});

test('database enforces exact bounded metadata and timestamp evidence for both kinds', (t) => {
  const database = createMigratedV2Database(t);
  const owners = seedOwners(database);
  const versions = createV2Repositories(database).scenePropVersions;
  const maximum = versions.create(version('scene', 11030, owners.sceneUid, {
    name: '😀'.repeat(120),
    visualDescription: 'x'.repeat(4000),
    lighting: 'y'.repeat(1000),
    colorAnchors: Array.from({ length: 16 }, (_, index) => `#${index.toString(16).padStart(6, '0')}`),
  }, { createdAtEpochMs: 253402300799999 }));
  assert.equal(maximum.createdAtEpochMs, 253402300799999);

  const sceneInsert = database.prepare(`
    INSERT INTO scene_versions
      (uid, scene_uid, parent_uid, state, metadata_json)
    VALUES (?, ?, NULL, 'ready', ?)
  `);
  const propInsert = database.prepare(`
    INSERT INTO prop_versions
      (uid, prop_uid, parent_uid, state, metadata_json)
    VALUES (?, ?, NULL, 'ready', ?)
  `);
  const invalidScenes = [
    {},
    { ...sceneMetadata, extra: true },
    { ...sceneMetadata, name: 7 },
    { ...sceneMetadata, name: '😀'.repeat(121) },
    { ...sceneMetadata, name: '\u00a0bounded' },
    { ...sceneMetadata, visualDescription: 'bad\0value' },
    { ...sceneMetadata, visualDescription: 'x'.repeat(4001) },
    { ...sceneMetadata, lighting: 'x'.repeat(1001) },
    { ...sceneMetadata, colorAnchors: ['#ABCDEF'] },
    { ...sceneMetadata, colorAnchors: ['#112233', '#112233'] },
    { ...sceneMetadata, colorAnchors: Array.from({ length: 17 }, (_, index) => `#${index.toString(16).padStart(6, '0')}`) },
  ];
  const invalidProps = [
    {},
    { ...propMetadata, extra: true },
    { ...propMetadata, visualDescription: false },
    { ...propMetadata, visualDescription: 'bounded\u3000' },
    { ...propMetadata, colorAnchors: ['not-a-color'] },
    { ...propMetadata, name: 'x'.repeat(33000) },
  ];
  let index = 11031;
  for (const metadata of invalidScenes) {
    assert.throws(() => sceneInsert.run(uid(index++), owners.sceneUid, JSON.stringify(metadata)));
  }
  for (const metadata of invalidProps) {
    assert.throws(() => propInsert.run(uid(index++), owners.propUid, JSON.stringify(metadata)));
  }
  assert.equal(database.prepare('SELECT count(*) FROM scene_versions').pluck().get(), 1);
  assert.equal(database.prepare('SELECT count(*) FROM prop_versions').pluck().get(), 0);
});

test('all SQLite conflict policies preserve append-only version identity', (t) => {
  const database = createMigratedV2Database(t);
  const owners = seedOwners(database);
  const versions = createV2Repositories(database).scenePropVersions;
  const scene = versions.create(version('scene', 11060, owners.sceneUid, sceneMetadata));
  const metadataJson = JSON.stringify(sceneMetadata);
  const insertPrefixes = ['INSERT', 'INSERT OR IGNORE', 'INSERT OR FAIL', 'INSERT OR REPLACE'];
  for (const prefix of insertPrefixes) {
    assert.throws(() => database.prepare(`
      ${prefix} INTO scene_versions
        (uid, scene_uid, parent_uid, state, metadata_json)
      VALUES (?, ?, NULL, 'ready', ?)
    `).run(scene.uid, owners.sceneUid, metadataJson));
  }
  assert.throws(() => database.prepare(`
    INSERT INTO scene_versions (uid, scene_uid, parent_uid, state, metadata_json)
    VALUES (?, ?, NULL, 'ready', ?)
    ON CONFLICT(uid) DO UPDATE SET state = 'retired'
  `).run(scene.uid, owners.sceneUid, metadataJson));

  for (const policy of ['', 'OR IGNORE', 'OR FAIL', 'OR REPLACE']) {
    assert.throws(() => database.prepare(
      `UPDATE ${policy} scene_versions SET state = 'retired' WHERE uid = ?`,
    ).run(scene.uid));
  }
  assert.throws(() => database.prepare('DELETE FROM scene_versions WHERE uid = ?').run(scene.uid));
  assert.equal(database.prepare('SELECT state FROM scene_versions WHERE uid = ?').pluck().get(scene.uid), 'ready');
  assert.equal(database.prepare('SELECT count(*) FROM scene_versions').pluck().get(), 1);
});

test('persisted scene or prop drift fails closed with a fixed repository error', (t) => {
  const database = createMigratedV2Database(t);
  const owners = seedOwners(database);
  const versions = createV2Repositories(database).scenePropVersions;
  const prop = versions.create(version('prop', 11070, owners.propUid, propMetadata));
  database.exec('DROP TRIGGER v2_prop_versions_immutable_update');
  database.prepare("UPDATE prop_versions SET metadata_json = '{}' WHERE uid = ?").run(prop.uid);
  assert.throws(
    () => versions.get('prop', prop.uid),
    (error) => error.code === 'V2_REPOSITORY_DATA_INVALID'
      && !error.message.includes(prop.uid),
  );
});
