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

function boolean(value) {
  if (typeof value !== 'boolean') fail()
  return value
}

const REPORT_KEYS = [
  'contractVersion', 'connectionUid', 'collectedAtEpochMs', 'profileVersion',
  'platform', 'architecture', 'gpuVendor', 'gpuCount', 'totalVramMiB',
  'systemMemoryMiB', 'diskFreeMiB', 'pythonVersion', 'torchVersion',
  'cudaVersion', 'ffmpegVersion', 'comfyUiVersion', 'workspaceWritable',
  'directoriesReady', 'comfyUiReachable', 'ready',
]

export function environmentReportView(value) {
  const input = exactObject(value, REPORT_KEYS)
  if (input.contractVersion !== 'remote-environment-report.v1'
    || input.profileVersion !== '1.0.0' || input.platform !== 'linux'
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
    gpuCount: integer(input.gpuCount, 0, 16),
    totalVramMiB: integer(input.totalVramMiB, 0, 2097152),
    systemMemoryMiB: integer(input.systemMemoryMiB, 1, 4194304),
    diskFreeMiB: integer(input.diskFreeMiB, 0, 1073741824),
    pythonVersion: version(input.pythonVersion),
    torchVersion: version(input.torchVersion),
    cudaVersion: version(input.cudaVersion),
    ffmpegVersion: version(input.ffmpegVersion),
    comfyUiVersion: version(input.comfyUiVersion),
    workspaceWritable: boolean(input.workspaceWritable),
    directoriesReady: boolean(input.directoriesReady),
    comfyUiReachable: boolean(input.comfyUiReachable),
    ready: boolean(input.ready),
  }
  if ((report.gpuCount === 0) !== (report.gpuVendor === 'none')
    || (report.gpuCount === 0) !== (report.totalVramMiB === 0)) fail()
  const ffmpegMajor = report.ffmpegVersion === null
    ? null : Number.parseInt(report.ffmpegVersion.split('.')[0], 10)
  const expectedReady = report.gpuVendor === 'nvidia' && report.gpuCount > 0
    && (report.pythonVersion === '3.11' || report.pythonVersion?.startsWith('3.11.'))
    && report.torchVersion === '2.7.1' && report.cudaVersion === '12.8'
    && Number.isSafeInteger(ffmpegMajor) && ffmpegMajor >= 7
    && report.comfyUiVersion === '0.3.50' && report.workspaceWritable
    && report.directoriesReady && report.comfyUiReachable
  if (report.ready !== expectedReady) fail()
  return Object.freeze(report)
}

const STEP_SPECS = Object.freeze([
  Object.freeze({ id: 'workspace-layout.v1', action: 'ensure-workspace-layout', parameters: Object.freeze({ layoutVersion: '1.0.0' }) }),
  Object.freeze({ id: 'python-runtime.v1', action: 'ensure-python-runtime', parameters: Object.freeze({ pythonVersion: '3.11', torchVersion: '2.7.1', cudaVersion: '12.8' }) }),
  Object.freeze({ id: 'comfyui-version.v1', action: 'ensure-comfyui-version', parameters: Object.freeze({ comfyUiVersion: '0.3.50' }) }),
  Object.freeze({ id: 'custom-node-lock.v1', action: 'ensure-custom-nodes', parameters: Object.freeze({ lockVersion: 'builtin-nodes.1' }) }),
  Object.freeze({ id: 'ffmpeg-runtime.v1', action: 'verify-ffmpeg', parameters: Object.freeze({ minimumMajor: 7 }) }),
  Object.freeze({ id: 'workflow-bundle.v1', action: 'install-bundled-workflows', parameters: Object.freeze({ bundleVersion: 'mvp-workflows.1' }) }),
  Object.freeze({ id: 'environment-gate.v1', action: 'verify-environment', parameters: Object.freeze({ profileVersion: '1.0.0' }) }),
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

function modelView(value) {
  const input = exactObject(value, [
    'modelId', 'version', 'sizeBytes', 'licenseId', 'artifactSha256',
  ])
  return Object.freeze({
    modelId: token(input.modelId),
    version: token(input.version),
    sizeBytes: integer(input.sizeBytes, 1, 1125899906842624),
    licenseId: token(input.licenseId),
    artifactSha256: hash(input.artifactSha256),
  })
}

export function initializationPlanView(value) {
  const input = exactObject(value, [
    'contractVersion', 'profileId', 'profileVersion', 'connectionUid', 'planHash',
    'steps', 'modelDownloads', 'requiresLargeModelConfirmation',
  ])
  if (input.contractVersion !== 'remote-initialization-plan.v1'
    || input.profileId !== 'featurize-comfyui' || input.profileVersion !== '1.0.0') fail()
  const rawSteps = denseArray(input.steps, 7)
  if (rawSteps.length !== 7) fail()
  const steps = Object.freeze(rawSteps.map(stepView))
  const modelDownloads = Object.freeze(denseArray(input.modelDownloads, 64).map(modelView))
  if (modelDownloads.some((model, index) => index > 0
    && model.modelId <= modelDownloads[index - 1].modelId)) fail()
  if (!Number.isSafeInteger(modelDownloads.reduce((total, model) => total + model.sizeBytes, 0))) fail()
  const requiresLargeModelConfirmation = boolean(input.requiresLargeModelConfirmation)
  if (requiresLargeModelConfirmation !== (modelDownloads.length > 0)) fail()
  return Object.freeze({
    contractVersion: input.contractVersion,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    connectionUid: uid(input.connectionUid),
    planHash: hash(input.planHash),
    steps,
    modelDownloads,
    requiresLargeModelConfirmation,
  })
}

export function initializationRequestPayload(value) {
  const plan = initializationPlanView(value)
  return Object.freeze({ planHash: plan.planHash })
}

export function modelInstallationRequestPayload(value) {
  const plan = initializationPlanView(value)
  return Object.freeze({
    planHash: plan.planHash,
    confirmation: 'confirm-large-model-downloads',
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
  if (input.contractVersion !== 'remote-initialization-result.v1'
    || !['core', 'models'].includes(input.kind) || input.status !== 'completed') fail()
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
        ? expectedPlan.modelDownloads.map((model) => `model:${model.modelId}:${model.version}`)
        : [])
  const rawSteps = denseArray(input.steps, input.kind === 'core' ? 7 : 64)
  if (rawSteps.length !== expectedIds.length) fail()
  const steps = Object.freeze(rawSteps.map((step, index) => (
    initializationStepView(step, expectedIds[index])
  )))
  const report = input.kind === 'core' ? environmentReportView(input.report) : input.report
  if ((input.kind === 'models' && report !== null)
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
