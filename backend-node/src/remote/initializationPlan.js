'use strict';

const crypto = require('node:crypto');

const {
  canonicalUid,
  denseArray,
  exactObject,
  fail,
  safeInteger,
  safeToken,
  sha256,
} = require('./environmentValidation');
const {
  H3_REMOTE_ENVIRONMENT_PROFILE,
  createH3RemoteModelCatalog,
} = require('./h3EnvironmentProfile');

const PROFILE = Object.freeze({
  profileId: H3_REMOTE_ENVIRONMENT_PROFILE.profileId,
  profileVersion: H3_REMOTE_ENVIRONMENT_PROFILE.profileVersion,
  approvedEnvironmentSha256: H3_REMOTE_ENVIRONMENT_PROFILE.approvedEnvironmentSha256,
  gpuName: H3_REMOTE_ENVIRONMENT_PROFILE.gpu.name,
  gpuCount: 1,
  totalVramMiB: H3_REMOTE_ENVIRONMENT_PROFILE.gpu.vramMiB,
  driverVersion: H3_REMOTE_ENVIRONMENT_PROFILE.gpu.driverVersion,
  pythonVersion: H3_REMOTE_ENVIRONMENT_PROFILE.runtime.pythonVersion,
  torchVersion: H3_REMOTE_ENVIRONMENT_PROFILE.runtime.pytorchVersion,
  cudaVersion: H3_REMOTE_ENVIRONMENT_PROFILE.cudaVersion,
  comfyUiVersion: H3_REMOTE_ENVIRONMENT_PROFILE.comfyUI.version,
  comfyUiRevision: H3_REMOTE_ENVIRONMENT_PROFILE.comfyUI.revision,
  comfyListenScope: H3_REMOTE_ENVIRONMENT_PROFILE.comfyUI.listenScope,
  customNodeLockVersion: 'minimax-h3-builtin-nodes.v1',
  workflowBundleVersion: 'minimax-h3-t2v.v1',
  ffmpegVersion: H3_REMOTE_ENVIRONMENT_PROFILE.runtime.ffmpegVersion,
});
const MAX_MODEL_SIZE_BYTES = 1_125_899_906_842_624;

const STEP_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'workspace-layout.v1',
    action: 'ensure-workspace-layout',
    parameters: Object.freeze({ layoutVersion: '2.0.0' }),
  }),
  Object.freeze({
    id: 'python-runtime.v1',
    action: 'verify-python-runtime',
    parameters: Object.freeze({
      pythonVersion: PROFILE.pythonVersion,
      torchVersion: PROFILE.torchVersion,
      cudaVersion: PROFILE.cudaVersion,
    }),
  }),
  Object.freeze({
    id: 'ffmpeg-runtime.v1',
    action: 'verify-ffmpeg',
    parameters: Object.freeze({ ffmpegVersion: PROFILE.ffmpegVersion }),
  }),
  Object.freeze({
    id: 'workflow-bundle.v1',
    action: 'install-bundled-workflows',
    parameters: Object.freeze({ bundleVersion: PROFILE.workflowBundleVersion }),
  }),
  Object.freeze({
    id: 'comfyui-version.v1',
    action: 'ensure-comfyui-service',
    parameters: Object.freeze({
      comfyUiVersion: PROFILE.comfyUiVersion,
      comfyUiRevision: PROFILE.comfyUiRevision,
      listenScope: PROFILE.comfyListenScope,
    }),
  }),
  Object.freeze({
    id: 'custom-node-lock.v1',
    action: 'verify-custom-nodes',
    parameters: Object.freeze({ lockVersion: PROFILE.customNodeLockVersion }),
  }),
  Object.freeze({
    id: 'environment-gate.v1',
    action: 'verify-environment',
    parameters: Object.freeze({
      profileVersion: PROFILE.profileVersion,
      approvedEnvironmentSha256: PROFILE.approvedEnvironmentSha256,
    }),
  }),
]);

const INITIALIZATION_ACTION_METHODS = Object.freeze({
  'ensure-workspace-layout': 'ensureWorkspaceLayout',
  'verify-python-runtime': 'verifyPythonRuntime',
  'ensure-comfyui-service': 'ensureComfyUiService',
  'verify-custom-nodes': 'verifyCustomNodes',
  'verify-ffmpeg': 'verifyFfmpeg',
  'install-bundled-workflows': 'installBundledWorkflows',
  'verify-environment': 'verifyEnvironment',
});

function copyStep(step, ordinal) {
  return Object.freeze({
    ordinal,
    id: step.id,
    action: step.action,
    parameters: step.parameters,
  });
}

function modelEntry(value) {
  const input = exactObject(value, [
    'modelId', 'version', 'relativePath', 'sizeBytes', 'licenseId',
    'artifactSha256', 'acquisition',
  ]);
  if (typeof input.relativePath !== 'string'
    || !/^models\/(?:diffusion_models|text_encoders|vae|loras)\/[A-Za-z0-9._-]{1,160}$/u
      .test(input.relativePath)
    || input.acquisition !== 'runtime-user-acquired') fail();
  return Object.freeze({
    modelId: safeToken(input.modelId, false),
    version: safeToken(input.version, false),
    relativePath: input.relativePath,
    sizeBytes: safeInteger(input.sizeBytes, 1, MAX_MODEL_SIZE_BYTES),
    licenseId: safeToken(input.licenseId, false),
    artifactSha256: sha256(input.artifactSha256),
    acquisition: input.acquisition,
  });
}

function normalizedModels(value) {
  const models = denseArray(value, 64).map(modelEntry);
  models.sort((left, right) => (left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0));
  if (models.some((model, index) => index > 0 && model.modelId === models[index - 1].modelId)) fail();
  const totalBytes = models.reduce((total, model) => total + model.sizeBytes, 0);
  if (!Number.isSafeInteger(totalBytes)) fail();
  const approved = createH3RemoteModelCatalog();
  const keys = [
    'modelId', 'version', 'relativePath', 'sizeBytes', 'licenseId',
    'artifactSha256', 'acquisition',
  ];
  if (models.length !== approved.length || models.some((model, index) => (
    keys.some((key) => model[key] !== approved[index][key])
  ))) fail();
  return Object.freeze(models);
}

function createInitializationPlan(value) {
  const input = exactObject(value, ['connectionUid', 'modelCatalog']);
  const connectionUid = canonicalUid(input.connectionUid);
  const steps = Object.freeze(STEP_DEFINITIONS.map(copyStep));
  const modelFiles = normalizedModels(input.modelCatalog);
  const hashInput = Object.freeze({
    contractVersion: 'remote-initialization-plan.v2',
    profileId: PROFILE.profileId,
    profileVersion: PROFILE.profileVersion,
    approvedEnvironmentSha256: PROFILE.approvedEnvironmentSha256,
    connectionUid,
    steps,
    modelFiles,
    requiresModelVerificationConfirmation: true,
  });
  const planHash = crypto.createHash('sha256').update(JSON.stringify(hashInput)).digest('hex');
  return Object.freeze({
    contractVersion: hashInput.contractVersion,
    profileId: hashInput.profileId,
    profileVersion: hashInput.profileVersion,
    connectionUid,
    planHash,
    steps,
    approvedEnvironmentSha256: hashInput.approvedEnvironmentSha256,
    modelFiles: hashInput.modelFiles,
    requiresModelVerificationConfirmation:
      hashInput.requiresModelVerificationConfirmation,
  });
}

function createInitializationRequest(value) {
  const input = exactObject(value, ['planHash']);
  return Object.freeze({ planHash: sha256(input.planHash) });
}

function createModelVerificationRequest(value) {
  const input = exactObject(value, ['planHash', 'confirmation']);
  if (input.confirmation !== 'confirm-model-file-verification') fail();
  return Object.freeze({
    planHash: sha256(input.planHash),
    confirmation: input.confirmation,
  });
}

module.exports = Object.freeze({
  INITIALIZATION_ACTION_METHODS,
  PROFILE,
  createInitializationPlan,
  createInitializationRequest,
  createModelVerificationRequest,
});
