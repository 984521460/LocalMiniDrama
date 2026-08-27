import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createLatestRequestGuard,
  groupNarrativeResults,
} from '../src/components/narrative/narrativeReview.js'

test('projects one coherent approved benchmark chain in workflow order', () => {
  const chain = [
    { uid: 'facts', resultType: 'extraction', status: 'approved', createdAt: '2026-01-01T00:00:00Z' },
    { uid: 'adaptation', resultType: 'adaptation', status: 'approved', upstreamResultUid: 'facts', createdAt: '2026-01-01T00:01:00Z' },
    { uid: 'script', resultType: 'script', status: 'approved', upstreamResultUid: 'adaptation', createdAt: '2026-01-01T00:02:00Z' },
    { uid: 'shot', resultType: 'shot', status: 'approved', upstreamResultUid: 'script', createdAt: '2026-01-01T00:03:00Z' },
  ]
  const grouped = groupNarrativeResults(chain)
  assert.deepEqual(grouped.map((item) => [item.type, item.result?.uid, item.result?.status]), [
    ['extraction', 'facts', 'approved'],
    ['adaptation', 'adaptation', 'approved'],
    ['script', 'script', 'approved'],
    ['shot', 'shot', 'approved'],
  ])
  assert.equal(Object.isFrozen(grouped), true)
})

test('invalidates stale workflow responses and keeps the page behind thin evidence modules', () => {
  const guard = createLatestRequestGuard()
  const oldRequest = guard.begin()
  const latestRequest = guard.begin()
  assert.equal(guard.isCurrent(oldRequest), false)
  assert.equal(guard.isCurrent(latestRequest), true)
  guard.invalidate()
  assert.equal(guard.isCurrent(latestRequest), false)

  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const sourceRoot = path.join(testDirectory, '..', 'src')
  const workflow = fs.readFileSync(path.join(sourceRoot, 'views', 'NarrativeWorkflow.vue'), 'utf8')
  const review = fs.readFileSync(
    path.join(sourceRoot, 'components', 'narrative', 'NarrativeReviewWorkspace.vue'),
    'utf8',
  )
  assert.match(workflow, /SourceSelectionPanel/)
  assert.match(workflow, /NarrativeReviewWorkspace/)
  assert.match(review, /事实 → 改编 → 剧本 → 分镜逐级批准/)
  assert.match(review, /groupNarrativeResults/)
  assert.match(review, /createLatestRequestGuard/)
  assert.match(review, /result\.status === 'stale'/)
  assert.match(review, /查看证据/)
  assert.doesNotMatch(workflow, /groupNarrativeResults/)
})
