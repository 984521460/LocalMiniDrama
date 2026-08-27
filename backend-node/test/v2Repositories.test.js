const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
  createV2Repositories,
} = require('../src/repositories/v2');
const {
  createWorkflowPlanFixture,
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

test('source repository writes documents and blocks atomically and maps JSON rows', (t) => {
  const database = createMigratedV2Database(t);
  const repositories = createV2Repositories(database);
  const dramaUid = uid(2000);
  insertDrama(database, dramaUid);

  const created = repositories.sources.createDocumentWithBlocks({
    document: {
      uid: uid(2001),
      dramaUid,
      sourceType: 'markdown',
      originalName: 'story.md',
      encoding: 'utf-8',
      contentSha256: SHA_A,
      fullText: '# Chapter\nBody',
    },
    blocks: [
      {
        uid: uid(2002),
        ordinal: 0,
        headingPath: ['Chapter'],
        charStart: 0,
        charEnd: 9,
        text: '# Chapter',
        textSha256: SHA_B,
      },
    ],
  });
  assert.equal(created.document.dramaUid, dramaUid);
  assert.deepEqual(created.blocks[0].headingPath, ['Chapter']);
  assert.equal(Object.hasOwn(created.document, 'drama_uid'), false);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.blocks[0].headingPath), true);
  assert.deepEqual(repositories.sources.listBlocks(created.document.uid), created.blocks);

  assert.throws(
    () => repositories.sources.getDocument(uid(2099)),
    (error) => error instanceof V2RepositoryNotFoundError && error.code === 'V2_REPOSITORY_NOT_FOUND',
  );

  assert.throws(
    () => repositories.sources.createDocumentWithBlocks({
      document: {
        uid: uid(2010),
        dramaUid,
        sourceType: 'txt',
        originalName: 'duplicate.txt',
        encoding: 'utf-8',
        contentSha256: SHA_B,
        fullText: 'duplicate ordinals',
      },
      blocks: [
        { uid: uid(2011), ordinal: 0, headingPath: [], charStart: 0, charEnd: 4, text: 'dupe', textSha256: SHA_A },
        { uid: uid(2012), ordinal: 0, headingPath: [], charStart: 5, charEnd: 9, text: 'dupe', textSha256: SHA_B },
      ],
    }),
    V2RepositoryConflictError,
  );
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_documents WHERE uid = ?').get(uid(2010)).count, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_blocks WHERE document_uid = ?').get(uid(2010)).count, 0);
});

test('asset repository creates versions and changes the current version in one transaction', (t) => {
  const database = createMigratedV2Database(t);
  const repositories = createV2Repositories(database);
  const ownerUid = uid(2100);
  insertDrama(database, ownerUid);

  const asset = repositories.assets.create({
    uid: uid(2101),
    ownerType: 'drama',
    ownerUid,
    assetType: 'poster',
    status: 'draft',
  });
  const version = repositories.assets.addVersion({
    uid: uid(2102),
    assetUid: asset.uid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${ownerUid}/poster/${uid(2102)}`,
    relativePath: `projects/${ownerUid}/assets/${uid(2102)}.png`,
    sha256: SHA_A,
    mimeType: 'image/png',
    width: 1080,
    height: 1920,
    durationMs: null,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });

  assert.equal(version.assetUid, asset.uid);
  const aggregate = repositories.assets.getWithVersions(asset.uid);
  assert.equal(aggregate.asset.currentVersionUid, version.uid);
  assert.deepEqual(aggregate.versions.map((item) => item.uid), [version.uid]);
  assert.throws(() => repositories.assets.get(uid(2199)), V2RepositoryNotFoundError);

  const deleted = repositories.assets.softDelete(asset.uid, { expectedStatus: 'ready' });
  assert.equal(deleted.status, 'deleted');
  assert.equal(repositories.assets.getWithVersions(asset.uid).versions.length, 1);
  assert.deepEqual(repositories.assets.listByOwner('drama', ownerUid), []);
  assert.deepEqual(repositories.assets.listByOwner('drama', ownerUid, { includeDeleted: true }).map((item) => item.uid), [asset.uid]);
  assert.throws(
    () => repositories.assets.softDelete(asset.uid, { expectedStatus: 'ready' }),
    V2RepositoryConflictError,
  );
});

test('workflow repository saves a graph atomically and returns domain-shaped JSON snapshots', (t) => {
  const database = createMigratedV2Database(t);
  const repositories = createV2Repositories(database);
  const dramaUid = uid(2200);
  insertDrama(database, dramaUid);

  const graph = repositories.workflows.createGraph({
    definition: {
      uid: uid(2201), dramaUid, name: 'Main workflow', version: 1, status: 'draft', description: null,
    },
    nodes: [
      { uid: uid(2202), nodeType: 'source', position: { x: 0, y: 0 }, config: {}, domainRefType: null, domainRefUid: null, status: 'ready' },
      { uid: uid(2203), nodeType: 'asset', position: { x: 200, y: 0 }, config: { kind: 'poster' }, domainRefType: null, domainRefUid: null, status: 'ready' },
    ],
    edges: [
      { uid: uid(2204), sourceNodeUid: uid(2202), sourcePort: 'out', targetNodeUid: uid(2203), targetPort: 'in' },
    ],
  });
  assert.equal(graph.definition.dramaUid, dramaUid);
  assert.deepEqual(graph.nodes[1].config, { kind: 'poster' });
  assert.deepEqual(repositories.workflows.getGraph(graph.definition.uid), graph);

  assert.throws(
    () => repositories.workflows.createGraph({
      definition: { uid: uid(2210), dramaUid, name: 'Broken', version: 1, status: 'draft', description: null },
      nodes: [
        { uid: uid(2211), nodeType: 'source', position: {}, config: {}, domainRefType: null, domainRefUid: null, status: 'ready' },
      ],
      edges: [
        { uid: uid(2212), sourceNodeUid: uid(2211), sourcePort: 'out', targetNodeUid: uid(2299), targetPort: 'in' },
      ],
    }),
    V2RepositoryConflictError,
  );
  assert.equal(database.prepare('SELECT count(*) AS count FROM workflow_definitions WHERE uid = ?').get(uid(2210)).count, 0);
});

test('selection, manifest, workflow run, node run, and export tables use explicit repository methods', (t) => {
  const database = createMigratedV2Database(t);
  const repositories = createV2Repositories(database);
  const dramaUid = uid(2250);
  insertDrama(database, dramaUid);

  const source = repositories.sources.createDocumentWithBlocks({
    document: {
      uid: uid(2251), dramaUid, sourceType: 'txt', originalName: 'selection.txt', encoding: 'utf-8',
      contentSha256: SHA_A, fullText: 'Alpha\nBeta',
    },
    blocks: [
      { uid: uid(2252), ordinal: 0, headingPath: [], charStart: 0, charEnd: 5, text: 'Alpha', textSha256: SHA_A },
      { uid: uid(2253), ordinal: 1, headingPath: [], charStart: 6, charEnd: 10, text: 'Beta', textSha256: SHA_B },
    ],
  });
  const selection = repositories.sources.createSelection({
    uid: uid(2254),
    documentUid: source.document.uid,
    startBlockUid: source.blocks[0].uid,
    endBlockUid: source.blocks[1].uid,
    startOffset: 0,
    endOffset: 4,
    selectedTextSha256: SHA_B,
  });
  assert.equal(repositories.sources.getSelection(selection.uid).documentUid, source.document.uid);

  const graph = repositories.workflows.createGraph({
    definition: { uid: uid(2255), dramaUid, name: 'Execution graph', version: 1, status: 'active', description: null },
    nodes: [
      { uid: uid(2256), nodeType: 'source', position: { x: 0, y: 0 }, config: { selectionUid: selection.uid }, domainRefType: 'source_selection', domainRefUid: selection.uid, status: 'ready' },
    ],
    edges: [],
  });
  const manifest = repositories.workflows.createManifest({
    uid: uid(2257),
    manifestId: 'h3-repository-fixture',
    version: '1.0.0',
    engine: 'comfyui',
    workflowFile: 'workflows/h3-fixture.json',
    workflowSha256: SHA_A,
    modelFamily: 'h3',
    requirements: [{ type: 'model', id: 'h3' }],
    inputs: { prompt: 'text' },
    outputs: { video: 'file' },
    validation: { valid: true },
    status: 'validated',
  });
  assert.deepEqual(repositories.workflows.findManifest(manifest.manifestId, manifest.version).requirements, [{ type: 'model', id: 'h3' }]);

  const workflowPlan = createWorkflowPlanFixture(
    graph.definition.uid,
    [graph.nodes[0].uid],
    graph.definition.graphRevision,
  );
  const workflowRun = repositories.runs.createWorkflowWithNodes({
    run: {
      uid: uid(2258), workflowUid: graph.definition.uid, graphSnapshot: workflowPlan,
      graphHash: workflowPlan.graphHash, graphRevision: workflowPlan.graphRevision,
      triggerType: 'selection', status: 'queued',
    },
    nodes: [
      { uid: uid(2259), nodeUid: graph.nodes[0].uid, ordinal: 0, inputSnapshot: {}, output: null, cacheKey: null, status: 'queued' },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(workflowRun.run.graphSnapshot)), JSON.parse(JSON.stringify(workflowPlan)));
  assert.deepEqual(workflowRun.nodes[0].inputSnapshot, {});

  const exportRun = repositories.runs.createExport({
    uid: uid(2260),
    dramaUid,
    workflowRunUid: workflowRun.run.uid,
    timelineSnapshot: { clips: [] },
    encoding: { codec: 'h264' },
    audio: {},
    subtitle: {},
    outputAssetVersionUid: null,
    validation: { playable: false },
    status: 'queued',
  });
  assert.deepEqual(exportRun.timelineSnapshot, { clips: [] });
  assert.equal(repositories.runs.getWorkflowWithNodes(workflowRun.run.uid).nodes.length, 1);
});

test('run repository uses optimistic status transitions and distinguishes stale from missing rows', (t) => {
  const database = createMigratedV2Database(t);
  const repositories = createV2Repositories(database);
  const ownerUid = uid(2300);
  insertDrama(database, ownerUid);
  const run = repositories.runs.createGeneration({
    uid: uid(2301),
    ownerType: 'drama',
    ownerUid,
    provider: 'comfyui',
    model: 'h3',
    seed: 42,
    parameters: { steps: 4 },
    input: { prompt: 'safe fixture' },
    promptVersionUid: null,
    status: 'queued',
  });
  assert.deepEqual(run.parameters, { steps: 4 });

  const running = repositories.runs.transitionGenerationStatus({
    uid: run.uid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  assert.equal(running.status, 'running');
  assert.throws(
    () => repositories.runs.transitionGenerationStatus({
      uid: run.uid,
      expectedStatus: 'queued',
      nextStatus: 'succeeded',
    }),
    (error) => error instanceof V2RepositoryConflictError && error.code === 'V2_REPOSITORY_CONFLICT',
  );
  assert.throws(
    () => repositories.runs.transitionGenerationStatus({
      uid: uid(2399), expectedStatus: 'queued', nextStatus: 'running',
    }),
    V2RepositoryNotFoundError,
  );
});

test('remote repository preserves opaque credentials and prompt identity through explicit methods', (t) => {
  const database = createMigratedV2Database(t);
  const repositories = createV2Repositories(database);
  const connection = repositories.remote.createConnection({
    uid: uid(2400),
    name: 'GPU worker',
    host: 'workspace.example.invalid',
    port: 22,
    username: 'worker',
    hostFingerprint: 'SHA256:fixture',
    credentialRef: `credential:v1:${uid(2401)}`,
    status: 'ready',
  });
  assert.match(connection.credentialRef, /^credential:v1:/);
  assert.throws(
    () => repositories.remote.createConnection({
      uid: uid(2410),
      name: 'Unsafe worker',
      host: 'workspace.example.invalid',
      port: 22,
      username: 'worker',
      hostFingerprint: null,
      credentialRef: `credential:v1:${uid(2411)}`,
      status: 'ready',
      password: 'must-never-be-accepted',
    }),
    /unsupported field.*password/i,
  );

  const task = repositories.remote.createTask({
    uid: uid(2402),
    connectionUid: connection.uid,
    workflowRunUid: null,
    provider: 'comfyui',
    promptId: null,
    remoteRelativeDir: 'jobs/repository-task',
    stage: 'prepared',
    status: 'queued',
  });
  const assigned = repositories.remote.assignPrompt(task.uid, 'prompt-repository-1');
  assert.equal(assigned.promptId, 'prompt-repository-1');
  assert.throws(
    () => repositories.remote.assignPrompt(task.uid, 'prompt-repository-2'),
    V2RepositoryConflictError,
  );
});

test('repository transaction callback is synchronous and rolls back all aggregate writes', (t) => {
  const database = createMigratedV2Database(t);
  const repositories = createV2Repositories(database);
  const dramaUid = uid(2500);
  insertDrama(database, dramaUid);

  assert.throws(() => repositories.withTransaction((tx) => {
    tx.assets.create({
      uid: uid(2501), ownerType: 'drama', ownerUid: dramaUid, assetType: 'poster', status: 'draft',
    });
    tx.sources.createDocumentWithBlocks({
      document: {
        uid: uid(2502), dramaUid, sourceType: 'txt', originalName: 'rollback.txt', encoding: 'utf-8',
        contentSha256: SHA_A, fullText: 'rollback',
      },
      blocks: [{
        uid: uid(2503), ordinal: 0, headingPath: [], charStart: 0, charEnd: 8,
        text: 'rollback', textSha256: SHA_A,
      }],
    });
    throw new Error('rollback fixture');
  }), /rollback fixture/);
  assert.throws(
    () => repositories.withTransaction(async () => 'not allowed'),
    /must be synchronous/i,
  );
  assert.equal(database.prepare('SELECT count(*) AS count FROM assets WHERE uid = ?').get(uid(2501)).count, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_documents WHERE uid = ?').get(uid(2502)).count, 0);
});

test('transaction-scoped repositories expire before asynchronous continuations can write', async (t) => {
  const database = createMigratedV2Database(t);
  const repositories = createV2Repositories(database);
  const dramaUid = uid(2510);
  insertDrama(database, dramaUid);

  let releaseAsync;
  const asyncGate = new Promise((resolve) => { releaseAsync = resolve; });
  let finishAsync;
  const asyncFinished = new Promise((resolve) => { finishAsync = resolve; });
  let asyncContinuationError;

  assert.throws(() => repositories.withTransaction(async (tx) => {
    tx.assets.create({
      uid: uid(2511), ownerType: 'drama', ownerUid: dramaUid, assetType: 'poster', status: 'draft',
    });
    await asyncGate;
    try {
      tx.assets.create({
        uid: uid(2512), ownerType: 'drama', ownerUid: dramaUid, assetType: 'poster', status: 'draft',
      });
    } catch (error) {
      asyncContinuationError = error;
    } finally {
      finishAsync();
    }
  }), /must be synchronous/i);
  releaseAsync();
  await asyncFinished;

  assert.match(asyncContinuationError?.message || '', /transaction scope.*expired/i);
  assert.equal(database.prepare('SELECT count(*) AS count FROM assets WHERE uid IN (?, ?)').get(uid(2511), uid(2512)).count, 0);

  let thenCalled = false;
  assert.throws(() => repositories.withTransaction((tx) => {
    tx.assets.create({
      uid: uid(2513), ownerType: 'drama', ownerUid: dramaUid, assetType: 'poster', status: 'draft',
    });
    return {
      then() {
        thenCalled = true;
        queueMicrotask(() => tx.assets.create({
          uid: uid(2514), ownerType: 'drama', ownerUid: dramaUid, assetType: 'poster', status: 'draft',
        }));
      },
    };
  }), /must be synchronous/i);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thenCalled, false);
  assert.equal(database.prepare('SELECT count(*) AS count FROM assets WHERE uid IN (?, ?)').get(uid(2513), uid(2514)).count, 0);

  let microtaskError;
  let finishMicrotask;
  const microtaskFinished = new Promise((resolve) => { finishMicrotask = resolve; });
  repositories.withTransaction((tx) => {
    tx.assets.create({
      uid: uid(2515), ownerType: 'drama', ownerUid: dramaUid, assetType: 'poster', status: 'draft',
    });
    queueMicrotask(() => {
      try {
        tx.assets.create({
          uid: uid(2516), ownerType: 'drama', ownerUid: dramaUid, assetType: 'poster', status: 'draft',
        });
      } catch (error) {
        microtaskError = error;
      } finally {
        finishMicrotask();
      }
    });
  });
  await microtaskFinished;

  assert.match(microtaskError?.message || '', /transaction scope.*expired/i);
  assert.equal(database.prepare('SELECT count(*) AS count FROM assets WHERE uid = ?').get(uid(2515)).count, 1);
  assert.equal(database.prepare('SELECT count(*) AS count FROM assets WHERE uid = ?').get(uid(2516)).count, 0);
});

test('native Promises cannot hide their brand or rejection handler from transaction checks', (t) => {
  const database = createMigratedV2Database(t);
  const repositories = createV2Repositories(database);
  const dramaUid = uid(2520);
  insertDrama(database, dramaUid);

  const hiddenThen = Promise.resolve('hidden then');
  Object.defineProperty(hiddenThen, 'then', { configurable: true, value: undefined });
  assert.throws(() => repositories.withTransaction((tx) => {
    tx.assets.create({
      uid: uid(2521), ownerType: 'drama', ownerUid: dramaUid, assetType: 'poster', status: 'draft',
    });
    return hiddenThen;
  }), /must be synchronous/i);
  assert.equal(database.prepare('SELECT count(*) AS count FROM assets WHERE uid = ?').get(uid(2521)).count, 0);

  const hiddenCatch = Promise.reject(new Error('handled fixture rejection'));
  Promise.prototype.then.call(hiddenCatch, undefined, () => {});
  Object.defineProperty(hiddenCatch, 'catch', { configurable: true, value: null });
  assert.throws(
    () => repositories.withTransaction(() => hiddenCatch),
    /must be synchronous/i,
  );

  const crossRealm = vm.runInNewContext('Promise.reject(new Error("cross realm fixture rejection"))');
  Promise.prototype.then.call(crossRealm, undefined, () => {});
  Object.defineProperty(crossRealm, 'then', {
    configurable: true,
    get() {
      throw new Error('public then getter must not be read');
    },
  });
  assert.throws(
    () => repositories.withTransaction(() => crossRealm),
    /must be synchronous/i,
  );
});

test('not-found errors omit caller-controlled identifiers from structured output', (t) => {
  const database = createMigratedV2Database(t);
  const repositories = createV2Repositories(database);
  const callerValue = 'Bearer ultra-secret-value';
  let captured;

  try {
    repositories.assets.get(callerValue);
  } catch (error) {
    captured = error;
  }

  assert.ok(captured instanceof V2RepositoryNotFoundError);
  assert.equal(Object.hasOwn(captured, 'uid'), false);
  assert.equal(JSON.stringify(captured).includes(callerValue), false);
  assert.equal(captured.message.includes(callerValue), false);
});

test('row mappers fail closed when persisted JSON has the wrong domain shape', (t) => {
  const database = createMigratedV2Database(t);
  const repositories = createV2Repositories(database);
  const dramaUid = uid(2550);
  insertDrama(database, dramaUid);
  const source = repositories.sources.createDocumentWithBlocks({
    document: {
      uid: uid(2551), dramaUid, sourceType: 'txt', originalName: 'shape.txt', encoding: 'utf-8',
      contentSha256: SHA_A, fullText: 'shape',
    },
    blocks: [
      { uid: uid(2552), ordinal: 0, headingPath: [], charStart: 0, charEnd: 5, text: 'shape', textSha256: SHA_B },
    ],
  });
  const graph = repositories.workflows.createGraph({
    definition: { uid: uid(2553), dramaUid, name: 'Shape graph', version: 1, status: 'draft', description: null },
    nodes: [
      { uid: uid(2554), nodeType: 'shape', position: {}, config: {}, domainRefType: null, domainRefUid: null, status: 'ready' },
    ],
    edges: [],
  });

  database.pragma('ignore_check_constraints = ON');
  database.exec('DROP TRIGGER v2_source_blocks_immutable_content');
  database.prepare("UPDATE source_blocks SET heading_path_json = '{}' WHERE uid = ?").run(source.blocks[0].uid);
  database.prepare("UPDATE canvas_nodes SET config_json = '[]' WHERE uid = ?").run(graph.nodes[0].uid);
  database.pragma('ignore_check_constraints = OFF');

  assert.throws(() => repositories.sources.getBlock(source.blocks[0].uid), V2RepositoryDataError);
  assert.throws(() => repositories.workflows.getGraph(graph.definition.uid), V2RepositoryDataError);
});

test('v2 SQL and database-driver dependencies stay behind repository and migration boundaries', () => {
  const sourceRoot = path.resolve(__dirname, '../src');
  const domainRoot = path.resolve(__dirname, '../../packages/domain/src');
  const v2SqlPattern = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:source_documents|source_blocks|source_selections|assets|asset_versions|workflow_definitions|canvas_nodes|canvas_edges|workflow_manifests|generation_runs|workflow_runs|node_runs|export_runs|remote_connections|remote_tasks)\b/i;
  const violations = [];

  function visit(directory, callback) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, callback);
      else if (/\.[cm]?[jt]s$/.test(entry.name)) callback(target, fs.readFileSync(target, 'utf8'));
    }
  }

  visit(sourceRoot, (filename, source) => {
    const normalized = filename.replaceAll('\\', '/');
    const allowed = normalized.includes('/src/repositories/v2/')
      || normalized.includes('/src/db/v2/')
      || normalized.endsWith('/src/db/migrate.js')
      || normalized.endsWith('/src/db/legacyAssetTable.js')
      || normalized.endsWith('/src/services/assetService.js');
    if (!allowed && v2SqlPattern.test(source)) violations.push(path.relative(sourceRoot, filename));
  });
  visit(domainRoot, (filename, source) => {
    if (/better-sqlite3/.test(source)) violations.push(path.relative(domainRoot, filename));
  });

  assert.deepEqual(violations, []);
});
