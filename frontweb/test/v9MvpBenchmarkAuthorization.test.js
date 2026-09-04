import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  mvpBenchmarkAuthorizationSeed,
  mvpBenchmarkAuthorizationView,
} from '../src/benchmark/mvpAuthorization.js'
import { createMvpBenchmarkAuthorizationState } from '../src/composables/useMvpBenchmarkAuthorization.js'
import { workflowSuccessEnvelopeDataJsonText } from '../src/api/v2/workflowRequest.js'

function uid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
}

function authorization(overrides = {}) {
  return {
    schemaVersion: 'mvp-benchmark-external-authorization.v1',
    uid: uid(1),
    sessionUid: uid(2),
    dramaUid: uid(3),
    sessionPlanSha256: 'a'.repeat(64),
    connectionUid: uid(4),
    connectionEvidenceSha256: 'b'.repeat(64),
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
    authorizationSha256: 'c'.repeat(64),
    ...overrides,
  }
}

test('authorization projection is exact, bounded, secret-free, and source-bound', () => {
  const value = authorization()
  assert.deepEqual(mvpBenchmarkAuthorizationView(structuredClone(value), {
    dramaUid: value.dramaUid,
    sessionUid: value.sessionUid,
    sessionPlanSha256: value.sessionPlanSha256,
    connectionUid: value.connectionUid,
    connectionEvidenceSha256: value.connectionEvidenceSha256,
    maximumCostCnyFen: 374,
    validityDurationMs: 7_200_000,
  }), value)
  assert.throws(() => mvpBenchmarkAuthorizationView({ ...value, extra: true }))
  assert.throws(() => mvpBenchmarkAuthorizationView({ ...value, requiredGpuClass: 'rtx4090-48gb' }))
  assert.throws(() => mvpBenchmarkAuthorizationView({ ...value, authorizationSha256: 'C'.repeat(64) }))
  assert.throws(() => mvpBenchmarkAuthorizationView(value, {
    sessionPlanSha256: 'd'.repeat(64),
  }))
  assert.throws(() => mvpBenchmarkAuthorizationView(value, {
    connectionEvidenceSha256: 'd'.repeat(64),
  }))
  assert.throws(() => mvpBenchmarkAuthorizationView(
    { ...value, expiresAtEpochMs: 7_201_001 },
    { validityDurationMs: 7_200_000 },
  ))
  assert.doesNotMatch(JSON.stringify(value), /credentialRef|password|secret/iu)
})

test('authorization projection and seed reject inherited missing-key fallbacks without reads', () => {
  const value = authorization()
  delete value.schemaVersion
  value.extra = true
  let reads = 0
  Object.defineProperty(Object.prototype, 'schemaVersion', {
    configurable: true,
    get() { reads += 1; return 'mvp-benchmark-external-authorization.v1' },
  })
  try {
    assert.throws(() => mvpBenchmarkAuthorizationView(value))
    assert.equal(reads, 0)
  } finally {
    delete Object.prototype.schemaVersion
  }
  assert.deepEqual(mvpBenchmarkAuthorizationSeed({
    maximumCostCnyFen: 374,
    validityDurationMs: 7_200_000,
  }), { maximumCostCnyFen: 374, validityDurationMs: 7_200_000 })
  assert.throws(() => mvpBenchmarkAuthorizationSeed({
    maximumCostCnyFen: 0,
    validityDurationMs: 7_200_000,
  }))

  let envelopeReads = 0
  Object.defineProperty(Object.prototype, 'success', {
    configurable: true,
    get() { envelopeReads += 1; return true },
  })
  try {
    assert.throws(() => workflowSuccessEnvelopeDataJsonText(
      '{"data":{},"timestamp":"2026-09-02T00:00:00.000Z","extra":true}',
    ))
    assert.equal(envelopeReads, 0)
  } finally {
    delete Object.prototype.success
  }
})

test('latest authorization request wins and only ready configured connections are selectable', async () => {
  const pending = []
  const state = createMvpBenchmarkAuthorizationState({
    async listConnections() {
      return [
        {
          uid: uid(4),
          status: 'ready',
          credentialConfigured: true,
          connectionEvidenceSha256: 'b'.repeat(64),
        },
        { uid: uid(5), status: 'ready', credentialConfigured: false },
        { uid: uid(6), status: 'disabled', credentialConfigured: true },
      ]
    },
    createAuthorization(_session, connection, seed) {
      return new Promise((resolve, reject) => pending.push({ connection, seed, resolve, reject }))
    },
  })
  await state.refreshConnections()
  assert.deepEqual(state.connections.value.map((entry) => entry.uid), [uid(4)])
  const session = { uid: uid(2), dramaUid: uid(3), planSha256: 'a'.repeat(64) }
  const seed = { maximumCostCnyFen: 374, validityDurationMs: 7_200_000 }
  const first = state.authorize(session, uid(4), seed)
  const second = state.authorize(session, uid(4), seed)
  pending[1].resolve(authorization({ uid: uid(8) }))
  await second
  pending[0].resolve(authorization({ uid: uid(7) }))
  await first
  assert.equal(state.authorization.value.uid, uid(8))

  const drifted = createMvpBenchmarkAuthorizationState({
    async listConnections() {
      return [{
        uid: uid(4),
        status: 'ready',
        credentialConfigured: true,
        connectionEvidenceSha256: 'b'.repeat(64),
      }]
    },
    async createAuthorization() {
      return authorization({ sessionPlanSha256: 'd'.repeat(64) })
    },
  })
  await drifted.refreshConnections()
  assert.equal(await drifted.authorize(session, uid(4), seed), false)
  assert.equal(drifted.authorization.value, null)
})

test('authorization UI requires explicit confirmation and exposes no external action call', () => {
  const api = fs.readFileSync(path.resolve('src/api/v2/mvpBenchmarkAuthorization.js'), 'utf8')
  const panel = fs.readFileSync(
    path.resolve('src/components/benchmark/MvpBenchmarkAuthorizationPanel.vue'),
    'utf8',
  )
  const canvas = fs.readFileSync(path.resolve('src/views/WorkflowCanvas.vue'), 'utf8')
  assert.match(api, /connections\/\$\{encodeURIComponent\(connection\.uid\)\}\/authorization/u)
  assert.match(api, /maximumCostCnyFen/u)
  assert.match(api, /validityDurationMs/u)
  assert.doesNotMatch(api, /preflight|execute-next|release|SSH|Vault|Provider/u)
  assert.match(panel, /费用上限（分）/u)
  assert.match(panel, /有效期（分钟）/u)
  assert.match(panel, /不会执行预检|不执行预检/u)
  assert.match(canvas, /ElMessageBox\.confirm/u)
  assert.match(canvas, /不会访问 SSH、Vault、Provider 或 GPU/u)
  assert.doesNotMatch(panel, /credentialRef|secret|password/u)
})
