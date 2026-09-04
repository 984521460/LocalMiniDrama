const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const {
  createVoiceProfilePublicRecord,
  createVoiceProfileRecord,
  parseVoiceProfilePublicRecord,
} = require('../src/audio/voiceProfile');
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

const DRAMA_UID = uid(80000);
const CREDENTIAL_REF = `credential:v1:${uid(80001)}`;

function seedVoice(database) {
  insertDrama(database, DRAMA_UID, 'Voice profile drama');
  database.prepare("INSERT INTO characters (id, drama_id, name) VALUES (1, 1, 'Hero')").run();
  const characterUid = database.prepare('SELECT uid FROM characters WHERE id = 1').pluck().get();
  const versions = createV2Repositories(database).characterVersions;
  const identity = versions.create({
    schemaVersion: '5.0',
    kind: 'identity',
    uid: uid(80002),
    characterUid,
    parentUid: null,
    metadata: {
      name: 'Hero identity',
      visualSignature: 'stable hero identity',
      colorAnchors: ['#112233'],
    },
    createdAtEpochMs: 0,
  });
  const voice = versions.create({
    schemaVersion: '5.0',
    kind: 'voice',
    uid: uid(80003),
    characterUid,
    identityVersionUid: identity.uid,
    parentUid: null,
    metadata: {
      name: 'Mandarin calm',
      language: 'zh-CN',
      style: 'calm and restrained',
    },
    createdAtEpochMs: 0,
  });
  return { characterUid, identity, voice };
}

function profileInput(characterUid, voiceUid, index = 80010, overrides = {}) {
  return {
    schemaVersion: '8.0',
    uid: uid(index),
    dramaUid: DRAMA_UID,
    characterUid,
    characterVoiceVersionUid: voiceUid,
    parentUid: null,
    revision: 1,
    provider: 'openai-compatible',
    model: 'gpt-4o-mini-tts',
    voiceKey: 'alloy',
    credentialRef: CREDENTIAL_REF,
    sourceKind: 'provider-preset',
    status: 'ready',
    defaultEmotion: 'neutral',
    emotionMap: {
      neutral: 'neutral',
      happy: 'happy',
      sad: 'sad',
      angry: 'angry',
      fearful: 'fearful',
      surprised: 'surprised',
    },
    minimumSpeedPermille: 500,
    defaultSpeedPermille: 1000,
    maximumSpeedPermille: 2000,
    createdAtEpochMs: 1,
    ...overrides,
  };
}

test('migration twelve installs append-only voice profile and selection tables', (t) => {
  const database = createMigratedV2Database(t);
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name IN ('voice_profiles','voice_profile_selection_events')
    ORDER BY name
  `).pluck().all();
  assert.deepEqual(tables, ['voice_profile_selection_events', 'voice_profiles']);
  assert.equal(database.prepare('SELECT max(version) FROM schema_migrations').pluck().get(), 30);
});

test('voice profiles bind immutable character voice evidence without exposing credential refs', (t) => {
  const database = createMigratedV2Database(t);
  const { characterUid, voice } = seedVoice(database);
  const repository = createV2Repositories(database).voiceProfiles;
  const internal = repository.create(profileInput(characterUid, voice.uid));
  const publicRecord = createVoiceProfilePublicRecord(internal);

  assert.equal(internal.voiceVersion.uid, voice.uid);
  assert.equal(internal.voiceVersion.language, 'zh-CN');
  assert.equal(internal.credentialRef, CREDENTIAL_REF);
  assert.equal(internal.defaultSpeedPermille, 1000);
  assert.equal(internal.emotionMap.angry, 'angry');
  assert.equal(publicRecord.credentialConfigured, true);
  assert.equal(Object.hasOwn(publicRecord, 'credentialRef'), false);
  assert.doesNotMatch(JSON.stringify(publicRecord), /credential:v1|80001/u);
  assert.deepEqual(parseVoiceProfilePublicRecord(JSON.parse(JSON.stringify(publicRecord))), publicRecord);
  assert.deepEqual(repository.list(characterUid), [internal]);
  assert.ok(Object.isFrozen(internal));
  assert.ok(Object.isFrozen(internal.voiceVersion));
});

test('profile revisions and fixed-voice selection form monotonic append-only chains', (t) => {
  const database = createMigratedV2Database(t);
  const { characterUid, voice } = seedVoice(database);
  const repository = createV2Repositories(database).voiceProfiles;
  const first = repository.create(profileInput(characterUid, voice.uid));
  const second = repository.create(profileInput(characterUid, voice.uid, 80011, {
    parentUid: first.uid,
    revision: 2,
    provider: 'minimax',
    model: 'speech-2.5-hd-preview',
    voiceKey: 'male-qn-qingse',
    createdAtEpochMs: 2,
  }));

  const firstSelection = repository.activate({
    schemaVersion: '8.0',
    uid: uid(80020),
    dramaUid: DRAMA_UID,
    characterUid,
    voiceProfileUid: first.uid,
    previousVoiceProfileUid: null,
    stateVersion: 1,
    changedAtEpochMs: 3,
  });
  const secondSelection = repository.activate({
    schemaVersion: '8.0',
    uid: uid(80021),
    dramaUid: DRAMA_UID,
    characterUid,
    voiceProfileUid: second.uid,
    previousVoiceProfileUid: first.uid,
    stateVersion: 2,
    changedAtEpochMs: 4,
  });

  assert.equal(firstSelection.voiceProfileUid, first.uid);
  assert.equal(secondSelection.previousVoiceProfileUid, first.uid);
  assert.equal(repository.getActive(characterUid).profile.uid, second.uid);
  assert.equal(repository.getActive(characterUid).selection.stateVersion, 2);
  assert.deepEqual(repository.list(characterUid).map((item) => item.uid), [first.uid, second.uid]);
  assert.throws(() => database.prepare('UPDATE voice_profiles SET model=? WHERE uid=?')
    .run('changed', first.uid));
  assert.throws(() => database.prepare('DELETE FROM voice_profile_selection_events WHERE uid=?')
    .run(firstSelection.uid));
});

test('repository revalidates the complete profile revision chain after persistence', async (t) => {
  function createChain(context, count = 2) {
    const database = createMigratedV2Database(context);
    const { characterUid, voice } = seedVoice(database);
    const repository = createV2Repositories(database).voiceProfiles;
    const records = [repository.create(profileInput(characterUid, voice.uid))];
    for (let revision = 2; revision <= count; revision += 1) {
      records.push(repository.create(profileInput(characterUid, voice.uid, 80060 + revision, {
        parentUid: records.at(-1).uid,
        revision,
        createdAtEpochMs: revision,
      })));
    }
    database.exec('DROP TRIGGER v2_voice_profiles_immutable_update');
    return { database, repository, records };
  }

  await t.test('wrong parent', (context) => {
    const { database, repository, records } = createChain(context, 3);
    database.prepare('UPDATE voice_profiles SET parent_uid=? WHERE uid=?')
      .run(records[0].uid, records[2].uid);
    assert.throws(() => repository.get(records[2].uid), V2RepositoryDataError);
  });

  await t.test('revision gap', (context) => {
    const { database, repository, records } = createChain(context);
    database.prepare('UPDATE voice_profiles SET revision=3 WHERE uid=?').run(records[1].uid);
    assert.throws(() => repository.get(records[1].uid), V2RepositoryDataError);
  });

  await t.test('non-monotonic creation time', (context) => {
    const { database, repository, records } = createChain(context);
    database.prepare('UPDATE voice_profiles SET created_at_epoch_ms=0 WHERE uid=?')
      .run(records[1].uid);
    assert.throws(() => repository.get(records[1].uid), V2RepositoryDataError);
  });
});

test('repository revalidates the complete active-voice selection chain', async (t) => {
  function createSelectionChain(context) {
    const database = createMigratedV2Database(context);
    const { characterUid, voice } = seedVoice(database);
    const repository = createV2Repositories(database).voiceProfiles;
    const first = repository.create(profileInput(characterUid, voice.uid));
    const second = repository.create(profileInput(characterUid, voice.uid, 80070, {
      parentUid: first.uid,
      revision: 2,
      createdAtEpochMs: 2,
    }));
    const firstSelection = repository.activate({
      schemaVersion: '8.0',
      uid: uid(80071),
      dramaUid: DRAMA_UID,
      characterUid,
      voiceProfileUid: first.uid,
      previousVoiceProfileUid: null,
      stateVersion: 1,
      changedAtEpochMs: 3,
    });
    const secondSelection = repository.activate({
      schemaVersion: '8.0',
      uid: uid(80072),
      dramaUid: DRAMA_UID,
      characterUid,
      voiceProfileUid: second.uid,
      previousVoiceProfileUid: first.uid,
      stateVersion: 2,
      changedAtEpochMs: 4,
    });
    database.exec('DROP TRIGGER v2_voice_profile_selection_immutable_update');
    return { database, repository, firstSelection, secondSelection };
  }

  await t.test('previous profile drift', (context) => {
    const { database, repository, secondSelection } = createSelectionChain(context);
    database.prepare(`
      UPDATE voice_profile_selection_events SET previous_voice_profile_uid=NULL WHERE uid=?
    `).run(secondSelection.uid);
    assert.throws(() => repository.getActive(secondSelection.characterUid), V2RepositoryDataError);
  });

  await t.test('state version gap', (context) => {
    const { database, repository, secondSelection } = createSelectionChain(context);
    database.prepare('UPDATE voice_profile_selection_events SET state_version=3 WHERE uid=?')
      .run(secondSelection.uid);
    assert.throws(() => repository.getActive(secondSelection.characterUid), V2RepositoryDataError);
  });

  await t.test('non-monotonic change time', (context) => {
    const { database, repository, secondSelection } = createSelectionChain(context);
    database.prepare('UPDATE voice_profile_selection_events SET changed_at_epoch_ms=2 WHERE uid=?')
      .run(secondSelection.uid);
    assert.throws(() => repository.getActive(secondSelection.characterUid), V2RepositoryDataError);
  });
});

test('profile and selection writes roll back when persisted chains are already invalid', async (t) => {
  await t.test('profile revision write is atomic', (context) => {
    const database = createMigratedV2Database(context);
    const { characterUid, voice } = seedVoice(database);
    const repository = createV2Repositories(database).voiceProfiles;
    const first = repository.create(profileInput(characterUid, voice.uid));

    database.exec('DROP TRIGGER v2_voice_profiles_immutable_update');
    database.prepare('UPDATE voice_profiles SET revision=2 WHERE uid=?').run(first.uid);
    assert.throws(() => repository.create(profileInput(characterUid, voice.uid, 80083, {
      parentUid: first.uid,
      revision: 3,
      createdAtEpochMs: 3,
    })), V2RepositoryDataError);
    assert.equal(database.prepare('SELECT count(*) FROM voice_profiles').pluck().get(), 1);
    assert.equal(database.prepare('SELECT count(*) FROM voice_profiles WHERE uid=?').pluck()
      .get(uid(80083)), 0);
  });

  await t.test('selection write is atomic', (context) => {
    const database = createMigratedV2Database(context);
    const { characterUid, voice } = seedVoice(database);
    const repository = createV2Repositories(database).voiceProfiles;
    const profile = repository.create(profileInput(characterUid, voice.uid));
    const nextProfile = repository.create(profileInput(characterUid, voice.uid, 80086, {
      parentUid: profile.uid,
      revision: 2,
      createdAtEpochMs: 2,
    }));
    const first = repository.activate({
      schemaVersion: '8.0',
      uid: uid(80084),
      dramaUid: DRAMA_UID,
      characterUid,
      voiceProfileUid: profile.uid,
      previousVoiceProfileUid: null,
      stateVersion: 1,
      changedAtEpochMs: 3,
    });

    database.exec('DROP TRIGGER v2_voice_profile_selection_immutable_update');
    database.prepare(`
      UPDATE voice_profile_selection_events SET state_version=2 WHERE uid=?
    `).run(first.uid);
    assert.throws(() => repository.activate({
      schemaVersion: '8.0',
      uid: uid(80085),
      dramaUid: DRAMA_UID,
      characterUid,
      voiceProfileUid: nextProfile.uid,
      previousVoiceProfileUid: profile.uid,
      stateVersion: 3,
      changedAtEpochMs: 4,
    }), V2RepositoryDataError);
    assert.equal(database.prepare('SELECT count(*) FROM voice_profile_selection_events').pluck()
      .get(), 1);
    assert.equal(database.prepare(`
      SELECT count(*) FROM voice_profile_selection_events WHERE uid=?
    `).pluck().get(uid(80085)), 0);
  });
});

test('database rejects cross-owner, malformed credential, and replacement writes atomically', (t) => {
  const database = createMigratedV2Database(t);
  const { characterUid, voice } = seedVoice(database);
  database.prepare("INSERT INTO dramas (title, uid) VALUES ('Other', ?)").run(uid(80030));
  const repository = createV2Repositories(database).voiceProfiles;
  const first = repository.create(profileInput(characterUid, voice.uid));

  assert.throws(
    () => repository.create(profileInput(characterUid, voice.uid, 80031, {
      dramaUid: uid(80030),
      parentUid: first.uid,
      revision: 2,
    })),
    V2RepositoryConflictError,
  );
  assert.throws(
    () => repository.create(profileInput(characterUid, voice.uid, 80032, {
      parentUid: first.uid,
      revision: 2,
      credentialRef: 'plain-text-password',
    })),
    /Voice profile input is invalid/u,
  );

  database.pragma('recursive_triggers = OFF');
  assert.throws(() => database.prepare(`
    INSERT OR REPLACE INTO voice_profiles (
      uid,drama_uid,character_uid,character_voice_version_uid,
      voice_identity_version_uid,voice_parent_uid,parent_uid,revision,
      provider,model,voice_key,credential_ref,source_kind,voice_name,voice_language,
      voice_style,status,default_emotion,emotion_map_json,minimum_speed_permille,
      default_speed_permille,maximum_speed_permille,voice_version_created_at_epoch_ms,
      created_at_epoch_ms
    ) SELECT ?,drama_uid,character_uid,character_voice_version_uid,
      voice_identity_version_uid,voice_parent_uid,parent_uid,revision,
      provider,model,voice_key,credential_ref,source_kind,voice_name,voice_language,
      voice_style,status,default_emotion,emotion_map_json,minimum_speed_permille,
      default_speed_permille,maximum_speed_permille,voice_version_created_at_epoch_ms,
      created_at_epoch_ms
      FROM voice_profiles WHERE uid=?
  `).run(uid(80033), first.uid));
  assert.equal(database.prepare('SELECT count(*) FROM voice_profiles').pluck().get(), 1);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});

test('database emotion mappings use the same 64-byte bound as runtime and Schema', (t) => {
  const database = createMigratedV2Database(t);
  const { characterUid, voice } = seedVoice(database);
  const repository = createV2Repositories(database).voiceProfiles;
  const first = repository.create(profileInput(characterUid, voice.uid));
  const insertRevision = database.prepare(`
    INSERT INTO voice_profiles (
      uid,drama_uid,character_uid,character_voice_version_uid,
      voice_identity_version_uid,voice_parent_uid,parent_uid,revision,
      provider,model,voice_key,credential_ref,source_kind,voice_name,voice_language,
      voice_style,status,default_emotion,emotion_map_json,minimum_speed_permille,
      default_speed_permille,maximum_speed_permille,voice_version_created_at_epoch_ms,
      created_at_epoch_ms
    ) SELECT ?,drama_uid,character_uid,character_voice_version_uid,
      voice_identity_version_uid,voice_parent_uid,uid,?,
      provider,model,voice_key,credential_ref,source_kind,voice_name,voice_language,
      voice_style,status,default_emotion,?,minimum_speed_permille,
      default_speed_permille,maximum_speed_permille,voice_version_created_at_epoch_ms,?
      FROM voice_profiles WHERE uid=?
  `);
  const emotionMap = (neutral) => JSON.stringify({
    neutral,
    happy: 'happy',
    sad: 'sad',
    angry: 'angry',
    fearful: 'fearful',
    surprised: 'surprised',
  });
  const secondUid = uid(80034);

  insertRevision.run(secondUid, 2, emotionMap('x'.repeat(64)), 2, first.uid);
  assert.equal(repository.get(secondUid).emotionMap.neutral, 'x'.repeat(64));
  assert.throws(() => insertRevision.run(
    uid(80035),
    3,
    emotionMap('x'.repeat(65)),
    3,
    secondUid,
  ));
  assert.equal(database.prepare('SELECT count(*) FROM voice_profiles').pluck().get(), 2);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
});

test('repository fails closed when linked immutable voice evidence drifts', (t) => {
  const database = createMigratedV2Database(t);
  const { characterUid, voice } = seedVoice(database);
  const repository = createV2Repositories(database).voiceProfiles;
  const profile = repository.create(profileInput(characterUid, voice.uid));

  database.exec('DROP TRIGGER v2_character_voice_versions_immutable_update');
  database.prepare(`
    UPDATE character_voice_versions
    SET metadata_json='{"name":"Changed","language":"zh-CN","style":"different"}'
    WHERE uid=?
  `).run(voice.uid);
  assert.throws(() => repository.get(profile.uid), V2RepositoryDataError);
  assert.throws(() => repository.list(characterUid), V2RepositoryDataError);
});

test('repository fails closed when a linked voice is re-owned by another character', (t) => {
  const database = createMigratedV2Database(t);
  const { characterUid, voice } = seedVoice(database);
  database.prepare("INSERT INTO characters (id, drama_id, name) VALUES (2, 1, 'Other')").run();
  const otherCharacterUid = database.prepare('SELECT uid FROM characters WHERE id=2').pluck().get();
  const versions = createV2Repositories(database).characterVersions;
  const otherIdentity = versions.create({
    schemaVersion: '5.0',
    kind: 'identity',
    uid: uid(80036),
    characterUid: otherCharacterUid,
    parentUid: null,
    metadata: {
      name: 'Other identity',
      visualSignature: 'different stable identity',
      colorAnchors: ['#445566'],
    },
    createdAtEpochMs: 0,
  });
  const repository = createV2Repositories(database).voiceProfiles;
  const profile = repository.create(profileInput(characterUid, voice.uid));

  database.exec('DROP TRIGGER v2_character_voice_versions_immutable_update');
  database.prepare(`
    UPDATE character_voice_versions
    SET character_uid=?, identity_version_uid=?
    WHERE uid=?
  `).run(otherCharacterUid, otherIdentity.uid, voice.uid);
  assert.throws(() => repository.get(profile.uid), V2RepositoryDataError);
  assert.throws(() => repository.list(characterUid), V2RepositoryDataError);
});

test('repository fails closed when linked voice identity or parent lineage drifts', async (t) => {
  await t.test('identity version drift', () => {
    const database = createMigratedV2Database(t);
    const { characterUid, voice } = seedVoice(database);
    const versions = createV2Repositories(database).characterVersions;
    const replacementIdentity = versions.create({
      schemaVersion: '5.0',
      kind: 'identity',
      uid: uid(80037),
      characterUid,
      parentUid: null,
      metadata: {
        name: 'Replacement identity',
        visualSignature: 'second identity for drift test',
        colorAnchors: ['#778899'],
      },
      createdAtEpochMs: 1,
    });
    const repository = createV2Repositories(database).voiceProfiles;
    const profile = repository.create(profileInput(characterUid, voice.uid));

    database.exec('DROP TRIGGER v2_character_voice_versions_immutable_update');
    database.prepare('UPDATE character_voice_versions SET identity_version_uid=? WHERE uid=?')
      .run(replacementIdentity.uid, voice.uid);
    assert.throws(() => repository.get(profile.uid), V2RepositoryDataError);
  });

  await t.test('parent voice drift', () => {
    const database = createMigratedV2Database(t);
    const { characterUid, identity, voice } = seedVoice(database);
    const versions = createV2Repositories(database).characterVersions;
    const childVoice = versions.create({
      schemaVersion: '5.0',
      kind: 'voice',
      uid: uid(80038),
      characterUid,
      identityVersionUid: identity.uid,
      parentUid: voice.uid,
      metadata: {
        name: 'Mandarin calm revision',
        language: 'zh-CN',
        style: 'calm and restrained revision',
      },
      createdAtEpochMs: 1,
    });
    const repository = createV2Repositories(database).voiceProfiles;
    const profile = repository.create(profileInput(characterUid, childVoice.uid));

    database.exec('DROP TRIGGER v2_character_voice_versions_immutable_update');
    database.prepare('UPDATE character_voice_versions SET parent_uid=NULL WHERE uid=?')
      .run(childVoice.uid);
    assert.throws(() => repository.get(profile.uid), V2RepositoryDataError);
  });
});

test('repository validates live identity ownership across the complete voice lineage', async (t) => {
  function createOtherIdentity(database, versions, index) {
    database.prepare("INSERT INTO characters (id, drama_id, name) VALUES (2, 1, 'Other')").run();
    const otherCharacterUid = database.prepare('SELECT uid FROM characters WHERE id=2').pluck().get();
    const identity = versions.create({
      schemaVersion: '5.0',
      kind: 'identity',
      uid: uid(index),
      characterUid: otherCharacterUid,
      parentUid: null,
      metadata: {
        name: 'Other identity',
        visualSignature: 'other character identity',
        colorAnchors: ['#abcdef'],
      },
      createdAtEpochMs: 0,
    });
    return { otherCharacterUid, identity };
  }

  await t.test('referenced identity owner drift', (context) => {
    const database = createMigratedV2Database(context);
    const { characterUid, identity, voice } = seedVoice(database);
    const versions = createV2Repositories(database).characterVersions;
    const { otherCharacterUid } = createOtherIdentity(database, versions, 80080);
    const repository = createV2Repositories(database).voiceProfiles;
    const profile = repository.create(profileInput(characterUid, voice.uid));

    database.exec('DROP TRIGGER v2_character_identity_versions_immutable_update');
    database.prepare('UPDATE character_identity_versions SET character_uid=? WHERE uid=?')
      .run(otherCharacterUid, identity.uid);
    assert.throws(() => repository.get(profile.uid), V2RepositoryDataError);
  });

  await t.test('parent voice owner drift', (context) => {
    const database = createMigratedV2Database(context);
    const { characterUid, identity, voice } = seedVoice(database);
    const versions = createV2Repositories(database).characterVersions;
    const { otherCharacterUid, identity: otherIdentity } = createOtherIdentity(
      database,
      versions,
      80081,
    );
    const childVoice = versions.create({
      schemaVersion: '5.0',
      kind: 'voice',
      uid: uid(80082),
      characterUid,
      identityVersionUid: identity.uid,
      parentUid: voice.uid,
      metadata: {
        name: 'Child voice',
        language: 'zh-CN',
        style: 'child of the original voice',
      },
      createdAtEpochMs: 1,
    });
    const repository = createV2Repositories(database).voiceProfiles;
    const profile = repository.create(profileInput(characterUid, childVoice.uid));

    database.exec('DROP TRIGGER v2_character_voice_versions_immutable_update');
    database.prepare(`
      UPDATE character_voice_versions
      SET character_uid=?, identity_version_uid=? WHERE uid=?
    `).run(otherCharacterUid, otherIdentity.uid, voice.uid);
    assert.throws(() => repository.get(profile.uid), V2RepositoryDataError);
  });
});

test('localhost routes create, activate, and list public fixed-voice DTOs', async (t) => {
  const voiceProfileRoutes = require('../src/routes/v2/voiceProfiles');
  const database = createMigratedV2Database(t);
  const { characterUid, voice } = seedVoice(database);
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use(voiceProfileRoutes(null, {
    credentialVault: Object.freeze({
      inspect(ref) {
        return Promise.resolve(Object.freeze({ ref, kind: 'api_key', configured: true }));
      },
    }),
    createProfileUid: () => uid(80040),
    createSelectionUid: () => uid(80041),
    nowEpochMs: () => 10,
  }, database));
  const server = await new Promise((resolve) => {
    const active = app.listen(0, '127.0.0.1', () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/dramas/${DRAMA_UID}/characters/${characterUid}/voice-profiles`;

  const createResponse = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      character_voice_version_uid: voice.uid,
      parent_uid: null,
      expected_revision: 0,
      provider: 'openai-compatible',
      model: 'gpt-4o-mini-tts',
      voice_key: 'alloy',
      credential_ref: CREDENTIAL_REF,
      default_emotion: 'neutral',
      emotion_map: {
        neutral: 'neutral',
        happy: 'happy',
        sad: 'sad',
        angry: 'angry',
        fearful: 'fearful',
        surprised: 'surprised',
      },
      minimum_speed_permille: 500,
      default_speed_permille: 1000,
      maximum_speed_permille: 2000,
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).data;
  assert.equal(created.uid, uid(80040));
  assert.equal(created.credentialConfigured, true);
  assert.doesNotMatch(JSON.stringify(created), /credential:v1/u);

  const activateResponse = await fetch(`${base}/${created.uid}/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_state_version: 0 }),
  });
  assert.equal(activateResponse.status, 201);
  assert.equal((await activateResponse.json()).data.profile.uid, created.uid);

  const activeResponse = await fetch(`${base}/active`);
  assert.equal(activeResponse.status, 200);
  const active = (await activeResponse.json()).data;
  assert.equal(active.profile.uid, created.uid);
  assert.equal(active.selection.stateVersion, 1);
  assert.doesNotMatch(JSON.stringify(active), /credential:v1/u);

  const listResponse = await fetch(base);
  assert.equal(listResponse.status, 200);
  assert.deepEqual((await listResponse.json()).data.map((item) => item.uid), [created.uid]);
});

test('public schema matches runtime and hostile accessors or proxies never execute', () => {
  const schemaPath = path.resolve(__dirname, '../../schemas/v8/voice-profile.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const internal = createVoiceProfileRecord({
    ...profileInput(uid(80050), uid(80051), 80052),
    voiceVersion: {
      uid: uid(80051),
      identityVersionUid: uid(80053),
      parentUid: null,
      name: 'Mandarin calm',
      language: 'zh-CN',
      style: 'calm and restrained',
      createdAtEpochMs: 0,
    },
  });
  const publicRecord = createVoiceProfilePublicRecord(internal);
  assert.equal(validate(publicRecord), true, JSON.stringify(validate.errors));

  let reads = 0;
  const hostile = { ...internal };
  Object.defineProperty(hostile, 'model', {
    enumerable: true,
    get() {
      reads += 1;
      return 'leaked';
    },
  });
  assert.throws(() => createVoiceProfileRecord(hostile), /Voice profile input is invalid/u);
  assert.equal(reads, 0);
  const proxied = new Proxy(internal, {
    ownKeys() {
      reads += 1;
      return [];
    },
  });
  assert.throws(() => createVoiceProfileRecord(proxied), /Voice profile input is invalid/u);
  assert.equal(reads, 0);
});
