'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const Database = require('better-sqlite3');

const receiptSchema = require('../../schemas/v9/mvp-benchmark-workspace-receipt.schema.json');
const {
  RECEIPT_FILE,
  WORKSPACE_NAME,
} = require('../src/benchmark/mvpBenchmarkWorkspace');
const {
  checkMvpBenchmarkWorkspace,
  prepareMvpBenchmarkWorkspace,
} = require('../../scripts/mvp-benchmark-workspace');
const { uid } = require('./helpers/v2RepositoryDatabase');

const SOURCE_ROOT = path.resolve(__dirname, '../../benchmarks/mvp-source');
const validateReceipt = new Ajv2020({ allErrors: true, strict: true }).compile(receiptSchema);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localminidrama-mvp-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data');
  const configRoot = path.join(root, 'base-config');
  const configPath = path.join(configRoot, 'config.yaml');
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(configRoot);
  fs.writeFileSync(configPath, 'server:\n  host: 127.0.0.1\n', { flag: 'wx' });
  let nextUid = 220000;
  return Object.freeze({
    dataRoot,
    configPath,
    sourceRoot: SOURCE_ROOT,
    nowEpochMs: () => 1788566400000,
    createUid: () => uid(nextUid++),
  });
}

function inspectOperationalRows(databasePath) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma('query_only = ON');
    const tables = [
      'workflow_runs',
      'remote_connections',
      'remote_tasks',
      'h3_generation_intents',
      'audio_mode_intents',
      'audio_tts_submissions',
      'bgm_tracks',
      'assets',
      'mvp_benchmark_sessions',
      'export_runs',
    ];
    return tables.map((table) => database.prepare(`SELECT count(*) FROM ${table}`).pluck().get());
  } finally {
    database.close();
  }
}

test('prepare creates one isolated source-selected workspace and check reopens exact evidence', (t) => {
  const current = fixture(t);
  const receipt = prepareMvpBenchmarkWorkspace(current);
  assert.equal(validateReceipt(receipt), true, JSON.stringify(validateReceipt.errors));
  assert.equal(receipt.workspaceName, WORKSPACE_NAME);
  assert.equal(receipt.status, 'source-selected');
  assert.equal(receipt.sourceId, 'rain-before-clear-v1');
  assert.equal(receipt.targetNarrativeDurationSeconds, 60);
  assert.equal(receipt.contractsReady, true);
  assert.equal(receipt.readyConnectionAtPreparation, false);
  assert.equal(receipt.preparedAtEpochMs, 1788566400000);

  const workspace = path.join(current.dataRoot, WORKSPACE_NAME);
  assert.deepEqual(
    fs.readFileSync(path.join(workspace, 'configs', 'config.yaml')),
    fs.readFileSync(current.configPath),
  );
  assert.equal(fs.lstatSync(path.join(workspace, 'data', 'storage')).isDirectory(), true);
  assert.equal(
    fs.readFileSync(path.join(workspace, RECEIPT_FILE), 'utf8'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  assert.deepEqual(
    inspectOperationalRows(path.join(workspace, 'data', 'drama_generator.db')),
    new Array(10).fill(0),
  );
  assert.deepEqual(checkMvpBenchmarkWorkspace({
    dataRoot: current.dataRoot,
    configPath: current.configPath,
    sourceRoot: current.sourceRoot,
  }), receipt);
});

test('prepare refuses an existing workspace without changing its sentinel', (t) => {
  const current = fixture(t);
  const workspace = path.join(current.dataRoot, WORKSPACE_NAME);
  const sentinel = path.join(workspace, 'sentinel.txt');
  fs.mkdirSync(workspace);
  fs.writeFileSync(sentinel, 'existing-user-state', { flag: 'wx' });
  assert.throws(() => prepareMvpBenchmarkWorkspace(current), {
    code: 'MVP_BENCHMARK_WORKSPACE_INVALID',
  });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'existing-user-state');
});

test('prepare refuses a linked workspace and never follows it', (t) => {
  const current = fixture(t);
  const external = path.join(path.dirname(current.dataRoot), 'external');
  const sentinel = path.join(external, 'sentinel.txt');
  const workspace = path.join(current.dataRoot, WORKSPACE_NAME);
  fs.mkdirSync(external);
  fs.writeFileSync(sentinel, 'external-user-state', { flag: 'wx' });
  try {
    fs.symlinkSync(external, workspace, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('directory links are unavailable in this Windows environment');
      return;
    }
    throw error;
  }
  assert.throws(() => prepareMvpBenchmarkWorkspace(current), {
    code: 'MVP_BENCHMARK_WORKSPACE_INVALID',
  });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external-user-state');
});

test('prepare refuses a hard-linked workspace target without changing its peer', (t) => {
  const current = fixture(t);
  const external = path.join(path.dirname(current.dataRoot), 'external-workspace-file');
  const workspace = path.join(current.dataRoot, WORKSPACE_NAME);
  fs.writeFileSync(external, 'external-user-state', { flag: 'wx' });
  fs.linkSync(external, workspace);
  assert.throws(() => prepareMvpBenchmarkWorkspace(current), {
    code: 'MVP_BENCHMARK_WORKSPACE_INVALID',
  });
  assert.equal(fs.readFileSync(external, 'utf8'), 'external-user-state');
  assert.equal(fs.lstatSync(external, { bigint: true }).nlink, 2n);
});

test('check rejects receipt, config, and source drift', (t) => {
  const current = fixture(t);
  const receipt = prepareMvpBenchmarkWorkspace(current);
  const workspace = path.join(current.dataRoot, WORKSPACE_NAME);
  const receiptPath = path.join(workspace, RECEIPT_FILE);
  fs.writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, status: 'completed' }, null, 2)}\n`);
  assert.throws(() => checkMvpBenchmarkWorkspace({
    dataRoot: current.dataRoot,
    configPath: current.configPath,
    sourceRoot: current.sourceRoot,
  }), { code: 'MVP_BENCHMARK_WORKSPACE_INVALID' });

  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.appendFileSync(current.configPath, 'changed: true\n');
  assert.throws(() => checkMvpBenchmarkWorkspace({
    dataRoot: current.dataRoot,
    configPath: current.configPath,
    sourceRoot: current.sourceRoot,
  }), { code: 'MVP_BENCHMARK_WORKSPACE_INVALID' });

  const sourceCopy = path.join(path.dirname(current.dataRoot), 'source-copy');
  fs.mkdirSync(sourceCopy);
  for (const fileName of ['manifest.json', 'source.md', 'LICENSE.md']) {
    fs.copyFileSync(path.join(SOURCE_ROOT, fileName), path.join(sourceCopy, fileName));
  }
  fs.appendFileSync(path.join(sourceCopy, 'source.md'), '\nchanged\n');
  assert.throws(() => checkMvpBenchmarkWorkspace({
    dataRoot: current.dataRoot,
    configPath: path.join(workspace, 'configs', 'config.yaml'),
    sourceRoot: sourceCopy,
  }), { code: 'MVP_BENCHMARK_WORKSPACE_INVALID' });
});

test('a failed post-creation import removes only the workspace it created', (t) => {
  const current = fixture(t);
  const invalidUidOptions = {
    ...current,
    createUid: () => 'not-a-canonical-uid',
  };
  assert.throws(() => prepareMvpBenchmarkWorkspace(invalidUidOptions), {
    code: 'MVP_BENCHMARK_WORKSPACE_INVALID',
  });
  assert.equal(fs.existsSync(path.join(current.dataRoot, WORKSPACE_NAME)), false);
  assert.equal(fs.existsSync(current.configPath), true);
});
