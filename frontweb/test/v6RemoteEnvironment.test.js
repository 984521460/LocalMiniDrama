import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'

import {
  environmentReportView,
  initializationPlanView,
  initializationRequestPayload,
  modelInstallationRequestPayload,
} from '../src/components/remote/environmentContract.js'

const UID = '00000000-0000-4000-8000-000000009901'
const HASH = 'a'.repeat(64)
const STEPS = [
  { ordinal: 0, id: 'workspace-layout.v1', action: 'ensure-workspace-layout', parameters: { layoutVersion: '1.0.0' } },
  { ordinal: 1, id: 'python-runtime.v1', action: 'ensure-python-runtime', parameters: { pythonVersion: '3.11', torchVersion: '2.7.1', cudaVersion: '12.8' } },
  { ordinal: 2, id: 'comfyui-version.v1', action: 'ensure-comfyui-version', parameters: { comfyUiVersion: '0.3.50' } },
  { ordinal: 3, id: 'custom-node-lock.v1', action: 'ensure-custom-nodes', parameters: { lockVersion: 'builtin-nodes.1' } },
  { ordinal: 4, id: 'ffmpeg-runtime.v1', action: 'verify-ffmpeg', parameters: { minimumMajor: 7 } },
  { ordinal: 5, id: 'workflow-bundle.v1', action: 'install-bundled-workflows', parameters: { bundleVersion: 'mvp-workflows.1' } },
  { ordinal: 6, id: 'environment-gate.v1', action: 'verify-environment', parameters: { profileVersion: '1.0.0' } },
]

test('remote environment views are exact and never accept path or command fields', () => {
  const report = environmentReportView({
    contractVersion: 'remote-environment-report.v1',
    connectionUid: UID,
    collectedAtEpochMs: 0,
    profileVersion: '1.0.0',
    platform: 'linux',
    architecture: 'x64',
    gpuVendor: 'nvidia',
    gpuCount: 1,
    totalVramMiB: 24564,
    systemMemoryMiB: 65536,
    diskFreeMiB: 524288,
    pythonVersion: '3.11.9',
    torchVersion: '2.7.1',
    cudaVersion: '12.8',
    ffmpegVersion: '7.1.1',
    comfyUiVersion: '0.3.50',
    workspaceWritable: true,
    directoriesReady: true,
    comfyUiReachable: true,
    ready: true,
  })
  assert.equal(report.ready, true)
  assert.throws(() => environmentReportView({ ...report, homePath: '/private/path' }))
})

test('initialization payloads contain hashes and exact confirmation only', () => {
  const plan = initializationPlanView({
    contractVersion: 'remote-initialization-plan.v1',
    profileId: 'featurize-comfyui',
    profileVersion: '1.0.0',
    connectionUid: UID,
    planHash: HASH,
    steps: STEPS,
    modelDownloads: [],
    requiresLargeModelConfirmation: false,
  })
  assert.equal(plan.planHash, HASH)
  assert.deepEqual(initializationRequestPayload(plan), { planHash: HASH })
  assert.deepEqual(modelInstallationRequestPayload(plan), {
    planHash: HASH,
    confirmation: 'confirm-large-model-downloads',
  })
  assert.throws(() => initializationRequestPayload({ ...plan, command: 'ignored' }))
  assert.throws(() => initializationPlanView({ ...plan, steps: [...STEPS].reverse() }))

  const firstModel = {
    modelId: 'model-a',
    version: '1.0.0',
    sizeBytes: 1024,
    licenseId: 'synthetic-license',
    artifactSha256: 'b'.repeat(64),
  }
  const secondModel = {
    modelId: 'model-b',
    version: '1.0.0',
    sizeBytes: 2048,
    licenseId: 'synthetic-license',
    artifactSha256: 'c'.repeat(64),
  }
  assert.throws(() => initializationPlanView({
    ...plan,
    modelDownloads: [firstModel, { ...firstModel, version: '2.0.0' }],
    requiresLargeModelConfirmation: true,
  }))
  assert.throws(() => initializationPlanView({
    ...plan,
    modelDownloads: [secondModel, firstModel],
    requiresLargeModelConfirmation: true,
  }))

  const parameterDrifts = [
    ['layoutVersion', '9.9.9'],
    ['pythonVersion', '3.12'],
    ['comfyUiVersion', '9.9.9'],
    ['lockVersion', 'drifted-nodes.1'],
    ['minimumMajor', 8],
    ['bundleVersion', 'drifted-workflows.1'],
    ['profileVersion', '9.9.9'],
  ]
  for (const [index, [key, driftedValue]] of parameterDrifts.entries()) {
    const driftedSteps = STEPS.map((step, stepIndex) => (stepIndex === index
      ? { ...step, parameters: { ...step.parameters, [key]: driftedValue } }
      : step))
    assert.throws(() => initializationPlanView({ ...plan, steps: driftedSteps }))
  }
})

test('remote environment panel compiles as a standalone bounded UI component', () => {
  const filename = path.resolve('src/components/remote/RemoteEnvironmentPanel.vue')
  const source = fs.readFileSync(filename, 'utf8')
  const parsed = parse(source, { filename })
  assert.deepEqual(parsed.errors, [])
  assert.doesNotThrow(() => compileScript(parsed.descriptor, { id: 'remote-environment-panel' }))
  const compiled = compileTemplate({
    id: 'remote-environment-panel',
    filename,
    source: parsed.descriptor.template.content,
  })
  assert.deepEqual(compiled.errors, [])
})
