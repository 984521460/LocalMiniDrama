const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');

const {
  createShotVersionBindingService,
} = require('../src/continuity/shotVersionBindingService');
const shotContinuitySnapshotRoutes = require('../src/routes/v2/shotContinuitySnapshots');
const {
  V2RepositoryConflictError,
} = require('../src/repositories/v2');
const { seedContinuityFixture } = require('./helpers/v5ContinuityFixtures');
const { uid } = require('./helpers/v2RepositoryDatabase');

function createService(fixture, start = 39000) {
  let nextUid = start;
  return createShotVersionBindingService({
    database: fixture.database,
    repositories: fixture.repositories,
    createUid: () => uid(nextUid++),
    nowEpochMs: () => 1000,
  });
}

function tableCount(database, table) {
  return database.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
}

test('approved shot chain materializes every concrete version atomically and idempotently', (t) => {
  const fixture = seedContinuityFixture(t, null, {
    factMatchedEntities: true,
    createScenePropVersions: false,
  });
  const service = createService(fixture);

  const first = service.materialize(fixture.shot.resultUid);
  assert.equal(first.length, fixture.shot.result.output.shots.length);
  assert.equal(tableCount(fixture.database, 'scene_versions'), 1);
  assert.equal(tableCount(fixture.database, 'prop_versions'), 1);
  assert.equal(tableCount(fixture.database, 'shot_continuity_snapshots'), first.length);
  assert.equal(first[0].scene.name, '客栈');
  assert.equal(first[0].scene.visualDescription, '雨夜的客栈');
  assert.equal(first[0].characters[0].characterUid,
    fixture.factCharacters['character-zhao-yun'].characterUid);
  assert.equal(first[1].characters[0].characterUid,
    fixture.factCharacters['character-innkeeper'].characterUid);
  assert.equal(first[0].props[0].propUid, fixture.propUid);
  assert.equal(first[2].characters.length, 0);
  assert.equal(first[2].props.length, 0);

  const second = service.materialize(fixture.shot.resultUid);
  assert.deepEqual(second, first);
  assert.equal(tableCount(fixture.database, 'scene_versions'), 1);
  assert.equal(tableCount(fixture.database, 'prop_versions'), 1);
  assert.equal(tableCount(fixture.database, 'shot_continuity_snapshots'), first.length);
  assert.deepEqual(fixture.repositories.shotContinuitySnapshots.list(fixture.shot.resultUid), first);
});

test('latest ready versions are selected while ambiguous owners roll back all writes', (t) => {
  const readyFixture = seedContinuityFixture(t, null, { factMatchedEntities: true });
  const latestScene = readyFixture.repositories.scenePropVersions.create({
    schemaVersion: '5.0',
    kind: 'scene',
    uid: uid(39100),
    sceneUid: readyFixture.sceneUid,
    parentUid: readyFixture.sceneVersion.uid,
    state: 'ready',
    metadata: {
      name: '客栈夜景',
      visualDescription: '更新后的雨夜客栈视觉版本。',
      lighting: '微弱灯笼与冷色雨光。',
      colorAnchors: ['#223344'],
    },
    createdAtEpochMs: 10,
  });
  const selected = createService(readyFixture, 39200).materialize(readyFixture.shot.resultUid);
  assert.ok(selected.every((snapshot) => snapshot.scene.versionUid === latestScene.uid));

  const ambiguous = seedContinuityFixture(t, null, {
    factMatchedEntities: true,
    createScenePropVersions: false,
  });
  ambiguous.database.prepare("INSERT INTO characters (id, drama_id, name) VALUES (3, 1, '赵云')")
    .run();
  assert.throws(
    () => createService(ambiguous, 39300).materialize(ambiguous.shot.resultUid),
    V2RepositoryConflictError,
  );
  assert.equal(tableCount(ambiguous.database, 'scene_versions'), 0);
  assert.equal(tableCount(ambiguous.database, 'prop_versions'), 0);
  assert.equal(tableCount(ambiguous.database, 'shot_continuity_snapshots'), 0);
});

test('partial immutable snapshot sets fail closed without appending more state', (t) => {
  const fixture = seedContinuityFixture(t, null, { factMatchedEntities: true });
  const planned = fixture.shot.result.output.shots[0];
  const zhao = fixture.factCharacters['character-zhao-yun'];
  fixture.repositories.shotContinuitySnapshots.create({
    snapshotUid: uid(39400),
    dramaUid: fixture.dramaUid,
    shotResultUid: fixture.shot.resultUid,
    shotResultHash: fixture.shot.resultHash,
    shotEnvelopeHash: fixture.shot.envelopeHash,
    shotApprovalRef: `review:v1:${fixture.shot.reviewUid}`,
    shotId: planned.shotId,
    shotOrdinal: planned.ordinal,
    scene: { sceneUid: fixture.sceneUid, versionUid: fixture.sceneVersion.uid },
    characters: [{
      factRef: planned.characterFactRefs[0],
      characterUid: zhao.characterUid,
      referencePackageUid: zhao.reference.packageRecord.packageUid,
      costumeVersionUid: zhao.reference.costume.uid,
    }],
    props: [{
      factRef: planned.propFactRefs[0],
      propUid: fixture.propUid,
      versionUid: fixture.propVersion.uid,
    }],
    createdAtEpochMs: 1,
  });

  assert.throws(
    () => createService(fixture, 39500).materialize(fixture.shot.resultUid),
    V2RepositoryConflictError,
  );
  assert.equal(tableCount(fixture.database, 'shot_continuity_snapshots'), 1);
});

test('a current character lock drift rolls back newly derived scene and prop versions', (t) => {
  const fixture = seedContinuityFixture(t, null, {
    factMatchedEntities: true,
    createScenePropVersions: false,
  });
  const innkeeper = fixture.factCharacters['character-innkeeper'];
  fixture.repositories.characterCandidates.unlock({
    eventUid: uid(39550),
    characterUid: innkeeper.characterUid,
    candidateUid: innkeeper.reference.packageRecord.candidateUid,
    identityVersionUid: innkeeper.reference.identity.uid,
    expectedStateVersion: innkeeper.reference.lock.stateVersion,
    changedAtEpochMs: 2,
  });

  assert.throws(
    () => createService(fixture, 39560).materialize(fixture.shot.resultUid),
    V2RepositoryConflictError,
  );
  assert.equal(tableCount(fixture.database, 'scene_versions'), 0);
  assert.equal(tableCount(fixture.database, 'prop_versions'), 0);
  assert.equal(tableCount(fixture.database, 'shot_continuity_snapshots'), 0);
});

test('localhost materialize route accepts only an empty request and returns reopenable snapshots', async (t) => {
  const fixture = seedContinuityFixture(t, null, {
    factMatchedEntities: true,
    createScenePropVersions: false,
  });
  let nextUid = 39600;
  const app = express();
  app.use(express.json());
  app.use(shotContinuitySnapshotRoutes(null, {
    createBindingUid: () => uid(nextUid++),
    nowEpochMs: () => 1000,
  }, fixture.database));
  const server = await new Promise((resolve) => {
    const active = app.listen(0, '127.0.0.1', () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`
    + `/narrative-results/${fixture.shot.resultUid}/continuity-snapshots/materialize`;

  const createdResponse = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(createdResponse.status, 200);
  const created = (await createdResponse.json()).data;
  assert.equal(created.length, fixture.shot.result.output.shots.length);

  const invalidResponse = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unsupported: true }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.match(await invalidResponse.text(), /SHOT_CONTINUITY_INPUT_INVALID/);
  assert.equal(tableCount(fixture.database, 'shot_continuity_snapshots'), created.length);
});
