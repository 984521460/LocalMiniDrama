import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { useNarrativeExecution } from '../src/composables/useNarrativeExecution.js'
import {
  createNarrativeExecutionRequest,
  narrativeExecutionResponseView,
  narrativeExecutionStatus,
} from '../src/narrative/narrativeExecution.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uid = (value) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
const sha = (value) => value.repeat(64)
const TYPES = ['extraction', 'adaptation', 'script', 'shot']
const TASKS = ['NovelExtractionTask', 'EpisodeAdaptationTask', 'ScriptFormattingTask', 'ShotPlanningTask']
const SCHEMAS = ['novel-extraction.v1', 'episode-adaptation.v1', 'script-formatting.v1', 'shot-planning.v1']

function result(index, overrides = {}) {
  return {
    uid: uid(100 + index),
    dramaUid: uid(1),
    sourceSelectionUid: uid(2),
    resultType: TYPES[index],
    taskType: TASKS[index],
    schemaVersion: SCHEMAS[index],
    inputHash: sha('a'),
    resultHash: sha('b'),
    envelopeHash: sha('c'),
    result: {},
    upstreamResultUid: index === 0 ? null : uid(99 + index),
    status: 'approved',
    currentReviewUid: uid(200 + index),
    createdAt: `2026-08-30T02:00:0${index}.000Z`,
    updatedAt: `2026-08-30T02:00:0${index}.000Z`,
    staleOperationUid: null,
    staleReasonCode: null,
    staleRootKind: null,
    staleRootUid: null,
    staledAtEpochMs: null,
    ...overrides,
  }
}

function extractionRequest(operationUid = uid(10)) {
  return createNarrativeExecutionRequest({
    operationUid,
    dramaUid: uid(1),
    sourceSelectionUid: uid(2),
    results: [],
  })
}

function successResponse(request = extractionRequest()) {
  const record = result(0, {
    uid: uid(20),
    status: 'pending_review',
    currentReviewUid: null,
  })
  return {
    execution: {
      schemaVersion: 'narrative-task-execution.v1',
      operationUid: request.operationUid,
      requestSha256: sha('f'),
      request,
      expectedInputHash: record.inputHash,
      state: 'succeeded',
      resultUid: record.uid,
      errorCode: null,
      createdAtEpochMs: 1788055200000,
      updatedAtEpochMs: 1788055200001,
    },
    result: record,
  }
}

test('builds each narrative request only from the exact approved upstream chain', () => {
  assert.equal(extractionRequest().resultType, 'extraction')
  const adaptation = createNarrativeExecutionRequest({
    operationUid: uid(11), dramaUid: uid(1), sourceSelectionUid: uid(2),
    results: [result(0)],
    durationBudget: { targetSeconds: 60, toleranceSeconds: 5 },
    style: { genre: '漫剧😀', tone: '紧凑', audience: '大众' },
  })
  assert.equal(adaptation.resultType, 'adaptation')
  assert.equal(adaptation.upstreamApprovalRef, `review:v1:${uid(200)}`)
  assert.deepEqual(adaptation.durationBudget, { targetSeconds: 60, toleranceSeconds: 5 })

  const chain = [result(0), result(1), result(2), result(3)]
  assert.equal(narrativeExecutionStatus({
    dramaUid: uid(1), sourceSelectionUid: uid(2), results: chain,
  }).state, 'complete')
  assert.equal(narrativeExecutionStatus({
    dramaUid: uid(1), sourceSelectionUid: uid(2),
    results: [result(0, { status: 'pending_review', currentReviewUid: null })],
  }).state, 'review_required')
})

test('rejects malformed result evidence and inconsistent execution responses', () => {
  assert.equal(narrativeExecutionResponseView(successResponse()).execution.state, 'succeeded')
  assert.throws(() => narrativeExecutionResponseView({
    ...successResponse(), extra: true,
  }))
  assert.throws(() => narrativeExecutionResponseView({
    ...successResponse(extractionRequest(uid(12))),
    result: result(1),
  }))
  const drifted = successResponse()
  drifted.execution.resultUid = uid(999)
  assert.throws(() => narrativeExecutionResponseView(drifted))
  assert.throws(() => createNarrativeExecutionRequest({
    operationUid: uid(13), dramaUid: uid(1), sourceSelectionUid: uid(2),
    results: [{ ...result(0), resultHash: 'bad' }],
    durationBudget: { targetSeconds: 60, toleranceSeconds: 5 },
    style: { genre: '漫剧', tone: '紧凑', audience: '大众' },
  }))
})

test('same-drama stale execution cannot overwrite the latest composable state', async () => {
  const pending = []
  let nextUid = 30
  const execution = useNarrativeExecution({
    createOperationUid: () => uid(nextUid++),
    api: {
      execute(dramaId, request) {
        assert.equal(dramaId, 1)
        return new Promise((resolve) => pending.push({ request, resolve }))
      },
    },
  })
  const input = {
    dramaId: 1, dramaUid: uid(1), sourceSelectionUid: uid(2), results: [],
  }
  const first = execution.execute(input)
  const second = execution.execute(input)
  pending[1].resolve(narrativeExecutionResponseView(successResponse(pending[1].request)))
  const latest = await second
  pending[0].resolve(narrativeExecutionResponseView(successResponse(pending[0].request)))
  assert.equal(await first, null)
  assert.equal(execution.last.value.execution.operationUid, latest.execution.operationUid)
  assert.equal(execution.busy.value, false)
})

test('keeps narrative execution API, state, and UI in separate modules', () => {
  const sourceRoot = path.resolve(__dirname, '../src')
  const panel = fs.readFileSync(path.join(
    sourceRoot, 'components/narrative/NarrativeExecutionPanel.vue',
  ), 'utf8')
  const review = fs.readFileSync(path.join(
    sourceRoot, 'components/narrative/NarrativeReviewWorkspace.vue',
  ), 'utf8')
  const api = fs.readFileSync(path.join(sourceRoot, 'api/v2/narrativeExecutions.js'), 'utf8')
  assert.match(panel, /生成结果始终进入人工审核/)
  assert.match(panel, /目标时长（秒）/)
  assert.match(panel, /const duration = reactive\(\{ targetSeconds: 60, toleranceSeconds: 5 \}\)/u)
  assert.match(panel, /durationBudget: \{ \.\.\.duration \}/u)
  assert.match(panel, /useNarrativeExecution/)
  assert.match(review, /NarrativeExecutionPanel/)
  assert.match(api, /workflowJsonTextRequest/)
  assert.doesNotMatch(panel, /api[_-]?key|credential|bearer|secret/iu)
})
