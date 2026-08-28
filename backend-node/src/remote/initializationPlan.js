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

const PROFILE = Object.freeze({
  profileId: 'featurize-comfyui',
  profileVersion: '1.0.0',
  pythonVersion: '3.11',
  torchVersion: '2.7.1',
  cudaVersion: '12.8',
  comfyUiVersion: '0.3.50',
  customNodeLockVersion: 'builtin-nodes.1',
  workflowBundleVersion: 'mvp-workflows.1',
  ffmpegMinimumMajor: 7,
});
const MAX_MODEL_SIZE_BYTES = 1_125_899_906_842_624;

const STEP_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'workspace-layout.v1',
    action: 'ensure-workspace-layout',
    parameters: Object.freeze({ layoutVersion: '1.0.0' }),
  }),
  Object.freeze({
    id: 'python-runtime.v1',
    action: 'ensure-python-runtime',
    parameters: Object.freeze({
      pythonVersion: PROFILE.pythonVersion,
      torchVersion: PROFILE.torchVersion,
      cudaVersion: PROFILE.cudaVersion,
    }),
  }),
  Object.freeze({
    id: 'comfyui-version.v1',
    action: 'ensure-comfyui-version',
    parameters: Object.freeze({ comfyUiVersion: PROFILE.comfyUiVersion }),
  }),
  Object.freeze({
    id: 'custom-node-lock.v1',
    action: 'ensure-custom-nodes',
    parameters: Object.freeze({ lockVersion: PROFILE.customNodeLockVersion }),
  }),
  Object.freeze({
    id: 'ffmpeg-runtime.v1',
    action: 'verify-ffmpeg',
    parameters: Object.freeze({ minimumMajor: PROFILE.ffmpegMinimumMajor }),
  }),
  Object.freeze({
    id: 'workflow-bundle.v1',
    action: 'install-bundled-workflows',
    parameters: Object.freeze({ bundleVersion: PROFILE.workflowBundleVersion }),
  }),
  Object.freeze({
    id: 'environment-gate.v1',
    action: 'verify-environment',
    parameters: Object.freeze({ profileVersion: PROFILE.profileVersion }),
  }),
]);

const INITIALIZATION_ACTION_METHODS = Object.freeze({
  'ensure-workspace-layout': 'ensureWorkspaceLayout',
  'ensure-python-runtime': 'ensurePythonRuntime',
  'ensure-comfyui-version': 'ensureComfyUiVersion',
  'ensure-custom-nodes': 'ensureCustomNodes',
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
    'modelId', 'version', 'sizeBytes', 'licenseId', 'artifactSha256',
  ]);
  return Object.freeze({
    modelId: safeToken(input.modelId, false),
    version: safeToken(input.version, false),
    sizeBytes: safeInteger(input.sizeBytes, 1, MAX_MODEL_SIZE_BYTES),
    licenseId: safeToken(input.licenseId, false),
    artifactSha256: sha256(input.artifactSha256),
  });
}

function normalizedModels(value) {
  const models = denseArray(value, 64).map(modelEntry);
  models.sort((left, right) => (left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0));
  if (models.some((model, index) => index > 0 && model.modelId === models[index - 1].modelId)) fail();
  const totalBytes = models.reduce((total, model) => total + model.sizeBytes, 0);
  if (!Number.isSafeInteger(totalBytes)) fail();
  return Object.freeze(models);
}

function createInitializationPlan(value) {
  const input = exactObject(value, ['connectionUid', 'modelCatalog']);
  const connectionUid = canonicalUid(input.connectionUid);
  const steps = Object.freeze(STEP_DEFINITIONS.map(copyStep));
  const modelDownloads = normalizedModels(input.modelCatalog);
  const hashInput = Object.freeze({
    contractVersion: 'remote-initialization-plan.v1',
    profileId: PROFILE.profileId,
    profileVersion: PROFILE.profileVersion,
    connectionUid,
    steps,
    modelDownloads,
    requiresLargeModelConfirmation: modelDownloads.length > 0,
  });
  const planHash = crypto.createHash('sha256').update(JSON.stringify(hashInput)).digest('hex');
  return Object.freeze({
    contractVersion: hashInput.contractVersion,
    profileId: hashInput.profileId,
    profileVersion: hashInput.profileVersion,
    connectionUid,
    planHash,
    steps,
    modelDownloads,
    requiresLargeModelConfirmation: hashInput.requiresLargeModelConfirmation,
  });
}

function createInitializationRequest(value) {
  const input = exactObject(value, ['planHash']);
  return Object.freeze({ planHash: sha256(input.planHash) });
}

function createModelInstallationRequest(value) {
  const input = exactObject(value, ['planHash', 'confirmation']);
  if (input.confirmation !== 'confirm-large-model-downloads') fail();
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
  createModelInstallationRequest,
});
