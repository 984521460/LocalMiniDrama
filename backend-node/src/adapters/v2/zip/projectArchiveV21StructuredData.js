'use strict';

const { types } = require('node:util');

const { archiveError, isProjectArchiveError } = require('./errors');
const {
  assertProjectStructuredDomainEvidence,
} = require('./projectArchiveV21DomainEvidence');
const {
  assertProjectArchiveV21CharacterCandidateExecutionStructured,
} = require('./projectArchiveV21CharacterCandidateExecutionEvidence');

const MAX_RECORDS = 100000;
const MAX_STRING_BYTES = 16 * 1024 * 1024;
const MAX_STRUCTURED_DEPTH = 64;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CREDENTIAL_REFERENCE = /^credential:v1:[0-9a-f-]{36}$/i;

function spec(table, columns, json = {}) {
  return Object.freeze({
    table,
    columns: Object.freeze(columns),
    json: Object.freeze(json),
  });
}

const STRUCTURED_RECORD_SPECS = Object.freeze({
  narrativeResults: spec('narrative_results', [
    'uid', 'drama_uid', 'source_selection_uid', 'result_type', 'task_type',
    'schema_version', 'input_hash', 'result_hash', 'envelope_hash', 'result_json',
    'upstream_result_uid', 'status', 'current_review_uid', 'created_at', 'updated_at',
    'stale_operation_uid', 'stale_reason_code', 'stale_root_kind', 'stale_root_uid',
    'staled_at_epoch_ms',
  ], { result_json: 'object' }),
  narrativeReviewEvents: spec('narrative_review_events', [
    'uid', 'result_uid', 'decision', 'result_hash', 'envelope_hash', 'comment', 'created_at',
  ]),
  narrativeStaleEvents: spec('narrative_stale_events', [
    'uid', 'operation_uid', 'result_uid', 'root_kind', 'root_uid', 'reason_code',
    'staled_at_epoch_ms',
  ]),
  characterIdentityVersions: spec('character_identity_versions', [
    'uid', 'character_uid', 'parent_uid', 'metadata_json', 'created_at_epoch_ms',
  ], { metadata_json: 'object' }),
  characterAppearanceVersions: spec('character_appearance_versions', [
    'uid', 'character_uid', 'identity_version_uid', 'parent_uid', 'metadata_json',
    'created_at_epoch_ms',
  ], { metadata_json: 'object' }),
  characterCostumeVersions: spec('character_costume_versions', [
    'uid', 'character_uid', 'identity_version_uid', 'parent_uid', 'metadata_json',
    'created_at_epoch_ms',
  ], { metadata_json: 'object' }),
  characterVoiceVersions: spec('character_voice_versions', [
    'uid', 'character_uid', 'identity_version_uid', 'parent_uid', 'metadata_json',
    'created_at_epoch_ms',
  ], { metadata_json: 'object' }),
  sceneVersions: spec('scene_versions', [
    'uid', 'scene_uid', 'parent_uid', 'state', 'metadata_json', 'created_at_epoch_ms',
  ], { metadata_json: 'object' }),
  propVersions: spec('prop_versions', [
    'uid', 'prop_uid', 'parent_uid', 'state', 'metadata_json', 'created_at_epoch_ms',
  ], { metadata_json: 'object' }),
  characterCandidateBatches: spec('character_candidate_batches', [
    'uid', 'character_uid', 'prompt_semantic_uid', 'profile_uid', 'manifest_uid',
    'width', 'height', 'seed', 'candidate_count', 'request_sha256', 'created_at_epoch_ms',
  ]),
  characterCandidateResults: spec('character_candidate_results', [
    'uid', 'batch_uid', 'character_uid', 'ordinal', 'asset_version_uid', 'asset_uid',
    'storage_provider', 'relative_path', 'duration_ms', 'asset_version_parent_uid',
    'asset_version_created_at', 'asset_created_at', 'asset_updated_at', 'logical_uri',
    'media_type', 'width', 'height', 'content_sha256', 'presentation',
  ]),
  characterCandidateExecutions: spec('character_candidate_executions', [
    'operation_uid', 'drama_uid', 'character_uid', 'source_selection_uid',
    'extraction_result_uid', 'extraction_result_hash', 'extraction_envelope_hash',
    'extraction_review_uid', 'request_json', 'request_sha256', 'source_json',
    'source_sha256', 'profile_json', 'profile_sha256', 'manifest_json',
    'manifest_sha256', 'state', 'batch_uid', 'error_code', 'created_at_epoch_ms',
    'updated_at_epoch_ms',
  ]),
  characterCandidateExecutionItems: spec('character_candidate_execution_items', [
    'operation_uid', 'ordinal', 'seed', 'prompt_sha256', 'provider', 'model',
    'parameters_json', 'parameters_sha256', 'candidate_uid', 'asset_uid',
    'asset_version_uid', 'logical_uri', 'relative_path', 'content_sha256',
    'byte_length', 'width', 'height', 'created_at_epoch_ms',
  ]),
  characterIdentityLockEvents: spec('character_identity_lock_events', [
    'uid', 'character_uid', 'candidate_uid', 'identity_version_uid', 'operation',
    'state_version', 'changed_at_epoch_ms',
  ]),
  characterReferencePackages: spec('character_reference_packages', [
    'uid', 'character_uid', 'identity_version_uid', 'candidate_uid', 'lock_event_uid',
    'lock_state_version', 'appearance_version_uid', 'costume_version_uid',
    'appearance_metadata_json', 'costume_metadata_json', 'created_at_epoch_ms',
  ], { appearance_metadata_json: 'object', costume_metadata_json: 'object' }),
  characterReferencePackageItems: spec('character_reference_package_items', [
    'uid', 'package_uid', 'character_uid', 'ordinal', 'item_kind', 'asset_version_uid',
    'asset_uid', 'storage_provider', 'relative_path', 'duration_ms',
    'asset_version_parent_uid', 'asset_version_created_at', 'asset_created_at',
    'asset_updated_at', 'logical_uri', 'media_type', 'width', 'height', 'content_sha256',
  ]),
  shotContinuitySnapshots: spec('shot_continuity_snapshots', [
    'uid', 'drama_uid', 'shot_result_uid', 'shot_result_hash', 'shot_envelope_hash',
    'shot_review_uid', 'shot_id', 'shot_ordinal', 'scene_uid', 'scene_version_uid',
    'scene_metadata_json', 'created_at_epoch_ms',
  ], { scene_metadata_json: 'object' }),
  shotContinuityCharacterRefs: spec('shot_continuity_character_refs', [
    'snapshot_uid', 'ordinal', 'fact_ref', 'character_uid', 'reference_package_uid',
    'identity_version_uid', 'costume_version_uid', 'package_lock_event_uid',
    'package_lock_state_version', 'package_appearance_version_uid',
    'package_appearance_metadata_json', 'costume_metadata_json',
  ], { package_appearance_metadata_json: 'object', costume_metadata_json: 'object' }),
  shotContinuityPropRefs: spec('shot_continuity_prop_refs', [
    'snapshot_uid', 'ordinal', 'fact_ref', 'prop_uid', 'prop_version_uid',
    'prop_metadata_json',
  ], { prop_metadata_json: 'object' }),
  voiceProfiles: spec('voice_profiles', [
    'uid', 'drama_uid', 'character_uid', 'character_voice_version_uid',
    'voice_identity_version_uid', 'voice_parent_uid', 'parent_uid', 'revision', 'provider',
    'model', 'voice_key', 'source_kind', 'status', 'default_emotion', 'emotion_map_json',
    'minimum_speed_permille', 'default_speed_permille', 'maximum_speed_permille',
    'voice_name', 'voice_language', 'voice_style', 'voice_version_created_at_epoch_ms',
    'created_at_epoch_ms', 'credential_binding_state',
  ], { emotion_map_json: 'object' }),
  voiceProfileSelectionEvents: spec('voice_profile_selection_events', [
    'uid', 'drama_uid', 'character_uid', 'voice_profile_uid',
    'previous_voice_profile_uid', 'state_version', 'changed_at_epoch_ms',
  ]),
  bgmLicenses: spec('bgm_licenses', [
    'uid', 'track_uid', 'schema_version', 'basis', 'attestation_kind',
    'commercial_use_allowed', 'derivatives_allowed', 'attribution_required',
    'attribution_text', 'attested_at_epoch_ms',
  ]),
  bgmTracks: spec('bgm_tracks', [
    'uid', 'drama_uid', 'title', 'source_kind', 'provider_id', 'asset_uid',
    'asset_version_uid', 'license_uid', 'license_basis', 'commercial_use_allowed',
    'derivatives_allowed', 'attribution_required', 'attribution_text',
    'license_attested_at_epoch_ms', 'version_storage_provider', 'version_logical_uri',
    'version_relative_path', 'version_sha256', 'version_mime_type', 'version_width',
    'version_height', 'version_duration_ms', 'version_parent_uid', 'version_status',
    'version_created_at', 'created_at_epoch_ms',
  ]),
});

const OWNER_FILTERS = Object.freeze({
  narrativeResults: 'row.drama_uid = @dramaUid',
  narrativeReviewEvents: 'EXISTS (SELECT 1 FROM narrative_results AS owner WHERE owner.uid = row.result_uid AND owner.drama_uid = @dramaUid)',
  narrativeStaleEvents: 'EXISTS (SELECT 1 FROM narrative_results AS owner WHERE owner.uid = row.result_uid AND owner.drama_uid = @dramaUid)',
  characterIdentityVersions: "EXISTS (SELECT 1 FROM characters AS owner JOIN dramas AS drama ON drama.id = owner.drama_id WHERE owner.uid = row.character_uid AND drama.uid = @dramaUid AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL)",
  characterAppearanceVersions: "EXISTS (SELECT 1 FROM characters AS owner JOIN dramas AS drama ON drama.id = owner.drama_id WHERE owner.uid = row.character_uid AND drama.uid = @dramaUid AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL)",
  characterCostumeVersions: "EXISTS (SELECT 1 FROM characters AS owner JOIN dramas AS drama ON drama.id = owner.drama_id WHERE owner.uid = row.character_uid AND drama.uid = @dramaUid AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL)",
  characterVoiceVersions: "EXISTS (SELECT 1 FROM characters AS owner JOIN dramas AS drama ON drama.id = owner.drama_id WHERE owner.uid = row.character_uid AND drama.uid = @dramaUid AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL)",
  sceneVersions: "EXISTS (SELECT 1 FROM scenes AS owner JOIN dramas AS drama ON drama.id = owner.drama_id WHERE owner.uid = row.scene_uid AND drama.uid = @dramaUid AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL)",
  propVersions: "EXISTS (SELECT 1 FROM props AS owner JOIN dramas AS drama ON drama.id = owner.drama_id WHERE owner.uid = row.prop_uid AND drama.uid = @dramaUid AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL)",
  characterCandidateBatches: "EXISTS (SELECT 1 FROM characters AS owner JOIN dramas AS drama ON drama.id = owner.drama_id WHERE owner.uid = row.character_uid AND drama.uid = @dramaUid AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL)",
  characterCandidateResults: 'EXISTS (SELECT 1 FROM character_candidate_batches AS batch JOIN characters AS owner ON owner.uid = batch.character_uid JOIN dramas AS drama ON drama.id = owner.drama_id WHERE batch.uid = row.batch_uid AND drama.uid = @dramaUid AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL)',
  characterCandidateExecutions: 'row.drama_uid = @dramaUid',
  characterCandidateExecutionItems: 'EXISTS (SELECT 1 FROM character_candidate_executions AS execution WHERE execution.operation_uid = row.operation_uid AND execution.drama_uid = @dramaUid)',
  characterIdentityLockEvents: "EXISTS (SELECT 1 FROM characters AS owner JOIN dramas AS drama ON drama.id = owner.drama_id WHERE owner.uid = row.character_uid AND drama.uid = @dramaUid AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL)",
  characterReferencePackages: "EXISTS (SELECT 1 FROM characters AS owner JOIN dramas AS drama ON drama.id = owner.drama_id WHERE owner.uid = row.character_uid AND drama.uid = @dramaUid AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL)",
  characterReferencePackageItems: 'EXISTS (SELECT 1 FROM character_reference_packages AS package JOIN characters AS owner ON owner.uid = package.character_uid JOIN dramas AS drama ON drama.id = owner.drama_id WHERE package.uid = row.package_uid AND drama.uid = @dramaUid AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL)',
  shotContinuitySnapshots: 'row.drama_uid = @dramaUid',
  shotContinuityCharacterRefs: 'EXISTS (SELECT 1 FROM shot_continuity_snapshots AS snapshot WHERE snapshot.uid = row.snapshot_uid AND snapshot.drama_uid = @dramaUid)',
  shotContinuityPropRefs: 'EXISTS (SELECT 1 FROM shot_continuity_snapshots AS snapshot WHERE snapshot.uid = row.snapshot_uid AND snapshot.drama_uid = @dramaUid)',
  voiceProfiles: 'row.drama_uid = @dramaUid',
  voiceProfileSelectionEvents: 'row.drama_uid = @dramaUid',
  bgmLicenses: 'EXISTS (SELECT 1 FROM bgm_tracks AS track WHERE track.uid = row.track_uid AND track.drama_uid = @dramaUid)',
  bgmTracks: 'row.drama_uid = @dramaUid',
});

function invalidManifest() {
  throw archiveError('PROJECT_ARCHIVE_MANIFEST_INVALID');
}

function exactObjectDescriptors(value, keys) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) {
    invalidManifest();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidManifest();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => typeof key !== 'string') || actual.length !== keys.length) invalidManifest();
  const sorted = actual.slice().sort();
  const expected = keys.slice().sort();
  if (sorted.some((key, index) => key !== expected[index])) invalidManifest();
  for (const key of actual) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) invalidManifest();
  }
  return descriptors;
}

function plainObjectDescriptors(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) {
    invalidManifest();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidManifest();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) invalidManifest();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) invalidManifest();
  }
  return descriptors;
}

function denseArrayValues(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value)) {
    invalidManifest();
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) invalidManifest();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_RECORDS) invalidManifest();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== lengthDescriptor.value + 1) {
    invalidManifest();
  }
  const values = new Array(lengthDescriptor.value);
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      invalidManifest();
    }
    values[index] = descriptor.value;
  }
  return values;
}

function assertString(value) {
  if (typeof value !== 'string' || value.length > MAX_STRING_BYTES
    || Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) invalidManifest();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalidManifest();
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalidManifest();
  }
  return value;
}

function assertJsonValue(value) {
  const stack = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    const current = entry.value;
    if (++visited > MAX_RECORDS * 20 || entry.depth > MAX_STRUCTURED_DEPTH) invalidManifest();
    if (current === null || typeof current === 'boolean') continue;
    if (typeof current === 'string') {
      assertString(current);
      continue;
    }
    if (typeof current === 'number' && Number.isFinite(current)) continue;
    if (current !== null && typeof current === 'object' && types.isProxy(current)) invalidManifest();
    if (Array.isArray(current)) {
      for (const child of denseArrayValues(current)) stack.push({ value: child, depth: entry.depth + 1 });
      continue;
    }
    const descriptors = plainObjectDescriptors(current);
    for (const descriptor of Object.values(descriptors)) {
      stack.push({ value: descriptor.value, depth: entry.depth + 1 });
    }
  }
}

function normalizedKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertSecretFree(value) {
  const stack = [value];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (++visited > MAX_RECORDS * 20) invalidManifest();
    if (typeof current === 'string') {
      assertString(current);
      if (CREDENTIAL_REFERENCE.test(current)) throw archiveError('PROJECT_ARCHIVE_SECRET_DETECTED');
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    if (types.isProxy(current)) invalidManifest();
    if (Array.isArray(current)) {
      for (const child of denseArrayValues(current)) stack.push(child);
      continue;
    }
    const descriptors = plainObjectDescriptors(current);
    const keys = Object.keys(descriptors);
    for (const key of keys) {
      const normalized = normalizedKey(key);
      if (key !== 'credential_binding_state' && (
        normalized === 'apikey' || normalized === 'password' || normalized === 'token'
        || normalized === 'secret' || normalized === 'authorization'
        || normalized.includes('credential') || normalized.endsWith('secret')
        || normalized.endsWith('password') || normalized.endsWith('token')
      )) throw archiveError('PROJECT_ARCHIVE_SECRET_DETECTED');
      stack.push(descriptors[key].value);
    }
  }
}

function recordIdentity(name, row) {
  if (Object.hasOwn(row, 'uid')) return row.uid;
  if (name === 'characterCandidateExecutions') return row.operation_uid;
  if (name === 'characterCandidateExecutionItems') return `${row.operation_uid}:${row.ordinal}`;
  if (name === 'shotContinuityCharacterRefs' || name === 'shotContinuityPropRefs') {
    return `${row.snapshot_uid}:${row.ordinal}`;
  }
  invalidManifest();
}

function validateRecord(name, value) {
  const definition = STRUCTURED_RECORD_SPECS[name];
  const descriptors = exactObjectDescriptors(value, definition.columns);
  for (const column of definition.columns) {
    const field = descriptors[column].value;
    const jsonKind = definition.json[column];
    if (jsonKind) {
      if (field === null || typeof field !== 'object' || types.isProxy(field)
        || Array.isArray(field) !== (jsonKind === 'array')) {
        invalidManifest();
      }
      assertJsonValue(field);
      continue;
    }
    if (field !== null && typeof field !== 'string'
      && !(typeof field === 'number' && Number.isSafeInteger(field))) invalidManifest();
    if (typeof field === 'string') assertString(field);
    if ((column === 'uid' || column.endsWith('_uid')) && field !== null
      && (typeof field !== 'string' || !UUID_V4.test(field))) invalidManifest();
  }
  if (name === 'voiceProfiles' && value.credential_binding_state !== 'needs_rebind') invalidManifest();
  return value;
}

function assertAcyclicParentChains(rows) {
  const byUid = new Map(rows.map((row) => [row.uid, row]));
  const states = new Map();
  for (const row of rows) {
    if (states.get(row.uid) === 2) continue;
    const path = [];
    let current = row;
    while (current !== null) {
      const state = states.get(current.uid) || 0;
      if (state === 1) invalidManifest();
      if (state === 2) break;
      states.set(current.uid, 1);
      path.push(current.uid);
      if (current.parent_uid === null) {
        current = null;
      } else {
        current = byUid.get(current.parent_uid);
        if (!current) invalidManifest();
      }
    }
    for (const uid of path) states.set(uid, 2);
  }
}

function assertReferences(records, dramaUid) {
  for (const name of ['narrativeResults', 'shotContinuitySnapshots', 'voiceProfiles',
    'voiceProfileSelectionEvents', 'bgmTracks']) {
    if (records[name].some((row) => row.drama_uid !== dramaUid)) invalidManifest();
  }
  const resultUids = new Set(records.narrativeResults.map((row) => row.uid));
  if (records.narrativeReviewEvents.some((row) => !resultUids.has(row.result_uid))
    || records.narrativeStaleEvents.some((row) => !resultUids.has(row.result_uid))) invalidManifest();
  const resultByUid = new Map(records.narrativeResults.map((row) => [row.uid, row]));
  const reviewByUid = new Map(records.narrativeReviewEvents.map((row) => [row.uid, row]));
  const staleByResultUid = new Map(records.narrativeStaleEvents.map((row) => [row.result_uid, row]));
  for (const row of records.narrativeResults) {
    if (row.upstream_result_uid !== null && !resultUids.has(row.upstream_result_uid)) invalidManifest();
    if (row.status === 'pending_review') {
      if (row.current_review_uid !== null) invalidManifest();
    } else if (row.status === 'approved' || row.status === 'rejected') {
      const review = reviewByUid.get(row.current_review_uid);
      if (!review || review.result_uid !== row.uid
        || review.result_hash !== row.result_hash || review.envelope_hash !== row.envelope_hash
        || review.decision !== (row.status === 'approved' ? 'approve' : 'reject')) invalidManifest();
    } else if (row.status === 'stale') {
      const stale = staleByResultUid.get(row.uid);
      if (row.current_review_uid !== null || !stale
        || stale.operation_uid !== row.stale_operation_uid
        || stale.root_kind !== row.stale_root_kind || stale.root_uid !== row.stale_root_uid
        || stale.reason_code !== row.stale_reason_code
        || stale.staled_at_epoch_ms !== row.staled_at_epoch_ms) invalidManifest();
    } else invalidManifest();
  }
  for (const review of records.narrativeReviewEvents) {
    const result = resultByUid.get(review.result_uid);
    if (!result || review.result_hash !== result.result_hash
      || review.envelope_hash !== result.envelope_hash
      || !['approve', 'reject'].includes(review.decision)) invalidManifest();
  }

  const identityByUid = new Map(records.characterIdentityVersions.map((row) => [row.uid, row]));
  const versionGroups = [
    records.characterIdentityVersions,
    records.characterAppearanceVersions,
    records.characterCostumeVersions,
    records.characterVoiceVersions,
  ];
  for (const group of versionGroups) {
    const byUid = new Map(group.map((row) => [row.uid, row]));
    for (const row of group) {
      if (row.parent_uid !== null) {
        const parent = byUid.get(row.parent_uid);
        if (!parent || parent.character_uid !== row.character_uid
          || parent.created_at_epoch_ms > row.created_at_epoch_ms) invalidManifest();
      }
      if (Object.hasOwn(row, 'identity_version_uid')) {
        const identity = identityByUid.get(row.identity_version_uid);
        if (!identity || identity.character_uid !== row.character_uid) invalidManifest();
      }
    }
    assertAcyclicParentChains(group);
  }
  for (const [name, ownerField] of [['sceneVersions', 'scene_uid'], ['propVersions', 'prop_uid']]) {
    const byUid = new Map(records[name].map((row) => [row.uid, row]));
    for (const row of records[name]) {
      if (row.parent_uid !== null) {
        const parent = byUid.get(row.parent_uid);
        if (!parent || parent[ownerField] !== row[ownerField]
          || parent.created_at_epoch_ms > row.created_at_epoch_ms) invalidManifest();
      }
    }
    assertAcyclicParentChains(records[name]);
  }

  const batchByUid = new Map(records.characterCandidateBatches.map((row) => [row.uid, row]));
  const candidateByUid = new Map(records.characterCandidateResults.map((row) => [row.uid, row]));
  const candidatesByBatch = new Map();
  for (const row of records.characterCandidateResults) {
    const batch = batchByUid.get(row.batch_uid);
    if (!batch || row.character_uid !== batch.character_uid
      || row.width !== batch.width || row.height !== batch.height) invalidManifest();
    const rows = candidatesByBatch.get(row.batch_uid) || [];
    rows.push(row);
    candidatesByBatch.set(row.batch_uid, rows);
  }
  for (const batch of records.characterCandidateBatches) {
    const candidates = candidatesByBatch.get(batch.uid) || [];
    if (candidates.length !== batch.candidate_count) invalidManifest();
    const ordered = new Array(candidates.length);
    for (let index = 0; index < candidates.length; index += 1) {
      const ordinal = candidates[index].ordinal;
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= ordered.length
        || ordered[ordinal] !== undefined) invalidManifest();
      ordered[ordinal] = candidates[index];
    }
  }

  const lockByUid = new Map(records.characterIdentityLockEvents.map((row) => [row.uid, row]));
  const locksByCharacter = new Map();
  for (const row of records.characterIdentityLockEvents) {
    const candidate = candidateByUid.get(row.candidate_uid);
    const identity = identityByUid.get(row.identity_version_uid);
    if (!candidate || !identity || candidate.character_uid !== row.character_uid
      || identity.character_uid !== row.character_uid) invalidManifest();
    const rows = locksByCharacter.get(row.character_uid) || [];
    rows.push(row);
    locksByCharacter.set(row.character_uid, rows);
  }
  for (const rows of locksByCharacter.values()) {
    rows.sort((left, right) => left.state_version - right.state_version);
    if (rows.some((row, index) => row.state_version !== index + 1)) invalidManifest();
  }

  const appearanceByUid = new Map(records.characterAppearanceVersions.map((row) => [row.uid, row]));
  const costumeByUid = new Map(records.characterCostumeVersions.map((row) => [row.uid, row]));
  const packageByUid = new Map(records.characterReferencePackages.map((row) => [row.uid, row]));
  const itemsByPackage = new Map();
  for (const row of records.characterReferencePackageItems) {
    const packageRecord = packageByUid.get(row.package_uid);
    if (!packageRecord || packageRecord.character_uid !== row.character_uid) invalidManifest();
    const rows = itemsByPackage.get(row.package_uid) || [];
    rows.push(row);
    itemsByPackage.set(row.package_uid, rows);
  }
  for (const row of records.characterReferencePackages) {
    const identity = identityByUid.get(row.identity_version_uid);
    const candidate = candidateByUid.get(row.candidate_uid);
    const lock = lockByUid.get(row.lock_event_uid);
    const appearance = appearanceByUid.get(row.appearance_version_uid);
    const costume = costumeByUid.get(row.costume_version_uid);
    const items = itemsByPackage.get(row.uid) || [];
    if (!identity || !candidate || !lock || !appearance || !costume
      || [identity, candidate, lock, appearance, costume]
        .some((entry) => entry.character_uid !== row.character_uid)
      || lock.identity_version_uid !== row.identity_version_uid
      || lock.candidate_uid !== row.candidate_uid || lock.operation !== 'lock'
      || lock.state_version !== row.lock_state_version
      || appearance.identity_version_uid !== row.identity_version_uid
      || costume.identity_version_uid !== row.identity_version_uid
      || items.some((item, index) => item.ordinal !== index)) invalidManifest();
  }

  const sceneVersionByUid = new Map(records.sceneVersions.map((row) => [row.uid, row]));
  const propVersionByUid = new Map(records.propVersions.map((row) => [row.uid, row]));
  const snapshotByUid = new Map(records.shotContinuitySnapshots.map((row) => [row.uid, row]));
  const characterRefsBySnapshot = new Map();
  for (const row of records.shotContinuityCharacterRefs) {
    const snapshot = snapshotByUid.get(row.snapshot_uid);
    const packageRecord = packageByUid.get(row.reference_package_uid);
    if (!snapshot || !packageRecord || packageRecord.character_uid !== row.character_uid
      || packageRecord.identity_version_uid !== row.identity_version_uid
      || packageRecord.costume_version_uid !== row.costume_version_uid
      || packageRecord.lock_event_uid !== row.package_lock_event_uid
      || packageRecord.lock_state_version !== row.package_lock_state_version
      || packageRecord.appearance_version_uid !== row.package_appearance_version_uid) {
      invalidManifest();
    }
    const rows = characterRefsBySnapshot.get(row.snapshot_uid) || [];
    rows.push(row);
    characterRefsBySnapshot.set(row.snapshot_uid, rows);
  }
  const propRefsBySnapshot = new Map();
  for (const row of records.shotContinuityPropRefs) {
    const snapshot = snapshotByUid.get(row.snapshot_uid);
    const version = propVersionByUid.get(row.prop_version_uid);
    if (!snapshot || !version || version.prop_uid !== row.prop_uid) invalidManifest();
    const rows = propRefsBySnapshot.get(row.snapshot_uid) || [];
    rows.push(row);
    propRefsBySnapshot.set(row.snapshot_uid, rows);
  }
  for (const row of records.shotContinuitySnapshots) {
    const result = resultByUid.get(row.shot_result_uid);
    const review = reviewByUid.get(row.shot_review_uid);
    const sceneVersion = sceneVersionByUid.get(row.scene_version_uid);
    if (!result || !review || !sceneVersion || result.drama_uid !== dramaUid
      || result.result_hash !== row.shot_result_hash || result.envelope_hash !== row.shot_envelope_hash
      || review.result_uid !== row.shot_result_uid || review.decision !== 'approve'
      || sceneVersion.scene_uid !== row.scene_uid) invalidManifest();
    for (const children of [characterRefsBySnapshot.get(row.uid) || [], propRefsBySnapshot.get(row.uid) || []]) {
      if (children.some((child, index) => child.ordinal !== index)) invalidManifest();
    }
  }

  const voiceVersionByUid = new Map(records.characterVoiceVersions.map((row) => [row.uid, row]));
  const profileByUid = new Map(records.voiceProfiles.map((row) => [row.uid, row]));
  const profilesByCharacter = new Map();
  for (const row of records.voiceProfiles) {
    const version = voiceVersionByUid.get(row.character_voice_version_uid);
    const identity = identityByUid.get(row.voice_identity_version_uid);
    if (!version || !identity || version.character_uid !== row.character_uid
      || version.identity_version_uid !== row.voice_identity_version_uid
      || version.parent_uid !== row.voice_parent_uid || identity.character_uid !== row.character_uid) {
      invalidManifest();
    }
    const rows = profilesByCharacter.get(row.character_uid) || [];
    rows.push(row);
    profilesByCharacter.set(row.character_uid, rows);
  }
  for (const rows of profilesByCharacter.values()) {
    rows.sort((left, right) => left.revision - right.revision);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const previous = index === 0 ? null : rows[index - 1];
      if (row.revision !== index + 1 || row.parent_uid !== (previous?.uid || null)) invalidManifest();
    }
  }
  const selectionsByCharacter = new Map();
  for (const row of records.voiceProfileSelectionEvents) {
    const profile = profileByUid.get(row.voice_profile_uid);
    if (!profile || profile.character_uid !== row.character_uid || profile.drama_uid !== row.drama_uid
      || (row.previous_voice_profile_uid !== null && !profileByUid.has(row.previous_voice_profile_uid))) {
      invalidManifest();
    }
    const rows = selectionsByCharacter.get(row.character_uid) || [];
    rows.push(row);
    selectionsByCharacter.set(row.character_uid, rows);
  }
  for (const rows of selectionsByCharacter.values()) {
    rows.sort((left, right) => left.state_version - right.state_version);
    for (let index = 0; index < rows.length; index += 1) {
      const previous = index === 0 ? null : rows[index - 1];
      if (rows[index].state_version !== index + 1
        || rows[index].previous_voice_profile_uid !== (previous?.voice_profile_uid || null)) {
        invalidManifest();
      }
    }
  }

  const licenseByUid = new Map(records.bgmLicenses.map((row) => [row.uid, row]));
  for (const row of records.bgmTracks) {
    const license = licenseByUid.get(row.license_uid);
    if (!license || license.track_uid !== row.uid || license.basis !== row.license_basis
      || license.commercial_use_allowed !== row.commercial_use_allowed
      || license.derivatives_allowed !== row.derivatives_allowed
      || license.attribution_required !== row.attribution_required
      || license.attribution_text !== row.attribution_text
      || license.attested_at_epoch_ms !== row.license_attested_at_epoch_ms) invalidManifest();
  }
  const trackUids = new Set(records.bgmTracks.map((row) => row.uid));
  if (records.bgmLicenses.some((row) => !trackUids.has(row.track_uid))) invalidManifest();
}

function validateProjectStructuredRecords(value, dramaUid) {
  if (typeof dramaUid !== 'string' || !UUID_V4.test(dramaUid)) invalidManifest();
  const names = Object.keys(STRUCTURED_RECORD_SPECS);
  const descriptors = exactObjectDescriptors(value, names);
  const records = {};
  for (const name of names) {
    const rows = denseArrayValues(descriptors[name].value);
    const seen = new Set();
    let previous = null;
    for (const row of rows) {
      validateRecord(name, row);
      const identity = recordIdentity(name, row);
      if (seen.has(identity) || (previous !== null && identity <= previous)) invalidManifest();
      seen.add(identity);
      previous = identity;
    }
    records[name] = rows;
  }
  assertReferences(records, dramaUid);
  assertProjectArchiveV21CharacterCandidateExecutionStructured(records, invalidManifest);
  assertSecretFree(value);
  assertProjectStructuredDomainEvidence(records, invalidManifest);
  return value;
}

function selectColumns(name, definition) {
  return definition.columns.map((column) => (
    name === 'voiceProfiles' && column === 'credential_binding_state'
      ? "'needs_rebind' AS credential_binding_state"
      : `row.${column}`
  )).join(', ');
}

function orderBy(name) {
  if (name === 'shotContinuityCharacterRefs' || name === 'shotContinuityPropRefs') {
    return 'row.snapshot_uid, row.ordinal';
  }
  if (name === 'characterCandidateExecutions') return 'row.operation_uid';
  if (name === 'characterCandidateExecutionItems') return 'row.operation_uid, row.ordinal';
  return 'row.uid';
}

function parseRow(name, row) {
  const definition = STRUCTURED_RECORD_SPECS[name];
  const record = {};
  for (const column of definition.columns) {
    let value = row[column];
    if (definition.json[column]) {
      try {
        value = JSON.parse(value);
      } catch {
        invalidManifest();
      }
    }
    record[column] = value;
  }
  return record;
}

function deepFreeze(value) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) if (child && typeof child === 'object') stack.push(child);
      Object.freeze(current);
    }
  }
  return value;
}

function createProjectArchiveV21StructuredData(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('Project archive structured data database is invalid');
  }
  const dramaExists = database.prepare(
    'SELECT 1 FROM dramas WHERE uid = ? AND deleted_at IS NULL',
  ).pluck();
  const statements = Object.freeze(Object.fromEntries(
    Object.entries(STRUCTURED_RECORD_SPECS).map(([name, definition]) => [name, database.prepare(`
      SELECT ${selectColumns(name, definition)}
      FROM ${definition.table} AS row
      WHERE ${OWNER_FILTERS[name]}
      ORDER BY ${orderBy(name)}
    `)]),
  ));

  return Object.freeze({
    exportForDrama(dramaUid) {
      try {
        if (typeof dramaUid !== 'string' || !UUID_V4.test(dramaUid) || dramaExists.get(dramaUid) !== 1) {
          invalidManifest();
        }
        const records = {};
        for (const name of Object.keys(STRUCTURED_RECORD_SPECS)) {
          records[name] = statements[name].all({ dramaUid }).map((row) => parseRow(name, row));
        }
        validateProjectStructuredRecords(records, dramaUid);
        return deepFreeze(records);
      } catch (error) {
        if (isProjectArchiveError(error)) throw error;
        invalidManifest();
      }
    },
  });
}

module.exports = {
  STRUCTURED_RECORD_SPECS,
  createProjectArchiveV21StructuredData,
  validateProjectStructuredRecords,
};
