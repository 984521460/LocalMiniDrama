'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  STRUCTURED_RECORD_SPECS,
  createProjectArchiveV21StructuredData,
  validateProjectStructuredRecords,
} = require('../src/adapters/v2/zip/projectArchiveV21StructuredData');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');
const { createV2Repositories } = require('../src/repositories/v2');
const {
  seedContinuityFixture,
  snapshotInput,
} = require('./helpers/v5ContinuityFixtures');
const { createNarrativeStalenessService } = require('../src/narrative/staleness');

const EXPECTED_TABLES = Object.freeze([
  'narrative_results',
  'narrative_review_events',
  'narrative_stale_events',
  'character_identity_versions',
  'character_appearance_versions',
  'character_costume_versions',
  'character_voice_versions',
  'scene_versions',
  'prop_versions',
  'character_candidate_batches',
  'character_candidate_results',
  'character_candidate_executions',
  'character_candidate_execution_items',
  'character_identity_lock_events',
  'character_reference_packages',
  'character_reference_package_items',
  'shot_continuity_snapshots',
  'shot_continuity_character_refs',
  'shot_continuity_prop_refs',
  'voice_profiles',
  'voice_profile_selection_events',
  'bgm_licenses',
  'bgm_tracks',
]);

test('2.1 structured data catalog covers every P9-04B table exactly once', () => {
  const specs = Object.values(STRUCTURED_RECORD_SPECS);
  assert.deepEqual(specs.map((spec) => spec.table).sort(), [...EXPECTED_TABLES].sort());
  assert.equal(new Set(specs.map((spec) => spec.table)).size, EXPECTED_TABLES.length);
  const voiceSpec = STRUCTURED_RECORD_SPECS.voiceProfiles;
  assert.equal(voiceSpec.columns.includes('credential_ref'), false);
  assert.equal(voiceSpec.columns.includes('credential_binding_state'), true);
});

test('empty 2.1 structured project evidence is exact, deterministic, and frozen', (t) => {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(9800);
  insertDrama(database, dramaUid, 'Structured archive');
  const archive = createProjectArchiveV21StructuredData(database);
  const first = archive.exportForDrama(dramaUid);
  const second = archive.exportForDrama(dramaUid);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(Object.keys(first), Object.keys(STRUCTURED_RECORD_SPECS));
  for (const records of Object.values(first)) {
    assert.deepEqual(records, []);
    assert.equal(Object.isFrozen(records), true);
  }
  assert.equal(validateProjectStructuredRecords(first, dramaUid), first);
  assert.deepEqual(createV2Repositories(database).projectArchives.exportStructuredV21(dramaUid), first);
});

test('hostile structured archive roots fail closed without executing proxy traps', () => {
  let reads = 0;
  const hostile = new Proxy({}, {
    ownKeys() {
      reads += 1;
      throw new Error('structured archive sentinel');
    },
  });
  assert.throws(
    () => validateProjectStructuredRecords(hostile, uid(9801)),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID'
      && !String(error).includes('sentinel'),
  );
  assert.equal(reads, 0);
});

test('2.1 structured evidence exports every P9-04B domain without credential references', (t) => {
  const fixture = seedContinuityFixture(t);
  const { database, dramaUid, repositories } = fixture;
  repositories.shotContinuitySnapshots.create(snapshotInput(fixture));

  const voiceVersion = repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'voice',
    uid: uid(9810),
    characterUid: fixture.characterUid,
    identityVersionUid: fixture.character.identity.uid,
    parentUid: null,
    metadata: { name: 'Archive voice', language: 'zh-CN', style: 'calm' },
    createdAtEpochMs: 10,
  });
  const credentialRef = `credential:v1:${uid(9811)}`;
  const voiceProfile = repositories.voiceProfiles.create({
    schemaVersion: '8.0',
    uid: uid(9812),
    dramaUid,
    characterUid: fixture.characterUid,
    characterVoiceVersionUid: voiceVersion.uid,
    parentUid: null,
    revision: 1,
    provider: 'openai-compatible',
    model: 'gpt-4o-mini-tts',
    voiceKey: 'alloy',
    credentialRef,
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
    createdAtEpochMs: 11,
  });
  repositories.voiceProfiles.activate({
    schemaVersion: '8.0',
    uid: uid(9813),
    dramaUid,
    characterUid: fixture.characterUid,
    voiceProfileUid: voiceProfile.uid,
    previousVoiceProfileUid: null,
    stateVersion: 1,
    changedAtEpochMs: 12,
  });

  const bgmAssetUid = uid(9820);
  const bgmVersionUid = uid(9821);
  repositories.assets.create({
    uid: bgmAssetUid,
    ownerType: 'drama',
    ownerUid: dramaUid,
    assetType: 'bgm',
    status: 'draft',
  });
  repositories.assets.addVersion({
    uid: bgmVersionUid,
    assetUid: bgmAssetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${dramaUid}/bgm/${bgmAssetUid}/${bgmVersionUid}`,
    relativePath: `projects/${dramaUid}/assets/bgm/${bgmAssetUid}/${bgmVersionUid}.mp3`,
    sha256: 'a'.repeat(64),
    mimeType: 'audio/mpeg',
    width: null,
    height: null,
    durationMs: 60_000,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  repositories.bgmTracks.create({
    schemaVersion: 'bgm-track.v1',
    uid: uid(9822),
    dramaUid,
    title: 'Archive theme',
    sourceKind: 'local-import',
    providerId: 'local-library',
    assetVersionUid: bgmVersionUid,
    license: {
      schemaVersion: 'bgm-license.v1',
      uid: uid(9823),
      basis: 'licensed',
      attestationKind: 'user-attestation',
      commercialUseAllowed: true,
      derivativesAllowed: true,
      attributionRequired: false,
      attributionText: null,
      attestedAtEpochMs: 13,
    },
    createdAtEpochMs: 14,
  });

  const selectionUid = database.prepare(
    'SELECT uid FROM source_selections WHERE document_uid IN (SELECT uid FROM source_documents WHERE drama_uid=?)',
  ).pluck().get(dramaUid);
  createNarrativeStalenessService({ repositories, now: () => 15 }).invalidate({
    rootKind: 'source_selection',
    rootUid: selectionUid,
  });

  const records = repositories.projectArchives.exportStructuredV21(dramaUid);
  for (const [name, rows] of Object.entries(records)) {
    if (name === 'characterCandidateExecutions'
      || name === 'characterCandidateExecutionItems') {
      assert.deepEqual(rows, []);
      continue;
    }
    assert.ok(rows.length > 0, `${name} should be represented`);
  }
  assert.equal(records.voiceProfiles[0].credential_binding_state, 'needs_rebind');
  assert.equal(Object.hasOwn(records.voiceProfiles[0], 'credential_ref'), false);
  assert.equal(JSON.stringify(records).includes(credentialRef), false);
  assert.equal(validateProjectStructuredRecords(records, dramaUid), records);

  const invalidMutations = [
    (value) => { value.characterCandidateBatches[0].candidate_count += 1; },
    (value) => { value.characterVoiceVersions[0].identity_version_uid = uid(9880); },
    (value) => { value.characterReferencePackages[0].lock_state_version += 1; },
    (value) => { value.shotContinuitySnapshots[0].shot_review_uid = uid(9881); },
    (value) => { value.voiceProfiles[0].parent_uid = uid(9882); },
    (value) => { value.bgmLicenses[0].basis = 'generated'; },
    (value) => { value.narrativeStaleEvents[0].reason_code = 'different_reason'; },
    (value) => { value.characterCandidateResults.reverse(); },
    (value) => {
      const first = value.characterIdentityVersions[0];
      const second = { ...structuredClone(first), uid: uid(9883), parent_uid: first.uid };
      first.parent_uid = second.uid;
      value.characterIdentityVersions.push(second);
      value.characterIdentityVersions.sort((left, right) => left.uid < right.uid ? -1 : 1);
    },
    (value) => {
      const first = value.characterIdentityVersions[0];
      const second = { ...structuredClone(first), uid: uid(9884), parent_uid: uid(9885) };
      const third = { ...structuredClone(first), uid: uid(9885), parent_uid: first.uid };
      first.parent_uid = second.uid;
      value.characterIdentityVersions.push(second, third);
      value.characterIdentityVersions.sort((left, right) => left.uid < right.uid ? -1 : 1);
    },
    (value) => {
      const first = value.sceneVersions[0];
      const second = { ...structuredClone(first), uid: uid(9886), parent_uid: first.uid };
      first.parent_uid = second.uid;
      value.sceneVersions.push(second);
      value.sceneVersions.sort((left, right) => left.uid < right.uid ? -1 : 1);
    },
    (value) => {
      const first = value.propVersions[0];
      const second = { ...structuredClone(first), uid: uid(9887), parent_uid: first.uid };
      first.parent_uid = second.uid;
      value.propVersions.push(second);
      value.propVersions.sort((left, right) => left.uid < right.uid ? -1 : 1);
    },
  ];
  for (const mutate of invalidMutations) {
    const invalid = structuredClone(records);
    mutate(invalid);
    assert.throws(
      () => validateProjectStructuredRecords(invalid, dramaUid),
      (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
    );
  }
  const sameTimeParent = structuredClone(records);
  const firstIdentity = sameTimeParent.characterIdentityVersions[0];
  sameTimeParent.characterIdentityVersions.push({
    ...structuredClone(firstIdentity),
    uid: uid(9888),
    parent_uid: firstIdentity.uid,
  });
  sameTimeParent.characterIdentityVersions.sort(
    (left, right) => left.uid < right.uid ? -1 : 1,
  );
  assert.equal(validateProjectStructuredRecords(sameTimeParent, dramaUid), sameTimeParent);
  const secretBearing = structuredClone(records);
  secretBearing.narrativeResults[0].result_json.output.apiKey = 'synthetic-secret';
  assert.throws(
    () => validateProjectStructuredRecords(secretBearing, dramaUid),
    (error) => error?.code === 'PROJECT_ARCHIVE_SECRET_DETECTED',
  );

  let nestedReads = 0;
  const hostile = structuredClone(records);
  hostile.narrativeResults[0].result_json = new Proxy({}, {
    ownKeys() {
      nestedReads += 1;
      throw new Error('nested structured sentinel');
    },
  });
  assert.throws(
    () => validateProjectStructuredRecords(hostile, dramaUid),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID'
      && !String(error).includes('sentinel'),
  );
  assert.equal(nestedReads, 0);

  const revoked = structuredClone(records);
  const revocable = Proxy.revocable({}, {});
  revoked.narrativeResults[0].result_json = revocable.proxy;
  revocable.revoke();
  assert.throws(
    () => validateProjectStructuredRecords(revoked, dramaUid),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID'
      && !String(error).includes('revoked'),
  );

  const secondDramaUid = uid(9890);
  insertDrama(database, secondDramaUid, 'Other drama');
  const isolated = repositories.projectArchives.exportStructuredV21(secondDramaUid);
  for (const rows of Object.values(isolated)) assert.deepEqual(rows, []);

  database.exec('DROP TRIGGER v2_character_identity_versions_immutable_update');
  database.prepare("UPDATE character_identity_versions SET metadata_json='{}' WHERE uid=?")
    .run(fixture.character.identity.uid);
  assert.throws(
    () => repositories.projectArchives.exportStructuredV21(dramaUid),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
  assert.deepEqual(repositories.projectArchives.exportStructuredV21(secondDramaUid), isolated);
});
