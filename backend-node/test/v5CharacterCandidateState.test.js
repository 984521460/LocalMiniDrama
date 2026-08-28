const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');

const {
  createV2Repositories,
  V2RepositoryConflictError,
  V2RepositoryDataError,
} = require('../src/repositories/v2');
const { createCharacterCandidateBatch } = require('../src/assets/characterCandidateBatch');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

function sha(value) {
  return value.toString(16).padStart(64, '0');
}

function seedCharacter(database) {
  insertDrama(database, uid(13000));
  database.prepare("INSERT INTO characters (id, drama_id, name) VALUES (1, 1, 'Hero')").run();
  return database.prepare('SELECT uid FROM characters WHERE id = 1').pluck().get();
}

function candidateRequest(batchUid, characterUid, seed = 42) {
  return {
    schemaVersion: '5.0',
    batchUid,
    characterUid,
    promptSemanticUid: uid(13010),
    profileUid: uid(13011),
    manifestUid: uid(13012),
    width: 1024,
    height: 1024,
    seed,
    candidateCount: 4,
  };
}

function persistCandidateAssets(repositories, request, offset) {
  const records = [];
  for (let ordinal = 0; ordinal < 4; ordinal += 1) {
    const assetUid = uid(offset + ordinal * 3);
    const assetVersionUid = uid(offset + ordinal * 3 + 1);
    const candidateUid = uid(offset + ordinal * 3 + 2);
    const logicalUri = `asset://characters/${request.characterUid}/candidate-batches/${request.batchUid}/${ordinal}`;
    repositories.assets.create({
      uid: assetUid,
      ownerType: 'character',
      ownerUid: request.characterUid,
      assetType: 'character_candidate',
      status: 'draft',
    });
    repositories.assets.addVersion({
      uid: assetVersionUid,
      assetUid,
      storageProvider: 'local',
      logicalUri,
      relativePath: `characters/${request.characterUid}/candidates/${request.batchUid}/${ordinal}.png`,
      sha256: sha(offset + ordinal),
      mimeType: 'image/png',
      width: request.width,
      height: request.height,
      durationMs: null,
      parentUid: null,
      status: 'ready',
    }, { makeCurrent: true });
    records.push({
      uid: candidateUid,
      ordinal,
      assetVersionUid,
      logicalUri,
      mediaType: 'image/png',
      width: request.width,
      height: request.height,
      contentSha256: sha(offset + ordinal),
      presentation: 'single_portrait',
    });
  }
  return records;
}

function createPersistableBatch(repositories, characterUid, batchIndex, assetOffset, seed = 42) {
  const request = candidateRequest(uid(batchIndex), characterUid, seed);
  const candidates = persistCandidateAssets(repositories, request, assetOffset);
  return createCharacterCandidateBatch(request, { candidates });
}

function identity(repositories, characterUid, index, parentUid = null) {
  return repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'identity',
    uid: uid(index),
    characterUid,
    parentUid,
    metadata: {
      name: `Identity ${index}`,
      visualSignature: `stable face ${index}`,
      colorAnchors: ['#112233'],
    },
  });
}

test('migration eight installs immutable candidate batches, results, and lock events', (t) => {
  const database = createMigratedV2Database(t);
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'character_candidate_batches',
      'character_candidate_results',
      'character_identity_lock_events'
    ) ORDER BY name
  `).pluck().all();
  assert.deepEqual(tables, [
    'character_candidate_batches',
    'character_candidate_results',
    'character_identity_lock_events',
  ]);
});

test('continuing generation appends complete four-result batches without losing old candidates', (t) => {
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  const repositories = createV2Repositories(database);
  const first = createPersistableBatch(repositories, characterUid, 13020, 13100, 42);
  const second = createPersistableBatch(repositories, characterUid, 13021, 13200, 43);

  assert.deepEqual(repositories.characterCandidates.appendBatch(first), first);
  assert.deepEqual(repositories.characterCandidates.appendBatch(second), second);
  const batches = repositories.characterCandidates.listBatches(characterUid);
  assert.deepEqual(batches.map((batch) => batch.batchUid), [first.batchUid, second.batchUid]);
  assert.deepEqual(batches.map((batch) => batch.candidates.length), [4, 4]);
  assert.equal(new Set(batches.flatMap((batch) => batch.candidates.map((item) => item.uid))).size, 8);
  assert.ok(Object.isFrozen(batches));
  assert.ok(Object.isFrozen(batches[0].candidates));
});

test('candidate batch persistence rejects incomplete, mismatched, replacement, mutation, and deletion', (t) => {
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  const repositories = createV2Repositories(database);
  const batch = createPersistableBatch(repositories, characterUid, 13030, 13300);
  repositories.characterCandidates.appendBatch(batch);

  assert.throws(() => database.prepare(`
    INSERT INTO character_candidate_batches
      (uid, character_uid, request_sha256, created_at_epoch_ms)
    VALUES (?, ?, ?, 0)
  `).run(uid(13031), characterUid, sha(13031)));
  assert.throws(() => database.prepare(`
    UPDATE character_candidate_results SET content_sha256 = ? WHERE uid = ?
  `).run(sha(1), batch.candidates[0].uid));
  assert.throws(() => database.prepare(`
    DELETE FROM character_candidate_batches WHERE uid = ?
  `).run(batch.batchUid));
  assert.throws(() => database.prepare(`
    INSERT OR REPLACE INTO character_candidate_batches
      (uid, character_uid, request_sha256, created_at_epoch_ms)
    VALUES (?, ?, ?, 0)
  `).run(batch.batchUid, characterUid, batch.requestSha256));
  assert.throws(() => database.prepare(`
    UPDATE asset_versions SET logical_uri = logical_uri || '-drift' WHERE uid = ?
  `).run(batch.candidates[0].assetVersionUid));
  const candidateAssetUid = database.prepare(`
    SELECT asset_uid FROM asset_versions WHERE uid = ?
  `).pluck().get(batch.candidates[0].assetVersionUid);
  assert.throws(() => database.prepare(`
    UPDATE assets SET status = 'archived' WHERE uid = ?
  `).run(candidateAssetUid));
  assert.equal(repositories.characterCandidates.listBatches(characterUid).length, 1);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});

test('completed candidate batches freeze every asset and asset-version evidence field', (t) => {
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  const repositories = createV2Repositories(database);
  const batch = createPersistableBatch(repositories, characterUid, 13035, 13350);
  const candidateVersionUid = batch.candidates[0].assetVersionUid;
  const candidateAssetUid = database.prepare(`
    SELECT asset_uid FROM asset_versions WHERE uid = ?
  `).pluck().get(candidateVersionUid);
  const parentVersionUid = uid(13390);

  repositories.assets.addVersion({
    uid: parentVersionUid,
    assetUid: candidateAssetUid,
    storageProvider: 'local',
    logicalUri: `${batch.candidates[0].logicalUri}/parent`,
    relativePath: `characters/${characterUid}/candidates/${batch.batchUid}/parent.png`,
    sha256: sha(13390),
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    durationMs: null,
    parentUid: null,
    status: 'ready',
  });
  repositories.characterCandidates.appendBatch(batch);

  const mutations = [
    ['storage_provider = ?', ['nas']],
    ['relative_path = ?', [`characters/${characterUid}/candidates/${batch.batchUid}/relocated.png`]],
    ['duration_ms = ?', [1]],
    ['parent_uid = ?', [parentVersionUid]],
    ['created_at = ?', ['2000-01-01T00:00:00.000Z']],
  ];
  for (const [assignment, values] of mutations) {
    assert.throws(() => database.prepare(`
      UPDATE asset_versions SET ${assignment} WHERE uid = ?
    `).run(...values, candidateVersionUid));
  }

  assert.throws(() => database.prepare(`
    INSERT INTO asset_versions
      (uid, asset_uid, storage_provider, logical_uri, relative_path, sha256,
       mime_type, width, height, duration_ms, parent_uid, status, created_at)
    SELECT uid, asset_uid, 'nas', logical_uri, relative_path, sha256,
           mime_type, width, height, duration_ms, parent_uid, status, created_at
    FROM asset_versions WHERE uid = ?
    ON CONFLICT(uid) DO UPDATE SET storage_provider = excluded.storage_provider
  `).run(candidateVersionUid));
  assert.throws(() => database.prepare('DELETE FROM asset_versions WHERE uid = ?').run(candidateVersionUid));
  assert.throws(() => database.prepare(`
    UPDATE assets SET updated_at = ? WHERE uid = ?
  `).run('2000-01-01T00:00:00.000Z', candidateAssetUid));
  assert.throws(() => database.prepare('DELETE FROM assets WHERE uid = ?').run(candidateAssetUid));

  assert.equal(repositories.characterCandidates.getBatch(batch.batchUid).batchUid, batch.batchUid);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});

test('candidate batch reads fail closed on storage evidence drift without relying on freeze triggers', (t) => {
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  const repositories = createV2Repositories(database);
  const batch = createPersistableBatch(repositories, characterUid, 13036, 13450);
  const candidateVersionUid = batch.candidates[0].assetVersionUid;
  const originalVersion = database.prepare(`
    SELECT * FROM asset_versions WHERE uid = ?
  `).get(candidateVersionUid);
  const originalAsset = database.prepare('SELECT * FROM assets WHERE uid = ?').get(originalVersion.asset_uid);
  const parentVersionUid = uid(13490);
  const alternateAssetUid = uid(13491);

  repositories.assets.addVersion({
    uid: parentVersionUid,
    assetUid: originalVersion.asset_uid,
    storageProvider: 'local',
    logicalUri: `${batch.candidates[0].logicalUri}/read-parent`,
    relativePath: `characters/${characterUid}/candidates/${batch.batchUid}/read-parent.png`,
    sha256: sha(13490),
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    durationMs: null,
    parentUid: null,
    status: 'ready',
  });
  repositories.assets.create({
    uid: alternateAssetUid,
    ownerType: 'character',
    ownerUid: characterUid,
    assetType: 'character_candidate',
    status: 'draft',
  });
  repositories.characterCandidates.appendBatch(batch);

  database.exec('DROP TRIGGER v2_character_candidate_asset_versions_frozen');
  database.exec('DROP TRIGGER v2_character_candidate_assets_frozen');
  database.exec('DROP TRIGGER v2_asset_versions_immutable_owner');
  const expectDriftRejected = () => {
    assert.throws(
      () => repositories.characterCandidates.getBatch(batch.batchUid),
      V2RepositoryDataError,
    );
    assert.throws(
      () => repositories.characterCandidates.listBatches(characterUid),
      V2RepositoryDataError,
    );
  };
  const versionMutations = [
    ['storage_provider', 'nas'],
    ['relative_path', `characters/${characterUid}/candidates/${batch.batchUid}/bypassed.png`],
    ['duration_ms', 1],
    ['parent_uid', parentVersionUid],
    ['created_at', '2000-01-01T00:00:00.000Z'],
  ];
  for (const [column, value] of versionMutations) {
    database.prepare(`UPDATE asset_versions SET ${column} = ? WHERE uid = ?`)
      .run(value, candidateVersionUid);
    expectDriftRejected();
    database.prepare(`UPDATE asset_versions SET ${column} = ? WHERE uid = ?`)
      .run(originalVersion[column], candidateVersionUid);
  }
  for (const column of ['created_at', 'updated_at']) {
    database.prepare(`UPDATE assets SET ${column} = ? WHERE uid = ?`)
      .run('2000-01-01T00:00:00.000Z', originalAsset.uid);
    expectDriftRejected();
    database.prepare(`UPDATE assets SET ${column} = ? WHERE uid = ?`)
      .run(originalAsset[column], originalAsset.uid);
  }

  database.prepare('UPDATE asset_versions SET asset_uid = ? WHERE uid = ?')
    .run(alternateAssetUid, candidateVersionUid);
  database.prepare(`
    UPDATE assets SET current_version_uid = ?, status = 'ready' WHERE uid = ?
  `).run(candidateVersionUid, alternateAssetUid);
  expectDriftRejected();
  database.prepare(`
    UPDATE assets SET current_version_uid = NULL, status = 'draft' WHERE uid = ?
  `).run(alternateAssetUid);
  database.prepare('UPDATE asset_versions SET asset_uid = ? WHERE uid = ?')
    .run(originalVersion.asset_uid, candidateVersionUid);

  assert.equal(repositories.characterCandidates.getBatch(batch.batchUid).batchUid, batch.batchUid);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});

test('candidate batch sealing rejects noncanonical asset timestamp evidence', async (t) => {
  const cases = [
    ['version created time', 'asset_versions', 'created_at', 'XXXXXXXXXXXXXXXXXXXX'],
    ['asset created time', 'assets', 'created_at', 'XXXXXXXXXXXXXXXXXXXX'],
    ['asset updated time', 'assets', 'updated_at', 'XXXXXXXXXXXXXXXXXXXX'],
    ['invalid calendar date', 'asset_versions', 'created_at', '2026-02-30T00:00:00.000Z'],
    ['hour 24', 'asset_versions', 'created_at', '2026-01-01T24:00:00.000Z'],
    ['offset form', 'asset_versions', 'created_at', '2026-01-01T00:00:00.000+00:00'],
    ['missing milliseconds', 'asset_versions', 'created_at', '2026-01-01T00:00:00Z'],
    ['before epoch', 'asset_versions', 'created_at', '1969-12-31T23:59:59.999Z'],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [name, table, column, invalidValue] = cases[index];
    await t.test(name, (nested) => {
      const database = createMigratedV2Database(nested);
      const characterUid = seedCharacter(database);
      const repositories = createV2Repositories(database);
      const batch = createPersistableBatch(repositories, characterUid, 13060 + index, 13600 + index * 20);
      const versionUid = batch.candidates[0].assetVersionUid;
      const assetUid = database.prepare('SELECT asset_uid FROM asset_versions WHERE uid = ?')
        .pluck().get(versionUid);
      const targetUid = table === 'asset_versions' ? versionUid : assetUid;

      database.prepare(`UPDATE ${table} SET ${column} = ? WHERE uid = ?`)
        .run(invalidValue, targetUid);
      assert.throws(() => repositories.characterCandidates.appendBatch(batch));
      assert.equal(database.prepare('SELECT count(*) FROM character_candidate_batches').pluck().get(), 0);
      assert.equal(database.prepare('SELECT count(*) FROM character_candidate_results').pluck().get(), 0);
    });
  }
});

test('lock and unlock append optimistic events while preserving every candidate and identity version', (t) => {
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  const repositories = createV2Repositories(database);
  const batch = createPersistableBatch(repositories, characterUid, 13040, 13400);
  repositories.characterCandidates.appendBatch(batch);
  const firstIdentity = identity(repositories, characterUid, 13041);
  const secondIdentity = identity(repositories, characterUid, 13042, firstIdentity.uid);

  const locked = repositories.characterCandidates.lock({
    eventUid: uid(13043),
    characterUid,
    candidateUid: batch.candidates[0].uid,
    identityVersionUid: firstIdentity.uid,
    expectedStateVersion: 0,
    changedAtEpochMs: 0,
  });
  assert.equal(locked.status, 'locked');
  assert.equal(locked.stateVersion, 1);

  const unlocked = repositories.characterCandidates.unlock({
    eventUid: uid(13044),
    characterUid,
    candidateUid: batch.candidates[0].uid,
    identityVersionUid: firstIdentity.uid,
    expectedStateVersion: 1,
    changedAtEpochMs: 1,
  });
  assert.equal(unlocked.status, 'unlocked');
  assert.equal(unlocked.stateVersion, 2);

  const relocked = repositories.characterCandidates.lock({
    eventUid: uid(13045),
    characterUid,
    candidateUid: batch.candidates[1].uid,
    identityVersionUid: secondIdentity.uid,
    expectedStateVersion: 2,
    changedAtEpochMs: 2,
  });
  assert.equal(relocked.status, 'locked');
  assert.equal(relocked.stateVersion, 3);
  assert.equal(repositories.characterCandidates.listBatches(characterUid)[0].candidates.length, 4);
  assert.equal(repositories.characterVersions.list('identity', characterUid).length, 2);
  assert.equal(repositories.characterCandidates.listLockEvents(characterUid).length, 3);
  assert.throws(() => database.prepare(`
    INSERT INTO character_identity_lock_events
      (uid, character_uid, candidate_uid, identity_version_uid, operation,
       state_version, changed_at_epoch_ms)
    VALUES (?, ?, ?, ?, 'unlock', 4, 1)
  `).run(uid(13046), characterUid, batch.candidates[1].uid, secondIdentity.uid));
});

test('stale lock writers and cross-character references fail atomically', (t) => {
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  database.prepare("INSERT INTO characters (id, drama_id, name) VALUES (2, 1, 'Rival')").run();
  const rivalUid = database.prepare('SELECT uid FROM characters WHERE id = 2').pluck().get();
  const repositories = createV2Repositories(database);
  const batch = createPersistableBatch(repositories, characterUid, 13050, 13500);
  repositories.characterCandidates.appendBatch(batch);
  const heroIdentity = identity(repositories, characterUid, 13051);
  const rivalIdentity = identity(repositories, rivalUid, 13052);
  repositories.characterCandidates.lock({
    eventUid: uid(13053),
    characterUid,
    candidateUid: batch.candidates[0].uid,
    identityVersionUid: heroIdentity.uid,
    expectedStateVersion: 0,
    changedAtEpochMs: 0,
  });

  assert.throws(() => repositories.characterCandidates.unlock({
    eventUid: uid(13054),
    characterUid,
    candidateUid: batch.candidates[0].uid,
    identityVersionUid: heroIdentity.uid,
    expectedStateVersion: 0,
    changedAtEpochMs: 1,
  }), (error) => error instanceof V2RepositoryConflictError);
  assert.throws(() => repositories.characterCandidates.unlock({
    eventUid: uid(13055),
    characterUid,
    candidateUid: batch.candidates[0].uid,
    identityVersionUid: rivalIdentity.uid,
    expectedStateVersion: 1,
    changedAtEpochMs: 1,
  }), (error) => error instanceof V2RepositoryConflictError);
  assert.equal(repositories.characterCandidates.getLockState(characterUid).stateVersion, 1);
  assert.equal(repositories.characterCandidates.listLockEvents(characterUid).length, 1);
});

test('localhost routes persist continued batches and expose optimistic lock transitions', async (t) => {
  const characterCandidateRoutes = require('../src/routes/v2/characterCandidates');
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  const repositories = createV2Repositories(database);
  const identityVersion = identity(repositories, characterUid, 13060);
  const batchUids = [uid(13061), uid(13062)];
  const lockEventUids = [uid(13063), uid(13064), uid(13065)];
  let batchIndex = 0;
  let assetOffset = 13600;
  let now = 10;
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use(characterCandidateRoutes(null, {
    createUid: () => batchUids[batchIndex++],
    createLockEventUid: () => lockEventUids.shift(),
    nowEpochMs: () => now++,
    localGenerator: {
      scope: 'local',
      generateCharacterCandidates(request) {
        const candidates = persistCandidateAssets(repositories, request, assetOffset);
        assetOffset += 100;
        return { candidates };
      },
    },
  }, database));
  const server = await new Promise((resolve) => {
    const active = app.listen(0, '127.0.0.1', () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const body = {
    prompt_semantic_uid: uid(13010),
    profile_uid: uid(13011),
    manifest_uid: uid(13012),
    width: 1024,
    height: 1024,
    seed: 42,
    candidate_count: 4,
  };
  const post = (path, payload) => fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const firstResponse = await post(`/characters/${characterUid}/candidate-batches`, body);
  assert.equal(firstResponse.status, 201);
  const first = (await firstResponse.json()).data;
  const secondResponse = await post(`/characters/${characterUid}/candidate-batches`, {
    ...body,
    seed: 43,
  });
  assert.equal(secondResponse.status, 201);
  const listedResponse = await fetch(`${origin}/characters/${characterUid}/candidate-batches`);
  assert.equal(listedResponse.status, 200);
  assert.equal((await listedResponse.json()).data.length, 2);

  const lockBody = {
    candidate_uid: first.candidates[0].uid,
    identity_version_uid: identityVersion.uid,
    expected_state_version: 0,
  };
  const lockResponse = await post(`/characters/${characterUid}/identity-lock`, lockBody);
  assert.equal(lockResponse.status, 201);
  assert.equal((await lockResponse.json()).data.status, 'locked');
  const staleUnlock = await post(`/characters/${characterUid}/identity-unlock`, lockBody);
  assert.equal(staleUnlock.status, 409);
  assert.equal((await staleUnlock.json()).error.code, 'CHARACTER_CANDIDATE_CONFLICT');
  const unlockResponse = await post(`/characters/${characterUid}/identity-unlock`, {
    ...lockBody,
    expected_state_version: 1,
  });
  assert.equal(unlockResponse.status, 201);
  const stateResponse = await fetch(`${origin}/characters/${characterUid}/identity-lock`);
  const state = (await stateResponse.json()).data;
  assert.equal(state.status, 'unlocked');
  assert.equal(state.stateVersion, 2);
  assert.equal(repositories.characterCandidates.listBatches(characterUid).length, 2);
});
