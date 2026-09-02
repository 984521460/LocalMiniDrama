const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const {
  createVoiceProfileConfigurationService,
  getVoiceProfileConfigurationErrorCode,
} = require('../src/audio/voiceProfileConfigurationService');
const { V2RepositoryDataError, createV2Repositories } = require('../src/repositories/v2');
const voiceProfileRoutes = require('../src/routes/v2/voiceProfiles');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

const DRAMA_UID = uid(990100);
const CREDENTIAL_REF = `credential:v1:${uid(990101)}`;
const schemasRoot = path.resolve(__dirname, '../../schemas');
const schema = (relativePath) => JSON.parse(fs.readFileSync(
  path.join(schemasRoot, relativePath), 'utf8',
));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema('v5/character-version.schema.json'));
ajv.addSchema(schema('v8/voice-profile.schema.json'));
const validateConfiguration = ajv.compile(schema('v9/voice-profile-configuration.schema.json'));

function seedCharacter(database) {
  insertDrama(database, DRAMA_UID, 'Voice configuration drama');
  database.prepare("INSERT INTO characters (id,drama_id,name,appearance,description) VALUES (1,1,'Hero','silver hair','lead')").run();
  return database.prepare('SELECT uid FROM characters WHERE id=1').pluck().get();
}

function identityRequest(overrides = {}) {
  return {
    parent_uid: null,
    expected_version_count: 0,
    name: 'Hero identity',
    visual_signature: 'silver hair and blue eyes',
    color_anchors: ['#112233'],
    ...overrides,
  };
}

function voiceRequest(identityUid, overrides = {}) {
  return {
    identity_version_uid: identityUid,
    parent_uid: null,
    expected_version_count: 0,
    name: 'Mandarin calm',
    language: 'zh-CN',
    style: 'calm and restrained',
    ...overrides,
  };
}

function profileRequest(voiceUid, overrides = {}) {
  return {
    character_voice_version_uid: voiceUid,
    parent_uid: null,
    expected_revision: 0,
    provider: 'openai-compatible',
    model: 'gpt-4o-mini-tts',
    voice_key: 'alloy',
    credential_ref: CREDENTIAL_REF,
    default_emotion: 'neutral',
    emotion_map: {
      neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
      fearful: 'fearful', surprised: 'surprised',
    },
    minimum_speed_permille: 500,
    default_speed_permille: 1000,
    maximum_speed_permille: 2000,
    ...overrides,
  };
}

function fixture(t, { kind = 'api_key' } = {}) {
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  let currentKind = kind;
  let inspectCalls = 0;
  const vault = Object.freeze({
    inspect(ref) {
      inspectCalls += 1;
      return Promise.resolve(Object.freeze({ ref, kind: currentKind, configured: true }));
    },
  });
  const ids = [uid(990110), uid(990111), uid(990112), uid(990113)];
  let idIndex = 0;
  const service = createVoiceProfileConfigurationService({
    database,
    credentialVault: vault,
    createUid: () => ids[idIndex++],
    nowEpochMs: () => 100,
    timeoutMs: 1_000,
  });
  return {
    characterUid,
    database,
    service,
    setKind(value) { currentKind = value; },
    get inspectCalls() { return inspectCalls; },
  };
}

test('voice configuration service creates explicit version evidence and activates a secret-free profile', async (t) => {
  const current = fixture(t);
  const empty = current.service.getState(DRAMA_UID, current.characterUid);
  assert.equal(empty.schemaVersion, 'voice-profile-configuration.v1');
  assert.deepEqual(empty.identityVersions, []);
  assert.deepEqual(empty.voiceVersions, []);
  assert.deepEqual(empty.profiles, []);
  assert.equal(empty.active, null);

  const identity = current.service.createIdentityVersion(
    DRAMA_UID, current.characterUid, identityRequest(),
  );
  const voice = current.service.createVoiceVersion(
    DRAMA_UID, current.characterUid, voiceRequest(identity.uid),
  );
  const profile = await current.service.createProfile(
    DRAMA_UID, current.characterUid, profileRequest(voice.uid),
  );
  const active = await current.service.activateProfile(
    DRAMA_UID, current.characterUid, profile.uid, { expected_state_version: 0 },
  );

  assert.equal(current.inspectCalls, 2);
  assert.equal(active.profile.uid, profile.uid);
  assert.equal(active.selection.stateVersion, 1);
  const state = current.service.getState(DRAMA_UID, current.characterUid);
  assert.deepEqual(state.identityVersions, [identity]);
  assert.deepEqual(state.voiceVersions, [voice]);
  assert.deepEqual(state.profiles.map((item) => item.uid), [profile.uid]);
  assert.deepEqual(state.active, {
    profileUid: profile.uid,
    stateVersion: 1,
    changedAtEpochMs: 100,
  });
  assert.doesNotMatch(JSON.stringify(state), /credential:v1|synthetic-secret/u);
  assert.equal(validateConfiguration(state), true, JSON.stringify(validateConfiguration.errors));
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.identityVersions));
});

test('profile creation and activation inspect the shared provider credential before any write', async (t) => {
  const current = fixture(t, { kind: 'ssh_password' });
  const identity = current.service.createIdentityVersion(
    DRAMA_UID, current.characterUid, identityRequest(),
  );
  const voice = current.service.createVoiceVersion(
    DRAMA_UID, current.characterUid, voiceRequest(identity.uid),
  );
  await assert.rejects(
    current.service.createProfile(DRAMA_UID, current.characterUid, profileRequest(voice.uid)),
    (error) => getVoiceProfileConfigurationErrorCode(error) === 'VOICE_PROFILE_CREDENTIAL_INVALID',
  );
  assert.equal(current.database.prepare('SELECT count(*) FROM voice_profiles').pluck().get(), 0);

  current.setKind('api_key');
  const profile = await current.service.createProfile(
    DRAMA_UID, current.characterUid, profileRequest(voice.uid),
  );
  current.setKind('ssh_password');
  await assert.rejects(
    current.service.activateProfile(
      DRAMA_UID, current.characterUid, profile.uid, { expected_state_version: 0 },
    ),
    (error) => getVoiceProfileConfigurationErrorCode(error) === 'VOICE_PROFILE_CREDENTIAL_INVALID',
  );
  assert.equal(
    current.database.prepare('SELECT count(*) FROM voice_profile_selection_events').pluck().get(),
    0,
  );
});

test('character version creation rolls back when an existing persisted lineage is invalid', (t) => {
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  const repository = createV2Repositories(database).characterVersions;
  const first = repository.create({
    schemaVersion: '5.0', kind: 'identity', uid: uid(990120), characterUid,
    parentUid: null,
    metadata: { name: 'Hero', visualSignature: 'stable', colorAnchors: [] },
    createdAtEpochMs: 1,
  });
  const second = repository.create({
    schemaVersion: '5.0', kind: 'identity', uid: uid(990121), characterUid,
    parentUid: first.uid,
    metadata: { name: 'Hero two', visualSignature: 'stable two', colorAnchors: [] },
    createdAtEpochMs: 1,
  });
  database.exec('DROP TRIGGER v2_character_identity_versions_immutable_update');
  database.prepare('UPDATE character_identity_versions SET parent_uid=? WHERE uid=?')
    .run(second.uid, first.uid);

  assert.throws(() => repository.create({
    schemaVersion: '5.0', kind: 'identity', uid: uid(990122), characterUid,
    parentUid: null,
    metadata: { name: 'Hero three', visualSignature: 'stable three', colorAnchors: [] },
    createdAtEpochMs: 2,
  }), V2RepositoryDataError);
  assert.equal(
    database.prepare('SELECT count(*) FROM character_identity_versions').pluck().get(),
    2,
  );
});

test('localhost voice configuration route exposes the complete production configuration flow', async (t) => {
  const database = createMigratedV2Database(t);
  const characterUid = seedCharacter(database);
  const ids = [uid(990130), uid(990131), uid(990132), uid(990133)];
  let idIndex = 0;
  const vault = Object.freeze({
    inspect(ref) {
      return Promise.resolve(Object.freeze({ ref, kind: 'api_key', configured: true }));
    },
  });
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use(voiceProfileRoutes(null, {
    credentialVault: vault,
    createUid: () => ids[idIndex++],
    nowEpochMs: () => 200,
    timeoutMs: 1_000,
  }, database));
  const server = await new Promise((resolve) => {
    const active = app.listen(0, '127.0.0.1', () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}/dramas/${DRAMA_UID}/characters/${characterUid}`;

  const identityResponse = await fetch(`${root}/identity-versions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(identityRequest()),
  });
  assert.equal(identityResponse.status, 201);
  const identity = (await identityResponse.json()).data;
  const voiceResponse = await fetch(`${root}/voice-versions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(voiceRequest(identity.uid)),
  });
  assert.equal(voiceResponse.status, 201);
  const voice = (await voiceResponse.json()).data;
  const profileResponse = await fetch(`${root}/voice-profiles`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(profileRequest(voice.uid)),
  });
  assert.equal(profileResponse.status, 201);
  const profile = (await profileResponse.json()).data;
  const activeResponse = await fetch(`${root}/voice-profiles/${profile.uid}/activate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_state_version: 0 }),
  });
  assert.equal(activeResponse.status, 201);
  const stateResponse = await fetch(`${root}/voice-configuration`);
  assert.equal(stateResponse.status, 200);
  const state = (await stateResponse.json()).data;
  assert.equal(state.active.profileUid, profile.uid);
  assert.doesNotMatch(JSON.stringify(state), /credential:v1/u);
});
