const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const {
  V2CompatibilityError,
  createV2CompatibilityAdapter,
} = require('../src/adapters/v2/compat');
const { LocalStorageProvider } = require('../src/adapters/v2/storage');
const { runV2Migrations } = require('../src/db/v2');

const LEGACY_SCHEMA_SQL = fs.readFileSync(
  path.resolve(__dirname, '../migrations/01_init.sql'),
  'utf8',
);
const V2_MIGRATIONS_DIR = path.resolve(__dirname, '../migrations/v2');
const CORE_FIXTURES = Object.freeze({
  dramas: { id: 101, insert: "INSERT INTO dramas (id, title) VALUES (101, 'legacy drama')" },
  episodes: { id: 201, insert: "INSERT INTO episodes (id, drama_id, title) VALUES (201, 101, 'legacy episode')" },
  characters: { id: 301, insert: "INSERT INTO characters (id, drama_id, name) VALUES (301, 101, 'legacy character')" },
  scenes: { id: 401, insert: "INSERT INTO scenes (id, drama_id, episode_id, location) VALUES (401, 101, 201, 'legacy scene')" },
  props: { id: 501, insert: "INSERT INTO props (id, drama_id, name) VALUES (501, 101, 'legacy prop')" },
  storyboards: { id: 601, insert: "INSERT INTO storyboards (id, episode_id, scene_id, title) VALUES (601, 201, 401, 'legacy board')" },
});

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-v2-compat-'));
  const projectRoot = path.join(root, 'legacy-project');
  fs.mkdirSync(projectRoot);
  const databasePath = path.join(root, 'legacy.sqlite');
  let database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  database.exec(LEGACY_SCHEMA_SQL);
  for (const fixture of Object.values(CORE_FIXTURES)) database.exec(fixture.insert);
  runV2Migrations(database, { migrationsDir: V2_MIGRATIONS_DIR });

  t.after(() => {
    if (database?.open) {
      if (database.inTransaction) database.exec('ROLLBACK');
      database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    databasePath,
    projectRoot,
    get database() { return database; },
    reopen() {
      database.close();
      database = new Database(databasePath);
      database.pragma('foreign_keys = ON');
      return database;
    },
  };
}

function assertMappingFailure(callback) {
  assert.throws(callback, (error) => (
    error instanceof V2CompatibilityError
    && error.code === 'V2_COMPATIBILITY_MAPPING_FAILED'
    && error.message === 'The legacy value cannot be mapped safely'
    && !JSON.stringify(error).includes('secret')
  ));
}

function assertStorageFailure(callback, excludedText = '') {
  assert.throws(callback, (error) => (
    error instanceof V2CompatibilityError
    && error.code === 'V2_COMPATIBILITY_STORAGE_FAILED'
    && error.message === 'The compatibility data source is unavailable'
    && (!excludedText || !String(error).includes(excludedText))
    && (!excludedText || !JSON.stringify(error).includes(excludedText))
  ));
}

test('a migrated v1 project reopens and maps all core integer IDs to stable UUIDs', (t) => {
  const workspace = createWorkspace(t);
  const beforeClose = Object.fromEntries(Object.entries(CORE_FIXTURES).map(([entity, fixture]) => [
    entity,
    workspace.database.prepare(`SELECT uid FROM ${entity} WHERE id = ?`).get(fixture.id).uid,
  ]));

  workspace.reopen();
  const compatibility = createV2CompatibilityAdapter({
    database: workspace.database,
    projectRoot: workspace.projectRoot,
  });

  for (const [entity, fixture] of Object.entries(CORE_FIXTURES)) {
    const byLegacyId = compatibility.resolveCoreReference({ entity, legacyId: fixture.id });
    assert.deepEqual(byLegacyId, { entity, legacyId: fixture.id, uid: beforeClose[entity] });
    assert.equal(Object.isFrozen(byLegacyId), true);
    assert.deepEqual(compatibility.resolveCoreReference({ entity, uid: beforeClose[entity] }), byLegacyId);
    assert.deepEqual(
      compatibility.resolveCoreReference({ entity, legacyId: fixture.id, uid: beforeClose[entity] }),
      byLegacyId,
    );
  }
});

test('core mapping rejects ambiguity, malformed values, missing rows, and mismatches without guessing', (t) => {
  const workspace = createWorkspace(t);
  const compatibility = createV2CompatibilityAdapter({
    database: workspace.database,
    projectRoot: workspace.projectRoot,
  });
  const dramaUid = workspace.database.prepare('SELECT uid FROM dramas WHERE id = 101').get().uid;
  const episodeUid = workspace.database.prepare('SELECT uid FROM episodes WHERE id = 201').get().uid;

  const invalidInputs = [
    {},
    { entity: 'dramas' },
    { entity: 'users', legacyId: 101 },
    { entity: '__proto__', legacyId: 101 },
    { entity: 'toString', legacyId: 101 },
    { entity: 'dramas', legacyId: '101' },
    { entity: 'dramas', legacyId: 1.1 },
    { entity: 'dramas', legacyId: 0 },
    { entity: 'dramas', legacyId: 101, extra: true },
    { entity: 'dramas', uid: dramaUid.toUpperCase() },
  ];
  for (const input of invalidInputs) assertMappingFailure(() => compatibility.resolveCoreReference(input));
  assertMappingFailure(() => compatibility.resolveCoreReference({ entity: 'dramas', legacyId: 999999 }));
  assertMappingFailure(() => compatibility.resolveCoreReference({ entity: 'dramas', uid: episodeUid }));
  assertMappingFailure(() => compatibility.resolveCoreReference({ entity: 'dramas', legacyId: 101, uid: episodeUid }));
});

test('legacy absolute paths map to canonical frozen locators without exposing local roots', async (t) => {
  const workspace = createWorkspace(t);
  const assetPath = path.join(workspace.projectRoot, 'assets', 'legacy', 'scene-001.png');
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, Buffer.from('synthetic-asset'));
  const compatibility = createV2CompatibilityAdapter({
    database: workspace.database,
    projectRoot: workspace.projectRoot,
  });

  const locator = compatibility.mapLegacyAbsolutePath({
    absolutePath: assetPath,
    logicalSegments: ['scenes', 'legacy', 'scene-001'],
  });
  assert.deepEqual(locator, {
    storageProvider: 'local',
    logicalUri: 'asset://scenes/legacy/scene-001',
    relativePath: 'assets/legacy/scene-001.png',
  });
  assert.equal(Object.isFrozen(locator), true);
  assert.equal(Object.hasOwn(locator, 'absolutePath'), false);
  assert.equal(Object.hasOwn(locator, 'projectRoot'), false);
  assert.equal(JSON.stringify(locator).includes(workspace.projectRoot), false);

  const storage = new LocalStorageProvider({ projectRoot: workspace.projectRoot });
  assert.equal(Buffer.from(await storage.read(locator)).toString('utf8'), 'synthetic-asset');
});

test('legacy path mapping rejects a project root replaced after adapter construction', (t) => {
  const workspace = createWorkspace(t);
  const compatibility = createV2CompatibilityAdapter({
    database: workspace.database,
    projectRoot: workspace.projectRoot,
  });
  const movedRoot = `${workspace.projectRoot}-original`;
  fs.renameSync(workspace.projectRoot, movedRoot);
  fs.mkdirSync(workspace.projectRoot);
  const replacementAsset = path.join(workspace.projectRoot, 'replacement.bin');
  fs.writeFileSync(replacementAsset, Buffer.from('replacement'));

  assertMappingFailure(() => compatibility.mapLegacyAbsolutePath({
    absolutePath: replacementAsset,
    logicalSegments: ['legacy', 'replacement'],
  }));
});

test('legacy path mapping rejects missing, outside, ambiguous, directory, and linked paths', (t) => {
  const workspace = createWorkspace(t);
  const outsidePath = path.join(path.dirname(workspace.projectRoot), 'outside.bin');
  fs.writeFileSync(outsidePath, Buffer.from('outside'));
  const directoryPath = path.join(workspace.projectRoot, 'directory');
  fs.mkdirSync(directoryPath);
  const canonicalPath = path.join(workspace.projectRoot, 'canonical.bin');
  fs.writeFileSync(canonicalPath, Buffer.from('canonical'));
  const compatibility = createV2CompatibilityAdapter({
    database: workspace.database,
    projectRoot: workspace.projectRoot,
  });
  const logicalSegments = ['legacy', 'asset'];

  const invalidPaths = [
    outsidePath,
    path.join(workspace.projectRoot, 'missing.bin'),
    directoryPath,
    'assets/relative.bin',
    `${workspace.projectRoot}${path.sep}assets${path.sep}..${path.sep}canonical.bin`,
    `${workspace.projectRoot}${path.sep}.${path.sep}canonical.bin`,
    `${canonicalPath}${path.sep}`,
  ];
  for (const absolutePath of invalidPaths) {
    assertMappingFailure(() => compatibility.mapLegacyAbsolutePath({ absolutePath, logicalSegments }));
  }

  const linkPath = path.join(workspace.projectRoot, 'linked.bin');
  try {
    fs.symlinkSync(outsidePath, linkPath, 'file');
    assertMappingFailure(() => compatibility.mapLegacyAbsolutePath({ absolutePath: linkPath, logicalSegments }));
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
  }
});

test('compatibility requests reject accessors without reading caller-controlled values', (t) => {
  const workspace = createWorkspace(t);
  const compatibility = createV2CompatibilityAdapter({
    database: workspace.database,
    projectRoot: workspace.projectRoot,
  });
  let getterReads = 0;
  const hostile = { entity: 'dramas' };
  Object.defineProperty(hostile, 'legacyId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 101;
    },
  });

  assertMappingFailure(() => compatibility.resolveCoreReference(hostile));
  assert.equal(getterReads, 0);
});

test('database rows are snapshotted from exact own data fields behind the fixed error boundary', (t) => {
  const workspace = createWorkspace(t);
  const uid = workspace.database.prepare('SELECT uid FROM dramas WHERE id = 101').get().uid;
  const canary = 'hostile-row-canary';

  let throwingGetterReads = 0;
  const throwingRow = {};
  Object.defineProperty(throwingRow, 'id', {
    enumerable: true,
    get() {
      throwingGetterReads += 1;
      throw new Error(canary);
    },
  });
  Object.defineProperty(throwingRow, 'uid', { enumerable: true, value: uid });
  const throwingAdapter = createV2CompatibilityAdapter({
    database: { prepare: () => ({ get: () => throwingRow }) },
    projectRoot: workspace.projectRoot,
  });
  assert.throws(
    () => throwingAdapter.resolveCoreReference({ entity: 'dramas', legacyId: 101 }),
    (error) => (
      error.code === 'V2_COMPATIBILITY_MAPPING_FAILED'
      && !String(error).includes(canary)
      && !JSON.stringify(error).includes(canary)
    ),
  );
  assert.equal(throwingGetterReads, 0);

  const proxyRow = new Proxy({}, {
    getPrototypeOf() { throw new Error(canary); },
  });
  const proxyAdapter = createV2CompatibilityAdapter({
    database: { prepare: () => ({ get: () => proxyRow }) },
    projectRoot: workspace.projectRoot,
  });
  assertStorageFailure(
    () => proxyAdapter.resolveCoreReference({ entity: 'dramas', legacyId: 101 }),
    canary,
  );

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const revokedAdapter = createV2CompatibilityAdapter({
    database: { prepare: () => ({ get: () => revoked.proxy }) },
    projectRoot: workspace.projectRoot,
  });
  assertStorageFailure(() => revokedAdapter.resolveCoreReference({ entity: 'dramas', legacyId: 101 }));

  const inheritedRow = Object.create({ id: 101, uid });
  const inheritedAdapter = createV2CompatibilityAdapter({
    database: { prepare: () => ({ get: () => inheritedRow }) },
    projectRoot: workspace.projectRoot,
  });
  assertMappingFailure(() => inheritedAdapter.resolveCoreReference({ entity: 'dramas', legacyId: 101 }));

  let getterReads = 0;
  const accessorRow = { id: 101 };
  Object.defineProperty(accessorRow, 'uid', {
    enumerable: true,
    get() {
      getterReads += 1;
      return uid;
    },
  });
  const accessorAdapter = createV2CompatibilityAdapter({
    database: { prepare: () => ({ get: () => accessorRow }) },
    projectRoot: workspace.projectRoot,
  });
  assertMappingFailure(() => accessorAdapter.resolveCoreReference({ entity: 'dramas', legacyId: 101 }));
  assert.equal(getterReads, 0);
});

test('caller-created and replayed compatibility errors cannot forge internal failure classification', (t) => {
  const workspace = createWorkspace(t);
  const compatibility = createV2CompatibilityAdapter({
    database: workspace.database,
    projectRoot: workspace.projectRoot,
  });
  const publicError = new V2CompatibilityError('V2_COMPATIBILITY_STORAGE_FAILED');
  const publicForgery = new Proxy({}, {
    ownKeys() { throw publicError; },
  });
  assert.throws(
    () => compatibility.resolveCoreReference(publicForgery),
    (error) => error !== publicError && error.code === 'V2_COMPATIBILITY_MAPPING_FAILED',
  );

  const failingDatabaseAdapter = createV2CompatibilityAdapter({
    database: { prepare: () => ({ get: () => { throw new Error('database unavailable'); } }) },
    projectRoot: workspace.projectRoot,
  });
  let capturedInternalError;
  try {
    failingDatabaseAdapter.resolveCoreReference({ entity: 'dramas', legacyId: 101 });
  } catch (error) {
    capturedInternalError = error;
  }
  assert.equal(capturedInternalError?.code, 'V2_COMPATIBILITY_STORAGE_FAILED');
  const replay = new Proxy({}, {
    getPrototypeOf() { throw capturedInternalError; },
  });
  assert.throws(
    () => compatibility.resolveCoreReference(replay),
    (error) => error !== capturedInternalError && error.code === 'V2_COMPATIBILITY_MAPPING_FAILED',
  );
});

test('Windows project-root casing differences map the same physical legacy project', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const workspace = createWorkspace(t);
  const assetPath = path.join(workspace.projectRoot, 'assets', 'legacy', 'case.bin');
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, Buffer.from('case-compatible'));
  const alternateRoot = workspace.projectRoot.replace(/legacy-project$/, 'LEGACY-PROJECT');
  assert.notEqual(alternateRoot, workspace.projectRoot);
  const compatibility = createV2CompatibilityAdapter({
    database: workspace.database,
    projectRoot: alternateRoot,
  });
  const locator = compatibility.mapLegacyAbsolutePath({
    absolutePath: assetPath.toUpperCase(),
    logicalSegments: ['legacy', 'case'],
  });
  assert.equal(locator.relativePath, 'assets/legacy/case.bin');
  const storage = new LocalStorageProvider({ projectRoot: workspace.projectRoot });
  assert.equal(Buffer.from(await storage.read(locator)).toString('utf8'), 'case-compatible');
});

test('v2 adapter modules keep legacy identifiers and absolute-path inputs inside compat', () => {
  const adaptersRoot = path.resolve(__dirname, '../src/adapters/v2');
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
    }
  };
  visit(adaptersRoot);

  const outsideCompatibilityBoundary = files.filter((filename) => (
    !filename.startsWith(`${path.join(adaptersRoot, 'compat')}${path.sep}`)
  ));
  for (const filename of outsideCompatibilityBoundary) {
    const source = fs.readFileSync(filename, 'utf8');
    assert.doesNotMatch(source, /\blegacyId\b|\babsolutePath\b|\blocal_path\b/, filename);
  }
});
