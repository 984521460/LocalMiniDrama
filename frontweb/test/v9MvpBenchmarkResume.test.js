import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  mvpBenchmarkResumeSnapshotView,
  parseMvpBenchmarkResumeSnapshotJson,
} from '../src/benchmark/mvpResume.js'
import { createMvpBenchmarkResumeState } from '../src/composables/useMvpBenchmarkResume.js'

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

function batch() {
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

function progress() {
  const currentBatch = batch()
  return {
    schemaVersion: 'mvp-benchmark-production-execution-progress.v1',
    authorizationUid: currentBatch.authorizationUid,
    sessionUid: currentBatch.sessionUid,
    dramaUid: currentBatch.dramaUid,
    batchSha256: currentBatch.batchSha256,
    completedCount: 0,
    totalCount: currentBatch.reservations.length,
    batchComplete: false,
    nextItem: {
      ordinal: 0,
      itemKind: currentBatch.reservations[0].itemKind,
      itemUid: currentBatch.reservations[0].itemUid,
    },
  }
}

function rawSnapshot(state = 'execution') {
  return {
    schemaVersion: 'mvp-benchmark-resume-snapshot.v1',
    dramaUid: uid(2),
    workflowRunUid: uid(3),
    state,
    sessionJson: state === 'empty' ? null : JSON.stringify(session()),
    authorizationJson: state === 'empty' || state === 'session'
      ? null : JSON.stringify(authorization()),
    batchJson: state === 'execution' ? JSON.stringify(batch()) : null,
    progressJson: state === 'execution' ? JSON.stringify(progress()) : null,
  }
}

function parsedSnapshot(state = 'execution') {
  return parseMvpBenchmarkResumeSnapshotJson(JSON.stringify(rawSnapshot(state)), {
    dramaUid: uid(2),
    workflowRunUid: uid(3),
  })
}

test('resume snapshot restores only the exact locally verified prefix', () => {
  const empty = parsedSnapshot('empty')
  assert.equal(empty.state, 'empty')
  assert.equal(empty.session, null)

  const sessionOnly = parsedSnapshot('session')
  assert.equal(sessionOnly.session.uid, uid(1))
  assert.equal(sessionOnly.authorization, null)

  const authorized = parsedSnapshot('authorization')
  assert.equal(authorized.authorization.uid, uid(80))
  assert.equal(authorized.batch, null)

  const execution = parsedSnapshot()
  assert.equal(execution.batch.batchSha256, 'e'.repeat(64))
  assert.equal(execution.progress.completedCount, 0)
  assert.equal(execution.progress.nextItem.itemUid, uid(10))
  assert.equal(Object.isFrozen(execution), true)
})

test('resume snapshot rejects partial, cross-bound, and ambiguous nested evidence', () => {
  const partial = rawSnapshot('execution')
  partial.progressJson = null
  assert.throws(() => parseMvpBenchmarkResumeSnapshotJson(JSON.stringify(partial)))

  const crossRun = rawSnapshot('session')
  const crossSession = session()
  crossSession.workflowRunUid = uid(999)
  crossRun.sessionJson = JSON.stringify(crossSession)
  assert.throws(() => parseMvpBenchmarkResumeSnapshotJson(JSON.stringify(crossRun)))

  const duplicate = rawSnapshot('session')
  duplicate.sessionJson = duplicate.sessionJson.replace(
    '{', '{"schemaVersion":"mvp-benchmark-session-plan.v1",',
  )
  assert.throws(() => parseMvpBenchmarkResumeSnapshotJson(JSON.stringify(duplicate)))

  assert.throws(() => parseMvpBenchmarkResumeSnapshotJson(JSON.stringify({
    ...rawSnapshot('empty'), extra: true,
  })))
})

test('resume public view accepts only strict-JSON branded values without Proxy traps', () => {
  const trusted = parsedSnapshot()
  const untrusted = structuredClone(trusted)
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
    assert.throws(() => mvpBenchmarkResumeSnapshotView(untrusted))
    assert.throws(() => mvpBenchmarkResumeSnapshotView(hostile))
    assert.equal(mvpBenchmarkResumeSnapshotView(trusted).state, 'execution')
    assert.equal(reads, 0)
  } finally {
    Reflect.apply = originalApply
    WeakSet.prototype.has = originalWeakSetHas
  }
})

test('resume state is explicit and stale responses cannot replace the latest run', async () => {
  const pending = []
  let calls = 0
  const state = createMvpBenchmarkResumeState({
    getSnapshot() {
      calls += 1
      return new Promise((resolve) => pending.push(resolve))
    },
  })
  assert.equal(calls, 0)
  const first = state.load(uid(2), uid(3))
  const second = state.load(uid(2), uid(3))
  assert.equal(calls, 2)
  pending[1](parsedSnapshot('authorization'))
  assert.equal(await second, true)
  pending[0](parsedSnapshot('session'))
  assert.equal(await first, false)
  assert.equal(state.snapshot.value.state, 'authorization')
  state.invalidate()
  assert.equal(state.snapshot.value, null)
})

test('workflow mounts an explicit read-only resume control without automatic execution', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const canvas = fs.readFileSync(path.join(root, 'src/views/WorkflowCanvas.vue'), 'utf8')
  const panel = fs.readFileSync(
    path.join(root, 'src/components/benchmark/MvpBenchmarkResumePanel.vue'), 'utf8',
  )
  assert.match(canvas, /@resume="resumeMvpState"/u)
  assert.match(panel, /恢复本地执行状态/u)
  assert.match(panel, /不会访问 SSH、Vault、Provider 或 GPU/u)
  assert.doesNotMatch(panel, /execute-next|preflight\(/u)
})
