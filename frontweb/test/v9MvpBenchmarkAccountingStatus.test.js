import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  mvpBenchmarkAccountingStatusView,
  parseMvpBenchmarkAccountingStatusJson,
} from '../src/benchmark/mvpAccountingStatus.js'
import { parseMvpBenchmarkPreflightBatchJson } from '../src/benchmark/mvpPreflight.js'
import {
  createMvpBenchmarkAccountingStatusState,
} from '../src/composables/useMvpBenchmarkAccountingStatus.js'

function uid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
}

function session() {
  return {
    schemaVersion: 'mvp-benchmark-session-plan.v1',
    uid: uid(1), dramaUid: uid(2), workflowRunUid: uid(3), workflowUid: uid(4),
    graphHash: '1'.repeat(64), graphRevision: 1,
    h3Tasks: Array.from({ length: 4 }, (_, index) => ({
      taskUid: uid(10 + index), intentUid: uid(20 + index),
      nodeRunUid: uid(30 + index), nodeUid: uid(40 + index),
      assetUid: uid(50 + index), manifestUid: uid(60 + index),
      generationSpecSha256: String(index + 2).repeat(64),
      planEvidenceSha256: String(index + 6).repeat(64),
    })),
    audioIntents: [{
      intentUid: uid(70), nodeRunUid: uid(71), nodeUid: uid(72), planSha256: 'a'.repeat(64),
    }],
    planSha256: 'b'.repeat(64), createdAtEpochMs: 100,
  }
}

function authorization() {
  return {
    schemaVersion: 'mvp-benchmark-external-authorization.v1',
    uid: uid(80), sessionUid: uid(1), dramaUid: uid(2),
    sessionPlanSha256: 'b'.repeat(64), connectionUid: uid(81),
    connectionEvidenceSha256: 'c'.repeat(64), requiredGpuClass: 'rtx4090-24gb',
    requiredEnvironmentSha256: '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
    liveEnvironmentCheck: 'required-before-execution', maximumCostCnyFen: 374,
    dataScope: 'single-benchmark-session', h3SubmissionLimit: 4, ttsSubmissionLimit: 1,
    perItemAttemptLimit: 1, instanceDisposition: 'return-after-terminal-or-expiry',
    authorizedAtEpochMs: 1_000, expiresAtEpochMs: 7_201_000,
    authorizationSha256: 'd'.repeat(64),
  }
}

function rawBatch() {
  const currentSession = session()
  const currentAuthorization = authorization()
  const sources = [
    ...currentSession.h3Tasks.map((item) => ({
      itemKind: 'h3', itemUid: item.taskUid, requestSha256: item.planEvidenceSha256,
    })),
    ...currentSession.audioIntents.map((item) => ({
      itemKind: 'tts', itemUid: item.intentUid, requestSha256: item.planSha256,
    })),
  ]
  const attestationUid = uid(82)
  const reservations = sources.map((source, index) => ({
    schemaVersion: 'mvp-benchmark-execution-reservation.v1', uid: uid(90 + index),
    authorizationUid: currentAuthorization.uid, attestationUid,
    sessionUid: currentSession.uid, dramaUid: currentSession.dramaUid, ...source,
    estimate: {
      schemaVersion: 'mvp-benchmark-cost-estimate.v1', ...source,
      estimatedCostCnyFen: index + 1, policyUid: uid(100 + index),
      estimateSha256: String(index + 1).repeat(64),
    },
    estimatedCostCnyFen: index + 1, attemptNumber: 1, reservedAtEpochMs: 2_000,
    reservationSha256: String(index + 2).repeat(64),
  }))
  return {
    schemaVersion: 'mvp-benchmark-execution-preflight-batch.v1',
    authorizationUid: currentAuthorization.uid, sessionUid: currentSession.uid,
    dramaUid: currentSession.dramaUid, attestationUid, reservations,
    estimatedCostCnyFen: 15, preparedAtEpochMs: 2_000, batchSha256: 'e'.repeat(64),
  }
}

function values() {
  const currentSession = session()
  const currentAuthorization = authorization()
  const currentBatch = parseMvpBenchmarkPreflightBatchJson(
    JSON.stringify(rawBatch()), currentSession, currentAuthorization,
  )
  return { session: currentSession, authorization: currentAuthorization, batch: currentBatch }
}

function rawStatus() {
  const current = values()
  return {
    schemaVersion: 'mvp-benchmark-accounting-status.v1',
    dramaUid: current.session.dramaUid,
    sessionUid: current.session.uid,
    authorizationUid: current.authorization.uid,
    batchSha256: current.batch.batchSha256,
    totalCount: current.batch.reservations.length,
    settledCount: 1,
    actualCostCnyFen: 1,
    allSettled: false,
    releaseState: 'required',
    obligationSha256: 'f'.repeat(64),
    receiptSha256: null,
    items: current.batch.reservations.map((reservation, index) => ({
      ordinal: index,
      itemKind: reservation.itemKind,
      itemUid: reservation.itemUid,
      reservationUid: reservation.uid,
      settlementState: index === 0 ? 'settled' : 'pending',
      settlementUid: index === 0 ? uid(200) : null,
      settlementSha256: index === 0 ? '9'.repeat(64) : null,
      actualCostCnyFen: index === 0 ? 1 : null,
    })),
  }
}

function parsedStatus() {
  const current = values()
  return {
    ...current,
    status: parseMvpBenchmarkAccountingStatusJson(
      JSON.stringify(rawStatus()), current.session, current.authorization, current.batch,
    ),
  }
}

test('accounting status projects exact item, cost, and release evidence', () => {
  const current = parsedStatus()
  assert.equal(current.status.settledCount, 1)
  assert.equal(current.status.actualCostCnyFen, 1)
  assert.equal(current.status.items[0].settlementState, 'settled')
  assert.equal(current.status.items[1].settlementState, 'pending')
  assert.equal(current.status.releaseState, 'required')
  assert.equal(Object.isFrozen(current.status), true)
})

test('accounting status rejects identity, aggregate, order, and release branch drift', () => {
  const current = values()
  const mismatches = [
    { settledCount: 2 },
    { actualCostCnyFen: 2 },
    { allSettled: true },
    { batchSha256: '0'.repeat(64) },
    { releaseState: 'released' },
  ]
  for (const mismatch of mismatches) {
    assert.throws(() => parseMvpBenchmarkAccountingStatusJson(
      JSON.stringify({ ...rawStatus(), ...mismatch }),
      current.session,
      current.authorization,
      current.batch,
    ))
  }
  const reordered = rawStatus()
  ;[reordered.items[0], reordered.items[1]] = [reordered.items[1], reordered.items[0]]
  assert.throws(() => parseMvpBenchmarkAccountingStatusJson(
    JSON.stringify(reordered), current.session, current.authorization, current.batch,
  ))
})

test('accounting status public view is strict-JSON branded and ignores intrinsic pollution', () => {
  const current = parsedStatus()
  const untrusted = structuredClone(current.status)
  let reads = 0
  const hostile = new Proxy(untrusted, {
    getOwnPropertyDescriptor() { reads += 1; throw new Error('descriptor sentinel') },
    getPrototypeOf() { reads += 1; throw new Error('prototype sentinel') },
    ownKeys() { reads += 1; throw new Error('keys sentinel') },
  })
  const originalApply = Reflect.apply
  const originalWeakSetHas = WeakSet.prototype.has
  try {
    Reflect.apply = (fn, thisArg, args) => (
      fn === originalWeakSetHas ? true : originalApply(fn, thisArg, args)
    )
    WeakSet.prototype.has = () => true
    assert.throws(() => mvpBenchmarkAccountingStatusView(
      untrusted, current.session, current.authorization, current.batch,
    ))
    assert.throws(() => mvpBenchmarkAccountingStatusView(
      hostile, current.session, current.authorization, current.batch,
    ))
    assert.equal(mvpBenchmarkAccountingStatusView(
      current.status, current.session, current.authorization, current.batch,
    ).actualCostCnyFen, 1)
    assert.equal(reads, 0)
  } finally {
    Reflect.apply = originalApply
    WeakSet.prototype.has = originalWeakSetHas
  }
})

test('accounting status refresh is explicit and a stale response cannot replace the latest one', async () => {
  const current = parsedStatus()
  const pending = []
  let calls = 0
  const state = createMvpBenchmarkAccountingStatusState({
    getStatus() {
      calls += 1
      return new Promise((resolve) => pending.push(resolve))
    },
  })
  assert.equal(calls, 0)
  const first = state.load(current.session, current.authorization, current.batch)
  const second = state.load(current.session, current.authorization, current.batch)
  pending[1](current.status)
  assert.equal(await second, true)
  pending[0](current.status)
  assert.equal(await first, false)
  assert.equal(state.status.value.actualCostCnyFen, 1)
  state.invalidate()
  assert.equal(state.status.value, null)
})

test('workflow exposes read-only accounting status without settlement or release actions', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const panel = fs.readFileSync(
    path.join(root, 'src/components/benchmark/MvpBenchmarkAccountingStatusPanel.vue'), 'utf8',
  )
  assert.match(panel, /结算与归还状态/u)
  assert.match(panel, /不会结算费用，也不会归还实例/u)
  assert.doesNotMatch(panel, /@click=.*settle|@click=.*release|confirmRelease/u)
})
