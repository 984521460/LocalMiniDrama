'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const Database = require('better-sqlite3');

const {
  CAPABILITY_SPECS,
  CHECKLIST_SPECS,
  createMvpBenchmarkReadiness,
  parseMvpBenchmarkReadiness,
} = require('../src/benchmark/mvpBenchmarkReadiness');
const {
  createMvpBenchmarkReadinessRepository,
} = require('../src/repositories/v2');
const {
  SUPPORTED_MATERIALIZED_NODE_TYPES,
} = require('../src/workflows/materializedNodeExecutor');
const { createMigratedV2Database, uid } = require('./helpers/v2RepositoryDatabase');

function productionRuntimeFixture({ full = false } = {}) {
  const runtime = {
    remoteExecution: {
      remoteCoordinator: { execute() {} },
      remoteTasks: { get() {} },
      remoteEnvironment: { inspect() {} },
    },
    mediaExports: { service: { start() {} } },
  };
  if (full) {
    runtime.narrativeTasks = { execute() {} };
    runtime.characterCandidates = { complete() {} };
    runtime.workflows = {
      executeNode() {},
      supportedNodeTypes: SUPPORTED_MATERIALIZED_NODE_TYPES,
    };
    runtime.h3Local = { execute() {} };
    runtime.audio = { tts: { execute() {} } };
  }
  return Object.freeze(runtime);
}

function insertReadyConnection(database) {
  database.prepare(`
    INSERT INTO remote_connections
      (uid, name, host, port, username, host_fingerprint, credential_ref, status)
    VALUES (?, 'Synthetic benchmark worker', 'worker.example.invalid', 22, 'fixture', ?, ?, 'ready')
  `).run(
    uid(9901),
    `SHA256:${'a'.repeat(43)}`,
    `credential:v1:${uid(9902)}`,
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readinessOptions(runtime, database) {
  return Object.freeze({
    runtime,
    readinessRepository: createMvpBenchmarkReadinessRepository(database),
  });
}

test('readiness derives the fixed production capability and Section 19 checklist contracts', (t) => {
  const database = createMigratedV2Database(t);
  const partial = createMvpBenchmarkReadiness(readinessOptions(
    productionRuntimeFixture(),
    database,
  ));

  assert.equal(partial.schemaVersion, 'mvp-benchmark-readiness.v1');
  assert.equal(partial.checklistVersion, 'mvp-section-19.v1');
  assert.equal(partial.mvpComplete, false);
  assert.equal(partial.readyForBenchmark, false);
  assert.deepEqual(partial.capabilities.map((item) => item.id), CAPABILITY_SPECS.map((item) => item.id));
  assert.deepEqual(partial.checklist.map((item) => item.id), CHECKLIST_SPECS.map((item) => item.id));
  assert.equal(partial.checklist.length, 34);
  assert.ok(partial.checklist.every((item) => item.status === 'pending'));
  assert.deepEqual(partial.pendingCapabilityIds, [
    'windows-release-evidence',
    'human-av-review',
  ]);
  assert.deepEqual(partial.blockedCapabilityIds, [
    'narrative-execution',
    'character-candidate-execution',
    'workflow-execution',
    'ready-gpu-connection',
    'h3-local-execution',
    'tts-execution',
  ]);

  insertReadyConnection(database);
  const ready = createMvpBenchmarkReadiness(readinessOptions(
    productionRuntimeFixture({ full: true }),
    database,
  ));
  assert.equal(ready.readyForBenchmark, true);
  assert.deepEqual(ready.blockedCapabilityIds, []);
  assert.equal(ready.mvpComplete, false);
  assert.deepEqual(ready.pendingCapabilityIds, [
    'windows-release-evidence',
    'human-av-review',
  ]);
  assert.equal(Object.isFrozen(ready), true);
  assert.equal(Object.isFrozen(ready.capabilities), true);
  assert.equal(Object.isFrozen(ready.checklist), true);
});

test('readiness fails closed when a production component is only partially assembled', (t) => {
  const database = createMigratedV2Database(t);
  const runtime = productionRuntimeFixture();
  runtime.remoteExecution.remoteEnvironment = {};
  const result = createMvpBenchmarkReadiness(readinessOptions(runtime, database));

  assert.equal(
    result.capabilities.find((item) => item.id === 'remote-execution').status,
    'blocked',
  );
  assert.equal(
    result.capabilities.find((item) => item.id === 'h3-local-execution').status,
    'blocked',
  );

  let proxyReads = 0;
  const hostileRuntime = {
    remoteExecution: new Proxy({}, {
      get() {
        proxyReads += 1;
        throw new Error('synthetic-runtime-sentinel');
      },
      getOwnPropertyDescriptor() {
        proxyReads += 1;
        throw new Error('synthetic-runtime-sentinel');
      },
    }),
  };
  const hostileResult = createMvpBenchmarkReadiness(readinessOptions(hostileRuntime, database));
  assert.equal(
    hostileResult.capabilities.find((item) => item.id === 'remote-execution').status,
    'blocked',
  );
  assert.equal(proxyReads, 0);

  const executeOnly = createMvpBenchmarkReadiness(readinessOptions({
    workflows: { executeNode() {} },
  }, database));
  assert.equal(
    executeOnly.capabilities.find((item) => item.id === 'workflow-execution').status,
    'blocked',
  );

  const reordered = createMvpBenchmarkReadiness(readinessOptions({
    workflows: {
      executeNode() {},
      supportedNodeTypes: [...SUPPORTED_MATERIALIZED_NODE_TYPES].reverse(),
    },
  }, database));
  assert.equal(
    reordered.capabilities.find((item) => item.id === 'workflow-execution').status,
    'blocked',
  );

  let supportedProxyReads = 0;
  const supportedProxy = new Proxy([], {
    get() {
      supportedProxyReads += 1;
      throw new Error('synthetic-supported-types-sentinel');
    },
    getOwnPropertyDescriptor() {
      supportedProxyReads += 1;
      throw new Error('synthetic-supported-types-sentinel');
    },
  });
  const hostileSupported = createMvpBenchmarkReadiness(readinessOptions({
    workflows: { executeNode() {}, supportedNodeTypes: supportedProxy },
  }, database));
  assert.equal(
    hostileSupported.capabilities.find((item) => item.id === 'workflow-execution').status,
    'blocked',
  );
  assert.equal(supportedProxyReads, 0);

  let supportedAccessorReads = 0;
  const workflowWithAccessor = { executeNode() {} };
  Object.defineProperty(workflowWithAccessor, 'supportedNodeTypes', {
    enumerable: true,
    get() {
      supportedAccessorReads += 1;
      throw new Error('synthetic-supported-types-sentinel');
    },
  });
  const accessorSupported = createMvpBenchmarkReadiness(readinessOptions({
    workflows: workflowWithAccessor,
  }, database));
  assert.equal(
    accessorSupported.capabilities.find((item) => item.id === 'workflow-execution').status,
    'blocked',
  );
  assert.equal(supportedAccessorReads, 0);
});

test('readiness repository reports missing database contracts without mutating the database', () => {
  const database = new Database(':memory:');
  try {
    const repository = createMvpBenchmarkReadinessRepository(database);
    assert.deepEqual(repository.inspect(), {
      contractsReady: false,
      readyConnection: false,
    });
    assert.deepEqual(
      database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all(),
      [],
    );
  } finally {
    database.close();
  }
});

test('readiness fails closed when the migration ledger has an internal gap', (t) => {
  const database = createMigratedV2Database(t);
  const runtime = productionRuntimeFixture({ full: true });
  const repository = createMvpBenchmarkReadinessRepository(database);
  assert.equal(repository.inspect().contractsReady, true);

  database.prepare('DELETE FROM schema_migrations WHERE version = 15').run();

  assert.deepEqual(repository.inspect(), {
    contractsReady: false,
    readyConnection: false,
  });
  const readiness = createMvpBenchmarkReadiness({ runtime, readinessRepository: repository });
  assert.equal(
    readiness.capabilities.find((item) => item.id === 'database-contracts').status,
    'blocked',
  );
  assert.equal(
    readiness.capabilities.find((item) => item.id === 'project-archive-v21').status,
    'blocked',
  );
  assert.equal(readiness.readyForBenchmark, false);
});

test('readiness fails closed when the version-seventeen intent table is missing', (t) => {
  const database = createMigratedV2Database(t);
  const repository = createMvpBenchmarkReadinessRepository(database);
  assert.equal(repository.inspect().contractsReady, true);

  database.exec('DROP TABLE audio_mode_intents');

  assert.deepEqual(repository.inspect(), {
    contractsReady: false,
    readyConnection: false,
  });
});

test('readiness fails closed when the version-eighteen TTS submission table is missing', (t) => {
  const database = createMigratedV2Database(t);
  const repository = createMvpBenchmarkReadinessRepository(database);
  assert.equal(repository.inspect().contractsReady, true);

  database.exec('DROP TABLE audio_tts_submissions');

  assert.deepEqual(repository.inspect(), {
    contractsReady: false,
    readyConnection: false,
  });
});

test('readiness parser binds the whole projection to the current runtime and database', (t) => {
  const database = createMigratedV2Database(t);
  const runtime = productionRuntimeFixture();
  const options = readinessOptions(runtime, database);
  const current = createMvpBenchmarkReadiness(options);
  assert.deepEqual(parseMvpBenchmarkReadiness(clone(current), options), current);

  const forgedComplete = clone(current);
  forgedComplete.mvpComplete = true;
  assert.throws(
    () => parseMvpBenchmarkReadiness(forgedComplete, options),
    { name: 'TypeError', message: 'MVP benchmark readiness is invalid' },
  );

  const coordinatedReady = clone(current);
  coordinatedReady.capabilities = coordinatedReady.capabilities.map((item) => (
    item.status === 'blocked' ? { ...item, status: 'ready', blockerCode: null } : item
  ));
  coordinatedReady.blockedCapabilityIds = [];
  coordinatedReady.readyForBenchmark = true;
  assert.throws(
    () => parseMvpBenchmarkReadiness(coordinatedReady, options),
    { name: 'TypeError', message: 'MVP benchmark readiness is invalid' },
  );

  const missingChecklistItem = clone(current);
  missingChecklistItem.checklist.pop();
  assert.throws(
    () => parseMvpBenchmarkReadiness(missingChecklistItem, options),
    { name: 'TypeError', message: 'MVP benchmark readiness is invalid' },
  );

  const reordered = clone(current);
  [reordered.capabilities[0], reordered.capabilities[1]] = [
    reordered.capabilities[1], reordered.capabilities[0],
  ];
  assert.throws(
    () => parseMvpBenchmarkReadiness(reordered, options),
    { name: 'TypeError', message: 'MVP benchmark readiness is invalid' },
  );
});

test('readiness parser rejects Proxy and accessor inputs without executing traps', (t) => {
  const database = createMigratedV2Database(t);
  const runtime = productionRuntimeFixture();
  const options = readinessOptions(runtime, database);
  const current = clone(createMvpBenchmarkReadiness(options));
  let proxyReads = 0;
  const proxyCapabilities = new Proxy(current.capabilities, {
    get() {
      proxyReads += 1;
      throw new Error('synthetic-proxy-sentinel');
    },
    getOwnPropertyDescriptor() {
      proxyReads += 1;
      throw new Error('synthetic-proxy-sentinel');
    },
    ownKeys() {
      proxyReads += 1;
      throw new Error('synthetic-proxy-sentinel');
    },
  });
  assert.throws(
    () => parseMvpBenchmarkReadiness(
      { ...current, capabilities: proxyCapabilities },
      options,
    ),
    { name: 'TypeError', message: 'MVP benchmark readiness is invalid' },
  );
  assert.equal(proxyReads, 0);

  let accessorReads = 0;
  const hostile = clone(current);
  Object.defineProperty(hostile, 'schemaVersion', {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error('synthetic-accessor-sentinel');
    },
  });
  assert.throws(
    () => parseMvpBenchmarkReadiness(hostile, options),
    { name: 'TypeError', message: 'MVP benchmark readiness is invalid' },
  );
  assert.equal(accessorReads, 0);
});

test('public Schema accepts the runtime projection and never accepts completion', (t) => {
  const database = createMigratedV2Database(t);
  const runtime = productionRuntimeFixture();
  const readiness = createMvpBenchmarkReadiness(readinessOptions(runtime, database));
  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v9/mvp-benchmark-readiness.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(readiness), true, JSON.stringify(validate.errors));

  const forged = clone(readiness);
  forged.mvpComplete = true;
  assert.equal(validate(forged), false);

  const extraChecklist = clone(readiness);
  extraChecklist.checklist.push(extraChecklist.checklist[0]);
  assert.equal(validate(extraChecklist), false);

  const missingBlockedIdentity = clone(readiness);
  missingBlockedIdentity.blockedCapabilityIds = missingBlockedIdentity.blockedCapabilityIds.slice(1);
  assert.equal(validate(missingBlockedIdentity), false);
});

test('actual createApp exposes conservative readiness without external calls', async () => {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-benchmark-readiness-'));
  const configDir = path.join(tempRoot, 'configs');
  const databasePath = path.join(tempRoot, 'data', 'benchmark.sqlite').replace(/\\/gu, '/');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/gu, '/');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), [
    'app:',
    '  name: LocalMiniDrama-MVP-Benchmark',
    '  version: 0.0.0-test',
    'server:',
    '  port: 0',
    '  host: 127.0.0.1',
    '  insecure_tls: false',
    'database:',
    '  type: sqlite',
    `  path: "${databasePath}"`,
    'storage:',
    `  local_path: "${storagePath}"`,
    '',
  ].join('\n'), 'utf8');

  let server = null;
  let closeDatabase = () => {};
  try {
    process.chdir(tempRoot);
    const { createApp } = require('../src/app');
    const { closeDb } = require('../src/db');
    closeDatabase = closeDb;
    const created = createApp();
    await created.startupRecoveryPromise;
    server = await new Promise((resolve, reject) => {
      const instance = created.app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    const address = server.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/v2/mvp-benchmark/readiness`,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.mvpComplete, false);
    assert.equal(body.data.readyForBenchmark, false);
    assert.deepEqual(body.data.pendingCapabilityIds, [
      'windows-release-evidence',
      'human-av-review',
    ]);
    assert.deepEqual(body.data.blockedCapabilityIds, [
      'narrative-execution',
      'character-candidate-execution',
      'ready-gpu-connection',
      'h3-local-execution',
      'tts-execution',
    ]);
    assert.equal(typeof created.runtime.h3Local.execute, 'function');

    insertReadyConnection(created.db);
    const readyConnectionResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/v2/mvp-benchmark/readiness`,
    );
    const readyConnectionBody = await readyConnectionResponse.json();
    assert.equal(readyConnectionResponse.status, 200);
    assert.deepEqual(readyConnectionBody.data.blockedCapabilityIds, [
      'narrative-execution',
      'character-candidate-execution',
      'tts-execution',
    ]);
    assert.equal(
      readyConnectionBody.data.capabilities.find(
        (capability) => capability.id === 'h3-local-execution',
      ).status,
      'ready',
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
