import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { compileScript, parse } from '@vue/compiler-sfc'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'

import { parseMvpBenchmarkPreflightBatchJson } from '../src/benchmark/mvpPreflight.js'
import {
  createMvpBenchmarkFinalizationState,
} from '../src/composables/useMvpBenchmarkFinalization.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`

async function renderFinalizationPanel(props) {
  const filename = path.resolve(
    __dirname, '../src/components/benchmark/MvpBenchmarkFinalizationPanel.vue',
  )
  const source = fs.readFileSync(filename, 'utf8')
  const descriptor = parse(source, { filename }).descriptor
  const vueUrl = import.meta.resolve('vue')
  const compiled = compileScript(descriptor, {
    id: 'mvp-benchmark-finalization-panel',
    inlineTemplate: true,
  }).content
    .replaceAll('from "vue"', `from '${vueUrl}'`)
    .replaceAll("from 'vue'", `from '${vueUrl}'`)
  const componentUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
  const component = (await import(componentUrl)).default
  const app = createSSRApp(component, props)
  app.component('el-button', {
    props: { disabled: Boolean, loading: Boolean },
    setup(buttonProps, { slots }) {
      return () => h('button', {
        disabled: buttonProps.disabled,
        'data-loading': String(buttonProps.loading),
      }, slots.default?.())
    },
  })
  return renderToString(app)
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
      intentUid: uid(70), nodeRunUid: uid(71), nodeUid: uid(72), planSha256: 'a'.repeat(64),
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
  const sourceSession = session()
  const sourceAuthorization = authorization()
  const items = [
    ...sourceSession.h3Tasks.map((item) => ({
      itemKind: 'h3', itemUid: item.taskUid, requestSha256: item.planEvidenceSha256,
    })),
    {
      itemKind: 'tts', itemUid: sourceSession.audioIntents[0].intentUid,
      requestSha256: sourceSession.audioIntents[0].planSha256,
    },
  ]
  const attestationUid = uid(82)
  const reservations = items.map((item, index) => ({
    schemaVersion: 'mvp-benchmark-execution-reservation.v1',
    uid: uid(90 + index),
    authorizationUid: sourceAuthorization.uid,
    attestationUid,
    sessionUid: sourceSession.uid,
    dramaUid: sourceSession.dramaUid,
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
    authorizationUid: sourceAuthorization.uid,
    sessionUid: sourceSession.uid,
    dramaUid: sourceSession.dramaUid,
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

function mediaExportRun() {
  const runUid = uid(200)
  const dramaUid = uid(2)
  return {
    schemaVersion: 'media-export-run.v1',
    uid: runUid,
    dramaUid,
    workflowRunUid: uid(3),
    sourceNodeRunUid: uid(201),
    executionPlanSha256: 'f'.repeat(64),
    status: 'succeeded',
    outputAssetUid: uid(202),
    outputAssetVersionUid: uid(203),
    output: {
      relativePath: `projects/${dramaUid}/exports/${runUid}.mp4`,
      sha256: '9'.repeat(64),
      bytes: 10_000,
      durationMs: 6_500,
      width: 1920,
      height: 1080,
      frameRate: '24/1',
      videoCodec: 'h264',
      audioCodec: 'aac',
    },
    errorCode: null,
    createdAt: '2026-09-04T00:00:00.000Z',
    startedAt: '2026-09-04T00:00:01.000Z',
    completedAt: '2026-09-04T00:00:02.000Z',
  }
}

test('finalization state accepts one exact local export result and ignores a stale response', async () => {
  const pending = []
  const calls = []
  const state = createMvpBenchmarkFinalizationState({
    finalize(...values) {
      calls.push(values)
      return new Promise((resolve) => pending.push(resolve))
    },
  })
  const first = state.finalize(session(), authorization(), batch(), uid(300))
  const second = state.finalize(session(), authorization(), batch(), uid(301))
  pending[1](mediaExportRun())
  assert.equal(await second, true)
  pending[0](mediaExportRun())
  assert.equal(await first, false)
  assert.equal(state.run.value.status, 'succeeded')
  assert.equal(state.run.value.statusLabel, '已完成')
  assert.equal(calls.length, 2)
  assert.equal(calls[1][3], uid(301))
})

test('finalization failure is fixed and never retains a prior export result', async () => {
  const state = createMvpBenchmarkFinalizationState({
    finalize() { return Promise.resolve(mediaExportRun()) },
  })
  assert.equal(await state.finalize(session(), authorization(), batch(), uid(300)), true)
  assert.ok(state.run.value)
  assert.equal(await state.finalize(session(), authorization(), batch(), 'invalid'), false)
  assert.equal(state.error.value, 'MVP_BENCHMARK_FINALIZATION_REQUEST_FAILED')
  assert.equal(state.run.value, null)
  state.invalidate()
  assert.equal(state.run.value, null)
})

test('the finalization panel is explicit, local-only and wired after BGM selection', () => {
  const panel = fs.readFileSync(path.resolve(
    __dirname, '../src/components/benchmark/MvpBenchmarkFinalizationPanel.vue',
  ), 'utf8')
  const canvas = fs.readFileSync(path.resolve(
    __dirname, '../src/views/WorkflowCanvas.vue',
  ), 'utf8')
  assert.match(panel, /编译并导出成片/)
  assert.match(panel, /不会再次访问 SSH、Vault、Provider 或 GPU/)
  assert.match(panel, /batchComplete && props\.selectedTrackUid/)
  assert.match(canvas, /MvpBenchmarkFinalizationPanel/)
  assert.match(canvas, /finalizeMvpProduction/)
  assert.match(canvas, /mvpExecutionBatchComplete/)
  assert.match(canvas, /bgmLibrary\.selectedTrackUid/)
  assert.match(canvas, /确认本地成片编译/)
  assert.doesNotMatch(panel, /credentialRef|apiKey|secret/i)
})

test('the compiled finalization panel renders a disabled gate until batch and BGM are ready', async () => {
  const unavailable = await renderFinalizationPanel({
    batchComplete: false,
    selectedTrackUid: '',
    run: null,
    busy: false,
    error: '',
  })
  assert.match(unavailable, /<button disabled[^>]*>编译并导出成片<\/button>/)
  assert.match(unavailable, /所有预检批次项目取得可信成功结果后才可编译成片/)

  const available = await renderFinalizationPanel({
    batchComplete: true,
    selectedTrackUid: uid(300),
    run: { statusLabel: '已完成' },
    busy: false,
    error: '',
  })
  assert.match(available, /<button [^>]*data-loading="false"[^>]*>编译并导出成片<\/button>/)
  assert.doesNotMatch(available, /<button disabled/)
  assert.match(available, /成片导出状态：已完成/)
})
