import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  mvpBenchmarkCloseoutStatusView,
  parseMvpBenchmarkCloseoutStatusJson,
} from '../src/benchmark/mvpCloseoutStatus.js'
import { parseMvpBenchmarkPreflightBatchJson } from '../src/benchmark/mvpPreflight.js'
import {
  createMvpBenchmarkCloseoutStatusState,
} from '../src/composables/useMvpBenchmarkCloseoutStatus.js'

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
    requiredEnvironmentSha256: '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43',
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
  const batch = parseMvpBenchmarkPreflightBatchJson(
    JSON.stringify(rawBatch()), currentSession, currentAuthorization,
  )
  return { session: currentSession, authorization: currentAuthorization, batch }
}

const GATE_IDS = [
  'production-execution', 'final-export', 'human-av-review',
  'accounting-settlement', 'resource-release',
]
const PENDING_CODES = [
  'MVP_BENCHMARK_PRODUCTION_EXECUTION_PENDING',
  'MVP_BENCHMARK_FINAL_EXPORT_PENDING',
  'MVP_BENCHMARK_HUMAN_AV_REVIEW_PENDING',
  'MVP_BENCHMARK_ACCOUNTING_SETTLEMENT_PENDING',
  'MVP_BENCHMARK_RESOURCE_RELEASE_PENDING',
]
const GLOBAL_IDS = [
  'windows-release-lifecycle', 'section-19-project-evidence',
  'licenses-and-sources', 'accepted-residual-risks',
]

function rawStatus(complete = false) {
  const current = values()
  return {
    schemaVersion: 'mvp-benchmark-closeout-status.v1',
    dramaUid: current.session.dramaUid,
    sessionUid: current.session.uid,
    authorizationUid: current.authorization.uid,
    batchSha256: current.batch.batchSha256,
    benchmarkEvidenceComplete: complete,
    mvpComplete: false,
    completedGateCount: complete ? 5 : 0,
    totalGateCount: 5,
    gates: GATE_IDS.map((id, index) => ({
      id,
      status: complete ? 'complete' : 'pending',
      evidenceSha256: complete ? String(index + 1).repeat(64) : null,
      blockerCode: complete ? null : PENDING_CODES[index],
    })),
    remainingMvpEvidenceIds: complete ? GLOBAL_IDS : [...GATE_IDS, ...GLOBAL_IDS],
  }
}

function parsedStatus(complete = false) {
  const current = values()
  return {
    ...current,
    status: parseMvpBenchmarkCloseoutStatusJson(
      JSON.stringify(rawStatus(complete)), current.session, current.authorization, current.batch,
    ),
  }
}

test('closeout status projects exact gates and never claims project MVP completion', () => {
  const pending = parsedStatus(false)
  assert.equal(pending.status.completedGateCount, 0)
  assert.equal(pending.status.mvpComplete, false)
  assert.equal(pending.status.remainingMvpEvidenceIds.length, 9)
  const complete = parsedStatus(true)
  assert.equal(complete.status.benchmarkEvidenceComplete, true)
  assert.equal(complete.status.completedGateCount, 5)
  assert.equal(complete.status.mvpComplete, false)
  assert.deepEqual(complete.status.remainingMvpEvidenceIds, GLOBAL_IDS)
})

test('closeout status rejects count, gate branch, order, and remaining-evidence drift', () => {
  const current = values()
  const invalid = [
    { ...rawStatus(), completedGateCount: 1 },
    { ...rawStatus(), benchmarkEvidenceComplete: true },
    { ...rawStatus(), mvpComplete: true },
    { ...rawStatus(), remainingMvpEvidenceIds: GLOBAL_IDS },
  ]
  const wrongGate = rawStatus()
  wrongGate.gates[0] = { ...wrongGate.gates[0], blockerCode: PENDING_CODES[1] }
  invalid.push(wrongGate)
  const reordered = rawStatus()
  ;[reordered.gates[0], reordered.gates[1]] = [reordered.gates[1], reordered.gates[0]]
  invalid.push(reordered)
  for (const candidate of invalid) {
    assert.throws(() => parseMvpBenchmarkCloseoutStatusJson(
      JSON.stringify(candidate), current.session, current.authorization, current.batch,
    ))
  }
})

test('closeout public view is strict-JSON branded and resists intrinsic pollution', () => {
  const current = parsedStatus(true)
  const untrusted = structuredClone(current.status)
  let reads = 0
  const hostile = new Proxy(untrusted, {
    getOwnPropertyDescriptor() { reads += 1; throw new Error('sentinel') },
    getPrototypeOf() { reads += 1; throw new Error('sentinel') },
    ownKeys() { reads += 1; throw new Error('sentinel') },
  })
  const originalApply = Reflect.apply
  const originalWeakSetHas = WeakSet.prototype.has
  try {
    Reflect.apply = (fn, thisArg, args) => (
      fn === originalWeakSetHas ? true : originalApply(fn, thisArg, args)
    )
    WeakSet.prototype.has = () => true
    assert.throws(() => mvpBenchmarkCloseoutStatusView(
      untrusted, current.session, current.authorization, current.batch,
    ))
    assert.throws(() => mvpBenchmarkCloseoutStatusView(
      hostile, current.session, current.authorization, current.batch,
    ))
    assert.equal(mvpBenchmarkCloseoutStatusView(
      current.status, current.session, current.authorization, current.batch,
    ).mvpComplete, false)
    assert.equal(reads, 0)
  } finally {
    Reflect.apply = originalApply
    WeakSet.prototype.has = originalWeakSetHas
  }
})

test('closeout refresh is explicit and stale responses cannot replace the latest status', async () => {
  const current = parsedStatus(false)
  const complete = parsedStatus(true)
  const pending = []
  let calls = 0
  const state = createMvpBenchmarkCloseoutStatusState({
    getStatus() {
      calls += 1
      return new Promise((resolve) => pending.push(resolve))
    },
  })
  assert.equal(calls, 0)
  const first = state.load(current.session, current.authorization, current.batch)
  const second = state.load(current.session, current.authorization, current.batch)
  pending[1](complete.status)
  assert.equal(await second, true)
  pending[0](current.status)
  assert.equal(await first, false)
  assert.equal(state.status.value.completedGateCount, 5)
  state.invalidate()
  assert.equal(state.status.value, null)
})

test('workflow exposes a read-only closeout panel without claiming automatic MVP completion', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const panel = fs.readFileSync(
    path.join(root, 'src/components/benchmark/MvpBenchmarkCloseoutStatusPanel.vue'), 'utf8',
  )
  const canvas = fs.readFileSync(path.join(root, 'src/views/WorkflowCanvas.vue'), 'utf8')
  assert.match(panel, /MVP 收尾证据/u)
  assert.match(panel, /不等于项目 MVP 已完成/u)
  assert.match(panel, /不会提交任务、结算费用或归还实例/u)
  assert.doesNotMatch(panel, /@click=.*execute|@click=.*settle|@click=.*release/u)
  assert.match(canvas, /MvpBenchmarkCloseoutStatusPanel/u)
  assert.match(canvas, /refreshMvpCloseoutStatus/u)
})
