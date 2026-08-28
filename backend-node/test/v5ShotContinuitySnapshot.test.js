const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const {
  compareShotContinuitySnapshots,
  createShotContinuitySnapshot,
} = require('../src/assets/shotContinuitySnapshot');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');
const {
  seedContinuityFixture,
  snapshotInput,
} = require('./helpers/v5ContinuityFixtures');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
} = require('../src/repositories/v2');
const shotContinuitySnapshotRoutes = require('../src/routes/v2/shotContinuitySnapshots');

const snapshotSchema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../schemas/v5/shot-continuity-snapshot.schema.json'),
  'utf8',
));
const comparisonSchema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../schemas/v5/shot-continuity-comparison.schema.json'),
  'utf8',
));

function snapshotValue(ordinal = 1) {
  return {
    schemaVersion: '5.0',
    snapshotUid: uid(18000 + ordinal),
    dramaUid: uid(18000),
    shotResultUid: uid(18010),
    shotResultHash: '1'.repeat(64),
    shotEnvelopeHash: '2'.repeat(64),
    shotApprovalRef: `review:v1:${uid(18011)}`,
    shotId: `shot-${ordinal}`,
    shotOrdinal: ordinal,
    scene: {
      sceneUid: uid(18020),
      versionUid: uid(18021),
      name: 'Courtyard',
      visualDescription: 'Stone courtyard after rain.',
      lighting: 'Cool dawn light.',
      colorAnchors: ['#334455'],
    },
    characters: [{
      factRef: 'character-hero',
      characterUid: uid(18030),
      referencePackageUid: uid(18031),
      identityVersionUid: uid(18032),
      costumeVersionUid: uid(18033),
    }],
    props: [{
      factRef: 'prop-sword',
      propUid: uid(18040),
      versionUid: uid(18041),
      name: 'Sword',
      visualDescription: 'Weathered steel sword.',
      colorAnchors: ['#778899'],
    }],
    createdAtEpochMs: 0,
  };
}

test('migration eight installs append-only shot continuity snapshot tables', (t) => {
  const database = createMigratedV2Database(t);
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'shot_continuity_%'
    ORDER BY name
  `).pluck().all();
  assert.deepEqual(tables, [
    'shot_continuity_character_refs',
    'shot_continuity_prop_refs',
    'shot_continuity_snapshots',
  ]);
});

test('continuity snapshot contract freezes concrete versions and compares adjacent shots', () => {
  const first = createShotContinuitySnapshot(snapshotValue(1));
  const second = createShotContinuitySnapshot({
    ...snapshotValue(2),
    shotResultUid: first.shotResultUid,
    shotResultHash: first.shotResultHash,
    shotEnvelopeHash: first.shotEnvelopeHash,
    shotApprovalRef: first.shotApprovalRef,
    characters: snapshotValue(2).characters.map((entry) => ({
      ...entry,
      characterUid: first.characters[0].characterUid,
      identityVersionUid: first.characters[0].identityVersionUid,
      referencePackageUid: first.characters[0].referencePackageUid,
      costumeVersionUid: uid(18034),
    })),
  });
  const comparison = compareShotContinuitySnapshots(first, second);
  assert.equal(comparison.adjacent, true);
  assert.equal(comparison.scene.changed, false);
  assert.deepEqual(comparison.characters.changed, [{
    characterUid: first.characters[0].characterUid,
    fields: ['costumeVersionUid'],
  }]);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.characters));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  assert.equal(ajv.compile(snapshotSchema)(first), true);
  assert.equal(ajv.compile(comparisonSchema)(comparison), true);

  assert.throws(
    () => compareShotContinuitySnapshots(second, first),
    /Shot continuity snapshot input is invalid/,
  );
  assert.throws(
    () => createShotContinuitySnapshot({
      ...snapshotValue(1),
      characters: [snapshotValue(1).characters[0], snapshotValue(1).characters[0]],
    }),
    /Shot continuity snapshot input is invalid/,
  );
});

test('approved shots append immutable continuity snapshots and compare adjacent concrete versions', (t) => {
  const fixture = seedContinuityFixture(t);
  const firstInput = snapshotInput(fixture, 1, 18500);
  const secondInput = snapshotInput(fixture, 2, 18501);
  const first = fixture.repositories.shotContinuitySnapshots.create(firstInput);
  const second = fixture.repositories.shotContinuitySnapshots.create(secondInput);

  assert.equal(first.scene.versionUid, fixture.sceneVersion.uid);
  assert.equal(first.characters[0].identityVersionUid, fixture.character.identity.uid);
  assert.equal(first.characters[0].costumeVersionUid, fixture.character.costume.uid);
  assert.equal(first.props[0].versionUid, fixture.propVersion.uid);
  assert.deepEqual(
    fixture.repositories.shotContinuitySnapshots.list(fixture.shot.resultUid)
      .map((snapshot) => snapshot.snapshotUid),
    [first.snapshotUid, second.snapshotUid],
  );
  const comparison = fixture.repositories.shotContinuitySnapshots.compare(
    first.snapshotUid,
    second.snapshotUid,
  );
  assert.equal(comparison.adjacent, true);
  assert.deepEqual(comparison.characters.unchanged, [fixture.characterUid]);
  assert.deepEqual(comparison.props.unchanged, [fixture.propUid]);

  fixture.repositories.characterCandidates.unlock({
    eventUid: uid(18510),
    characterUid: fixture.characterUid,
    candidateUid: fixture.character.packageRecord.candidateUid,
    identityVersionUid: fixture.character.identity.uid,
    expectedStateVersion: fixture.character.lock.stateVersion,
    changedAtEpochMs: 3,
  });
  assert.equal(
    fixture.repositories.shotContinuitySnapshots.get(first.snapshotUid).snapshotUid,
    first.snapshotUid,
  );

  const extraction = fixture.database.prepare(`
    SELECT uid, result_hash, envelope_hash FROM narrative_results
    WHERE drama_uid = ? AND result_type = 'extraction'
  `).get(fixture.dramaUid);
  const newReviewUid = uid(18511);
  fixture.database.prepare(`
    INSERT INTO narrative_review_events
      (uid, result_uid, decision, result_hash, envelope_hash, comment)
    VALUES (?, ?, 'approve', ?, ?, NULL)
  `).run(newReviewUid, extraction.uid, extraction.result_hash, extraction.envelope_hash);
  fixture.database.prepare(`
    UPDATE narrative_results SET status = 'approved', current_review_uid = ? WHERE uid = ?
  `).run(newReviewUid, extraction.uid);
  assert.equal(
    fixture.repositories.shotContinuitySnapshots.get(first.snapshotUid).snapshotUid,
    first.snapshotUid,
  );
  assert.throws(
    () => fixture.repositories.shotContinuitySnapshots.create({
      ...secondInput,
      snapshotUid: uid(18512),
    }),
    V2RepositoryConflictError,
  );

  assert.throws(
    () => fixture.repositories.shotContinuitySnapshots.create(firstInput),
    V2RepositoryConflictError,
  );
  assert.throws(() => fixture.database.prepare(`
    UPDATE shot_continuity_snapshots SET created_at_epoch_ms = 9 WHERE uid = ?
  `).run(first.snapshotUid));
  assert.throws(() => fixture.database.prepare(`
    DELETE FROM shot_continuity_character_refs WHERE snapshot_uid = ?
  `).run(first.snapshotUid));
});

test('continuity snapshot repository rejects an invalid complete approval chain without writes', (t) => {
  const fixture = seedContinuityFixture(t);
  fixture.database.exec('DROP TRIGGER v2_narrative_results_immutable_payload');
  fixture.database.prepare(`
    UPDATE narrative_results SET result_json = ?
    WHERE drama_uid = ? AND result_type = 'extraction'
  `).run(JSON.stringify({ output: { invalid: true } }), fixture.dramaUid);

  assert.throws(
    () => fixture.repositories.shotContinuitySnapshots.create(
      snapshotInput(fixture, 1, 18520),
    ),
    V2RepositoryDataError,
  );
  assert.equal(
    fixture.database.prepare('SELECT count(*) FROM shot_continuity_snapshots').pluck().get(),
    0,
  );
  assert.equal(
    fixture.database.prepare('SELECT count(*) FROM shot_continuity_character_refs').pluck().get(),
    0,
  );
  assert.equal(
    fixture.database.prepare('SELECT count(*) FROM shot_continuity_prop_refs').pluck().get(),
    0,
  );
});

test('continuity snapshots fail closed for unlocked, cross-project, missing, and drifted versions', (t) => {
  const fixture = seedContinuityFixture(t);
  const base = snapshotInput(fixture, 1, 18600);

  fixture.repositories.characterCandidates.unlock({
    eventUid: uid(18601),
    characterUid: fixture.characterUid,
    candidateUid: fixture.character.packageRecord.candidateUid,
    identityVersionUid: fixture.character.identity.uid,
    expectedStateVersion: fixture.character.lock.stateVersion,
    changedAtEpochMs: 2,
  });
  assert.throws(
    () => fixture.repositories.shotContinuitySnapshots.create(base),
    V2RepositoryConflictError,
  );

  const second = seedContinuityFixture(t);
  insertDrama(second.database, uid(18610), 'Other drama');
  second.database.prepare(`
    INSERT INTO scenes (id, drama_id, location, time) VALUES (2, 2, 'Other', 'Night')
  `).run();
  const otherSceneUid = second.database.prepare('SELECT uid FROM scenes WHERE id = 2').pluck().get();
  const otherSceneVersion = second.repositories.scenePropVersions.create({
    schemaVersion: '5.0',
    kind: 'scene',
    uid: uid(18611),
    sceneUid: otherSceneUid,
    parentUid: null,
    state: 'ready',
    metadata: {
      name: 'Other scene',
      visualDescription: 'A scene owned by another drama.',
      lighting: 'Night light.',
      colorAnchors: ['#112233'],
    },
    createdAtEpochMs: 0,
  });
  assert.throws(
    () => second.repositories.shotContinuitySnapshots.create({
      ...snapshotInput(second, 1, 18602),
      scene: { sceneUid: otherSceneUid, versionUid: otherSceneVersion.uid },
    }),
    V2RepositoryConflictError,
  );

  const third = seedContinuityFixture(t);
  const stored = third.repositories.shotContinuitySnapshots.create(snapshotInput(third, 1, 18603));
  third.database.exec('DROP TRIGGER v2_scene_versions_immutable_update');
  third.database.prepare(`
    UPDATE scene_versions SET metadata_json = ? WHERE uid = ?
  `).run(JSON.stringify({
    name: 'Changed courtyard',
    visualDescription: 'Changed evidence after bypass.',
    lighting: 'Changed light.',
    colorAnchors: ['#112233'],
  }), third.sceneVersion.uid);
  assert.throws(
    () => third.repositories.shotContinuitySnapshots.get(stored.snapshotUid),
    V2RepositoryDataError,
  );

  const fourth = seedContinuityFixture(t);
  const hashBound = fourth.repositories.shotContinuitySnapshots.create(
    snapshotInput(fourth, 1, 18604),
  );
  fourth.database.exec('DROP TRIGGER v2_narrative_results_immutable_payload');
  fourth.database.prepare(`
    UPDATE narrative_results SET result_json = ? WHERE uid = ?
  `).run(JSON.stringify({
    output: {
      shots: [{
        shotId: 'shot-1',
        ordinal: 1,
        characterFactRefs: ['character-hero'],
        propFactRefs: ['prop-sword'],
        changed: true,
      }],
    },
  }), fourth.shot.resultUid);
  assert.throws(
    () => fourth.repositories.shotContinuitySnapshots.get(hashBound.snapshotUid),
    V2RepositoryDataError,
  );
});

test('localhost continuity routes expose fixed DTOs and fixed non-leaking errors', async (t) => {
  const fixture = seedContinuityFixture(t);
  const source = snapshotInput(fixture, 1, 18700);
  const app = express();
  app.use(express.json());
  app.use(shotContinuitySnapshotRoutes(null, {
    createSnapshotUid: () => source.snapshotUid,
    nowEpochMs: () => source.createdAtEpochMs,
    getApprovedShot: () => Object.freeze({
      dramaUid: source.dramaUid,
      shotResultUid: source.shotResultUid,
      shotResultHash: source.shotResultHash,
      shotEnvelopeHash: source.shotEnvelopeHash,
      shotApprovalRef: source.shotApprovalRef,
      shotId: source.shotId,
      shotOrdinal: source.shotOrdinal,
    }),
  }, fixture.database));
  const server = await new Promise((resolve) => {
    const active = app.listen(0, '127.0.0.1', () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const body = {
    scene: { scene_uid: source.scene.sceneUid, version_uid: source.scene.versionUid },
    characters: source.characters.map((entry) => ({
      fact_ref: entry.factRef,
      character_uid: entry.characterUid,
      reference_package_uid: entry.referencePackageUid,
      costume_version_uid: entry.costumeVersionUid,
    })),
    props: source.props.map((entry) => ({
      fact_ref: entry.factRef,
      prop_uid: entry.propUid,
      version_uid: entry.versionUid,
    })),
  };
  const createdResponse = await fetch(
    `${origin}/narrative-results/${source.shotResultUid}/shots/${source.shotId}/continuity-snapshots`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).data;
  assert.equal(created.snapshotUid, source.snapshotUid);
  assert.doesNotMatch(JSON.stringify(created), /metadataJson|storage|relativePath|secret/i);

  const listResponse = await fetch(
    `${origin}/narrative-results/${source.shotResultUid}/continuity-snapshots`,
  );
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json()).data.length, 1);

  const sentinel = 'SYNTHETIC_PRIVATE_SENTINEL';
  const invalidResponse = await fetch(
    `${origin}/narrative-results/${source.shotResultUid}/shots/${source.shotId}/continuity-snapshots`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, [sentinel]: sentinel }),
    },
  );
  const invalidText = await invalidResponse.text();
  assert.equal(invalidResponse.status, 400);
  assert.doesNotMatch(invalidText, new RegExp(sentinel));
  assert.match(invalidText, /SHOT_CONTINUITY_INPUT_INVALID/);
});
