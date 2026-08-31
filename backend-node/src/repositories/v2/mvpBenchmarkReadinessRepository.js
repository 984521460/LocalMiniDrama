'use strict';

const { assertDatabase } = require('./repositorySupport');

const REQUIRED_TABLES = Object.freeze([
  'asset_versions', 'audio_mode_intents', 'audio_tts_submissions', 'bgm_tracks', 'canvas_edges', 'canvas_nodes', 'export_runs',
  'media_export_run_seals', 'narrative_results', 'remote_connections', 'source_documents',
  'voice_profiles', 'workflow_definitions', 'workflow_runs',
]);
const REQUIRED_TABLE_PLACEHOLDERS = '?,?,?,?,?,?,?,?,?,?,?,?,?,?';
const EXPECTED_FIRST_MIGRATION_VERSION = 1;
const EXPECTED_MIGRATION_VERSION = 18;

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
      );
      const readyConnection = current.readyConnection.get();
      const migrationSummary = current.migrationSummary.get();
      return Object.freeze({
        contractsReady: tableCount === REQUIRED_TABLES.length
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
