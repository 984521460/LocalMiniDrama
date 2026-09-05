const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const TOKEN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u
const VERSION = /^[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\+[0-9a-z.]+)?$/u

function fail() {
  throw new TypeError('Remote environment data is invalid')
}

function exactObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  let descriptors
  let prototype
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
    prototype = Object.getPrototypeOf(value)
  } catch {
    fail()
  }
  if (prototype !== Object.prototype && prototype !== null) fail()
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) fail()
  const output = Object.create(null)
  for (const key of keys) {
    if (!Object.hasOwn(descriptors, key)) fail()
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    output[key] = descriptor.value
  }
  return output
}

function denseArray(value, maxLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength
    || Reflect.ownKeys(descriptors).length !== length + 1) fail()
  const output = []
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(descriptors, String(index))) fail()
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    output.push(descriptor.value)
  }
  return output
}

function uid(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail()
  return value
}

function hash(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail()
  return value
}

function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail()
  return value
}

function token(value, nullable = false) {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !TOKEN.test(value)) fail()
  return value
}

function version(value) {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 32 || !VERSION.test(value)) fail()
  return value
}

function safeLabel(value, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > 128
    || (!allowEmpty && value.length === 0) || !/^[\x20-\x7e]*$/u.test(value)) fail()
  return value
}

function revision(value) {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) fail()
  return value
}

function boolean(value) {
  if (typeof value !== 'boolean') fail()
  return value
}

const REPORT_KEYS = [
  'contractVersion', 'connectionUid', 'collectedAtEpochMs', 'profileVersion',
  'platform', 'architecture', 'gpuVendor', 'gpuName', 'gpuCount', 'totalVramMiB',
  'driverVersion',
  'systemMemoryMiB', 'diskFreeMiB', 'pythonVersion', 'torchVersion',
  'cudaVersion', 'ffmpegVersion', 'comfyUiVersion', 'comfyUiRevision', 'workspaceWritable',
  'directoriesReady', 'comfyUiReachable', 'ready',
]

export function environmentReportView(value) {
  const input = exactObject(value, REPORT_KEYS)
  if (input.contractVersion !== 'remote-environment-report.v2'
    || input.profileVersion !== '2.0.0' || input.platform !== 'linux'
    || !['x64', 'arm64'].includes(input.architecture)
    || !['nvidia', 'amd', 'other', 'none'].includes(input.gpuVendor)) fail()
  const report = {
    contractVersion: input.contractVersion,
    connectionUid: uid(input.connectionUid),
    collectedAtEpochMs: integer(input.collectedAtEpochMs, 0, 8640000000000000),
    profileVersion: input.profileVersion,
    platform: input.platform,
    architecture: input.architecture,
    gpuVendor: input.gpuVendor,
    gpuName: safeLabel(input.gpuName, true),
    gpuCount: integer(input.gpuCount, 0, 16),
    totalVramMiB: integer(input.totalVramMiB, 0, 2097152),
    driverVersion: version(input.driverVersion),
    systemMemoryMiB: integer(input.systemMemoryMiB, 1, 4194304),
    diskFreeMiB: integer(input.diskFreeMiB, 0, 1073741824),
    pythonVersion: version(input.pythonVersion),
    torchVersion: version(input.torchVersion),
    cudaVersion: version(input.cudaVersion),
    ffmpegVersion: version(input.ffmpegVersion),
    comfyUiVersion: version(input.comfyUiVersion),
    comfyUiRevision: revision(input.comfyUiRevision),
    workspaceWritable: boolean(input.workspaceWritable),
    directoriesReady: boolean(input.directoriesReady),
    comfyUiReachable: boolean(input.comfyUiReachable),
    ready: boolean(input.ready),
  }
  if ((report.gpuCount === 0) !== (report.gpuVendor === 'none')
    || (report.gpuCount === 0) !== (report.totalVramMiB === 0)) fail()
  const expectedReady = report.gpuVendor === 'nvidia'
    && report.gpuName === 'NVIDIA GeForce RTX 4090' && report.gpuCount === 1
    && report.totalVramMiB === 24564 && report.driverVersion === '595.84'
    && report.pythonVersion === '3.12.12'
    && report.torchVersion === '2.11.0+cu130' && report.cudaVersion === '13.0'
    && report.ffmpegVersion === '8.1.2'
    && report.comfyUiVersion === '0.33.0'
    && report.comfyUiRevision === '0696f61d953d09878988ebc4ca46e263f73ff65f'
    && report.workspaceWritable
    && report.directoriesReady && report.comfyUiReachable
  if (report.ready !== expectedReady) fail()
  return Object.freeze(report)
}

const STEP_SPECS = Object.freeze([
  Object.freeze({ id: 'workspace-layout.v1', action: 'ensure-workspace-layout', parameters: Object.freeze({ layoutVersion: '2.0.0' }) }),
  Object.freeze({ id: 'python-runtime.v1', action: 'verify-python-runtime', parameters: Object.freeze({ pythonVersion: '3.12.12', torchVersion: '2.11.0+cu130', cudaVersion: '13.0' }) }),
  Object.freeze({ id: 'ffmpeg-runtime.v1', action: 'verify-ffmpeg', parameters: Object.freeze({ ffmpegVersion: '8.1.2' }) }),
  Object.freeze({ id: 'workflow-bundle.v1', action: 'install-bundled-workflows', parameters: Object.freeze({ bundleVersion: 'minimax-h3-t2v.v1' }) }),
  Object.freeze({ id: 'comfyui-version.v1', action: 'ensure-comfyui-service', parameters: Object.freeze({ comfyUiVersion: '0.33.0', comfyUiRevision: '0696f61d953d09878988ebc4ca46e263f73ff65f', listenScope: 'loopback' }) }),
  Object.freeze({ id: 'custom-node-lock.v1', action: 'verify-custom-nodes', parameters: Object.freeze({ lockVersion: 'minimax-h3-builtin-nodes.v1' }) }),
  Object.freeze({ id: 'environment-gate.v1', action: 'verify-environment', parameters: Object.freeze({ profileVersion: '2.0.0', approvedEnvironmentSha256: '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43' }) }),
])

const MODEL_SPECS = Object.freeze([
  Object.freeze({ modelId: 'audio-vae', relativePath: 'models/vae/minimax_h3_audio_vae_fp32.safetensors', sizeBytes: 605254808, artifactSha256: '8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48' }),
  Object.freeze({ modelId: 'fl2va-diffusion', relativePath: 'models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors', sizeBytes: 20970379616, artifactSha256: 'e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a' }),
  Object.freeze({ modelId: 'fl2va-turbo-lora', relativePath: 'models/loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors', sizeBytes: 1956192992, artifactSha256: 'c396a9a06f58399e9df9754b18299818d84a2ddd371724ba48fe4a41221437dc' }),
  Object.freeze({ modelId: 'ref2va-diffusion', relativePath: 'models/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors', sizeBytes: 20970379616, artifactSha256: '9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779' }),
  Object.freeze({ modelId: 'ref2va-turbo-lora', relativePath: 'models/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors', sizeBytes: 1956193000, artifactSha256: '5b9ab5ade15d0775676d01a907268a69a1468dc6033b3b0d3ded5502f3ebb84c' }),
  Object.freeze({ modelId: 'text-encoder', relativePath: 'models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', sizeBytes: 15687142551, artifactSha256: '35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6' }),
  Object.freeze({ modelId: 'video-vae', relativePath: 'models/vae/minimax_h3_video_vae_fp16.safetensors', sizeBytes: 5207808496, artifactSha256: '7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522' }),
])

function stepView(value, ordinal) {
  const input = exactObject(value, ['ordinal', 'id', 'action', 'parameters'])
  const spec = STEP_SPECS[ordinal]
  if (!spec || input.ordinal !== ordinal || input.id !== spec.id || input.action !== spec.action) fail()
  const parameterKeys = Object.keys(spec.parameters)
  const parameters = exactObject(input.parameters, parameterKeys)
  if (parameterKeys.some((key) => parameters[key] !== spec.parameters[key])) fail()
  return Object.freeze({
    ordinal,
    id: spec.id,
    action: spec.action,
    parameters: spec.parameters,
  })
}

function modelView(value, ordinal) {
  const input = exactObject(value, [
    'modelId', 'version', 'relativePath', 'sizeBytes', 'licenseId',
    'artifactSha256', 'acquisition',
  ])
  const expected = MODEL_SPECS[ordinal]
  if (!expected || input.modelId !== expected.modelId
    || input.version !== '4cc1d817b6184899b41293954329f576cb5ae86b'
    || typeof input.relativePath !== 'string'
    || !/^models\/(?:diffusion_models|text_encoders|vae|loras)\/[A-Za-z0-9._-]{1,160}$/u.test(input.relativePath)
    || input.relativePath !== expected.relativePath
    || input.sizeBytes !== expected.sizeBytes
    || input.licenseId !== 'MiniMax-H3-Community-License-Agreement'
    || input.artifactSha256 !== expected.artifactSha256
    || input.acquisition !== 'runtime-user-acquired') fail()
  return Object.freeze({
    modelId: token(input.modelId),
    version: input.version,
    relativePath: input.relativePath,
    sizeBytes: integer(input.sizeBytes, 1, 1125899906842624),
    licenseId: input.licenseId,
    artifactSha256: hash(input.artifactSha256),
    acquisition: input.acquisition,
  })
}

export function initializationPlanView(value) {
  const input = exactObject(value, [
    'contractVersion', 'profileId', 'profileVersion', 'approvedEnvironmentSha256',
    'connectionUid', 'planHash', 'steps', 'modelFiles',
    'requiresModelVerificationConfirmation',
  ])
  if (input.contractVersion !== 'remote-initialization-plan.v2'
    || input.profileId !== 'minimax-h3-featurize' || input.profileVersion !== '2.0.0'
    || input.approvedEnvironmentSha256 !== '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43') fail()
  const rawSteps = denseArray(input.steps, 7)
  if (rawSteps.length !== 7) fail()
  const steps = Object.freeze(rawSteps.map(stepView))
  const modelFiles = Object.freeze(denseArray(input.modelFiles, 7).map(modelView))
  if (modelFiles.length !== 7 || modelFiles.some((model, index) => index > 0
    && model.modelId <= modelFiles[index - 1].modelId)) fail()
  if (!Number.isSafeInteger(modelFiles.reduce((total, model) => total + model.sizeBytes, 0))) fail()
  const requiresModelVerificationConfirmation = boolean(input.requiresModelVerificationConfirmation)
  if (!requiresModelVerificationConfirmation) fail()
  return Object.freeze({
    contractVersion: input.contractVersion,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    approvedEnvironmentSha256: input.approvedEnvironmentSha256,
    connectionUid: uid(input.connectionUid),
    planHash: hash(input.planHash),
    steps,
    modelFiles,
    requiresModelVerificationConfirmation,
  })
}

export function initializationRequestPayload(value) {
  const plan = initializationPlanView(value)
  return Object.freeze({ planHash: plan.planHash })
}

export function modelVerificationRequestPayload(value) {
  const plan = initializationPlanView(value)
  return Object.freeze({
    planHash: plan.planHash,
    confirmation: 'confirm-model-file-verification',
  })
}

function initializationStepView(value, expectedId) {
  const input = exactObject(value, ['id', 'status'])
  if (typeof input.id !== 'string' || input.id !== expectedId
    || !['completed', 'already-satisfied'].includes(input.status)) fail()
  return Object.freeze({ id: input.id, status: input.status })
}

export function initializationResultView(value, expected = null) {
  const input = exactObject(value, [
    'contractVersion', 'connectionUid', 'planHash', 'kind', 'status', 'steps', 'report',
  ])
  if (input.contractVersion !== 'remote-initialization-result.v2'
    || !['core', 'model-verification'].includes(input.kind) || input.status !== 'completed') fail()
  const connectionUid = uid(input.connectionUid)
  const planHash = hash(input.planHash)
  let expectedPlan = null
  if (expected !== null && typeof expected === 'object') {
    expectedPlan = initializationPlanView(expected)
    if (connectionUid !== expectedPlan.connectionUid || planHash !== expectedPlan.planHash) fail()
  } else if (expected !== null && connectionUid !== uid(expected)) fail()

  const expectedIds = input.kind === 'core'
    ? STEP_SPECS.map((step) => step.id)
    : (expectedPlan
        ? expectedPlan.modelFiles.map((model) => `model:${model.modelId}:${model.version}`)
        : [])
  const rawSteps = denseArray(input.steps, input.kind === 'core' ? 7 : 64)
  if (rawSteps.length !== expectedIds.length) fail()
  const steps = Object.freeze(rawSteps.map((step, index) => (
    initializationStepView(step, expectedIds[index])
  )))
  const report = input.kind === 'core' ? environmentReportView(input.report) : input.report
  if ((input.kind === 'model-verification' && report !== null)
    || (input.kind === 'core' && report.connectionUid !== connectionUid)) fail()
  return Object.freeze({
    contractVersion: input.contractVersion,
    connectionUid,
    planHash,
    kind: input.kind,
    status: input.status,
    steps,
    report,
  })
}
