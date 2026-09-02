import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  mvpBenchmarkProductionExecutionProgressView,
  mvpBenchmarkProductionExecutionStepView,
  parseMvpBenchmarkProductionExecutionProgressJson,
  parseMvpBenchmarkProductionExecutionStepJson,
} from '../src/benchmark/mvpExecution.js'
import { parseMvpBenchmarkPreflightBatchJson } from '../src/benchmark/mvpPreflight.js'
import { createMvpBenchmarkExecutionState } from '../src/composables/useMvpBenchmarkExecution.js'

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
    requiredEnvironmentSha256: '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8',
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

function rawBatch() {
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
  }
}

function batch() {
  return parseMvpBenchmarkPreflightBatchJson(
    JSON.stringify(rawBatch()), session(), authorization(),
  )
}

function rawStep(completedCount = 1) {
  const currentBatch = rawBatch()
  const complete = completedCount === currentBatch.reservations.length
  const reservation = currentBatch.reservations[completedCount - 1]
  return {
    schemaVersion: 'mvp-benchmark-production-execution-step.v1',
    authorizationUid: currentBatch.authorizationUid,
    sessionUid: currentBatch.sessionUid,
    dramaUid: currentBatch.dramaUid,
    batchSha256: currentBatch.batchSha256,
    completedCount,
    totalCount: currentBatch.reservations.length,
    batchComplete: complete,
    item: complete ? null : {
      ordinal: completedCount - 1,
      itemKind: reservation.itemKind,
      itemUid: reservation.itemUid,
      status: 'succeeded',
    },
  }
}

function parsedStep(completedCount = 1) {
  return parseMvpBenchmarkProductionExecutionStepJson(
    JSON.stringify(rawStep(completedCount)), session(), authorization(), batch(),
  )
}

function rawProgress(completedCount = 0) {
  const currentBatch = rawBatch()
  const complete = completedCount === currentBatch.reservations.length
  const reservation = currentBatch.reservations[completedCount]
  return {
    schemaVersion: 'mvp-benchmark-production-execution-progress.v1',
    authorizationUid: currentBatch.authorizationUid,
    sessionUid: currentBatch.sessionUid,
    dramaUid: currentBatch.dramaUid,
    batchSha256: currentBatch.batchSha256,
    completedCount,
    totalCount: currentBatch.reservations.length,
    batchComplete: complete,
    nextItem: complete ? null : {
      ordinal: completedCount,
      itemKind: reservation.itemKind,
      itemUid: reservation.itemUid,
    },
  }
}

function parsedProgress(completedCount = 0) {
  return parseMvpBenchmarkProductionExecutionProgressJson(
    JSON.stringify(rawProgress(completedCount)), session(), authorization(), batch(),
  )
}

test('execution step is exact, batch-bound, ordered, and terminal-safe', () => {
  assert.deepEqual(parsedStep(1), rawStep(1))
  assert.deepEqual(parsedStep(5), rawStep(5))
  assert.throws(() => parseMvpBenchmarkProductionExecutionStepJson(
    JSON.stringify({ ...rawStep(1), extra: true }), session(), authorization(), batch(),
  ))
  assert.throws(() => parseMvpBenchmarkProductionExecutionStepJson(
    JSON.stringify({ ...rawStep(1), totalCount: 4 }), session(), authorization(), batch(),
  ))
  assert.throws(() => parseMvpBenchmarkProductionExecutionStepJson(
    JSON.stringify({ ...rawStep(1), batchSha256: 'f'.repeat(64) }),
    session(), authorization(), batch(),
  ))
  assert.throws(() => parseMvpBenchmarkProductionExecutionStepJson(
    JSON.stringify({ ...rawStep(5), item: rawStep(1).item }), session(), authorization(), batch(),
  ))
  const wrongItem = rawStep(2)
  wrongItem.item.itemUid = uid(999)
  assert.throws(() => parseMvpBenchmarkProductionExecutionStepJson(
    JSON.stringify(wrongItem), session(), authorization(), batch(),
  ))
})

test('execution progress is exact, batch-bound, continuous, and terminal-safe', () => {
  assert.deepEqual(parsedProgress(0), rawProgress(0))
  assert.deepEqual(parsedProgress(1), rawProgress(1))
  assert.deepEqual(parsedProgress(5), rawProgress(5))
  assert.throws(() => parseMvpBenchmarkProductionExecutionProgressJson(
    JSON.stringify({ ...rawProgress(1), extra: true }), session(), authorization(), batch(),
  ))
  assert.throws(() => parseMvpBenchmarkProductionExecutionProgressJson(
    JSON.stringify({ ...rawProgress(1), batchSha256: 'f'.repeat(64) }),
    session(), authorization(), batch(),
  ))
  const skipped = rawProgress(1)
  skipped.nextItem.ordinal = 2
  assert.throws(() => parseMvpBenchmarkProductionExecutionProgressJson(
    JSON.stringify(skipped), session(), authorization(), batch(),
  ))
  assert.throws(() => parseMvpBenchmarkProductionExecutionProgressJson(
    JSON.stringify({ ...rawProgress(5), nextItem: rawProgress(1).nextItem }),
    session(), authorization(), batch(),
  ))
})

test('execution view accepts only strict-JSON branded values and ignores later intrinsic pollution', () => {
  const trusted = parsedStep(1)
  const untrusted = structuredClone(trusted)
  const trustedProgress = parsedProgress(1)
  const untrustedProgress = structuredClone(trustedProgress)
  const originalApply = Reflect.apply
  const originalWeakSetHas = WeakSet.prototype.has
  let proxyReads = 0
  const hostile = new Proxy(rawStep(1), {
    getOwnPropertyDescriptor() { proxyReads += 1; throw new Error('descriptor sentinel') },
    getPrototypeOf() { proxyReads += 1; throw new Error('prototype sentinel') },
    ownKeys() { proxyReads += 1; throw new Error('keys sentinel') },
  })
  try {
    Reflect.apply = (fn, thisArg, args) => (
      fn === originalWeakSetHas ? true : originalApply(fn, thisArg, args)
    )
    WeakSet.prototype.has = () => true
    assert.throws(() => mvpBenchmarkProductionExecutionStepView(
      untrusted, session(), authorization(), batch(),
    ))
    assert.throws(() => mvpBenchmarkProductionExecutionStepView(
      hostile, session(), authorization(), batch(),
    ))
    assert.throws(() => mvpBenchmarkProductionExecutionProgressView(
      untrustedProgress, session(), authorization(), batch(),
    ))
    assert.equal(mvpBenchmarkProductionExecutionStepView(
      trusted, session(), authorization(), batch(),
    ).completedCount, 1)
    assert.equal(mvpBenchmarkProductionExecutionProgressView(
      trustedProgress, session(), authorization(), batch(),
    ).completedCount, 1)
    assert.equal(proxyReads, 0)
  } finally {
    Reflect.apply = originalApply
    WeakSet.prototype.has = originalWeakSetHas
  }
})

test('execution state advances by one verified response and never auto-executes', async () => {
  const pending = []
  let calls = 0
  const ordinals = []
  const state = createMvpBenchmarkExecutionState({
    executeNext(_session, _authorization, _batch, ordinal) {
      calls += 1
      ordinals.push(ordinal)
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
    getProgress() { throw new Error('unexpected progress read') },
  })
  const first = state.executeNext(session(), authorization(), batch())
  assert.equal(calls, 1)
  pending[0].resolve(parsedStep(1))
  assert.equal(await first, true)
  assert.equal(state.step.value.completedCount, 1)
  assert.equal(calls, 1)

  const second = state.executeNext(session(), authorization(), batch())
  pending[1].resolve(parsedStep(3))
  assert.equal(await second, false)
  assert.equal(state.step.value.completedCount, 1)
  assert.equal(calls, 2)

  const retry = state.executeNext(session(), authorization(), batch())
  pending[2].resolve(parsedStep(2))
  assert.equal(await retry, true)
  assert.equal(state.step.value.completedCount, 2)
  assert.equal(calls, 3)
  assert.deepEqual(ordinals, [0, 1, 1])
  state.invalidate()
  assert.equal(state.step.value, null)
  assert.equal(state.progress.value, null)
})

test('latest execution response wins without advancing from a stale response', async () => {
  const pending = []
  const state = createMvpBenchmarkExecutionState({
    executeNext() {
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
    getProgress() { throw new Error('unexpected progress read') },
  })
  const first = state.executeNext(session(), authorization(), batch())
  const second = state.executeNext(session(), authorization(), batch())
  pending[1].resolve(parsedStep(1))
  assert.equal(await second, true)
  pending[0].resolve(parsedStep(1))
  assert.equal(await first, false)
  assert.equal(state.step.value.completedCount, 1)
})

test('read-only refresh reconstructs a lost receipt and resumes at the exact next item', async () => {
  const executedOrdinals = []
  let progressCalls = 0
  const state = createMvpBenchmarkExecutionState({
    executeNext(_session, _authorization, _batch, ordinal) {
      executedOrdinals.push(ordinal)
      return Promise.resolve(parsedStep(ordinal + 1))
    },
    getProgress() {
      progressCalls += 1
      return Promise.resolve(parsedProgress(1))
    },
  })
  assert.equal(await state.refresh(session(), authorization(), batch()), true)
  assert.equal(state.progress.value.completedCount, 1)
  assert.equal(state.step.value, null)
  assert.equal(progressCalls, 1)
  assert.deepEqual(executedOrdinals, [])

  assert.equal(await state.executeNext(session(), authorization(), batch()), true)
  assert.deepEqual(executedOrdinals, [1])
  assert.equal(state.step.value.completedCount, 2)
  assert.equal(state.progress.value, null)
})

test('stale progress refresh cannot overwrite a newer execution response', async () => {
  let resolveProgress
  const state = createMvpBenchmarkExecutionState({
    executeNext() { return Promise.resolve(parsedStep(1)) },
    getProgress() {
      return new Promise((resolve) => { resolveProgress = resolve })
    },
  })
  const refresh = state.refresh(session(), authorization(), batch())
  const execute = state.executeNext(session(), authorization(), batch())
  assert.equal(await execute, true)
  resolveProgress(parsedProgress(0))
  assert.equal(await refresh, false)
  assert.equal(state.step.value.completedCount, 1)
  assert.equal(state.progress.value, null)
})

test('execution UI requires per-item paid confirmation and exposes no automation or release claim', () => {
  const api = fs.readFileSync(path.resolve('src/api/v2/mvpBenchmarkExecution.js'), 'utf8')
  const panel = fs.readFileSync(
    path.resolve('src/components/benchmark/MvpBenchmarkExecutionPanel.vue'), 'utf8',
  )
  const canvas = fs.readFileSync(path.resolve('src/views/WorkflowCanvas.vue'), 'utf8')
  assert.match(api, /execute-next/u)
  assert.match(api, /execution-progress/u)
  assert.match(api, /\.get\(/u)
  assert.match(api, /mvp-benchmark-production-execution-request\.v1/u)
  assert.match(api, /expectedBatchSha256/u)
  assert.match(api, /expectedOrdinal/u)
  assert.match(api, /expectedItemKind/u)
  assert.match(api, /expectedItemUid/u)
  assert.match(panel, /仅执行这一项/u)
  assert.match(panel, /刷新可信进度/u)
  assert.match(panel, /刷新不会提交任务/u)
  assert.match(panel, /未结算|尚未归还/u)
  assert.match(canvas, /ElMessageBox\.confirm/u)
  assert.match(canvas, /真实 H3 或 TTS Provider 作业/u)
  assert.match(canvas, /可能消耗 GPU\/API 资源/u)
  assert.match(canvas, /@refresh="refreshMvpExecution"/u)
  assert.match(canvas, /本地持久成功证据重建进度/u)
  assert.doesNotMatch(api, /release|accounting|instance/u)
  assert.doesNotMatch(panel, /自动执行|自动归还/u)
  assert.doesNotMatch(api + panel + canvas, /credentialRef|password|secret/u)
})
