import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  mvpBenchmarkPreflightBatchView,
  parseMvpBenchmarkPreflightBatchJson,
} from '../src/benchmark/mvpPreflight.js'
import { createMvpBenchmarkPreflightState } from '../src/composables/useMvpBenchmarkPreflight.js'

function uid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
}

function session() {
  return {
    schemaVersion: 'mvp-benchmark-session-plan.v1',
    uid: uid(1),
    dramaUid: uid(2),
    workflowRunUid: uid(3),
    workflowUid: uid(4),
    graphHash: '1'.repeat(64),
    graphRevision: 1,
    h3Tasks: Array.from({ length: 4 }, (_, index) => ({
      taskUid: uid(10 + index),
      intentUid: uid(20 + index),
      nodeRunUid: uid(30 + index),
      nodeUid: uid(40 + index),
      assetUid: uid(50 + index),
      manifestUid: uid(60 + index),
      generationSpecSha256: String(index + 2).repeat(64),
      planEvidenceSha256: String(index + 6).repeat(64),
    })),
    audioIntents: [{
      intentUid: uid(70),
      nodeRunUid: uid(71),
      nodeUid: uid(72),
      planSha256: 'a'.repeat(64),
    }],
    planSha256: 'b'.repeat(64),
    createdAtEpochMs: 100,
  }
}

function authorization() {
  return {
    schemaVersion: 'mvp-benchmark-external-authorization.v1',
    uid: uid(80),
    sessionUid: uid(1),
    dramaUid: uid(2),
    sessionPlanSha256: 'b'.repeat(64),
    connectionUid: uid(81),
    connectionEvidenceSha256: 'c'.repeat(64),
    requiredGpuClass: 'rtx4090-24gb',
    requiredEnvironmentSha256: '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43',
    liveEnvironmentCheck: 'required-before-execution',
    maximumCostCnyFen: 374,
    dataScope: 'single-benchmark-session',
    h3SubmissionLimit: 4,
    ttsSubmissionLimit: 1,
    perItemAttemptLimit: 1,
    instanceDisposition: 'return-after-terminal-or-expiry',
    authorizedAtEpochMs: 1_000,
    expiresAtEpochMs: 7_201_000,
    authorizationSha256: 'd'.repeat(64),
  }
}

function batch(overrides = {}) {
  const currentSession = session()
  const currentAuthorization = authorization()
  const items = [
    ...currentSession.h3Tasks.map((item) => ({
      itemKind: 'h3', itemUid: item.taskUid, requestSha256: item.planEvidenceSha256,
    })),
    ...currentSession.audioIntents.map((item) => ({
      itemKind: 'tts', itemUid: item.intentUid, requestSha256: item.planSha256,
    })),
  ]
  const attestationUid = uid(82)
  const reservations = items.map((item, index) => ({
    schemaVersion: 'mvp-benchmark-execution-reservation.v1',
    uid: uid(90 + index),
    authorizationUid: currentAuthorization.uid,
    attestationUid,
    sessionUid: currentSession.uid,
    dramaUid: currentSession.dramaUid,
    ...item,
    estimate: {
      schemaVersion: 'mvp-benchmark-cost-estimate.v1',
      ...item,
      estimatedCostCnyFen: index + 1,
      policyUid: uid(100 + index),
      estimateSha256: String(index + 1).repeat(64),
    },
    estimatedCostCnyFen: index + 1,
    attemptNumber: 1,
    reservedAtEpochMs: 2_000,
    reservationSha256: String(index + 2).repeat(64),
  }))
  return {
    schemaVersion: 'mvp-benchmark-execution-preflight-batch.v1',
    authorizationUid: currentAuthorization.uid,
    sessionUid: currentSession.uid,
    dramaUid: currentSession.dramaUid,
    attestationUid,
    reservations,
    estimatedCostCnyFen: 15,
    preparedAtEpochMs: 2_000,
    batchSha256: 'e'.repeat(64),
    ...overrides,
  }
}

function parsedBatch(value = batch()) {
  return parseMvpBenchmarkPreflightBatchJson(
    JSON.stringify(value), session(), authorization(),
  )
}

test('preflight batch projection is exact, source-bound, ordered, and cost-bounded', () => {
  const value = batch()
  assert.deepEqual(parsedBatch(value), value)
  assert.throws(() => parsedBatch({ ...value, extra: true }))
  const wrongItem = structuredClone(value)
  wrongItem.reservations[0].itemUid = uid(999)
  assert.throws(() => parsedBatch(wrongItem))
  const wrongEstimate = structuredClone(value)
  wrongEstimate.reservations[0].estimate.estimatedCostCnyFen = 99
  assert.throws(() => parsedBatch(wrongEstimate))
  const duplicateUid = structuredClone(value)
  duplicateUid.reservations[1].uid = duplicateUid.reservations[0].uid
  assert.throws(() => parsedBatch(duplicateUid))
  assert.throws(() => parsedBatch({ ...value, estimatedCostCnyFen: 375 }))
  assert.doesNotMatch(JSON.stringify(value), /credentialRef|password|secret|host|path/iu)
})

test('preflight projection rejects inherited missing-key fallbacks without reads', () => {
  const value = batch()
  delete value.schemaVersion
  value.extra = true
  let reads = 0
  Object.defineProperty(Object.prototype, 'schemaVersion', {
    configurable: true,
    get() { reads += 1; return 'mvp-benchmark-execution-preflight-batch.v1' },
  })
  try {
    assert.throws(() => mvpBenchmarkPreflightBatchView(value, session(), authorization()))
    assert.equal(reads, 0)
  } finally {
    delete Object.prototype.schemaVersion
  }
})

test('preflight projection rejects root and nested Proxy values without executing traps', async () => {
  const counts = { getOwnPropertyDescriptor: 0, getPrototypeOf: 0, ownKeys: 0 }
  const wrap = (value) => new Proxy(value, {
    getOwnPropertyDescriptor(target, key) {
      counts.getOwnPropertyDescriptor += 1
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
    getPrototypeOf(target) {
      counts.getPrototypeOf += 1
      return Reflect.getPrototypeOf(target)
    },
    ownKeys(target) {
      counts.ownKeys += 1
      return Reflect.ownKeys(target)
    },
  })

  assert.throws(() => mvpBenchmarkPreflightBatchView(
    wrap(batch()), session(), authorization(),
  ))
  const nestedObject = batch()
  nestedObject.reservations[0].estimate = wrap(nestedObject.reservations[0].estimate)
  assert.throws(() => mvpBenchmarkPreflightBatchView(
    nestedObject, session(), authorization(),
  ))
  const nestedArray = batch()
  nestedArray.reservations = wrap(nestedArray.reservations)
  assert.throws(() => mvpBenchmarkPreflightBatchView(
    nestedArray, session(), authorization(),
  ))

  let calls = 0
  const state = createMvpBenchmarkPreflightState({
    async createPreflight() {
      calls += 1
      return wrap(batch())
    },
  })
  assert.equal(await state.preflight(session(), authorization()), false)
  assert.equal(state.batch.value, null)
  assert.equal(calls, 1)
  assert.deepEqual(counts, { getOwnPropertyDescriptor: 0, getPrototypeOf: 0, ownKeys: 0 })
})

test('preflight trust boundary ignores later Reflect and WeakSet pollution', async () => {
  const trusted = parsedBatch()
  const untrusted = structuredClone(trusted)
  const originalApply = Reflect.apply
  const originalWeakSetHas = WeakSet.prototype.has
  let proxyReads = 0
  const hostile = new Proxy(batch(), {
    getOwnPropertyDescriptor() { proxyReads += 1; throw new Error('descriptor sentinel') },
    getPrototypeOf() { proxyReads += 1; throw new Error('prototype sentinel') },
    ownKeys() { proxyReads += 1; throw new Error('keys sentinel') },
  })
  try {
    Reflect.apply = (fn, thisArg, args) => (
      fn === originalWeakSetHas ? true : originalApply(fn, thisArg, args)
    )
    WeakSet.prototype.has = () => true
    assert.throws(() => mvpBenchmarkPreflightBatchView(
      untrusted, session(), authorization(),
    ))
    assert.throws(() => mvpBenchmarkPreflightBatchView(
      hostile, session(), authorization(),
    ))
    assert.equal(mvpBenchmarkPreflightBatchView(
      trusted, session(), authorization(),
    ).batchSha256, trusted.batchSha256)

    const state = createMvpBenchmarkPreflightState({
      async createPreflight() { return untrusted },
    })
    assert.equal(await state.preflight(session(), authorization()), false)
    assert.equal(state.batch.value, null)
    assert.equal(proxyReads, 0)
  } finally {
    Reflect.apply = originalApply
    WeakSet.prototype.has = originalWeakSetHas
  }
})

test('latest preflight request wins and failure never retains a stale success', async () => {
  const pending = []
  const state = createMvpBenchmarkPreflightState({
    createPreflight() {
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
  })
  const first = state.preflight(session(), authorization())
  const second = state.preflight(session(), authorization())
  pending[1].resolve(parsedBatch(batch({ batchSha256: 'f'.repeat(64) })))
  assert.equal(await second, true)
  pending[0].resolve(parsedBatch())
  assert.equal(await first, false)
  assert.equal(state.batch.value.batchSha256, 'f'.repeat(64))
  state.invalidate()
  assert.equal(state.batch.value, null)
})

test('preflight UI requires explicit SSH and Vault confirmation without execution calls', () => {
  const api = fs.readFileSync(path.resolve('src/api/v2/mvpBenchmarkPreflight.js'), 'utf8')
  const panel = fs.readFileSync(
    path.resolve('src/components/benchmark/MvpBenchmarkPreflightPanel.vue'), 'utf8',
  )
  const canvas = fs.readFileSync(path.resolve('src/views/WorkflowCanvas.vue'), 'utf8')
  assert.match(api, /authorizations\/\$\{encodeURIComponent\(authorization\.uid\)\}\/preflight/u)
  assert.doesNotMatch(api, /execute-next|release|accounting/u)
  assert.match(panel, /SSH/u)
  assert.match(panel, /Vault/u)
  assert.match(panel, /不会提交 H3\/TTS Provider 作业/u)
  assert.match(canvas, /ElMessageBox\.confirm/u)
  assert.match(canvas, /将读取本地 Vault/u)
  assert.doesNotMatch(panel, /credentialRef|password|secret/u)
})
