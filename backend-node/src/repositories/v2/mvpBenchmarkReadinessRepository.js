'use strict';

const { assertDatabase } = require('./repositorySupport');

const REQUIRED_TABLES = Object.freeze([
  'asset_versions', 'audio_mode_intents', 'audio_tts_execution_evidence', 'audio_tts_outputs',
  'audio_tts_submissions', 'bgm_tracks', 'canvas_edges', 'canvas_nodes', 'export_runs',
  'character_candidate_execution_items', 'character_candidate_executions',
  'character_reference_package_executions',
  'local_recovery_import_attempts', 'local_recovery_packages',
  'recovery_activity_ownership',
  'media_export_run_seals', 'mvp_benchmark_external_authorizations', 'mvp_benchmark_sessions',
  'mvp_benchmark_external_authorization_request_seals',
  'mvp_benchmark_execution_reservations', 'mvp_benchmark_live_environment_attestations',
  'mvp_benchmark_execution_reservation_seals',
  'mvp_benchmark_live_environment_attestation_seals',
  'mvp_benchmark_execution_settlements', 'mvp_benchmark_execution_settlement_seals',
  'mvp_benchmark_human_av_reviews', 'mvp_benchmark_human_av_review_seals',
  'mvp_benchmark_resource_release_obligations',
  'mvp_benchmark_resource_release_obligation_seals',
  'mvp_benchmark_resource_release_receipts',
  'mvp_benchmark_resource_release_receipt_seals',
  'narrative_results', 'narrative_task_executions', 'remote_asset_recoveries',
  'remote_asset_recovery_items', 'remote_connections', 'source_documents',
  'voice_profiles', 'workflow_definitions', 'workflow_runs',
]);
const REQUIRED_TABLE_PLACEHOLDERS = REQUIRED_TABLES.map(() => '?').join(',');
const REQUIRED_VIEW = 'mvp_benchmark_execution_ready_sessions';
const REQUIRED_TRIGGERS = Object.freeze([
  'v2_audio_tts_execution_evidence_validate_insert',
  'v2_mvp_benchmark_external_authorizations_current_sources_insert',
  'v2_mvp_benchmark_sessions_current_sources_insert',
  'v2_mvp_benchmark_human_av_reviews_validate_insert',
  'v2_mvp_benchmark_external_authorizations_operator_attestation_insert',
  'v2_mvp_benchmark_external_authorizations_request_seal_after_insert',
  'v2_mvp_benchmark_external_authorization_request_seals_validate_insert',
  'v2_mvp_benchmark_external_authorization_request_seals_immutable_update',
  'v2_mvp_benchmark_external_authorization_request_seals_append_only',
  'local_recovery_import_attempts_validate_update',
  'local_recovery_packages_require_attempt',
  'v2_remote_asset_recoveries_validate_update',
  'v2_remote_asset_recoveries_character_binding_update',
]);
const REQUIRED_TRIGGER_PLACEHOLDERS = REQUIRED_TRIGGERS.map(() => '?').join(',');
const EXPECTED_FIRST_MIGRATION_VERSION = 1;
const EXPECTED_MIGRATION_VERSION = 39;

function createMvpBenchmarkReadinessRepository(database) {
  assertDatabase(database);
  let statements;

  function getStatements() {
    if (!statements) {
      statements = Object.freeze({
        tableCount: database.prepare(`
          SELECT count(*) AS count FROM sqlite_schema
          WHERE type='table' AND name IN (${REQUIRED_TABLE_PLACEHOLDERS})
        `).pluck(),
        viewCount: database.prepare(`
          SELECT count(*) AS count FROM sqlite_schema
          WHERE type='view' AND name=?
        `).pluck(),
        triggerCount: database.prepare(`
          SELECT count(*) AS count FROM sqlite_schema
          WHERE type='trigger' AND name IN (${REQUIRED_TRIGGER_PLACEHOLDERS})
        `).pluck(),
        readyConnection: database.prepare(`
          SELECT EXISTS(
            SELECT 1 FROM remote_connections
            WHERE status='ready' AND host_fingerprint IS NOT NULL
          ) AS present
        `).pluck(),
        migrationSummary: database.prepare(`
          SELECT COUNT(*) AS count, MIN(version) AS min_version, MAX(version) AS max_version
          FROM schema_migrations
        `),
        remoteAuthenticationColumnCount: database.prepare(`
          SELECT count(*) AS count
          FROM pragma_table_xinfo('remote_connections')
          WHERE (name='auth_method_v2' AND type='TEXT' AND "notnull"=1)
             OR (name='ssh_public_key' AND type='TEXT' AND "notnull"=0)
        `).pluck(),
      });
    }
    return statements;
  }

  function inspect() {
    try {
      const current = getStatements();
      const tableCount = current.tableCount.get(...REQUIRED_TABLES);
      const readyConnection = current.readyConnection.get();
      const viewCount = current.viewCount.get(REQUIRED_VIEW);
      const triggerCount = current.triggerCount.get(...REQUIRED_TRIGGERS);
      const migrationSummary = current.migrationSummary.get();
      const remoteAuthenticationColumnCount = current.remoteAuthenticationColumnCount.get();
      return Object.freeze({
        contractsReady: tableCount === REQUIRED_TABLES.length
          && viewCount === 1
          && triggerCount === REQUIRED_TRIGGERS.length
          && migrationSummary.count === EXPECTED_MIGRATION_VERSION
          && migrationSummary.min_version === EXPECTED_FIRST_MIGRATION_VERSION
          && migrationSummary.max_version === EXPECTED_MIGRATION_VERSION
          && remoteAuthenticationColumnCount === 2,
        readyConnection: readyConnection === 1,
      });
    } catch {
      return Object.freeze({ contractsReady: false, readyConnection: false });
    }
  }

  return Object.freeze({ inspect });
}

module.exports = Object.freeze({ createMvpBenchmarkReadinessRepository });
