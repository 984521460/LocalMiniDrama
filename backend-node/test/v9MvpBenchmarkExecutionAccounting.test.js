'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const { LocalStorageProvider } = require('../src/adapters/v2/storage');
const { createAudioTtsExecutionService } = require('../src/audio/audioTtsExecutionService');
const {
  createAudioTtsOutputRepository,
} = require('../src/repositories/v2/audioTtsOutputRepository');
const { createLocalMediaProbe } = require('../src/media/localMediaProbe');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const {
  APPROVED_LIVE_ENVIRONMENT,
  createMvpBenchmarkCostEstimate,
  createMvpBenchmarkLiveEnvironmentObservation,
  serializeMvpBenchmarkExecutionPreflightJson,
} = require('../src/benchmark/mvpBenchmarkExecutionPreflight');
const {
  createMvpBenchmarkExecutionSettlement,
} = require('../src/benchmark/mvpBenchmarkExecutionAccounting');
const {
  createMvpBenchmarkExecutionAccountingService,
} = require('../src/benchmark/mvpBenchmarkExecutionAccountingService');
const { PROJECT_ARCHIVE_CATALOG } = require('../src/adapters/v2/zip/projectArchiveCatalog');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const {
  createMvpBenchmarkSessionFixture,
  mvpBenchmarkExternalAuthorizationRequestFixture,
} = require('./helpers/v9MvpBenchmarkSessionFixture');
const { uid } = require('./helpers/v2RepositoryDatabase');

function authorizationRequest(current, session) {
  return mvpBenchmarkExternalAuthorizationRequestFixture(current, session, {
    uid: uid(99700),
    maximumCostCnyFen: 1_000,
  });
}

function observation(current) {
  return createMvpBenchmarkLiveEnvironmentObservation({
    schemaVersion: 'mvp-benchmark-live-environment-observation.v1',
    connectionUid: current.connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(current.connection),
    observedAtEpochMs: 2_000,
    approvedEnvironmentSha256:
      '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43',
    gpu: structuredClone(APPROVED_LIVE_ENVIRONMENT.gpu),
    comfyUI: structuredClone(APPROVED_LIVE_ENVIRONMENT.comfyUI),
    runtime: structuredClone(APPROVED_LIVE_ENVIRONMENT.runtime),
    models: structuredClone(APPROVED_LIVE_ENVIRONMENT.models),
  });
}

function prepare(current, { itemKind = 'h3' } = {}) {
  const session = current.repositories.mvpBenchmarkSessions.prepare(current.request);
  const authorization = current.repositories.mvpBenchmarkExternalAuthorizations.prepare(
    authorizationRequest(current, session),
    { nowEpochMs: 1_000 },
  );
  const attestation = current.repositories.mvpBenchmarkExecutionPreflights.attest({
    uid: uid(99701),
    authorizationUid: authorization.uid,
    observation: observation(current),
  }, { nowEpochMs: 2_100 });
  const item = itemKind === 'h3' ? session.h3Tasks[0] : session.audioIntents[0];
  const itemUid = itemKind === 'h3' ? item.taskUid : item.intentUid;
  const requestSha256 = itemKind === 'h3' ? item.planEvidenceSha256 : item.planSha256;
  const estimate = createMvpBenchmarkCostEstimate({
    schemaVersion: 'mvp-benchmark-cost-estimate.v1',
    itemKind,
    itemUid,
    requestSha256,
    estimatedCostCnyFen: 400,
    policyUid: uid(99703),
  });
  const reservation = current.repositories.mvpBenchmarkExecutionPreflights.reserve({
    uid: uid(99702),
    authorizationUid: authorization.uid,
    attestationUid: attestation.uid,
    itemKind,
    itemUid,
    requestSha256,
    estimate,
  }, { nowEpochMs: 2_200 });
  return { attestation, authorization, item, reservation, session };
}

async function completeTts(current, t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-accounting-tts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'synthetic.wav');
  execFileSync(getFfmpegPath(), [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000:duration=0.25',
    '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', source,
  ]);
  const audio = fs.readFileSync(source);
  const storageProvider = new LocalStorageProvider({ projectRoot: root });
  const outputs = createAudioTtsOutputRepository({
    database: current.database,
    repositories: current.repositories,
  });
  const service = createAudioTtsExecutionService({
    repositories: current.repositories,
    submissions: current.repositories.audioTtsSubmissions,
    outputs,
    vault: { async read() { return 'synthetic-local-credential'; } },
    client: {
      async generate(request) {
        return Object.freeze({
          schemaVersion: 'tts-provider-response.v1',
          provider: request.provider,
          requestSha256: request.requestSha256,
          mimeType: 'audio/wav',
          audio: Buffer.from(audio),
        });
      },
    },
    storageProvider,
    mediaProbe: createLocalMediaProbe({
      localRoot: root,
      ffmpegPath: getFfmpegPath(),
      ffprobePath: getFfprobePath(),
      maxFileBytes: 16 * 1024 * 1024,
    }),
    timeoutMs: 30_000,
    nowEpochMs: Date.now,
  });
  return service.execute(current.audioIntent.uid);
}

function failTask(current, taskUid, { retryable = false } = {}) {
  let task = current.repositories.remote.getFormalTask(taskUid);
  task = current.repositories.remote.transitionFormalTask({
    uid: task.uid,
    expectedStateVersion: task.stateVersion,
    nextStage: 'uploading',
    nextStatus: 'running',
    recoveryState: 'none',
    outputAssetVersionUid: null,
    errorCode: null,
    errorDetailRef: null,
    errorPhase: null,
    errorRetryable: null,
    submissionLeaseExpiresAtEpochMs: null,
  });
  return current.repositories.remote.transitionFormalTask({
    uid: task.uid,
    expectedStateVersion: task.stateVersion,
    nextStage: 'failed',
    nextStatus: 'failed',
    recoveryState: retryable ? 'retryable' : 'orphaned',
    outputAssetVersionUid: null,
    errorCode: 'ERR_SYNTHETIC_UPLOAD',
    errorDetailRef: null,
    errorPhase: 'upload',
    errorRetryable: retryable,
    submissionLeaseExpiresAtEpochMs: null,
  });
}

function schema(name) {
  return JSON.parse(fs.readFileSync(
    path.resolve(__dirname, `../../schemas/v9/${name}.schema.json`),
    'utf8',
  ));
}

test('terminal cost settlement and release receipt are immutable bounded evidence', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const prepared = prepare(current);
  const accounting = current.repositories.mvpBenchmarkExecutionAccounting;
  const open = accounting.getReleaseObligation(prepared.authorization.uid);
  assert.equal(open.state, 'required');
  assert.equal(open.receipt, null);
  assert.equal(open.obligation.firstAttestationUid, prepared.attestation.uid);
  assert.deepEqual(accounting.recoverOpen(), { recoveredCount: 0, failedCount: 1 });

  assert.throws(
    () => accounting.inspectTerminalReservation(prepared.reservation.uid),
    { name: 'V2RepositoryDataError' },
  );
  const terminal = failTask(current, prepared.item.taskUid);
  assert.equal(terminal.status, 'failed');

  let next = 99710;
  const service = createMvpBenchmarkExecutionAccountingService({
    repositories: current.repositories,
    costFinalizer: {
      finalizeH3(input) {
        assert.equal(input.reservation.uid, prepared.reservation.uid);
        assert.equal(input.outcome, 'failed');
        return Promise.resolve({
          actualCostCnyFen: 175,
          billingEvidenceSha256: 'b'.repeat(64),
        });
      },
      finalizeTts() { throw new Error('not used'); },
    },
    releaseVerifier: {
      inspect(obligation) {
        assert.equal(obligation.authorizationUid, prepared.authorization.uid);
        return Promise.resolve({ released: true, releaseEvidenceSha256: 'c'.repeat(64) });
      },
    },
    createUid: () => uid(next++),
    nowEpochMs: () => Date.parse(terminal.completedAt),
  });
  const settlement = await service.settle(prepared.reservation.uid);
  assert.equal(settlement.actualCostCnyFen, 175);
  assert.equal(settlement.estimatedCostCnyFen, 400);
  assert.equal(settlement.outcome, 'failed');
  assert.equal(accounting.getActualCostCnyFen(prepared.authorization.uid), 175);
  assert.deepEqual(await service.settle(prepared.reservation.uid), settlement);

  const receipt = await service.release(prepared.authorization.uid);
  assert.equal(receipt.releaseEvidenceSha256, 'c'.repeat(64));
  assert.equal(accounting.getReleaseObligation(prepared.authorization.uid).state, 'released');
  assert.deepEqual(accounting.recoverOpen(), { recoveredCount: 0, failedCount: 0 });
  assert.deepEqual(await service.release(prepared.authorization.uid), receipt);

  const ajv = new Ajv2020({ strict: true });
  assert.equal(ajv.compile(schema('mvp-benchmark-execution-settlement'))(settlement), true);
  assert.equal(ajv.compile(schema('mvp-benchmark-resource-release-obligation'))(open.obligation), true);
  assert.equal(ajv.compile(schema('mvp-benchmark-resource-release-receipt'))(receipt), true);
  for (const table of [
    'mvp_benchmark_execution_settlements',
    'mvp_benchmark_execution_settlement_seals',
    'mvp_benchmark_resource_release_obligations',
    'mvp_benchmark_resource_release_obligation_seals',
    'mvp_benchmark_resource_release_receipts',
    'mvp_benchmark_resource_release_receipt_seals',
  ]) assert.equal(PROJECT_ARCHIVE_CATALOG.excludedTables.includes(table), true);
});

test('completed local TTS evidence can be settled once without a second provider call', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const prepared = prepare(current, { itemKind: 'tts' });
  const execution = await completeTts(current, t);
  const accounting = current.repositories.mvpBenchmarkExecutionAccounting;
  const terminal = accounting.inspectTerminalReservation(prepared.reservation.uid);
  assert.equal(terminal.outcome, 'succeeded');
  assert.equal(terminal.terminalEvidenceSha256, execution.evidence.executionSha256);

  let ttsFinalizations = 0;
  const service = createMvpBenchmarkExecutionAccountingService({
    repositories: current.repositories,
    costFinalizer: {
      finalizeH3() { throw new Error('not used'); },
      finalizeTts(input) {
        ttsFinalizations += 1;
        assert.equal(input.reservation.itemUid, current.audioIntent.uid);
        return Promise.resolve({
          actualCostCnyFen: 25,
          billingEvidenceSha256: '9'.repeat(64),
        });
      },
    },
    releaseVerifier: { inspect() { throw new Error('not used'); } },
    createUid: () => uid(99715),
    nowEpochMs: Date.now,
  });
  const settlement = await service.settle(prepared.reservation.uid);
  assert.equal(settlement.itemKind, 'tts');
  assert.equal(settlement.outcome, 'succeeded');
  assert.equal(settlement.actualCostCnyFen, 25);
  assert.deepEqual(await service.settle(prepared.reservation.uid), settlement);
  assert.equal(ttsFinalizations, 1);
});

test('untrusted cost and release results leave durable state unchanged', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const prepared = prepare(current);
  failTask(current, prepared.item.taskUid);
  const service = createMvpBenchmarkExecutionAccountingService({
    repositories: current.repositories,
    costFinalizer: {
      finalizeH3() {
        return Promise.resolve({
          actualCostCnyFen: 401,
          billingEvidenceSha256: 'd'.repeat(64),
        });
      },
      finalizeTts() { throw new Error('not used'); },
    },
    releaseVerifier: {
      inspect() {
        return Promise.resolve({ released: false, releaseEvidenceSha256: 'e'.repeat(64) });
      },
    },
    createUid: () => uid(99720),
    nowEpochMs: () => 4_000,
  });
  await assert.rejects(
    service.settle(prepared.reservation.uid),
    { code: 'MVP_BENCHMARK_EXECUTION_ACCOUNTING_UNAVAILABLE' },
  );
  await assert.rejects(
    service.release(prepared.authorization.uid),
    { code: 'MVP_BENCHMARK_RESOURCE_RELEASE_REQUIRED' },
  );
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_execution_settlements',
  ).pluck().get(), 0);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_resource_release_receipts',
  ).pluck().get(), 0);
  assert.deepEqual(
    current.repositories.mvpBenchmarkExecutionAccounting.recoverOpen(),
    { recoveredCount: 0, failedCount: 1 },
  );
});

test('release obligation survives authorization expiry and current connection drift', async (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const prepared = prepare(current);
  current.repositories.remote.replaceCredential({
    uid: current.connection.uid,
    expectedStateVersion: current.connection.stateVersion,
    credentialRef: `credential:v1:${uid(99730)}`,
  });
  const state = current.repositories.mvpBenchmarkExecutionAccounting
    .getReleaseObligation(prepared.authorization.uid);
  assert.equal(state.state, 'required');
  const service = createMvpBenchmarkExecutionAccountingService({
    repositories: current.repositories,
    costFinalizer: {
      finalizeH3() { throw new Error('not used'); },
      finalizeTts() { throw new Error('not used'); },
    },
    releaseVerifier: {
      inspect() {
        return Promise.resolve({ released: true, releaseEvidenceSha256: 'f'.repeat(64) });
      },
    },
    nowEpochMs: () => prepared.authorization.expiresAtEpochMs + 1,
  });
  const receipt = await service.release(prepared.authorization.uid);
  assert.equal(receipt.connectionEvidenceSha256, prepared.authorization.connectionEvidenceSha256);
});

test('SQLite rejects nonterminal, replacement, mutation, and deletion accounting writes', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const prepared = prepare(current);
  const nonterminal = createMvpBenchmarkExecutionSettlement({
    uid: uid(99740),
    reservation: prepared.reservation,
    outcome: 'failed',
    terminalEvidenceSha256: '1'.repeat(64),
    actualCostCnyFen: 0,
    billingEvidenceSha256: '2'.repeat(64),
    settledAtEpochMs: 3_000,
  });
  const insert = current.database.prepare(`
    INSERT INTO mvp_benchmark_execution_settlements
      (uid,reservation_uid,authorization_uid,session_uid,drama_uid,item_kind,item_uid,
       request_sha256,outcome,terminal_evidence_sha256,estimated_cost_cny_fen,
       actual_cost_cny_fen,billing_evidence_sha256,settled_at_epoch_ms,
       settlement_json,settlement_sha256)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const values = (record) => [
    record.uid, record.reservationUid, record.authorizationUid, record.sessionUid,
    record.dramaUid, record.itemKind, record.itemUid, record.requestSha256, record.outcome,
    record.terminalEvidenceSha256, record.estimatedCostCnyFen, record.actualCostCnyFen,
    record.billingEvidenceSha256, record.settledAtEpochMs,
    serializeMvpBenchmarkExecutionPreflightJson(record), record.settlementSha256,
  ];
  assert.throws(() => insert.run(...values(nonterminal)), /settlement invalid/u);
  assert.equal(current.database.prepare(
    'SELECT count(*) FROM mvp_benchmark_execution_settlements',
  ).pluck().get(), 0);

  let failed = failTask(current, prepared.item.taskUid, { retryable: true });
  assert.throws(
    () => current.repositories.mvpBenchmarkExecutionAccounting
      .inspectTerminalReservation(prepared.reservation.uid),
    { name: 'V2RepositoryDataError' },
  );
  current.repositories.remote.retryFormalTask({
    uid: failed.uid,
    expectedStateVersion: failed.stateVersion,
  });
  failed = failTask(current, prepared.item.taskUid);
  const terminal = current.repositories.mvpBenchmarkExecutionAccounting
    .inspectTerminalReservation(prepared.reservation.uid);
  const earlySettlement = createMvpBenchmarkExecutionSettlement({
    uid: uid(99741),
    reservation: prepared.reservation,
    outcome: terminal.outcome,
    terminalEvidenceSha256: terminal.terminalEvidenceSha256,
    actualCostCnyFen: 100,
    billingEvidenceSha256: '3'.repeat(64),
    settledAtEpochMs: 3_000,
  });
  assert.throws(() => insert.run(...values(earlySettlement)), /settlement invalid/u);
  const settlement = createMvpBenchmarkExecutionSettlement({
    uid: uid(99742),
    reservation: prepared.reservation,
    outcome: terminal.outcome,
    terminalEvidenceSha256: terminal.terminalEvidenceSha256,
    actualCostCnyFen: 100,
    billingEvidenceSha256: '3'.repeat(64),
    settledAtEpochMs: Date.parse(failed.completedAt),
  });
  insert.run(...values(settlement));
  assert.throws(() => current.database.prepare(`
    INSERT OR REPLACE INTO mvp_benchmark_execution_settlements
      (uid,reservation_uid,authorization_uid,session_uid,drama_uid,item_kind,item_uid,
       request_sha256,outcome,terminal_evidence_sha256,estimated_cost_cny_fen,
       actual_cost_cny_fen,billing_evidence_sha256,settled_at_epoch_ms,
       settlement_json,settlement_sha256)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(...values(settlement)), /immutable/u);
  assert.throws(() => current.database.prepare(`
    UPDATE mvp_benchmark_execution_settlements SET actual_cost_cny_fen=99 WHERE uid=?
  `).run(settlement.uid), /immutable/u);
  assert.throws(() => current.database.prepare(`
    DELETE FROM mvp_benchmark_execution_settlements WHERE uid=?
  `).run(settlement.uid), /append-only/u);
  assert.deepEqual(
    current.repositories.mvpBenchmarkExecutionAccounting.getSettlement(settlement.uid),
    settlement,
  );
});

test('read paths reject settlement, release seal, and terminal-source drift', (t) => {
  const current = createMvpBenchmarkSessionFixture(t);
  const prepared = prepare(current);
  const terminalTask = failTask(current, prepared.item.taskUid);
  const accounting = current.repositories.mvpBenchmarkExecutionAccounting;
  const settlement = accounting.settle({
    uid: uid(99750),
    reservationUid: prepared.reservation.uid,
    actualCostCnyFen: 100,
    billingEvidenceSha256: '4'.repeat(64),
  }, { nowEpochMs: Date.parse(terminalTask.completedAt) });
  const receipt = accounting.confirmRelease({
    authorizationUid: prepared.authorization.uid,
    releaseEvidenceSha256: '5'.repeat(64),
  }, { nowEpochMs: Date.parse(terminalTask.completedAt) });

  current.database.pragma('recursive_triggers = OFF');
  for (const [table, key, value] of [
    ['mvp_benchmark_execution_settlements', 'uid', settlement.uid],
    ['mvp_benchmark_execution_settlement_seals', 'settlement_uid', settlement.uid],
    ['mvp_benchmark_resource_release_obligations', 'authorization_uid', prepared.authorization.uid],
    ['mvp_benchmark_resource_release_obligation_seals', 'authorization_uid', prepared.authorization.uid],
    ['mvp_benchmark_resource_release_receipts', 'authorization_uid', prepared.authorization.uid],
    ['mvp_benchmark_resource_release_receipt_seals', 'authorization_uid', prepared.authorization.uid],
  ]) {
    assert.throws(
      () => current.database.prepare(
        `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} WHERE ${key}=?`,
      ).run(value),
      /immutable/u,
    );
  }

  current.database.exec('DROP TRIGGER v2_mvp_benchmark_execution_settlement_seals_immutable_update');
  current.database.prepare(`
    UPDATE mvp_benchmark_execution_settlement_seals SET settlement_sha256=?
    WHERE settlement_uid=?
  `).run('6'.repeat(64), settlement.uid);
  assert.throws(() => accounting.getSettlement(settlement.uid), { name: 'V2RepositoryDataError' });
  current.database.prepare(`
    UPDATE mvp_benchmark_execution_settlement_seals SET settlement_sha256=?
    WHERE settlement_uid=?
  `).run(settlement.settlementSha256, settlement.uid);

  current.database.exec('DROP TRIGGER v2_mvp_benchmark_execution_settlements_immutable_update');
  current.database.prepare(`
    UPDATE mvp_benchmark_execution_settlements SET actual_cost_cny_fen=actual_cost_cny_fen+1
    WHERE uid=?
  `).run(settlement.uid);
  assert.throws(
    () => accounting.getActualCostCnyFen(prepared.authorization.uid),
    { name: 'V2RepositoryDataError' },
  );
  current.database.prepare(`
    UPDATE mvp_benchmark_execution_settlements SET actual_cost_cny_fen=? WHERE uid=?
  `).run(settlement.actualCostCnyFen, settlement.uid);

  const early = createMvpBenchmarkExecutionSettlement({
    uid: settlement.uid,
    reservation: prepared.reservation,
    outcome: settlement.outcome,
    terminalEvidenceSha256: settlement.terminalEvidenceSha256,
    actualCostCnyFen: settlement.actualCostCnyFen,
    billingEvidenceSha256: settlement.billingEvidenceSha256,
    settledAtEpochMs: Date.parse(terminalTask.completedAt) - 1,
  });
  current.database.prepare(`
    UPDATE mvp_benchmark_execution_settlements
    SET settled_at_epoch_ms=?,settlement_json=?,settlement_sha256=? WHERE uid=?
  `).run(
    early.settledAtEpochMs,
    serializeMvpBenchmarkExecutionPreflightJson(early),
    early.settlementSha256,
    settlement.uid,
  );
  current.database.prepare(`
    UPDATE mvp_benchmark_execution_settlement_seals SET settlement_sha256=?
    WHERE settlement_uid=?
  `).run(early.settlementSha256, settlement.uid);
  assert.throws(() => accounting.getSettlement(settlement.uid), { name: 'V2RepositoryDataError' });
  current.database.prepare(`
    UPDATE mvp_benchmark_execution_settlements
    SET settled_at_epoch_ms=?,settlement_json=?,settlement_sha256=? WHERE uid=?
  `).run(
    settlement.settledAtEpochMs,
    serializeMvpBenchmarkExecutionPreflightJson(settlement),
    settlement.settlementSha256,
    settlement.uid,
  );
  current.database.prepare(`
    UPDATE mvp_benchmark_execution_settlement_seals SET settlement_sha256=?
    WHERE settlement_uid=?
  `).run(settlement.settlementSha256, settlement.uid);

  current.database.exec('DROP TRIGGER v2_mvp_benchmark_resource_release_receipt_seals_immutable_update');
  current.database.prepare(`
    UPDATE mvp_benchmark_resource_release_receipt_seals SET receipt_sha256=?
    WHERE authorization_uid=?
  `).run('7'.repeat(64), prepared.authorization.uid);
  assert.throws(
    () => accounting.getReleaseObligation(prepared.authorization.uid),
    { name: 'V2RepositoryDataError' },
  );
  current.database.prepare(`
    UPDATE mvp_benchmark_resource_release_receipt_seals SET receipt_sha256=?
    WHERE authorization_uid=?
  `).run(receipt.receiptSha256, prepared.authorization.uid);

  const obligation = accounting.getReleaseObligation(prepared.authorization.uid).obligation;
  current.database.exec('DROP TRIGGER v2_mvp_benchmark_resource_release_obligation_seals_immutable_update');
  current.database.prepare(`
    UPDATE mvp_benchmark_resource_release_obligation_seals SET obligation_sha256=?
    WHERE authorization_uid=?
  `).run('8'.repeat(64), prepared.authorization.uid);
  assert.throws(
    () => accounting.getReleaseObligation(prepared.authorization.uid),
    { name: 'V2RepositoryDataError' },
  );
  current.database.prepare(`
    UPDATE mvp_benchmark_resource_release_obligation_seals SET obligation_sha256=?
    WHERE authorization_uid=?
  `).run(obligation.obligationSha256, prepared.authorization.uid);

  current.database.exec(`
    DROP TRIGGER v2_remote_tasks_formal_terminal_immutable;
    DROP TRIGGER v2_remote_tasks_formal_validate_update;
  `);
  current.database.prepare(`
    UPDATE remote_tasks SET state_version=state_version+1 WHERE uid=?
  `).run(prepared.item.taskUid);
  assert.throws(() => accounting.getSettlement(settlement.uid), { name: 'V2RepositoryDataError' });
  current.database.prepare(`
    UPDATE remote_tasks SET state_version=?,error_retryable=1 WHERE uid=?
  `).run(terminalTask.stateVersion, prepared.item.taskUid);
  assert.throws(
    () => accounting.inspectTerminalReservation(prepared.reservation.uid),
    { name: 'V2RepositoryDataError' },
  );
  assert.throws(() => accounting.getSettlement(settlement.uid), { name: 'V2RepositoryDataError' });
});
