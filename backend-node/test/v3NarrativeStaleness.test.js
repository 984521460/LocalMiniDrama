const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const { runV2Migrations } = require('../src/db/v2');
const { createNarrativeStalenessService } = require('../src/narrative/staleness');
const { createV2Repositories } = require('../src/repositories/v2');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const TASK_BY_TYPE = Object.freeze({
  extraction: 'NovelExtractionTask',
  adaptation: 'EpisodeAdaptationTask',
  script: 'ScriptFormattingTask',
  shot: 'ShotPlanningTask',
});
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations/v2');
const LEGACY_SCHEMA_SQL = fs.readFileSync(path.resolve(__dirname, '../migrations/01_init.sql'), 'utf8');

function createVersionFourDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-v3-staleness-upgrade-'));
  const migrationsDir = path.join(root, 'migrations');
  const database = new Database(path.join(root, 'project.sqlite'));
  fs.mkdirSync(migrationsDir);
  for (const filename of [
    '0001_add_core_uids.sql',
    '0002_create_v2_base_tables.sql',
    '0003_source_evidence_integrity.sql',
    '0004_narrative_reviews.sql',
  ]) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(migrationsDir, filename));
  }
  database.pragma('foreign_keys = ON');
  database.exec(LEGACY_SCHEMA_SQL);
  const migration = runV2Migrations(database, { migrationsDir });
  assert.equal(migration.currentVersion, 4);
  t.after(() => {
    if (database.open) {
      if (database.inTransaction) database.exec('ROLLBACK');
      database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { database, migrationsDir };
}

function seedDocument(database, { dramaUid, documentUid, blockUid, selectionUids }) {
  database.transaction(() => {
    database.prepare(`
      INSERT INTO source_documents
        (uid, drama_uid, source_type, original_name, encoding, content_sha256, full_text, block_count)
      VALUES (?, ?, 'txt', 'staleness.txt', 'utf-8', ?, 'fixture', 1)
    `).run(documentUid, dramaUid, SHA_A);
    database.prepare(`
      INSERT INTO source_blocks
        (uid, document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256)
      VALUES (?, ?, 0, '[]', 0, 7, 'fixture', ?)
    `).run(blockUid, documentUid, SHA_B);
    for (const selectionUid of selectionUids) {
      database.prepare(`
        INSERT INTO source_selections
          (uid, document_uid, start_block_uid, end_block_uid, start_offset, end_offset, selected_text_sha256)
        VALUES (?, ?, ?, ?, 0, 7, ?)
      `).run(selectionUid, documentUid, blockUid, blockUid, SHA_B);
    }
  })();
}

function createApprovedResult(database, {
  resultUid,
  reviewUid,
  dramaUid,
  selectionUid,
  resultType,
  upstreamResultUid = null,
}) {
  database.prepare(`
    INSERT INTO narrative_results
      (uid, drama_uid, source_selection_uid, result_type, task_type, schema_version,
       input_hash, result_hash, envelope_hash, result_json, upstream_result_uid)
    VALUES (?, ?, ?, ?, ?, 'fixture.v1', ?, ?, ?, '{}', ?)
  `).run(
    resultUid,
    dramaUid,
    selectionUid,
    resultType,
    TASK_BY_TYPE[resultType],
    SHA_A,
    SHA_B,
    SHA_C,
    upstreamResultUid,
  );
  database.prepare(`
    INSERT INTO narrative_review_events
      (uid, result_uid, decision, result_hash, envelope_hash, comment)
    VALUES (?, ?, 'approve', ?, ?, 'fixture approval')
  `).run(reviewUid, resultUid, SHA_B, SHA_C);
  database.prepare(`
    UPDATE narrative_results
    SET status = 'approved', current_review_uid = ?
    WHERE uid = ?
  `).run(reviewUid, resultUid);
  return resultUid;
}

function createChain(database, {
  dramaUid,
  selectionUid,
  start,
  types = ['extraction', 'adaptation', 'script', 'shot'],
  upstreamResultUid = null,
}) {
  const resultUids = [];
  let upstream = upstreamResultUid;
  for (const [index, resultType] of types.entries()) {
    const resultUid = uid(start + index * 2);
    createApprovedResult(database, {
      resultUid,
      reviewUid: uid(start + index * 2 + 1),
      dramaUid,
      selectionUid,
      resultType,
      upstreamResultUid: upstream,
    });
    resultUids.push(resultUid);
    upstream = resultUid;
  }
  return Object.freeze(resultUids);
}

function createService(database, start = 9000) {
  let next = start;
  return createNarrativeStalenessService({
    repositories: createV2Repositories(database),
    createUid: () => uid(next++),
    nowEpochMs: () => Date.parse('2026-08-27T00:00:00.000Z'),
  });
}

function states(database, resultUids) {
  const statement = database.prepare(`
    SELECT uid, status, current_review_uid, stale_operation_uid, stale_reason_code,
      stale_root_kind, stale_root_uid, staled_at_epoch_ms
    FROM narrative_results WHERE uid = ?
  `);
  return resultUids.map((resultUid) => statement.get(resultUid));
}

test('migration five installs the staleness state and append-only audit contract', (t) => {
  const database = createMigratedV2Database(t);
  assert.equal(database.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 17);
  assert.deepEqual(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'narrative_stale_events'").all(),
    [{ name: 'narrative_stale_events' }],
  );
  const columns = new Set(database.prepare('PRAGMA table_info(narrative_results)').all().map((row) => row.name));
  for (const column of [
    'stale_operation_uid', 'stale_reason_code', 'stale_root_kind', 'stale_root_uid', 'staled_at_epoch_ms',
  ]) assert.equal(columns.has(column), true, column);
});

test('migration five backfills one immutable audit event for each legacy stale result', (t) => {
  const { database, migrationsDir } = createVersionFourDatabase(t);
  const dramaUid = uid(4800);
  const selectionUid = uid(4803);
  insertDrama(database, dramaUid, 'Legacy stale upgrade');
  seedDocument(database, {
    dramaUid,
    documentUid: uid(4801),
    blockUid: uid(4802),
    selectionUids: [selectionUid],
  });
  const chain = createChain(database, {
    dramaUid,
    selectionUid,
    start: 4810,
    types: ['extraction', 'adaptation'],
  });
  const replacementReviewUid = uid(4899);
  database.prepare(`
    INSERT INTO narrative_review_events
      (uid, result_uid, decision, result_hash, envelope_hash, comment)
    VALUES (?, ?, 'approve', ?, ?, 'legacy replacement approval')
  `).run(replacementReviewUid, chain[0], SHA_B, SHA_C);
  database.prepare(`
    UPDATE narrative_results SET status = 'approved', current_review_uid = ? WHERE uid = ?
  `).run(replacementReviewUid, chain[0]);
  assert.equal(database.prepare('SELECT status FROM narrative_results WHERE uid = ?').get(chain[1]).status, 'stale');
  database.prepare('UPDATE narrative_results SET updated_at = ? WHERE uid = ?')
    .run('2026-01-01T24:00:00.000Z', chain[1]);

  const filename = '0005_narrative_staleness.sql';
  fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(migrationsDir, filename));
  const migration = runV2Migrations(database, { migrationsDir });

  assert.deepEqual(migration.appliedVersions, [5]);
  assert.equal(migration.currentVersion, 5);
  const result = database.prepare(`
    SELECT status, stale_operation_uid, stale_reason_code, stale_root_kind, stale_root_uid, staled_at_epoch_ms
    FROM narrative_results WHERE uid = ?
  `).get(chain[1]);
  assert.equal(result.status, 'stale');
  assert.equal(result.stale_operation_uid, chain[1]);
  assert.equal(result.stale_reason_code, 'legacy_stale_state');
  assert.equal(result.stale_root_kind, 'narrative_result');
  assert.equal(result.stale_root_uid, chain[1]);
  assert.equal(result.staled_at_epoch_ms, Date.parse('2026-01-02T00:00:00.000Z'));
  assert.equal(database.prepare('SELECT typeof(staled_at_epoch_ms) AS kind FROM narrative_results WHERE uid = ?')
    .get(chain[1]).kind, 'integer');
  const events = database.prepare(`
    SELECT operation_uid, result_uid, root_kind, root_uid, reason_code, staled_at_epoch_ms
    FROM narrative_stale_events WHERE result_uid = ?
  `).all(chain[1]);
  assert.deepEqual(events, [{
    operation_uid: chain[1],
    result_uid: chain[1],
    root_kind: 'narrative_result',
    root_uid: chain[1],
    reason_code: 'legacy_stale_state',
    staled_at_epoch_ms: result.staled_at_epoch_ms,
  }]);
  assert.throws(
    () => database.prepare("UPDATE narrative_stale_events SET reason_code = 'narrative_result_superseded' WHERE result_uid = ?").run(chain[1]),
    /immutable/i,
  );
  for (const filename of [
    '0006_workflow_graph_registry.sql',
    '0007_workflow_run_state_integrity.sql',
  ]) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(migrationsDir, filename));
  }
  assert.equal(runV2Migrations(database, { migrationsDir }).currentVersion, 7);
  assert.equal(createService(database).listEvents(chain[1])[0].staledAt, '2026-01-02T00:00:00.000Z');
});

test('selection invalidation atomically stales only its complete narrative chain', (t) => {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(5000);
  const documentUid = uid(5001);
  const selectionA = uid(5003);
  const selectionB = uid(5004);
  insertDrama(database, dramaUid, 'Selection staleness');
  seedDocument(database, {
    dramaUid,
    documentUid,
    blockUid: uid(5002),
    selectionUids: [selectionA, selectionB],
  });
  const affected = createChain(database, { dramaUid, selectionUid: selectionA, start: 5100 });
  const unaffected = createChain(database, { dramaUid, selectionUid: selectionB, start: 5200 });
  const service = createService(database);

  const result = service.invalidate({ rootKind: 'source_selection', rootUid: selectionA });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.events), true);
  assert.equal(result.events[0].staledAt, '2026-08-27T00:00:00.000Z');
  assert.equal(Object.hasOwn(result.events[0], 'staledAtEpochMs'), false);
  assert.deepEqual([...result.affectedResultUids].sort(), [...affected].sort());
  assert.equal(result.reasonCode, 'source_selection_superseded');
  for (const state of states(database, affected)) {
    assert.equal(state.status, 'stale');
    assert.equal(state.current_review_uid, null);
    assert.equal(state.stale_operation_uid, result.operationUid);
    assert.equal(state.stale_reason_code, result.reasonCode);
    assert.equal(state.stale_root_kind, 'source_selection');
    assert.equal(state.stale_root_uid, selectionA);
    assert.equal(state.staled_at_epoch_ms, Date.parse('2026-08-27T00:00:00.000Z'));
  }
  assert.deepEqual(states(database, unaffected).map((row) => row.status), ['approved', 'approved', 'approved', 'approved']);
  assert.equal(result.events.length, affected.length);
  assert.deepEqual(service.listEvents(affected[0]), [result.events.find((event) => event.resultUid === affected[0])]);
});

test('document invalidation reaches every selection in that document and no other document', (t) => {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(5300);
  insertDrama(database, dramaUid, 'Document staleness');
  seedDocument(database, {
    dramaUid,
    documentUid: uid(5301),
    blockUid: uid(5302),
    selectionUids: [uid(5303), uid(5304)],
  });
  seedDocument(database, {
    dramaUid,
    documentUid: uid(5311),
    blockUid: uid(5312),
    selectionUids: [uid(5313)],
  });
  const first = createChain(database, { dramaUid, selectionUid: uid(5303), start: 5400, types: ['extraction'] });
  const second = createChain(database, { dramaUid, selectionUid: uid(5304), start: 5410, types: ['extraction', 'adaptation'] });
  const other = createChain(database, { dramaUid, selectionUid: uid(5313), start: 5420, types: ['extraction'] });

  const result = createService(database, 9100).invalidate({
    rootKind: 'source_document',
    rootUid: uid(5301),
  });

  assert.deepEqual([...result.affectedResultUids].sort(), [...first, ...second].sort());
  assert.deepEqual(states(database, [...first, ...second]).map((row) => row.status), ['stale', 'stale', 'stale']);
  assert.equal(states(database, other)[0].status, 'approved');
});

test('result invalidation stales only that branch and is idempotent', (t) => {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(5500);
  const selectionUid = uid(5503);
  insertDrama(database, dramaUid, 'Branch staleness');
  seedDocument(database, {
    dramaUid,
    documentUid: uid(5501),
    blockUid: uid(5502),
    selectionUids: [selectionUid],
  });
  const extraction = createChain(database, { dramaUid, selectionUid, start: 5600, types: ['extraction'] })[0];
  const branchA = createChain(database, {
    dramaUid, selectionUid, start: 5610, types: ['adaptation', 'script'], upstreamResultUid: extraction,
  });
  const branchB = createChain(database, {
    dramaUid, selectionUid, start: 5620, types: ['adaptation', 'script'], upstreamResultUid: extraction,
  });
  const service = createService(database, 9200);
  database.pragma('recursive_triggers = ON');

  const first = service.invalidate({ rootKind: 'narrative_result', rootUid: branchA[0] });
  const second = service.invalidate({ rootKind: 'narrative_result', rootUid: branchA[0] });

  assert.deepEqual([...first.affectedResultUids].sort(), [...branchA].sort());
  assert.deepEqual(second.affectedResultUids, []);
  assert.deepEqual(second.events, []);
  assert.equal(states(database, [extraction])[0].status, 'approved');
  assert.deepEqual(states(database, branchB).map((row) => row.status), ['approved', 'approved']);
});

test('ancestor review changes create immutable stale audit events for all descendants', (t) => {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(5700);
  const selectionUid = uid(5703);
  insertDrama(database, dramaUid, 'Review staleness');
  seedDocument(database, {
    dramaUid,
    documentUid: uid(5701),
    blockUid: uid(5702),
    selectionUids: [selectionUid],
  });
  const chain = createChain(database, { dramaUid, selectionUid, start: 5800 });
  const newReviewUid = uid(5899);
  database.pragma('recursive_triggers = ON');
  database.transaction(() => {
    database.prepare(`
      INSERT INTO narrative_review_events
        (uid, result_uid, decision, result_hash, envelope_hash, comment)
      VALUES (?, ?, 'approve', ?, ?, 'replacement approval')
    `).run(newReviewUid, chain[0], SHA_B, SHA_C);
    database.prepare(`
      UPDATE narrative_results SET status = 'approved', current_review_uid = ? WHERE uid = ?
    `).run(newReviewUid, chain[0]);
  })();

  assert.equal(states(database, [chain[0]])[0].status, 'approved');
  for (const state of states(database, chain.slice(1))) {
    assert.equal(state.status, 'stale');
    assert.equal(state.stale_operation_uid, newReviewUid);
    assert.equal(state.stale_reason_code, 'upstream_review_changed');
    assert.equal(state.stale_root_kind, 'narrative_result');
    assert.equal(state.stale_root_uid, chain[0]);
    assert.equal(Number.isSafeInteger(state.staled_at_epoch_ms), true);
  }
  const events = database.prepare(`
    SELECT result_uid, operation_uid, reason_code, root_kind, root_uid
    FROM narrative_stale_events WHERE operation_uid = ? ORDER BY result_uid
  `).all(newReviewUid);
  assert.equal(events.length, 3);
  assert.deepEqual(new Set(events.map((event) => event.result_uid)), new Set(chain.slice(1)));
});

test('stale transitions fail closed without valid metadata and audit writes are immutable', (t) => {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(5900);
  const selectionUid = uid(5903);
  insertDrama(database, dramaUid, 'Stale guards');
  seedDocument(database, {
    dramaUid,
    documentUid: uid(5901),
    blockUid: uid(5902),
    selectionUids: [selectionUid],
  });
  const chain = createChain(database, { dramaUid, selectionUid, start: 6000, types: ['extraction', 'adaptation'] });

  assert.throws(
    () => database.prepare(`
      INSERT INTO narrative_results
        (uid, drama_uid, source_selection_uid, result_type, task_type, schema_version,
         input_hash, result_hash, envelope_hash, result_json, upstream_result_uid,
         stale_operation_uid, stale_reason_code, stale_root_kind, stale_root_uid, staled_at_epoch_ms)
      SELECT ?, drama_uid, source_selection_uid, result_type, task_type, schema_version,
        input_hash, result_hash, envelope_hash, result_json, upstream_result_uid,
        ?, 'narrative_result_superseded', 'narrative_result', ?, 1787788800000
      FROM narrative_results WHERE uid = ?
    `).run(uid(6090), uid(6091), chain[0], chain[0]),
    /without stale metadata/i,
  );

  for (const conflictPolicy of ['', 'OR IGNORE', 'OR FAIL', 'OR REPLACE']) {
    assert.throws(
      () => database.prepare(`UPDATE ${conflictPolicy} narrative_results SET status = 'stale', current_review_uid = NULL WHERE uid = ?`).run(chain[0]),
      /stale metadata/i,
    );
  }

  const result = createService(database, 9300).invalidate({
    rootKind: 'narrative_result',
    rootUid: chain[1],
  });
  const eventUid = result.events[0].uid;
  assert.throws(
    () => database.prepare("UPDATE narrative_results SET stale_reason_code = 'legacy_stale_state' WHERE uid = ?").run(chain[1]),
    /immutable/i,
  );
  assert.throws(
    () => database.prepare('UPDATE narrative_stale_events SET reason_code = reason_code WHERE uid = ?').run(eventUid),
    /immutable/i,
  );
  assert.throws(
    () => database.prepare('DELETE FROM narrative_stale_events WHERE uid = ?').run(eventUid),
    /append-only/i,
  );
});

test('database accepts only integer epoch milliseconds and rejects cross-root operation reuse', (t) => {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(6050);
  const selectionUid = uid(6053);
  insertDrama(database, dramaUid, 'Stale operation identity');
  seedDocument(database, {
    dramaUid,
    documentUid: uid(6051),
    blockUid: uid(6052),
    selectionUids: [selectionUid],
  });
  const extraction = createChain(database, {
    dramaUid, selectionUid, start: 6060, types: ['extraction'],
  })[0];
  const branchA = createChain(database, {
    dramaUid, selectionUid, start: 6070, types: ['adaptation'], upstreamResultUid: extraction,
  })[0];
  const branchB = createChain(database, {
    dramaUid, selectionUid, start: 6080, types: ['adaptation'], upstreamResultUid: extraction,
  })[0];
  const update = database.prepare(`
    UPDATE narrative_results
    SET status = 'stale', current_review_uid = NULL,
        stale_operation_uid = @operationUid,
        stale_reason_code = 'narrative_result_superseded',
        stale_root_kind = 'narrative_result', stale_root_uid = @rootUid,
        staled_at_epoch_ms = @staledAtEpochMs
    WHERE uid = @resultUid
  `);

  assert.throws(() => update.run({
    operationUid: uid(9600),
    rootUid: branchA,
    resultUid: branchA,
    staledAtEpochMs: '2026-01-01T24:00:00.000Z',
  }), /stale metadata/i);
  assert.equal(states(database, [branchA])[0].status, 'approved');
  for (const invalidEpochMs of [-1, 1.5, 253402300800000]) {
    assert.throws(() => update.run({
      operationUid: uid(9600),
      rootUid: branchA,
      resultUid: branchA,
      staledAtEpochMs: invalidEpochMs,
    }), /stale metadata/i);
  }

  const sharedOperationUid = uid(9601);
  update.run({
    operationUid: sharedOperationUid,
    rootUid: branchA,
    resultUid: branchA,
    staledAtEpochMs: Date.parse('2026-08-27T00:00:00.000Z'),
  });
  assert.throws(() => update.run({
    operationUid: sharedOperationUid,
    rootUid: branchB,
    resultUid: branchB,
    staledAtEpochMs: Date.parse('2026-08-27T00:00:01.000Z'),
  }), /operation identity/i);
  assert.equal(states(database, [branchB])[0].status, 'approved');
  assert.deepEqual(database.prepare(`
    SELECT result_uid, root_uid, staled_at_epoch_ms
    FROM narrative_stale_events WHERE operation_uid = ?
  `).all(sharedOperationUid), [{
    result_uid: branchA,
    root_uid: branchA,
    staled_at_epoch_ms: Date.parse('2026-08-27T00:00:00.000Z'),
  }]);
});

test('audit insertion failure rolls the complete invalidation operation back', (t) => {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(6100);
  const selectionUid = uid(6103);
  insertDrama(database, dramaUid, 'Atomic staleness');
  seedDocument(database, {
    dramaUid,
    documentUid: uid(6101),
    blockUid: uid(6102),
    selectionUids: [selectionUid],
  });
  const chain = createChain(database, { dramaUid, selectionUid, start: 6200 });
  database.exec(`
    CREATE TRIGGER synthetic_stale_audit_failure
    BEFORE INSERT ON narrative_stale_events
    WHEN NEW.result_uid = '${chain[2]}'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic audit failure');
    END;
  `);

  assert.throws(
    () => createService(database, 9400).invalidate({
      rootKind: 'source_selection',
      rootUid: selectionUid,
    }),
    { code: 'NARRATIVE_STALENESS_CONFLICT' },
  );
  assert.deepEqual(states(database, chain).map((row) => row.status), ['approved', 'approved', 'approved', 'approved']);
  assert.equal(database.prepare('SELECT count(*) AS count FROM narrative_stale_events').get().count, 0);
});

test('staleness service rejects hostile, missing, and reused operation identities without leaking values', (t) => {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(6300);
  const selectionUid = uid(6303);
  insertDrama(database, dramaUid, 'Staleness input');
  seedDocument(database, {
    dramaUid,
    documentUid: uid(6301),
    blockUid: uid(6302),
    selectionUids: [selectionUid],
  });
  const extraction = createChain(database, { dramaUid, selectionUid, start: 6400, types: ['extraction'] })[0];
  const branchA = createChain(database, {
    dramaUid, selectionUid, start: 6410, types: ['adaptation'], upstreamResultUid: extraction,
  })[0];
  const branchB = createChain(database, {
    dramaUid, selectionUid, start: 6420, types: ['adaptation'], upstreamResultUid: extraction,
  })[0];
  const operationUid = uid(9500);
  const service = createNarrativeStalenessService({
    repositories: createV2Repositories(database),
    createUid: () => operationUid,
    nowEpochMs: () => Date.parse('2026-08-27T00:00:00.000Z'),
  });

  assert.throws(() => service.invalidate({ rootKind: 'unknown', rootUid: branchA }), {
    code: 'NARRATIVE_STALENESS_INPUT_INVALID',
  });
  assert.throws(() => service.invalidate({ rootKind: 'narrative_result', rootUid: 'sentinel-secret' }), {
    code: 'NARRATIVE_STALENESS_INPUT_INVALID',
  });
  const hostile = { rootKind: 'narrative_result' };
  Object.defineProperty(hostile, 'rootUid', { enumerable: true, get() { throw new Error('must not run'); } });
  assert.throws(() => service.invalidate(hostile), { code: 'NARRATIVE_STALENESS_INPUT_INVALID' });
  const missing = uid(9599);
  let missingError;
  try {
    service.invalidate({ rootKind: 'narrative_result', rootUid: missing });
  } catch (error) {
    missingError = error;
  }
  assert.equal(missingError.code, 'NARRATIVE_STALENESS_NOT_FOUND');
  assert.equal(JSON.stringify(missingError).includes(missing), false);

  for (const invalidEpochMs of ['2026-01-01T24:00:00.000Z', -1, 1.5, 253402300800000]) {
    const invalidClockService = createNarrativeStalenessService({
      repositories: createV2Repositories(database),
      createUid: () => uid(9598),
      nowEpochMs: () => invalidEpochMs,
    });
    assert.throws(
      () => invalidClockService.invalidate({ rootKind: 'narrative_result', rootUid: branchA }),
      { code: 'NARRATIVE_STALENESS_DATA_INVALID' },
    );
    assert.equal(states(database, [branchA])[0].status, 'approved');
  }

  service.invalidate({ rootKind: 'narrative_result', rootUid: branchA });
  assert.throws(
    () => service.invalidate({ rootKind: 'narrative_result', rootUid: branchB }),
    { code: 'NARRATIVE_STALENESS_CONFLICT' },
  );
  assert.equal(states(database, [branchB])[0].status, 'approved');
});
