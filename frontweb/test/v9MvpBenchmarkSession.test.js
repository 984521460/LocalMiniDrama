import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { mvpBenchmarkSessionView } from '../src/benchmark/mvpSession.js'
import { useMvpBenchmarkSession } from '../src/composables/useMvpBenchmarkSession.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { createMvpBenchmarkSessionPlan } = require(
  '../../backend-node/src/benchmark/mvpBenchmarkSession.js',
)

function uid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
}

function session(workflowRunUid = uid(1), dramaUid = uid(2)) {
  return createMvpBenchmarkSessionPlan({
    schemaVersion: 'mvp-benchmark-session-plan.v1',
    uid: uid(3),
    dramaUid,
    workflowRunUid,
    workflowUid: uid(4),
    graphHash: 'a'.repeat(64),
    graphRevision: 1,
    h3Tasks: [0, 1, 2, 3].map((index) => ({
      taskUid: uid(10 + index),
      intentUid: uid(20 + index),
      nodeRunUid: uid(30 + index),
      nodeUid: uid(40 + index),
      assetUid: uid(50 + index),
      manifestUid: uid(60),
      generationSpecSha256: String(index + 1).repeat(64),
      planEvidenceSha256: String(index + 5).repeat(64),
    })),
    audioIntents: [{
      intentUid: uid(70),
      nodeRunUid: uid(71),
      nodeUid: uid(72),
      planSha256: '9'.repeat(64),
    }],
    createdAtEpochMs: 0,
  })
}

test('MVP session view accepts only the exact path-bound secret-free plan', () => {
  const source = session()
  const view = mvpBenchmarkSessionView(structuredClone(source), {
    dramaUid: source.dramaUid,
    workflowRunUid: source.workflowRunUid,
  })
  assert.deepEqual(view, source)
  assert.equal(Object.isFrozen(view), true)
  assert.equal(Object.isFrozen(view.h3Tasks), true)

  const duplicateNode = structuredClone(source)
  duplicateNode.audioIntents[0].nodeUid = duplicateNode.h3Tasks[0].nodeUid
  const invalid = [
    { ...structuredClone(source), extra: true },
    { ...structuredClone(source), schemaVersion: 'mvp-benchmark-session-plan.v2' },
    { ...structuredClone(source), planSha256: 'z'.repeat(64) },
    { ...structuredClone(source), h3Tasks: structuredClone(source.h3Tasks).slice(0, 3) },
    duplicateNode,
  ]
  for (let index = 0; index < invalid.length; index += 1) {
    assert.throws(() => mvpBenchmarkSessionView(invalid[index]))
  }
  assert.throws(() => mvpBenchmarkSessionView(structuredClone(source), {
    dramaUid: uid(999), workflowRunUid: source.workflowRunUid,
  }))
})

test('MVP session view rejects accessors and inherited missing-key fallbacks without executing them', () => {
  let reads = 0
  const accessor = structuredClone(session())
  Object.defineProperty(accessor.h3Tasks[0], 'taskUid', {
    enumerable: true,
    get() { reads += 1; return uid(10) },
  })
  assert.throws(() => mvpBenchmarkSessionView(accessor))
  assert.equal(reads, 0)

  const missing = structuredClone(session())
  delete missing.workflowUid
  missing.extra = true
  Object.defineProperty(Object.prototype, 'workflowUid', {
    configurable: true,
    get() { reads += 1; return uid(4) },
  })
  try {
    assert.throws(() => mvpBenchmarkSessionView(missing))
    assert.equal(reads, 0)
  } finally {
    delete Object.prototype.workflowUid
  }
})

test('same-page stale session preparation cannot overwrite the latest workflow run', async () => {
  const pending = []
  const api = {
    prepareWorkflowSession(dramaUid, workflowRunUid) {
      return new Promise((resolve) => pending.push({ dramaUid, workflowRunUid, resolve }))
    },
  }
  const state = useMvpBenchmarkSession({ api })
  const dramaUid = uid(2)
  const firstRun = uid(101)
  const secondRun = uid(102)
  const first = state.prepare(dramaUid, firstRun)
  const second = state.prepare(dramaUid, secondRun)
  pending[1].resolve(session(secondRun, dramaUid))
  assert.equal(await second, true)
  pending[0].resolve(session(firstRun, dramaUid))
  assert.equal(await first, false)
  assert.equal(state.session.value?.workflowRunUid, secondRun)
  assert.equal(state.error.value, null)

  const third = state.prepare(dramaUid, uid(103))
  pending[2].resolve({ ...structuredClone(session(uid(103), dramaUid)), extra: true })
  assert.equal(await third, false)
  assert.equal(state.session.value, null)
  assert.equal(state.error.value, 'MVP_BENCHMARK_SESSION_REQUEST_FAILED')
})

test('MVP session UI uses one empty local preparation request and exposes no manual identity inputs', () => {
  const api = fs.readFileSync(path.resolve(
    __dirname, '../src/api/v2/mvpBenchmarkSession.js',
  ), 'utf8')
  const panel = fs.readFileSync(path.resolve(
    __dirname, '../src/components/benchmark/MvpBenchmarkSessionPanel.vue',
  ), 'utf8')
  const canvas = fs.readFileSync(path.resolve(
    __dirname, '../src/views/WorkflowCanvas.vue',
  ), 'utf8')

  assert.match(api, /workflowJsonTextRequest\.post\(/)
  assert.match(api, /mvp-benchmark\/workflow-runs\/\$\{encodeURIComponent\(run\)\}\/session/)
  assert.match(api, /,\s*\{\},\s*\)/s)
  assert.doesNotMatch(api, /authorizations|preflight|execute-next|credential|secret/i)
  assert.match(panel, /准备本地会话/)
  assert.match(panel, /不会创建外部授权/)
  assert.match(panel, /不会产生费用/)
  assert.match(panel, /\$emit\(['"]prepare['"]\)/)
  assert.doesNotMatch(panel, /h3TaskUids|audioIntentUids|credentialRef|authorizationUid/)
  assert.doesNotMatch(panel, /\$emit\(['"](?:authorize|execute|preflight|start)['"]\)/)
  assert.match(canvas, /MvpBenchmarkSessionPanel/)
  assert.match(canvas, /useMvpBenchmarkSession/)
  assert.match(canvas, /activeWorkflow\.value\?\.dramaUid/)
})
