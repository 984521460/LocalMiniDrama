'use strict';

const { assertDatabase } = require('./repositorySupport');

const REQUIRED_TABLES = Object.freeze([
  'asset_versions', 'audio_mode_intents', 'audio_tts_execution_evidence', 'audio_tts_outputs',
  'audio_tts_submissions', 'bgm_tracks', 'canvas_edges', 'canvas_nodes', 'export_runs',
  'character_candidate_execution_items', 'character_candidate_executions',
  'media_export_run_seals', 'mvp_benchmark_external_authorizations', 'mvp_benchmark_sessions',
  'mvp_benchmark_execution_reservations', 'mvp_benchmark_live_environment_attestations',
  'mvp_benchmark_execution_reservation_seals',
  'mvp_benchmark_live_environment_attestation_seals',
  'mvp_benchmark_execution_settlements', 'mvp_benchmark_execution_settlement_seals',
  'mvp_benchmark_resource_release_obligations',
  'mvp_benchmark_resource_release_obligation_seals',
  'mvp_benchmark_resource_release_receipts',
  'mvp_benchmark_resource_release_receipt_seals',
  'narrative_results', 'narrative_task_executions', 'remote_connections', 'source_documents',
  'voice_profiles', 'workflow_definitions', 'workflow_runs',
]);
const REQUIRED_TABLE_PLACEHOLDERS = '?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?';
const REQUIRED_VIEW = 'mvp_benchmark_execution_ready_sessions';
const EXPECTED_FIRST_MIGRATION_VERSION = 1;
const EXPECTED_MIGRATION_VERSION = 26;

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
      });
    }
    return statements;
  }

  function inspect() {
    try {
      const current = getStatements();
      const tableCount = current.tableCount.get(
        REQUIRED_TABLES[0],
        REQUIRED_TABLES[1],
        REQUIRED_TABLES[2],
        REQUIRED_TABLES[3],
        REQUIRED_TABLES[4],
        REQUIRED_TABLES[5],
        REQUIRED_TABLES[6],
        REQUIRED_TABLES[7],
        REQUIRED_TABLES[8],
        REQUIRED_TABLES[9],
        REQUIRED_TABLES[10],
        REQUIRED_TABLES[11],
        REQUIRED_TABLES[12],
        REQUIRED_TABLES[13],
        REQUIRED_TABLES[14],
        REQUIRED_TABLES[15],
        REQUIRED_TABLES[16],
        REQUIRED_TABLES[17],
        REQUIRED_TABLES[18],
        REQUIRED_TABLES[19],
        REQUIRED_TABLES[20],
        REQUIRED_TABLES[21],
        REQUIRED_TABLES[22],
        REQUIRED_TABLES[23],
        REQUIRED_TABLES[24],
        REQUIRED_TABLES[25],
        REQUIRED_TABLES[26],
        REQUIRED_TABLES[27],
        REQUIRED_TABLES[28],
        REQUIRED_TABLES[29],
        REQUIRED_TABLES[30],
      );
      const readyConnection = current.readyConnection.get();
      const viewCount = current.viewCount.get(REQUIRED_VIEW);
      const migrationSummary = current.migrationSummary.get();
      return Object.freeze({
        contractsReady: tableCount === REQUIRED_TABLES.length
          && viewCount === 1
          && migrationSummary.count === EXPECTED_MIGRATION_VERSION
          && migrationSummary.min_version === EXPECTED_FIRST_MIGRATION_VERSION
          && migrationSummary.max_version === EXPECTED_MIGRATION_VERSION,
        readyConnection: readyConnection === 1,
      });
    } catch {
      return Object.freeze({ contractsReady: false, readyConnection: false });
    }
  }

  return Object.freeze({ inspect });
}

module.exports = Object.freeze({ createMvpBenchmarkReadinessRepository });
