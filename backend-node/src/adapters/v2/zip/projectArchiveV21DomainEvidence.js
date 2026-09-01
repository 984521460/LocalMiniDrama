'use strict';

const { createCharacterCandidateBatch } = require('../../../assets/characterCandidateBatch');
const { createCharacterReferencePackage } = require('../../../assets/characterReferencePackage');
const { createCharacterVersionRecord } = require('../../../assets/characterVersions');
const { createScenePropVersionRecord } = require('../../../assets/scenePropVersions');
const { createShotContinuitySnapshot } = require('../../../assets/shotContinuitySnapshot');
const { createBgmTrack } = require('../../../audio/bgmTrack');
const {
  createVoiceProfileSelectionRecord,
  parseVoiceProfilePublicRecord,
} = require('../../../audio/voiceProfile');
const {
  normalizeNarrativeResult,
  resultHashes,
} = require('../../../narrative/reviews/contracts');

function rowsBy(records, name, field) {
  const grouped = new Map();
  for (const row of records[name]) {
    const rows = grouped.get(row[field]) || [];
    rows.push(row);
    grouped.set(row[field], rows);
  }
  return grouped;
}

function assertNarrative(records) {
  for (const row of records.narrativeResults) {
    const result = normalizeNarrativeResult(row.result_type, row.result_json);
    const hashes = resultHashes(result);
    if (result.taskType !== row.task_type || result.schemaVersion !== row.schema_version
      || result.inputHash !== row.input_hash || hashes.resultHash !== row.result_hash
      || hashes.envelopeHash !== row.envelope_hash) throw new TypeError();
  }
}

function assertVersions(records) {
  const characterGroups = [
    ['identity', 'characterIdentityVersions'],
    ['appearance', 'characterAppearanceVersions'],
    ['costume', 'characterCostumeVersions'],
    ['voice', 'characterVoiceVersions'],
  ];
  for (const [kind, name] of characterGroups) {
    for (const row of records[name]) {
      createCharacterVersionRecord({
        schemaVersion: '5.0',
        kind,
        uid: row.uid,
        characterUid: row.character_uid,
        ...(kind === 'identity' ? {} : { identityVersionUid: row.identity_version_uid }),
        parentUid: row.parent_uid,
        metadata: row.metadata_json,
        createdAtEpochMs: row.created_at_epoch_ms,
      });
    }
  }
  for (const [kind, name, ownerField, archiveField] of [
    ['scene', 'sceneVersions', 'sceneUid', 'scene_uid'],
    ['prop', 'propVersions', 'propUid', 'prop_uid'],
  ]) {
    for (const row of records[name]) {
      createScenePropVersionRecord({
        schemaVersion: '5.0',
        kind,
        uid: row.uid,
        [ownerField]: row[archiveField],
        parentUid: row.parent_uid,
        state: row.state,
        metadata: row.metadata_json,
        createdAtEpochMs: row.created_at_epoch_ms,
      });
    }
  }
}

function assertCandidates(records) {
  const candidatesByBatch = rowsBy(records, 'characterCandidateResults', 'batch_uid');
  for (const row of records.characterCandidateBatches) {
    const unordered = candidatesByBatch.get(row.uid) || [];
    const candidates = new Array(unordered.length);
    for (let index = 0; index < unordered.length; index += 1) {
      const ordinal = unordered[index].ordinal;
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= candidates.length
        || candidates[ordinal] !== undefined) throw new TypeError();
      candidates[ordinal] = unordered[index];
    }
    const candidateRecords = new Array(candidates.length);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!candidate) throw new TypeError();
      candidateRecords[index] = {
        uid: candidate.uid,
        ordinal: candidate.ordinal,
        assetVersionUid: candidate.asset_version_uid,
        logicalUri: candidate.logical_uri,
        mediaType: candidate.media_type,
        width: candidate.width,
        height: candidate.height,
        contentSha256: candidate.content_sha256,
        presentation: candidate.presentation,
      };
    }
    const batch = createCharacterCandidateBatch({
      schemaVersion: '5.0',
      batchUid: row.uid,
      characterUid: row.character_uid,
      promptSemanticUid: row.prompt_semantic_uid,
      profileUid: row.profile_uid,
      manifestUid: row.manifest_uid,
      width: row.width,
      height: row.height,
      seed: row.seed,
      candidateCount: row.candidate_count,
    }, {
      candidates: candidateRecords,
    });
    if (batch.requestSha256 !== row.request_sha256) throw new TypeError();
  }
}

function assertReferencePackages(records) {
  const itemsByPackage = rowsBy(records, 'characterReferencePackageItems', 'package_uid');
  for (const row of records.characterReferencePackages) {
    createCharacterReferencePackage({
      schemaVersion: '5.0',
      packageUid: row.uid,
      characterUid: row.character_uid,
      identityVersionUid: row.identity_version_uid,
      candidateUid: row.candidate_uid,
      lockEventUid: row.lock_event_uid,
      lockStateVersion: row.lock_state_version,
      appearanceVersion: {
        uid: row.appearance_version_uid,
        ...row.appearance_metadata_json,
      },
      defaultCostumeVersion: {
        uid: row.costume_version_uid,
        ...row.costume_metadata_json,
      },
      items: (itemsByPackage.get(row.uid) || []).map((item) => ({
        uid: item.uid,
        ordinal: item.ordinal,
        kind: item.item_kind,
        assetVersionUid: item.asset_version_uid,
        logicalUri: item.logical_uri,
        mediaType: item.media_type,
        width: item.width,
        height: item.height,
        contentSha256: item.content_sha256,
      })),
      createdAtEpochMs: row.created_at_epoch_ms,
    });
  }
}

function assertContinuity(records) {
  const characterRefs = rowsBy(records, 'shotContinuityCharacterRefs', 'snapshot_uid');
  const propRefs = rowsBy(records, 'shotContinuityPropRefs', 'snapshot_uid');
  for (const row of records.shotContinuitySnapshots) {
    createShotContinuitySnapshot({
      schemaVersion: '5.0',
      snapshotUid: row.uid,
      dramaUid: row.drama_uid,
      shotResultUid: row.shot_result_uid,
      shotResultHash: row.shot_result_hash,
      shotEnvelopeHash: row.shot_envelope_hash,
      shotApprovalRef: `review:v1:${row.shot_review_uid}`,
      shotId: row.shot_id,
      shotOrdinal: row.shot_ordinal,
      scene: {
        sceneUid: row.scene_uid,
        versionUid: row.scene_version_uid,
        ...row.scene_metadata_json,
      },
      characters: (characterRefs.get(row.uid) || []).map((entry) => ({
        factRef: entry.fact_ref,
        characterUid: entry.character_uid,
        referencePackageUid: entry.reference_package_uid,
        identityVersionUid: entry.identity_version_uid,
        costumeVersionUid: entry.costume_version_uid,
      })),
      props: (propRefs.get(row.uid) || []).map((entry) => ({
        factRef: entry.fact_ref,
        propUid: entry.prop_uid,
        versionUid: entry.prop_version_uid,
        ...entry.prop_metadata_json,
      })),
      createdAtEpochMs: row.created_at_epoch_ms,
    });
  }
}

function assertVoiceProfiles(records) {
  const voiceVersionByUid = new Map(
    records.characterVoiceVersions.map((row) => [row.uid, row]),
  );
  for (const row of records.voiceProfiles) {
    const version = voiceVersionByUid.get(row.character_voice_version_uid);
    if (!version) throw new TypeError();
    const profile = parseVoiceProfilePublicRecord({
      schemaVersion: '8.0',
      uid: row.uid,
      dramaUid: row.drama_uid,
      characterUid: row.character_uid,
      characterVoiceVersionUid: row.character_voice_version_uid,
      parentUid: row.parent_uid,
      revision: row.revision,
      provider: row.provider,
      model: row.model,
      voiceKey: row.voice_key,
      sourceKind: row.source_kind,
      status: row.status,
      defaultEmotion: row.default_emotion,
      emotionMap: row.emotion_map_json,
      minimumSpeedPermille: row.minimum_speed_permille,
      defaultSpeedPermille: row.default_speed_permille,
      maximumSpeedPermille: row.maximum_speed_permille,
      voiceVersion: {
        uid: version.uid,
        identityVersionUid: version.identity_version_uid,
        parentUid: version.parent_uid,
        ...version.metadata_json,
        createdAtEpochMs: version.created_at_epoch_ms,
      },
      credentialConfigured: true,
      createdAtEpochMs: row.created_at_epoch_ms,
    });
    if (profile.voiceVersion.name !== row.voice_name
      || profile.voiceVersion.language !== row.voice_language
      || profile.voiceVersion.style !== row.voice_style
      || profile.voiceVersion.createdAtEpochMs !== row.voice_version_created_at_epoch_ms) {
      throw new TypeError();
    }
  }
  for (const row of records.voiceProfileSelectionEvents) {
    createVoiceProfileSelectionRecord({
      schemaVersion: '8.0',
      uid: row.uid,
      dramaUid: row.drama_uid,
      characterUid: row.character_uid,
      voiceProfileUid: row.voice_profile_uid,
      previousVoiceProfileUid: row.previous_voice_profile_uid,
      stateVersion: row.state_version,
      changedAtEpochMs: row.changed_at_epoch_ms,
    });
  }
}

function assertBgm(records) {
  const licenseByUid = new Map(records.bgmLicenses.map((row) => [row.uid, row]));
  for (const row of records.bgmTracks) {
    const license = licenseByUid.get(row.license_uid);
    if (!license) throw new TypeError();
    createBgmTrack({
      schemaVersion: 'bgm-track.v1',
      uid: row.uid,
      dramaUid: row.drama_uid,
      title: row.title,
      sourceKind: row.source_kind,
      providerId: row.provider_id,
      assetVersion: {
        uid: row.asset_version_uid,
        assetUid: row.asset_uid,
        storageProvider: row.version_storage_provider,
        logicalUri: row.version_logical_uri,
        relativePath: row.version_relative_path,
        sha256: row.version_sha256,
        mimeType: row.version_mime_type,
        width: row.version_width,
        height: row.version_height,
        durationMs: row.version_duration_ms,
        parentUid: row.version_parent_uid,
        status: row.version_status,
        createdAt: row.version_created_at,
      },
      license: {
        schemaVersion: license.schema_version,
        uid: license.uid,
        basis: license.basis,
        attestationKind: license.attestation_kind,
        commercialUseAllowed: license.commercial_use_allowed === 1,
        derivativesAllowed: license.derivatives_allowed === 1,
        attributionRequired: license.attribution_required === 1,
        attributionText: license.attribution_text,
        attestedAtEpochMs: license.attested_at_epoch_ms,
      },
      createdAtEpochMs: row.created_at_epoch_ms,
    });
  }
}

function assertProjectStructuredDomainEvidence(records, invalid) {
  if (typeof invalid !== 'function') throw new TypeError('Archive invalid handler is required');
  try {
    assertNarrative(records);
    assertVersions(records);
    assertCandidates(records);
    assertReferencePackages(records);
    assertContinuity(records);
    assertVoiceProfiles(records);
    assertBgm(records);
  } catch {
    invalid();
  }
  return records;
}

module.exports = { assertProjectStructuredDomainEvidence };
