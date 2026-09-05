import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'

import {
  environmentReportView,
  initializationPlanView,
  initializationRequestPayload,
  modelVerificationRequestPayload,
} from '../src/components/remote/environmentContract.js'

const UID = '00000000-0000-4000-8000-000000009901'
const HASH = 'a'.repeat(64)
const LICENSED = JSON.parse(fs.readFileSync(path.resolve('../licenses/h3-runtime-assets.json'), 'utf8'))
const MODELS = LICENSED.assets.map((asset) => ({
  modelId: asset.role,
  version: LICENSED.runtimeRepository.revision,
  relativePath: `models/${asset.repositoryPath}`,
  sizeBytes: asset.bytes,
  licenseId: LICENSED.effectiveLicense.id,
  artifactSha256: asset.sha256,
  acquisition: LICENSED.distribution.acquisition,
})).sort((left, right) => left.modelId.localeCompare(right.modelId))
const STEPS = [
  { ordinal: 0, id: 'workspace-layout.v1', action: 'ensure-workspace-layout', parameters: { layoutVersion: '2.0.0' } },
  { ordinal: 1, id: 'python-runtime.v1', action: 'verify-python-runtime', parameters: { pythonVersion: '3.12.12', torchVersion: '2.11.0+cu130', cudaVersion: '13.0' } },
  { ordinal: 2, id: 'ffmpeg-runtime.v1', action: 'verify-ffmpeg', parameters: { ffmpegVersion: '8.1.2' } },
  { ordinal: 3, id: 'workflow-bundle.v1', action: 'install-bundled-workflows', parameters: { bundleVersion: 'minimax-h3-t2v.v1' } },
  { ordinal: 4, id: 'comfyui-version.v1', action: 'ensure-comfyui-service', parameters: { comfyUiVersion: '0.33.0', comfyUiRevision: '0696f61d953d09878988ebc4ca46e263f73ff65f', listenScope: 'loopback' } },
  { ordinal: 5, id: 'custom-node-lock.v1', action: 'verify-custom-nodes', parameters: { lockVersion: 'minimax-h3-builtin-nodes.v1' } },
  { ordinal: 6, id: 'environment-gate.v1', action: 'verify-environment', parameters: { profileVersion: '2.0.0', approvedEnvironmentSha256: '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43' } },
]

test('remote environment views are exact and never accept path or command fields', () => {
  const report = environmentReportView({
    contractVersion: 'remote-environment-report.v2',
    connectionUid: UID,
    collectedAtEpochMs: 0,
    profileVersion: '2.0.0',
    platform: 'linux',
    architecture: 'x64',
    gpuVendor: 'nvidia',
    gpuName: 'NVIDIA GeForce RTX 4090',
    gpuCount: 1,
    totalVramMiB: 24564,
    driverVersion: '595.84',
    systemMemoryMiB: 65536,
    diskFreeMiB: 524288,
    pythonVersion: '3.12.12',
    torchVersion: '2.11.0+cu130',
    cudaVersion: '13.0',
    ffmpegVersion: '8.1.2',
    comfyUiVersion: '0.33.0',
    comfyUiRevision: '0696f61d953d09878988ebc4ca46e263f73ff65f',
    workspaceWritable: true,
    directoriesReady: true,
    comfyUiReachable: true,
    ready: true,
  })
  assert.equal(report.ready, true)
  assert.equal(environmentReportView({ ...report, gpuName: 'NVIDIA RTX 6000 Ada', ready: false }).ready, false)
  assert.throws(() => environmentReportView({ ...report, homePath: '/private/path' }))

  let reads = 0
  const missingProfile = { ...report, extra: true }
  delete missingProfile.profileVersion
  Object.defineProperty(Object.prototype, 'profileVersion', {
    configurable: true,
    get() { reads += 1; return '2.0.0' },
  })
  try {
    assert.throws(() => environmentReportView(missingProfile))
    assert.equal(reads, 0)
  } finally {
    delete Object.prototype.profileVersion
  }
})

test('initialization payloads contain hashes and exact confirmation only', () => {
  const plan = initializationPlanView({
    contractVersion: 'remote-initialization-plan.v2',
    profileId: 'minimax-h3-featurize',
    profileVersion: '2.0.0',
    approvedEnvironmentSha256: '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43',
    connectionUid: UID,
    planHash: HASH,
    steps: STEPS,
    modelFiles: MODELS,
    requiresModelVerificationConfirmation: true,
  })
  assert.equal(plan.planHash, HASH)
  assert.deepEqual(initializationRequestPayload(plan), { planHash: HASH })
  assert.deepEqual(modelVerificationRequestPayload(plan), {
    planHash: HASH,
    confirmation: 'confirm-model-file-verification',
  })
  assert.throws(() => initializationRequestPayload({ ...plan, command: 'ignored' }))
  assert.throws(() => initializationPlanView({ ...plan, steps: [...STEPS].reverse() }))
  assert.throws(() => initializationPlanView({
    ...plan,
    modelFiles: [{ ...MODELS[0], artifactSha256: 'b'.repeat(64) }, ...MODELS.slice(1)],
  }))

  const firstModel = MODELS[0]
  const secondModel = MODELS[1]
  assert.throws(() => initializationPlanView({
    ...plan,
    modelFiles: [firstModel, { ...firstModel }, ...MODELS.slice(2)],
  }))
  assert.throws(() => initializationPlanView({
    ...plan,
    modelFiles: [secondModel, firstModel, ...MODELS.slice(2)],
  }))

  const parameterDrifts = [
    ['layoutVersion', '9.9.9'],
    ['pythonVersion', '3.11'],
    ['comfyUiVersion', '9.9.9'],
    ['lockVersion', 'drifted-nodes.1'],
    ['ffmpegVersion', '9.9.9'],
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
  assert.match(source, /不会下载运行时或模型权重/u)
  assert.match(source, /核心环境符合固定版本基线；模型仍需单独核验/u)
  assert.match(source, /:disabled="!available \|\| !safeReport\?\.ready"/u)
})
