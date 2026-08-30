import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  mediaExportRunRequest,
  mediaExportRunView,
} from '../src/media/mediaExportRun.js'
import { useMediaExports } from '../src/composables/useMediaExports.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uid = (value) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`

function record(overrides = {}) {
  const runUid = uid(1)
  const dramaUid = uid(2)
  return {
    schemaVersion: 'media-export-run.v1',
    uid: runUid,
    dramaUid,
    workflowRunUid: uid(3),
    sourceNodeRunUid: uid(4),
    executionPlanSha256: 'a'.repeat(64),
    status: 'succeeded',
    outputAssetUid: uid(5),
    outputAssetVersionUid: uid(6),
    output: {
      relativePath: `projects/${dramaUid}/exports/${runUid}.mp4`,
      sha256: 'b'.repeat(64), bytes: 1024, durationMs: 1500,
      width: 1920, height: 1080, frameRate: '24/1',
      videoCodec: 'h264', audioCodec: 'aac',
    },
    errorCode: null,
    createdAt: '2026-08-30T02:00:00.000Z',
    startedAt: '2026-08-30T02:00:01.000Z',
    completedAt: '2026-08-30T02:00:02.000Z',
    ...overrides,
  }
}

test('media export request sends only the opaque node-run identity', () => {
  assert.deepEqual(mediaExportRunRequest({ nodeRunUid: uid(4) }), { node_run_uid: uid(4) })
  assert.throws(() => mediaExportRunRequest({ nodeRunUid: uid(4), executionPlan: {} }))
})

test('media export view rejects unsafe paths, state drift and extra fields', () => {
  assert.equal(mediaExportRunView(record()).statusLabel, '已完成')
  assert.throws(() => mediaExportRunView(record({ extra: true })))
  assert.throws(() => mediaExportRunView(record({
    output: { ...record().output, relativePath: 'C:\\private\\final.mp4' },
  })))
  assert.throws(() => mediaExportRunView(record({ status: 'failed' })))
  assert.throws(() => mediaExportRunView(record({
    status: 'failed', outputAssetUid: null, outputAssetVersionUid: null,
    output: null, errorCode: 'MEDIA_EXPORT_UNKNOWN',
  })))
  assert.equal(mediaExportRunView(record({
    output: { ...record().output, bytes: 68_719_476_736, durationMs: 3_600_100 },
  })).status, 'succeeded')
  for (const output of [
    { ...record().output, bytes: 68_719_476_737 },
    { ...record().output, durationMs: 3_600_101 },
  ]) assert.throws(() => mediaExportRunView(record({ output })))
  for (const timestamps of [
    {
      createdAt: '2026-08-30T02:00:01.000Z',
      startedAt: '2026-08-30T02:00:00.999Z',
    },
    {
      startedAt: '2026-08-30T02:00:02.000Z',
      completedAt: '2026-08-30T02:00:01.999Z',
    },
  ]) assert.throws(() => mediaExportRunView(record(timestamps)))
})

test('media export UI remains a small modular panel wired into the workflow canvas', () => {
  const panel = fs.readFileSync(path.resolve(
    __dirname, '../src/components/media/MediaExportRunPanel.vue',
  ), 'utf8')
  const canvas = fs.readFileSync(path.resolve(
    __dirname, '../src/views/WorkflowCanvas.vue',
  ), 'utf8')
  assert.match(panel, /生成并验证 1080p 成片/)
  assert.match(canvas, /MediaExportRunPanel/)
  assert.match(canvas, /succeededExportNodeRunUid/)
  assert.doesNotMatch(panel, /api[_-]?key|credential|secret|absolutePath/i)
})

test('same-drama stale refresh cannot overwrite the latest media export list', async () => {
  const pending = []
  const api = {
    list() {
      return new Promise((resolve) => pending.push(resolve))
    },
    start() { throw new Error('not used') },
  }
  const exports = useMediaExports({ dramaId: 1, api })
  const first = exports.load()
  const second = exports.load()
  pending[1]([record()])
  assert.equal(await second, true)
  pending[0]([])
  assert.equal(await first, false)
  assert.equal(exports.runs.value.length, 1)
  assert.equal(exports.runs.value[0].uid, record().uid)
})
