const { ARCHIVE_V20, ARCHIVE_V21 } = require('./archiveVersionRouter');

const TABLE_NAME = /^_?[a-z][a-z0-9_]{0,127}$/;

const CURRENT_RECORD_TABLES = Object.freeze([
  'source_documents',
  'source_blocks',
  'source_selections',
  'assets',
  'asset_versions',
  'workflow_definitions',
  'canvas_nodes',
  'canvas_edges',
  'generation_runs',
  'workflow_runs',
  'node_runs',
  'export_runs',
  'media_export_run_seals',
  'workflow_manifests',
  'prompt_semantic_versions',
  'asset_generation_history',
  'asset_version_selection_events',
]);

const LEGACY_CORE_TABLES = Object.freeze([
  'dramas',
  'episodes',
  'storyboards',
  'characters',
  'scenes',
  'props',
]);

const LEGACY_ADDENDUM_TABLES = Object.freeze([
  'episode_characters',
  'storyboard_characters',
  'storyboard_props',
  'character_libraries',
  'scene_libraries',
  'prop_libraries',
  'legacy_assets',
  'frame_prompts',
  'image_generations',
  'video_generations',
  'video_merges',
]);

const REQUIRED_V21_TABLES = Object.freeze([
  ...CURRENT_RECORD_TABLES,
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
  ...LEGACY_CORE_TABLES,
  ...LEGACY_ADDENDUM_TABLES,
]);

const NEEDS_REBIND_TABLES = Object.freeze([
  'voice_profiles',
  'canvas_nodes',
  'workflow_runs',
  'node_runs',
]);

const NEEDS_REBIND_FIELDS = Object.freeze([
  Object.freeze({ table: 'voice_profiles', column: 'credential_ref', kind: 'direct-credential-ref' }),
  Object.freeze({ table: 'canvas_nodes', column: 'config_json', kind: 'nested-credential-ref' }),
  Object.freeze({ table: 'workflow_runs', column: 'graph_snapshot_json', kind: 'nested-credential-ref' }),
  Object.freeze({ table: 'node_runs', column: 'input_snapshot_json', kind: 'nested-credential-ref' }),
  Object.freeze({ table: 'node_runs', column: 'output_json', kind: 'nested-credential-ref' }),
]);

const EXCLUDED_TABLES = Object.freeze([
  'ai_service_configs',
  'remote_connections',
  'remote_tasks',
  'h3_api_submissions',
  'h3_generation_intents',
  'audio_mode_intents',
  'audio_tts_submissions',
  'audio_tts_outputs',
  'audio_tts_execution_evidence',
  'mvp_benchmark_sessions',
  'mvp_benchmark_external_authorizations',
  'mvp_benchmark_live_environment_attestations',
  'mvp_benchmark_execution_reservations',
  'mvp_benchmark_live_environment_attestation_seals',
  'mvp_benchmark_execution_reservation_seals',
  'async_tasks',
  'schema_migrations',
  '_v2_uid_generation_candidates',
  'global_settings',
  'ai_model_map',
  'prompt_overrides',
  'image_proxy_cache',
]);

const LEGACY_ADDENDUM_AREAS = Object.freeze([
  'episode-character-membership',
  'storyboard-character-membership',
  'referenced-character-scene-prop-libraries',
  'legacy-assets',
  'complete-image-video-generation-history',
  'video-merge-terminal-evidence',
]);

const PROJECT_ARCHIVE_CATALOG = Object.freeze({
  catalogVersion: 'project-archive-catalog.v1',
  currentExportVersion: ARCHIVE_V20,
  targetExportVersion: ARCHIVE_V21,
  includedTables: CURRENT_RECORD_TABLES,
  requiredV21Tables: REQUIRED_V21_TABLES,
  legacyCoreTables: LEGACY_CORE_TABLES,
  legacyAddendumTables: LEGACY_ADDENDUM_TABLES,
  needsRebindTables: NEEDS_REBIND_TABLES,
  needsRebindFields: NEEDS_REBIND_FIELDS,
  excludedTables: EXCLUDED_TABLES,
  legacyAddendumAreas: LEGACY_ADDENDUM_AREAS,
});

function uniqueTableNames(values, label) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError(`${label} is invalid`);
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !TABLE_NAME.test(value) || seen.has(value)) {
      throw new TypeError(`${label} is invalid`);
    }
    seen.add(value);
  }
  return seen;
}

function rebindFieldNames(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('Rebind archive fields are invalid');
  }
  const seen = new Set();
  for (const value of values) {
    if (
      value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || !TABLE_NAME.test(value.table)
      || !TABLE_NAME.test(value.column)
      || !['direct-credential-ref', 'nested-credential-ref'].includes(value.kind)
      || Object.keys(value).sort().join(',') !== 'column,kind,table'
    ) throw new TypeError('Rebind archive fields are invalid');
    const identity = `${value.table}.${value.column}`;
    if (seen.has(identity)) throw new TypeError('Rebind archive fields are invalid');
    seen.add(identity);
  }
  return seen;
}

function validateProjectArchiveCatalog(catalog, recordSpecs) {
  if (catalog !== PROJECT_ARCHIVE_CATALOG || recordSpecs === null || typeof recordSpecs !== 'object') {
    throw new TypeError('Project archive catalog is invalid');
  }
  if (catalog.catalogVersion !== 'project-archive-catalog.v1'
    || catalog.currentExportVersion !== ARCHIVE_V20
    || catalog.targetExportVersion !== ARCHIVE_V21) {
    throw new TypeError('Project archive catalog version is invalid');
  }

  const included = uniqueTableNames(catalog.includedTables, 'Included archive tables');
  const required = uniqueTableNames(catalog.requiredV21Tables, 'Required 2.1 archive tables');
  const legacyCore = uniqueTableNames(catalog.legacyCoreTables, 'Legacy core archive tables');
  const legacyAddendum = uniqueTableNames(catalog.legacyAddendumTables, 'Legacy addendum archive tables');
  const rebind = uniqueTableNames(catalog.needsRebindTables, 'Rebind archive tables');
  const rebindFields = rebindFieldNames(catalog.needsRebindFields);
  const excluded = uniqueTableNames(catalog.excludedTables, 'Excluded archive tables');
  for (const spec of Object.values(recordSpecs)) {
    if (!spec || typeof spec.table !== 'string' || !included.has(spec.table)) {
      throw new TypeError('Current archive record table is not catalogued');
    }
  }
  for (const table of included) if (!required.has(table)) throw new TypeError('2.0 table is missing from 2.1 target');
  for (const table of legacyCore) if (!required.has(table)) throw new TypeError('Legacy core table is missing from 2.1 target');
  for (const table of legacyAddendum) if (!required.has(table)) throw new TypeError('Legacy addendum table is missing from 2.1 target');
  for (const table of rebind) if (!required.has(table)) throw new TypeError('Rebind table is not a 2.1 project table');
  for (const table of rebind) {
    if (![...rebindFields].some((identity) => identity.startsWith(`${table}.`))) {
      throw new TypeError('Rebind table has no classified field');
    }
  }
  for (const identity of rebindFields) {
    if (!rebind.has(identity.slice(0, identity.indexOf('.')))) {
      throw new TypeError('Rebind field table is not classified for rebind');
    }
  }
  for (const table of excluded) if (required.has(table)) throw new TypeError('Excluded table is included in the project archive');
  return catalog;
}

validateProjectArchiveCatalog(PROJECT_ARCHIVE_CATALOG, Object.fromEntries(
  CURRENT_RECORD_TABLES.map((table) => [table, { table }]),
));

module.exports = {
  PROJECT_ARCHIVE_CATALOG,
  validateProjectArchiveCatalog,
};
