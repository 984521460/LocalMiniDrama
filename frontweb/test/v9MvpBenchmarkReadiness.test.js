import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  MVP_CAPABILITY_SPECS,
  MVP_CHECKLIST_SPECS,
  mvpBenchmarkReadinessView,
} from '../src/benchmark/mvpReadiness.js'
import { useMvpBenchmarkReadiness } from '../src/composables/useMvpBenchmarkReadiness.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { createMvpBenchmarkReadiness } = require(
  '../../backend-node/src/benchmark/mvpBenchmarkReadiness.js',
)

function readiness(overrides = {}) {
  const capabilities = MVP_CAPABILITY_SPECS.map((spec, index) => ({
    id: spec.id,
    kind: spec.kind,
    status: index === 5 ? 'blocked' : index >= 10 ? 'pending' : 'ready',
    blockerCode: index === 5 || index >= 10 ? spec.blockerCode : null,
  }))
  return {
    schemaVersion: 'mvp-benchmark-readiness.v1',
    checklistVersion: 'mvp-section-19.v1',
    readyForBenchmark: false,
    mvpComplete: false,
    capabilities,
    blockedCapabilityIds: ['ready-gpu-connection'],
    pendingCapabilityIds: ['windows-release-evidence', 'human-av-review'],
    checklist: MVP_CHECKLIST_SPECS.map((spec) => ({ ...spec, status: 'pending' })),
    ...overrides,
  }
}

test('MVP readiness view accepts only the exact fail-closed cross-layer contract', () => {
  const view = mvpBenchmarkReadinessView(readiness())
  assert.equal(view.mvpComplete, false)
  assert.equal(view.readyForBenchmark, false)
  assert.equal(view.capabilities.length, 12)
  assert.equal(view.checklist.length, 34)
  assert.deepEqual(view.blockedCapabilityIds, ['ready-gpu-connection'])
  assert.deepEqual(view.pendingCapabilityIds, ['windows-release-evidence', 'human-av-review'])
  assert.ok(Object.isFrozen(view))
  assert.ok(Object.isFrozen(view.capabilities))

  const invalid = [
    readiness({ extra: true }),
    readiness({ mvpComplete: true }),
    readiness({ readyForBenchmark: true }),
    readiness({ blockedCapabilityIds: [] }),
    readiness({ pendingCapabilityIds: ['human-av-review', 'windows-release-evidence'] }),
    readiness({ capabilities: readiness().capabilities.slice(1) }),
    readiness({ capabilities: readiness().capabilities.map((item, index) => (
      index === 5 ? { ...item, status: 'ready', blockerCode: null } : item
    )) }),
    readiness({ checklist: readiness().checklist.slice(0, 33) }),
    readiness({ checklist: readiness().checklist.map((item, index) => (
      index === 0 ? { ...item, status: 'complete' } : item
    )) }),
  ]
  for (const value of invalid) assert.throws(() => mvpBenchmarkReadinessView(value))
})

test('frontend projection accepts the current backend readiness DTO without weakening it', () => {
  const backend = createMvpBenchmarkReadiness()
  const frontend = mvpBenchmarkReadinessView(backend)
  assert.equal(frontend.schemaVersion, backend.schemaVersion)
  assert.deepEqual(frontend.capabilities, backend.capabilities)
  assert.deepEqual(frontend.checklist, backend.checklist)
  assert.equal(frontend.readyForBenchmark, false)
  assert.equal(frontend.mvpComplete, false)
})

test('MVP readiness view rejects accessors without executing them', () => {
  let reads = 0
  const candidate = readiness()
  Object.defineProperty(candidate, 'mvpComplete', {
    enumerable: true,
    get() { reads += 1; return false },
  })
  assert.throws(() => mvpBenchmarkReadinessView(candidate))
  assert.equal(reads, 0)

  const nested = readiness()
  Object.defineProperty(nested.capabilities[0], 'status', {
    enumerable: true,
    get() { reads += 1; return 'ready' },
  })
  assert.throws(() => mvpBenchmarkReadinessView(nested))
  assert.equal(reads, 0)

  const missingRootKey = readiness()
  delete missingRootKey.schemaVersion
  missingRootKey.extra = true
  Object.defineProperty(Object.prototype, 'schemaVersion', {
    configurable: true,
    get() { reads += 1; return 'mvp-benchmark-readiness.v1' },
  })
  try {
    assert.throws(() => mvpBenchmarkReadinessView(missingRootKey))
    assert.equal(reads, 0)
  } finally {
    delete Object.prototype.schemaVersion
  }

  const missingNestedKey = readiness()
  delete missingNestedKey.capabilities[0].status
  missingNestedKey.capabilities[0].extra = true
  Object.defineProperty(Object.prototype, 'status', {
    configurable: true,
    get() { reads += 1; return 'ready' },
  })
  try {
    assert.throws(() => mvpBenchmarkReadinessView(missingNestedKey))
    assert.equal(reads, 0)
  } finally {
    delete Object.prototype.status
  }

  const missingArrayIndex = readiness()
  delete missingArrayIndex.capabilities[0]
  missingArrayIndex.capabilities.extra = true
  Object.defineProperty(Object.prototype, '0', {
    configurable: true,
    get() { reads += 1; return missingArrayIndex.capabilities[1] },
  })
  try {
    assert.throws(() => mvpBenchmarkReadinessView(missingArrayIndex))
    assert.equal(reads, 0)
  } finally {
    delete Object.prototype['0']
  }
})

test('same-page stale readiness requests cannot overwrite the latest response', async () => {
  const pending = []
  const api = {
    getReadiness() {
      return new Promise((resolve) => pending.push(resolve))
    },
  }
  const state = useMvpBenchmarkReadiness({ api })
  const first = state.load()
  const second = state.load()
  pending[1](readiness())
  assert.equal(await second, true)
  pending[0](readiness({ mvpComplete: true }))
  assert.equal(await first, false)
  assert.equal(state.readiness.value?.mvpComplete, false)
  assert.equal(state.error.value, null)

  const third = state.load()
  pending[2](readiness({ extra: true }))
  assert.equal(await third, false)
  assert.equal(state.readiness.value, null)
  assert.equal(state.error.value, 'MVP_BENCHMARK_READINESS_REQUEST_FAILED')
})

test('MVP readiness is a read-only panel wired through the strict GET transport', () => {
  const api = fs.readFileSync(path.resolve(
    __dirname, '../src/api/v2/mvpBenchmark.js',
  ), 'utf8')
  const panel = fs.readFileSync(path.resolve(
    __dirname, '../src/components/benchmark/MvpBenchmarkReadinessPanel.vue',
  ), 'utf8')
  const canvas = fs.readFileSync(path.resolve(
    __dirname, '../src/views/WorkflowCanvas.vue',
  ), 'utf8')

  assert.match(api, /workflowJsonTextRequest\.get\(['"]\/v2\/mvp-benchmark\/readiness['"]\)/)
  assert.doesNotMatch(api, /\.post\(|\.delete\(|\.put\(|\.patch\(/)
  assert.match(panel, /MVP 尚未完成/)
  assert.match(panel, /34 项验收清单/)
  assert.match(panel, /\$emit\(['"]refresh['"]\)/)
  assert.doesNotMatch(panel, /\$emit\(['"](?:execute|prepare|authorize|start)['"]\)/)
  assert.doesNotMatch(panel, /credential|secret|api[_-]?key/i)
  assert.match(canvas, /MvpBenchmarkReadinessPanel/)
  assert.match(canvas, /useMvpBenchmarkReadiness/)
  assert.match(canvas, /name="mvp"/)
})
