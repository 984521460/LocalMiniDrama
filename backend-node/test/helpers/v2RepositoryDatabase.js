const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

const { runV2Migrations } = require('../../src/db/v2');
const { createWorkflowExecutionPlan } = require('../../src/workflows/executionPlan');

const LEGACY_SCHEMA_SQL = fs.readFileSync(
  path.resolve(__dirname, '../../migrations/01_init.sql'),
  'utf8',
);
const V2_MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations/v2');

function uid(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function createMigratedV2Database(t) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 0');
  database.exec(LEGACY_SCHEMA_SQL);
  const migration = runV2Migrations(database, { migrationsDir: V2_MIGRATIONS_DIR });
  if (migration.currentVersion !== 17) {
    database.close();
    throw new Error(`Expected v2 migration version 17, received ${migration.currentVersion}`);
  }
  t.after(() => {
    if (!database.open) return;
    if (database.inTransaction) database.exec('ROLLBACK');
    database.close();
  });
  return database;
}

function insertDrama(database, dramaUid, title = 'Repository test drama') {
  database.prepare('INSERT INTO dramas (title, uid) VALUES (?, ?)').run(title, dramaUid);
}

function createWorkflowPlanFixture(workflowUid, nodeUids = [], graphRevision = 0) {
  return createWorkflowExecutionPlan({
    definition: {
      uid: workflowUid,
      dramaUid: uid(0),
      graphRevision,
      registryVersion: '4.0.0',
    },
    nodes: nodeUids.map((nodeUid, index) => ({
      uid: nodeUid,
      nodeType: 'source.selection',
      position: { x: index * 100, y: 0 },
      config: { contextBeforeBlocks: 0 },
      domainRefType: null,
      domainRefUid: null,
      status: 'disabled',
    })),
    edges: [],
  }, {});
}

module.exports = {
  createWorkflowPlanFixture,
  createMigratedV2Database,
  insertDrama,
  uid,
};
