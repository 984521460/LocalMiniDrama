'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const statusSchema = require('../../schemas/v9/mvp-benchmark-accounting-status.schema.json');
const {
  MvpBenchmarkAccountingStatusError,
  createMvpBenchmarkAccountingStatusService,
} = require('../src/benchmark/mvpBenchmarkAccountingStatusService');
const mvpBenchmarkRoutes = require('../src/routes/v2/mvpBenchmark');
const { createMvpBenchmarkSessionFixture } = require('./helpers/v9MvpBenchmarkSessionFixture');

function uid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function fixture() {
  const authorization = Object.freeze({
    uid: uid(1), sessionUid: uid(2), dramaUid: uid(3),
  });
  const reservations = Object.freeze([
    Object.freeze({
      uid: uid(10), itemKind: 'h3', itemUid: uid(11),
      requestSha256: '1'.repeat(64), estimatedCostCnyFen: 200,
    }),
    Object.freeze({
      uid: uid(12), itemKind: 'tts', itemUid: uid(13),
      requestSha256: '2'.repeat(64), estimatedCostCnyFen: 50,
    }),
  ]);
  const batch = Object.freeze({
    authorizationUid: authorization.uid,
    sessionUid: authorization.sessionUid,
    dramaUid: authorization.dramaUid,
    batchSha256: '3'.repeat(64),
    reservations,
  });
  const settlement = Object.freeze({
    schemaVersion: 'mvp-benchmark-execution-settlement.v1',
    uid: uid(20),
    reservationUid: reservations[0].uid,
    authorizationUid: authorization.uid,
    sessionUid: authorization.sessionUid,
    dramaUid: authorization.dramaUid,
    itemKind: reservations[0].itemKind,
    itemUid: reservations[0].itemUid,
    requestSha256: reservations[0].requestSha256,
    outcome: 'succeeded',
    terminalEvidenceSha256: '4'.repeat(64),
    estimatedCostCnyFen: reservations[0].estimatedCostCnyFen,
    actualCostCnyFen: 175,
    billingEvidenceSha256: '5'.repeat(64),
    settledAtEpochMs: 3_000,
    settlementSha256: '6'.repeat(64),
  });
  const obligation = Object.freeze({
    authorizationUid: authorization.uid,
    sessionUid: authorization.sessionUid,
    dramaUid: authorization.dramaUid,
    obligationSha256: '7'.repeat(64),
  });
  const counters = {
    authorization: 0, batch: 0, settlement: 0, actualCost: 0, release: 0,
  };
  let released = false;
  let actualCost = settlement.actualCostCnyFen;
  const repositories = Object.freeze({
    mvpBenchmarkExternalAuthorizations: Object.freeze({
      getStoredBySession() { counters.authorization += 1; return authorization; },
    }),
    mvpBenchmarkExecutionPreflights: Object.freeze({
      getStoredBatchByAuthorization() { counters.batch += 1; return batch; },
    }),
    mvpBenchmarkExecutionAccounting: Object.freeze({
      getSettlementByReservation(reservationUid) {
        counters.settlement += 1;
        return reservationUid === settlement.reservationUid ? settlement : null;
      },
      getActualCostCnyFen() { counters.actualCost += 1; return actualCost; },
      getReleaseObligation() {
        counters.release += 1;
        const receipt = released ? Object.freeze({
          authorizationUid: authorization.uid,
          obligationSha256: obligation.obligationSha256,
          receiptSha256: '8'.repeat(64),
        }) : null;
        return Object.freeze({ obligation, receipt, state: receipt ? 'released' : 'required' });
      },
    }),
  });
  return Object.freeze({
    authorization, batch, counters, repositories, settlement,
    input: Object.freeze({
      dramaUid: authorization.dramaUid,
      sessionUid: authorization.sessionUid,
      authorizationUid: authorization.uid,
      batchSha256: batch.batchSha256,
    }),
    release() { released = true; },
    driftActualCost() { actualCost += 1; },
  });
}

test('accounting status maps exact persisted settlement and release evidence without writes', () => {
  const current = fixture();
  const service = createMvpBenchmarkAccountingStatusService({
    repositories: current.repositories,
  });
  const pendingRelease = service.read(current.input);
  assert.deepEqual(pendingRelease, {
    schemaVersion: 'mvp-benchmark-accounting-status.v1',
    dramaUid: current.input.dramaUid,
    sessionUid: current.input.sessionUid,
    authorizationUid: current.input.authorizationUid,
    batchSha256: current.input.batchSha256,
    totalCount: 2,
    settledCount: 1,
    actualCostCnyFen: 175,
    allSettled: false,
    releaseState: 'required',
    obligationSha256: '7'.repeat(64),
    receiptSha256: null,
    items: [
      {
        ordinal: 0,
        itemKind: 'h3',
        itemUid: uid(11),
        reservationUid: uid(10),
        settlementState: 'settled',
        settlementUid: uid(20),
        settlementSha256: '6'.repeat(64),
        actualCostCnyFen: 175,
      },
      {
        ordinal: 1,
        itemKind: 'tts',
        itemUid: uid(13),
        reservationUid: uid(12),
        settlementState: 'pending',
        settlementUid: null,
        settlementSha256: null,
        actualCostCnyFen: null,
      },
    ],
  });
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile(statusSchema);
  assert.equal(validate(pendingRelease), true, JSON.stringify(validate.errors));
  current.release();
  const released = service.read(current.input);
  assert.equal(released.releaseState, 'released');
  assert.equal(released.receiptSha256, '8'.repeat(64));
  assert.deepEqual(current.counters, {
    authorization: 2, batch: 2, settlement: 4, actualCost: 2, release: 2,
  });
});

test('accounting status rejects coordinated identity, aggregate, and hostile input drift', () => {
  const current = fixture();
  const service = createMvpBenchmarkAccountingStatusService({ repositories: current.repositories });
  assert.throws(
    () => service.read({ ...current.input, dramaUid: uid(999) }),
    (error) => error instanceof MvpBenchmarkAccountingStatusError
      && error.code === 'MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE',
  );
  current.driftActualCost();
  assert.throws(() => service.read(current.input), {
    code: 'MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE',
  });
  let reads = 0;
  const hostile = new Proxy(current.input, {
    getOwnPropertyDescriptor() { reads += 1; throw new Error('descriptor sentinel'); },
    getPrototypeOf() { reads += 1; throw new Error('prototype sentinel'); },
    ownKeys() { reads += 1; throw new Error('keys sentinel'); },
  });
  assert.throws(() => service.read(hostile), {
    code: 'MVP_BENCHMARK_ACCOUNTING_STATUS_INPUT_INVALID',
  });
  assert.equal(reads, 0);
});

test('accounting status rejects hostile repository records without executing accessors', () => {
  const current = fixture();
  let proxyReads = 0;
  const hostileAuthorization = new Proxy(current.authorization, {
    get() { proxyReads += 1; throw new Error('get sentinel'); },
    getOwnPropertyDescriptor() { proxyReads += 1; throw new Error('descriptor sentinel'); },
    getPrototypeOf() { proxyReads += 1; throw new Error('prototype sentinel'); },
    ownKeys() { proxyReads += 1; throw new Error('keys sentinel'); },
  });
  const proxyService = createMvpBenchmarkAccountingStatusService({
    repositories: Object.freeze({
      ...current.repositories,
      mvpBenchmarkExternalAuthorizations: Object.freeze({
        getStoredBySession() { return hostileAuthorization; },
      }),
    }),
  });
  assert.throws(() => proxyService.read(current.input), {
    code: 'MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE',
  });
  assert.equal(proxyReads, 0);

  let accessorReads = 0;
  const accessorAuthorization = {};
  Object.defineProperty(accessorAuthorization, 'uid', {
    enumerable: true,
    get() { accessorReads += 1; throw new Error('accessor sentinel'); },
  });
  const accessorService = createMvpBenchmarkAccountingStatusService({
    repositories: Object.freeze({
      ...current.repositories,
      mvpBenchmarkExternalAuthorizations: Object.freeze({
        getStoredBySession() { return accessorAuthorization; },
      }),
    }),
  });
  assert.throws(() => accessorService.read(current.input), {
    code: 'MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE',
  });
  assert.equal(accessorReads, 0);

  const invalidSettlementService = createMvpBenchmarkAccountingStatusService({
    repositories: Object.freeze({
      ...current.repositories,
      mvpBenchmarkExecutionAccounting: Object.freeze({
        ...current.repositories.mvpBenchmarkExecutionAccounting,
        getSettlementByReservation(reservationUid) {
          return reservationUid === current.settlement.reservationUid
            ? Object.freeze({ ...current.settlement, uid: 'not-a-uid' }) : null;
        },
      }),
    }),
  });
  assert.throws(() => invalidSettlementService.read(current.input), {
    code: 'MVP_BENCHMARK_ACCOUNTING_STATUS_UNAVAILABLE',
  });
});

test('accounting status route is GET-only and fails closed without production wiring', async (t) => {
  const databaseFixture = createMvpBenchmarkSessionFixture(t);
  const current = fixture();
  const service = createMvpBenchmarkAccountingStatusService({ repositories: current.repositories });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/v2', mvpBenchmarkRoutes(Object.freeze({}), Object.freeze({
    mvpBenchmark: Object.freeze({ accountingStatus: service }),
  }), databaseFixture.database));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => server.close());
  const address = server.address();
  const path = `/api/v1/v2/dramas/${current.input.dramaUid}/mvp-benchmark/sessions/${current.input.sessionUid}/authorizations/${current.input.authorizationUid}/batches/${current.input.batchSha256}/accounting-status`;
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.actualCostCnyFen, 175);
  const rejectedPost = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(rejectedPost.status, 404);

  const missing = express();
  missing.use('/api/v1/v2', mvpBenchmarkRoutes(
    Object.freeze({}), Object.freeze({}), databaseFixture.database,
  ));
  const missingServer = await new Promise((resolve) => {
    const listening = missing.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => missingServer.close());
  const missingAddress = missingServer.address();
  const unavailable = await fetch(`http://127.0.0.1:${missingAddress.port}${path}`);
  assert.equal(unavailable.status, 503);
});
