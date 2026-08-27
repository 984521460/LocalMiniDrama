const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const { V2MigrationError, runV2Migrations } = require('../src/db/v2');

const CORE_TABLES = Object.freeze([
  'dramas',
  'episodes',
  'characters',
  'scenes',
  'props',
  'storyboards',
]);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PENDING_UID = '__v2_uid_pending__';
const ZERO_UUID = '00000000-0000-4000-8000-000000000000';
const V2_MIGRATIONS_DIR = path.resolve(__dirname, '../migrations/v2');
const FIRST_MIGRATION_PATH = path.join(V2_MIGRATIONS_DIR, '0001_add_core_uids.sql');
const LEGACY_SCHEMA_SQL = fs.readFileSync(
  path.resolve(__dirname, '../migrations/01_init.sql'),
  'utf8',
);
const CORE_INSERT_WITH_UID = Object.freeze({
  dramas: "INSERT INTO dramas (title, uid) VALUES ('uid probe', ?)",
  episodes: "INSERT INTO episodes (drama_id, title, uid) VALUES (101, 'uid probe', ?)",
  characters: "INSERT INTO characters (drama_id, name, uid) VALUES (101, 'uid probe', ?)",
  scenes: "INSERT INTO scenes (drama_id, episode_id, location, uid) VALUES (101, 201, 'uid probe', ?)",
  props: "INSERT INTO props (drama_id, name, uid) VALUES (101, 'uid probe', ?)",
  storyboards: "INSERT INTO storyboards (episode_id, scene_id, title, uid) VALUES (201, 401, 'uid probe', ?)",
});
const CORE_INSERT_WITHOUT_UID = Object.freeze({
  dramas: "INSERT INTO dramas (title) VALUES ('legacy create')",
  episodes: "INSERT INTO episodes (drama_id, title) VALUES (101, 'legacy create')",
  characters: "INSERT INTO characters (drama_id, name) VALUES (101, 'legacy create')",
  scenes: "INSERT INTO scenes (drama_id, episode_id, location) VALUES (101, 201, 'legacy create')",
  props: "INSERT INTO props (drama_id, name) VALUES (101, 'legacy create')",
  storyboards: "INSERT INTO storyboards (episode_id, scene_id, title) VALUES (201, 401, 'legacy create')",
});

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-v2-core-uids-'));
  const databases = new Set();
  t.after(() => {
    for (const database of databases) {
      if (!database.open) continue;
      if (database.inTransaction) database.exec('ROLLBACK');
      database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, databases };
}

function copyCoreUidMigration(workspace) {
  const migrationsDir = path.join(workspace.root, 'core-uid-migration');
  fs.mkdirSync(migrationsDir);
  fs.copyFileSync(FIRST_MIGRATION_PATH, path.join(migrationsDir, path.basename(FIRST_MIGRATION_PATH)));
  return migrationsDir;
}

function openDatabase(workspace, filename = 'project.sqlite') {
  const database = new Database(path.join(workspace.root, filename));
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 0');
  workspace.databases.add(database);
  return database;
}

function seedLegacyCoreRows(database) {
  database.exec(`
    INSERT INTO dramas (id, title) VALUES (101, 'legacy one'), (102, 'legacy two');
    INSERT INTO episodes (id, drama_id, title)
      VALUES (201, 101, 'episode one'), (202, 102, 'episode two');
    INSERT INTO characters (id, drama_id, name)
      VALUES (301, 101, 'character one'), (302, 102, 'character two');
    INSERT INTO scenes (id, drama_id, episode_id, location)
      VALUES (401, 101, 201, 'scene one'), (402, 102, 202, 'scene two');
    INSERT INTO props (id, drama_id, name)
      VALUES (501, 101, 'prop one'), (502, 102, 'prop two');
    INSERT INTO storyboards (id, episode_id, scene_id, title)
      VALUES (601, 201, 401, 'board one'), (602, 202, 402, 'board two');
  `);
}

function readCoreUids(database) {
  return Object.fromEntries(CORE_TABLES.map((table) => [
    table,
    database.prepare(`SELECT id, uid FROM ${table} ORDER BY id`).all(),
  ]));
}

function assertCoreUidIntegrity(database) {
  for (const table of CORE_TABLES) {
    const rows = database.prepare(`SELECT id, uid FROM ${table} ORDER BY id`).all();
    assert.equal(rows.length > 0, true, `${table} fixture must contain rows`);
    assert.equal(rows.every((row) => UUID_V4_PATTERN.test(row.uid)), true, `${table} must contain UUID v4 values`);
    assert.equal(new Set(rows.map((row) => row.uid)).size, rows.length, `${table} UIDs must be unique`);

    const indexes = database.prepare(`PRAGMA index_list(${table})`).all();
    const uidIndex = indexes.find((index) => index.name === `idx_v2_${table}_uid`);
    assert.equal(uidIndex?.unique, 1, `${table} must have a unique UID index`);

    const uidColumn = database.prepare(`PRAGMA table_info(${table})`).all()
      .find((column) => column.name === 'uid');
    assert.equal(uidColumn?.notnull, 1, `${table}.uid must be NOT NULL`);
    assert.equal(uidColumn?.dflt_value, `'${PENDING_UID}'`, `${table}.uid must use the compatibility sentinel`);
  }

  assert.equal(database.prepare(
    'SELECT count(*) AS count FROM _v2_uid_generation_candidates',
  ).get().count, 0, 'UID candidate staging must be empty outside a trigger');
  assert.equal(database.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = '_v2_core_uid_guard'",
  ).get().count, 0, 'migration guard must not persist');
  assert.equal(database.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'v2_%_uid_%'",
  ).get().count, CORE_TABLES.length * 3, 'each core table must own validation and fill triggers');
}

test('backfills canonical UUID v4 values while legacy integer IDs remain readable', (t) => {
  const workspace = createWorkspace(t);
  const migrationsDir = copyCoreUidMigration(workspace);
  let database = openDatabase(workspace);
  database.exec(LEGACY_SCHEMA_SQL);
  seedLegacyCoreRows(database);

  const first = runV2Migrations(database, { migrationsDir });
  const firstUids = readCoreUids(database);
  const second = runV2Migrations(database, { migrationsDir });

  assert.deepEqual(first.appliedVersions, [1]);
  assert.equal(first.currentVersion, 1);
  assert.deepEqual(second.appliedVersions, []);
  assert.equal(second.currentVersion, 1);
  assert.deepEqual(readCoreUids(database), firstUids);
  assertCoreUidIntegrity(database);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);

  database.close();
  database = openDatabase(workspace);
  assert.deepEqual(readCoreUids(database), firstUids);

  assert.deepEqual(database.prepare(`
    SELECT e.id, e.drama_id, d.title AS drama_title
    FROM episodes e
    JOIN dramas d ON d.id = e.drama_id
    WHERE e.id = ?
  `).get(201), { id: 201, drama_id: 101, drama_title: 'legacy one' });
  assert.deepEqual(database.prepare(`
    SELECT s.id, s.episode_id, s.scene_id
    FROM storyboards s
    WHERE s.id = ?
  `).get(601), { id: 601, episode_id: 201, scene_id: 401 });

  for (const [table, sql] of Object.entries(CORE_INSERT_WITHOUT_UID)) {
    const created = database.prepare(sql).run();
    const createdRow = database.prepare(`SELECT id, uid FROM ${table} WHERE id = ?`).get(created.lastInsertRowid);
    assert.equal(typeof createdRow.id, 'number');
    assert.match(createdRow.uid, UUID_V4_PATTERN, `${table} legacy inserts must receive a UID`);
  }

  const invalidUids = [
    'not-a-uuid',
    `${randomUUID()}\0tail`,
    Buffer.from(randomUUID()),
    randomUUID().toUpperCase(),
    '11111111-1111-1111-8111-111111111111',
    '00000000-0000-0000-0000-000000000000',
  ];
  for (const table of CORE_TABLES) {
    const insert = database.prepare(CORE_INSERT_WITH_UID[table]);
    for (const invalidUid of invalidUids) {
      assert.throws(
        () => insert.run(invalidUid),
        new RegExp(`invalid ${table} uid`, 'i'),
        `${table} must reject noncanonical text and BLOB identifiers`,
      );
    }

    const explicitUid = randomUUID();
    const explicit = insert.run(explicitUid);
    assert.equal(
      database.prepare(`SELECT uid FROM ${table} WHERE id = ?`).get(explicit.lastInsertRowid).uid,
      explicitUid,
      `${table} must retain an explicit canonical UUID v4`,
    );

    assert.throws(
      () => database.prepare(`UPDATE ${table} SET uid = NULL WHERE id = (SELECT min(id) FROM ${table})`).run(),
      new RegExp(`invalid ${table} uid`, 'i'),
    );
    for (const invalidUid of [`${randomUUID()}\0tail`, Buffer.from(randomUUID())]) {
      assert.throws(
        () => database.prepare(`UPDATE ${table} SET uid = ? WHERE id = (SELECT min(id) FROM ${table})`).run(invalidUid),
        new RegExp(`invalid ${table} uid`, 'i'),
        `${table} updates must reject NUL-suffixed text and BLOB identifiers`,
      );
    }
  }
  assert.throws(
    () => database.prepare('UPDATE dramas SET uid = ? WHERE id = ?').run(firstUids.dramas[1].uid, 101),
    /UNIQUE constraint failed: dramas\.uid/,
  );
});

test('all SQLite conflict algorithms fail closed when generated UID candidates collide', (t) => {
  const workspace = createWorkspace(t);
  const migrationsDir = copyCoreUidMigration(workspace);
  let database = openDatabase(workspace, 'conflict-algorithms.sqlite');
  database.exec(LEGACY_SCHEMA_SQL);
  seedLegacyCoreRows(database);
  runV2Migrations(database, { migrationsDir });

  const conflictClauses = ['', ' OR IGNORE', ' OR FAIL', ' OR ABORT', ' OR REPLACE'];
  for (const [table, baseSql] of Object.entries(CORE_INSERT_WITHOUT_UID)) {
    for (const conflictClause of conflictClauses) {
      const sql = baseSql.replace('INSERT INTO', `INSERT${conflictClause} INTO`);
      const created = database.prepare(sql).run();
      const createdUid = database.prepare(`SELECT uid FROM ${table} WHERE id = ?`)
        .get(created.lastInsertRowid).uid;
      assert.match(createdUid, UUID_V4_PATTERN, `${table}${conflictClause || ' default'} must generate a UID`);
    }
    database.prepare(CORE_INSERT_WITH_UID[table]).run(ZERO_UUID);
  }

  const originalDrama = database.prepare('SELECT id, title, uid FROM dramas WHERE id = 101').get();
  database.prepare(`
    INSERT INTO dramas (id, title) VALUES (101, 'upserted')
    ON CONFLICT(id) DO UPDATE SET title = excluded.title
  `).run();
  assert.equal(database.prepare('SELECT uid FROM dramas WHERE id = 101').get().uid, originalDrama.uid);

  database.function('randomblob', { deterministic: true }, (size) => Buffer.alloc(Number(size), 0));
  for (const [table, baseSql] of Object.entries(CORE_INSERT_WITHOUT_UID)) {
    for (const conflictClause of conflictClauses) {
      const sql = baseSql.replace('INSERT INTO', `INSERT${conflictClause} INTO`);
      const beforeCount = database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
      assert.throws(
        () => database.prepare(sql).run(),
        new RegExp(`failed to generate unique ${table} uid`, 'i'),
        `${table}${conflictClause || ' default'} must roll back a generated UID collision`,
      );
      assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, beforeCount);
      assert.equal(database.prepare(`
        SELECT count(*) AS count FROM ${table}
        WHERE uid IS NULL OR uid = ?
      `).get(PENDING_UID).count, 0, `${table} must not retain a missing or pending UID`);
    }
  }

  assert.throws(
    () => database.prepare(`
      INSERT INTO dramas (id, title) VALUES (99999, 'new upsert')
      ON CONFLICT(id) DO UPDATE SET title = excluded.title
    `).run(),
    /failed to generate unique dramas uid/i,
  );
  assert.equal(database.prepare('SELECT count(*) AS count FROM dramas WHERE id = 99999').get().count, 0);

  const beforeReplace = database.prepare('SELECT id, title, uid FROM dramas WHERE id = 101').get();
  assert.throws(
    () => database.prepare("INSERT OR REPLACE INTO dramas (id, title) VALUES (101, 'replaced')").run(),
    /failed to generate unique dramas uid/i,
  );
  assert.deepEqual(database.prepare('SELECT id, title, uid FROM dramas WHERE id = 101').get(), beforeReplace);
  assert.equal(database.prepare(
    'SELECT count(*) AS count FROM _v2_uid_generation_candidates',
  ).get().count, 0);

  database.close();
  database = openDatabase(workspace, 'conflict-algorithms.sqlite');
  assertCoreUidIntegrity(database);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
});

test('a missing core table rolls the UID migration back and can be repaired safely', (t) => {
  const workspace = createWorkspace(t);
  const migrationsDir = copyCoreUidMigration(workspace);
  const database = openDatabase(workspace, 'recoverable.sqlite');
  database.exec(`
    CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER);
    CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER);
    CREATE TABLE scenes (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_id INTEGER);
    CREATE TABLE props (id INTEGER PRIMARY KEY, drama_id INTEGER);
    INSERT INTO dramas (id, title) VALUES (1, 'preserved');
    INSERT INTO episodes (id, drama_id) VALUES (2, 1);
    INSERT INTO characters (id, drama_id) VALUES (3, 1);
    INSERT INTO scenes (id, drama_id, episode_id) VALUES (4, 1, 2);
    INSERT INTO props (id, drama_id) VALUES (5, 1);
  `);

  assert.throws(
    () => runV2Migrations(database, { migrationsDir }),
    (error) => error instanceof V2MigrationError && error.code === 'MIGRATION_EXECUTION_FAILED',
  );
  for (const table of CORE_TABLES.filter((table) => table !== 'storyboards')) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    assert.equal(columns.some((column) => column.name === 'uid'), false, `${table} schema must roll back`);
  }
  assert.deepEqual(database.prepare('SELECT id, title FROM dramas').all(), [{ id: 1, title: 'preserved' }]);
  assert.equal(database.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get().count, 0);

  database.exec(`
    CREATE TABLE storyboards (id INTEGER PRIMARY KEY, episode_id INTEGER, scene_id INTEGER);
    INSERT INTO storyboards (id, episode_id, scene_id) VALUES (6, 2, 4);
  `);
  const recovered = runV2Migrations(database, { migrationsDir });
  assert.deepEqual(recovered.appliedVersions, [1]);
  assertCoreUidIntegrity(database);
});
