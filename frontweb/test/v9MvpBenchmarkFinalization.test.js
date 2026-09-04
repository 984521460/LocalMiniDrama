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
  createMvpBenchmarkShotTaskOrder,
  mvpBenchmarkShotTaskOrder,
} from '../src/benchmark/mvpShotOrder.js'
import {
  mvpBenchmarkHumanAvReviewSeed,
  parseMvpBenchmarkHumanAvReviewJson,
} from '../src/benchmark/mvpHumanAvReview.js'
import {
  createMvpBenchmarkFinalizationState,
} from '../src/composables/useMvpBenchmarkFinalization.js'
import {
  createMvpBenchmarkHumanAvReviewState,
} from '../src/composables/useMvpBenchmarkHumanAvReview.js'
import { useMvpBenchmarkShotOrder } from '../src/composables/useMvpBenchmarkShotOrder.js'

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

async function renderHumanAvReviewPanel(props) {
  const filename = path.resolve(
    __dirname, '../src/components/benchmark/MvpBenchmarkHumanAvReviewPanel.vue',
  )
  const source = fs.readFileSync(filename, 'utf8')
  const descriptor = parse(source, { filename }).descriptor
  const vueUrl = import.meta.resolve('vue')
  const compiled = compileScript(descriptor, {
    id: 'mvp-benchmark-human-av-review-panel',
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
  app.component('el-checkbox', {
    setup(_props, { slots }) { return () => h('label', slots.default?.()) },
  })
  app.component('el-input', {
    setup() { return () => h('textarea') },
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

function humanAvReview() {
  const exported = mediaExportRun()
  return parseMvpBenchmarkHumanAvReviewJson(JSON.stringify({
    schemaVersion: 'mvp-benchmark-human-av-review.v1',
    uid: uid(210),
    sessionUid: uid(1),
    authorizationUid: uid(80),
    batchSha256: 'e'.repeat(64),
    dramaUid: uid(2),
    workflowRunUid: uid(3),
    exportRunUid: exported.uid,
    exportExecutionPlanSha256: exported.executionPlanSha256,
    outputAssetUid: exported.outputAssetUid,
    outputAssetVersionUid: exported.outputAssetVersionUid,
    outputSha256: exported.output.sha256,
    outputBytes: exported.output.bytes,
    outputDurationMs: exported.output.durationMs,
    outputWidth: exported.output.width,
    outputHeight: exported.output.height,
    exportCompletedAtEpochMs: Date.parse(exported.completedAt),
    videoPlaybackAccepted: true,
    subtitleSyncAccepted: true,
    bgmBalanceAccepted: true,
    reviewNote: 'Synthetic local audiovisual review.',
    reviewedAtEpochMs: Date.parse(exported.completedAt) + 1_000,
    reviewSha256: '8'.repeat(64),
  }), session(), authorization(), batch(), exported)
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
  const order = createMvpBenchmarkShotTaskOrder(session())
  const first = state.finalize(session(), authorization(), batch(), uid(300), order)
  const second = state.finalize(session(), authorization(), batch(), uid(301), order)
  pending[1](mediaExportRun())
  assert.equal(await second, true)
  pending[0](mediaExportRun())
  assert.equal(await first, false)
  assert.equal(state.run.value.status, 'succeeded')
  assert.equal(state.run.value.statusLabel, '已完成')
  assert.equal(calls.length, 2)
  assert.equal(calls[1][3], uid(301))
  assert.deepEqual(calls[1][4], order)
})

test('finalization failure is fixed and never retains a prior export result', async () => {
  const state = createMvpBenchmarkFinalizationState({
    finalize() { return Promise.resolve(mediaExportRun()) },
  })
  const order = createMvpBenchmarkShotTaskOrder(session())
  assert.equal(await state.finalize(session(), authorization(), batch(), uid(300), order), true)
  assert.ok(state.run.value)
  assert.equal(await state.finalize(session(), authorization(), batch(), 'invalid', order), false)
  assert.equal(state.error.value, 'MVP_BENCHMARK_FINALIZATION_REQUEST_FAILED')
  assert.equal(state.run.value, null)
  state.invalidate()
  assert.equal(state.run.value, null)
})

test('shot order state moves one trusted complete permutation and resets without changing the session', () => {
  const source = session()
  const state = useMvpBenchmarkShotOrder()
  assert.equal(state.sync(source), true)
  const original = source.h3Tasks.map((entry) => entry.taskUid)
  assert.deepEqual(state.order.value, original)
  assert.equal(state.move(original[3], -1), true)
  assert.deepEqual(state.order.value, [original[0], original[1], original[3], original[2]])
  assert.deepEqual(mvpBenchmarkShotTaskOrder(state.snapshot(source), source), state.order.value)
  assert.equal(state.move(original[0], -1), false)
  assert.equal(state.reset(), true)
  assert.deepEqual(state.order.value, original)
  assert.deepEqual(source.h3Tasks.map((entry) => entry.taskUid), original)
  assert.throws(() => mvpBenchmarkShotTaskOrder([...state.order.value], source), TypeError)
  const globalSet = globalThis.Set
  let pollutedConstructorCalls = 0
  try {
    globalThis.Set = function PollutedSet() {
      pollutedConstructorCalls += 1
      throw new Error('synthetic-set-constructor')
    }
    mvpBenchmarkShotTaskOrder(state.snapshot(source), source)
  } finally {
    globalThis.Set = globalSet
  }
  assert.equal(pollutedConstructorCalls, 0)
  state.invalidate()
  assert.deepEqual(state.order.value, [])
})

test('the finalization panel is explicit, local-only and wired after BGM selection', () => {
  const panel = fs.readFileSync(path.resolve(
    __dirname, '../src/components/benchmark/MvpBenchmarkFinalizationPanel.vue',
  ), 'utf8')
  const canvas = fs.readFileSync(path.resolve(
    __dirname, '../src/views/WorkflowCanvas.vue',
  ), 'utf8')
  assert.match(panel, /编译并导出成片/)
  assert.match(panel, /成片镜头顺序（从上到下）/)
  assert.match(panel, /恢复原顺序/)
  assert.match(panel, /move-shot/)
  assert.match(panel, /不会再次访问 SSH、Vault、Provider 或 GPU/)
  assert.match(panel, /batchComplete && props\.selectedTrackUid && props\.shotTaskOrder\.length > 0/)
  assert.match(panel, /!props\.busy && !props\.run/)
  assert.match(canvas, /MvpBenchmarkFinalizationPanel/)
  assert.match(canvas, /finalizeMvpProduction/)
  assert.match(canvas, /mvpExecutionBatchComplete/)
  assert.match(canvas, /bgmLibrary\.selectedTrackUid/)
  assert.match(canvas, /mvpShotOrder\.snapshot\(session\)/)
  assert.match(canvas, /@move-shot="mvpShotOrder\.move"/)
  assert.match(canvas, /确认本地成片编译/)
  assert.doesNotMatch(panel, /credentialRef|apiKey|secret/i)
})

test('the compiled finalization panel renders a disabled gate until batch and BGM are ready', async () => {
  const unavailable = await renderFinalizationPanel({
    batchComplete: false,
    selectedTrackUid: '',
    shotTaskOrder: [],
    plannedShotTaskOrder: [],
    run: null,
    busy: false,
    error: '',
  })
  assert.match(unavailable, /<button disabled[^>]*>编译并导出成片<\/button>/)
  assert.match(unavailable, /所有预检批次项目取得可信成功结果后才可编译成片/)

  const available = await renderFinalizationPanel({
    batchComplete: true,
    selectedTrackUid: uid(300),
    shotTaskOrder: createMvpBenchmarkShotTaskOrder(session()),
    plannedShotTaskOrder: session().h3Tasks.map((entry) => entry.taskUid),
    run: null,
    busy: false,
    error: '',
  })
  assert.match(available, /<button [^>]*data-loading="false"[^>]*>编译并导出成片<\/button>/)
  assert.match(available, /原镜头 1/)
  assert.match(available, /上移/)
  assert.match(available, /下移/)

  const completed = await renderFinalizationPanel({
    batchComplete: true,
    selectedTrackUid: uid(300),
    shotTaskOrder: createMvpBenchmarkShotTaskOrder(session()),
    plannedShotTaskOrder: session().h3Tasks.map((entry) => entry.taskUid),
    run: { statusLabel: '已完成' },
    busy: false,
    error: '',
  })
  assert.match(completed, /<button disabled[^>]*>编译并导出成片<\/button>/)
  assert.match(completed, /成片导出状态：已完成/)
})

test('human audiovisual review state keeps one exact reviewed export and rejects stale state', async () => {
  const pending = []
  const state = createMvpBenchmarkHumanAvReviewState({
    get() { return Promise.resolve(humanAvReview()) },
    review(...values) {
      return new Promise((resolve) => pending.push({ resolve, values }))
    },
  })
  const first = state.submit(
    session(), authorization(), batch(), mediaExportRun(),
    {
      videoPlaybackAccepted: true,
      subtitleSyncAccepted: true,
      bgmBalanceAccepted: true,
      reviewNote: 'First local review.',
    },
  )
  const second = state.submit(
    session(), authorization(), batch(), mediaExportRun(),
    {
      videoPlaybackAccepted: true,
      subtitleSyncAccepted: true,
      bgmBalanceAccepted: true,
      reviewNote: 'Second local review.',
    },
  )
  pending[1].resolve(humanAvReview())
  assert.equal(await second, true)
  pending[0].resolve(humanAvReview())
  assert.equal(await first, false)
  assert.equal(state.review.value.reviewNote, 'Synthetic local audiovisual review.')
  assert.equal(pending[1].values[4].reviewNote, 'Second local review.')
  assert.equal(await state.load(
    session(), authorization(), batch(), mediaExportRun(),
  ), true)
  state.invalidate()
  assert.equal(state.review.value, null)
})

test('human audiovisual review strictly binds the reviewed export and all three decisions', () => {
  const review = humanAvReview()
  assert.equal(review.videoPlaybackAccepted, true)
  assert.equal(review.subtitleSyncAccepted, true)
  assert.equal(review.bgmBalanceAccepted, true)
  const exported = mediaExportRun()
  assert.throws(() => parseMvpBenchmarkHumanAvReviewJson(JSON.stringify({
    ...review,
    outputSha256: '7'.repeat(64),
  }), session(), authorization(), batch(), exported), TypeError)
  assert.throws(() => parseMvpBenchmarkHumanAvReviewJson(JSON.stringify({
    ...review,
    subtitleSyncAccepted: false,
  }), session(), authorization(), batch(), exported), TypeError)
  assert.equal(mvpBenchmarkHumanAvReviewSeed({
    videoPlaybackAccepted: true,
    subtitleSyncAccepted: true,
    bgmBalanceAccepted: true,
    reviewNote: '已完整视听 ✅',
  }).reviewNote, '已完整视听 ✅')
  assert.throws(() => mvpBenchmarkHumanAvReviewSeed({
    videoPlaybackAccepted: true,
    subtitleSyncAccepted: true,
    bgmBalanceAccepted: true,
    reviewNote: 'bad\ud800',
  }), TypeError)
})

test('the compiled human review panel is explicit, gated and shows immutable evidence', async () => {
  const pending = await renderHumanAvReviewPanel({
    run: mediaExportRun(),
    review: null,
    busy: false,
    error: '',
  })
  assert.match(pending, /程序化解码只证明文件结构有效/)
  assert.match(pending, /我已完整播放成片/)
  assert.match(pending, /我已核对字幕/)
  assert.match(pending, /BGM 没有盖住对白/)
  assert.match(pending, /<button disabled[^>]*>提交不可变人工验收<\/button>/)

  const completed = await renderHumanAvReviewPanel({
    run: mediaExportRun(),
    review: humanAvReview(),
    busy: false,
    error: '',
  })
  assert.match(completed, /已提交不可变验收/)
  assert.match(completed, /Synthetic local audiovisual review/)

  const canvas = fs.readFileSync(path.resolve(
    __dirname, '../src/views/WorkflowCanvas.vue',
  ), 'utf8')
  assert.match(canvas, /MvpBenchmarkHumanAvReviewPanel/)
  assert.match(canvas, /refreshMvpHumanAvReview/)
  assert.match(canvas, /reviewMvpProduction/)
  assert.match(canvas, /不会自动把 MVP 标记为完成/)
  assert.doesNotMatch(
    fs.readFileSync(path.resolve(
      __dirname, '../src/components/benchmark/MvpBenchmarkHumanAvReviewPanel.vue',
    ), 'utf8'),
    /credentialRef|apiKey|secret/i,
  )
})
