import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createLatestRequestGuard,
  groupNarrativeHistory,
  groupNarrativeResults,
  reviewStatusMeta,
} from '../src/components/narrative/narrativeReview.js'

test('groups only the latest coherent narrative result chain in workflow order', () => {
  const grouped = groupNarrativeResults([
    { uid: 'old-extraction', resultType: 'extraction', createdAt: '2026-01-01T00:00:00Z' },
    {
      uid: 'old-adaptation', resultType: 'adaptation', upstreamResultUid: 'old-extraction',
      createdAt: '2026-01-02T00:00:00Z',
    },
    { uid: 'new-extraction', resultType: 'extraction', createdAt: '2026-01-03T00:00:00Z' },
  ])
  assert.deepEqual(grouped.map((item) => [item.type, item.result?.uid || null]), [
    ['extraction', 'new-extraction'],
    ['adaptation', null],
    ['script', null],
    ['shot', null],
  ])
  assert.equal(Object.isFrozen(grouped), true)
})

test('traces a latest shot through its exact approved upstream identities', () => {
  const grouped = groupNarrativeResults([
    { uid: 'other', resultType: 'extraction', createdAt: '2026-01-01T00:00:00Z' },
    { uid: 'facts', resultType: 'extraction', createdAt: '2026-01-02T00:00:00Z' },
    {
      uid: 'adaptation', resultType: 'adaptation', upstreamResultUid: 'facts',
      createdAt: '2026-01-03T00:00:00Z',
    },
    {
      uid: 'script', resultType: 'script', upstreamResultUid: 'adaptation',
      createdAt: '2026-01-04T00:00:00Z',
    },
    {
      uid: 'shot', resultType: 'shot', upstreamResultUid: 'script',
      createdAt: '2026-01-05T00:00:00Z',
    },
  ])
  assert.deepEqual(grouped.map((item) => item.result?.uid || null), [
    'facts', 'adaptation', 'script', 'shot',
  ])
})

test('lists every result outside the current chain as immutable history in newest-first order', () => {
  const oldExtraction = {
    uid: 'old-extraction', resultType: 'extraction', status: 'stale',
    createdAt: '2026-01-01T00:00:00.000Z', resultHash: 'a'.repeat(64),
  }
  const oldAdaptation = {
    uid: 'old-adaptation', resultType: 'adaptation', status: 'stale',
    upstreamResultUid: oldExtraction.uid, createdAt: '2026-01-02T00:00:00.000Z',
    resultHash: 'b'.repeat(64),
  }
  const currentExtraction = {
    uid: 'current-extraction', resultType: 'extraction', status: 'pending_review',
    createdAt: '2026-01-03T00:00:00.000Z', resultHash: 'c'.repeat(64),
  }
  const history = groupNarrativeHistory([
    currentExtraction, oldExtraction, oldAdaptation,
  ])

  assert.deepEqual(history.map((item) => [item.type, item.result.uid]), [
    ['adaptation', 'old-adaptation'],
    ['extraction', 'old-extraction'],
  ])
  assert.equal(Object.isFrozen(history), true)
  assert.equal(Object.isFrozen(history[0]), true)
})

test('maps review states to stable user-facing labels and tones', () => {
  assert.deepEqual(reviewStatusMeta('pending_review'), { label: '待审核', tone: 'warning' })
  assert.deepEqual(reviewStatusMeta('approved'), { label: '已批准', tone: 'success' })
  assert.deepEqual(reviewStatusMeta('rejected'), { label: '已驳回', tone: 'danger' })
  assert.deepEqual(reviewStatusMeta('stale'), { label: '已失效', tone: 'info' })
  assert.throws(() => reviewStatusMeta('unknown'), /review status is invalid/i)
})

test('invalidates older review requests when the selected drama changes', () => {
  const guard = createLatestRequestGuard()
  const oldRequest = guard.begin()
  const currentRequest = guard.begin()
  assert.equal(guard.isCurrent(oldRequest), false)
  assert.equal(guard.isCurrent(currentRequest), true)
  guard.invalidate()
  assert.equal(guard.isCurrent(currentRequest), false)
})

test('keeps review API and workflow UI behind thin modules', () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const sourceRoot = path.join(testDirectory, '..', 'src')
  const api = fs.readFileSync(path.join(sourceRoot, 'api', 'v2', 'narrativeReviews.js'), 'utf8')
  const workspace = fs.readFileSync(
    path.join(sourceRoot, 'components', 'narrative', 'NarrativeReviewWorkspace.vue'),
    'utf8',
  )
  const workflow = fs.readFileSync(path.join(sourceRoot, 'views', 'NarrativeWorkflow.vue'), 'utf8')

  assert.match(api, /listForDrama/)
  assert.match(api, /review/)
  assert.match(workspace, /groupNarrativeResults/)
  assert.match(workspace, /groupNarrativeHistory/)
  assert.match(workspace, /历史测试作品/)
  assert.match(workspace, /查看旧版证据与完整结果/)
  const historyMarkup = workspace.match(
    /<section v-if="history\.length"[\s\S]*?<\/section>/u,
  )?.[0]
  assert.ok(historyMarkup)
  assert.match(historyMarkup, /viewEvidence\(entry\.result\.uid\)/u)
  assert.doesNotMatch(historyMarkup, /@click="submit\(|>批准<|>驳回<|supersede/u)
  assert.match(workspace, /审核数据加载失败/)
  assert.match(workspace, /createLatestRequestGuard/)
  assert.match(workspace, /results\.value = \[\]/)
  assert.match(workspace, /查看证据/)
  assert.match(workspace, /批准/)
  assert.match(workspace, /驳回/)
  assert.match(workflow, /NarrativeReviewWorkspace/)
  assert.doesNotMatch(workflow, /groupNarrativeResults/)
})
