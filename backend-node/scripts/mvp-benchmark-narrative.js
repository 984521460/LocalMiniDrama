'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const Database = require('better-sqlite3');

const {
  ERROR_CODE,
  createMvpBenchmarkNarrativePreparation,
} = require('../src/benchmark/mvpBenchmarkNarrativePreparation');
const {
  DATABASE_RELATIVE_PATH,
  WORKSPACE_NAME,
} = require('../src/benchmark/mvpBenchmarkWorkspace');
const { registerV2SqlFunctions } = require('../src/db/v2/sqlFunctions');
const {
  checkMvpBenchmarkWorkspace,
} = require('../../scripts/mvp-benchmark-workspace');

function commandPaths() {
  const repoRoot = path.resolve(__dirname, '../..');
  const dataRoot = path.join(repoRoot, 'backend-node', 'data');
  return Object.freeze({
    repoRoot,
    dataRoot,
    databasePath: path.join(dataRoot, WORKSPACE_NAME, DATABASE_RELATIVE_PATH),
    configPath: path.join(repoRoot, 'backend-node', 'configs', 'config.yaml'),
    sourceRoot: path.join(repoRoot, 'benchmarks', 'mvp-source'),
  });
}

function command(argv) {
  if (!Array.isArray(argv)) throw new TypeError();
  if (argv.length === 1 && argv[0] === 'status') return Object.freeze({ kind: 'status' });
  if (argv.length === 2 && argv[0] === 'stage') {
    return Object.freeze({ kind: 'stage', stage: argv[1] });
  }
  if (argv.length === 5 && ['approve', 'supersede'].includes(argv[0])) {
    return Object.freeze({
      kind: argv[0],
      stage: argv[1],
      resultUid: argv[2],
      resultHash: argv[3],
      envelopeHash: argv[4],
    });
  }
  throw new TypeError();
}

async function main(argv = process.argv.slice(2)) {
  const action = command(argv);
  const paths = commandPaths();
  const workspace = checkMvpBenchmarkWorkspace({
    dataRoot: paths.dataRoot,
    configPath: paths.configPath,
    sourceRoot: paths.sourceRoot,
  });
  let database;
  try {
    database = new Database(paths.databasePath, {
      fileMustExist: true,
      readonly: action.kind === 'status',
    });
    if (action.kind === 'status') database.pragma('query_only = ON');
    else database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');
    registerV2SqlFunctions(database);
    const preparation = createMvpBenchmarkNarrativePreparation({
      database,
      workspace: {
        workspaceName: workspace.workspaceName,
        sourceId: workspace.sourceId,
        dramaUid: workspace.dramaUid,
        sourceSelectionUid: workspace.sourceSelectionUid,
      },
      createUid: crypto.randomUUID,
    });
    let status;
    if (action.kind === 'status') status = preparation.inspect();
    else if (action.kind === 'stage') status = await preparation.stage(action.stage);
    else if (action.kind === 'approve') status = preparation.approve({
      stage: action.stage,
      resultUid: action.resultUid,
      resultHash: action.resultHash,
      envelopeHash: action.envelopeHash,
    });
    else status = await preparation.supersede({
      stage: action.stage,
      resultUid: action.resultUid,
      resultHash: action.resultHash,
      envelopeHash: action.envelopeHash,
    });
    if (action.kind !== 'status') database.pragma('wal_checkpoint(TRUNCATE)');
    return status;
  } finally {
    try { database?.close(); } catch {}
  }
}

if (require.main === module) {
  main().then(
    (status) => process.stdout.write(`${JSON.stringify(status)}\n`),
    () => {
      process.stderr.write(`${JSON.stringify({
        code: ERROR_CODE,
        message: 'MVP benchmark narrative preparation is invalid',
      })}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = Object.freeze({ command, commandPaths, main });
