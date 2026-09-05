'use strict';

const licensedAssets = require('../../../licenses/h3-runtime-assets.json');
const {
  APPROVED_LIVE_ENVIRONMENT,
  MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256,
} = require('../benchmark/mvpBenchmarkApprovedEnvironment');

const EXPECTED_SCHEMA = 'h3-runtime-assets.v1';
const EXPECTED_ACQUISITION = 'runtime-user-acquired';
const EXPECTED_LICENSE = 'MiniMax-H3-Community-License-Agreement';
const EXPECTED_MODEL_FAMILY = 'minimax-h3';
const SAFE_RELATIVE_PATH = /^(?:diffusion_models|text_encoders|vae|loras)\/[A-Za-z0-9._-]{1,160}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function invalid() {
  throw new TypeError('H3 remote environment profile is invalid');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function buildModelCatalog() {
  if (licensedAssets.schemaVersion !== EXPECTED_SCHEMA
    || licensedAssets.modelFamily !== EXPECTED_MODEL_FAMILY
    || licensedAssets.approvedEnvironmentSha256
      !== MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256
    || licensedAssets.distribution?.acquisition !== EXPECTED_ACQUISITION
    || licensedAssets.distribution?.packaged !== false
    || licensedAssets.distribution?.projectRedistributionAllowed !== false
    || licensedAssets.effectiveLicense?.id !== EXPECTED_LICENSE
    || typeof licensedAssets.runtimeRepository?.revision !== 'string'
    || !/^[0-9a-f]{40}$/u.test(licensedAssets.runtimeRepository.revision)
    || !Array.isArray(licensedAssets.assets)
    || licensedAssets.assets.length !== APPROVED_LIVE_ENVIRONMENT.models.length) invalid();

  const approvedByRole = new Map(
    APPROVED_LIVE_ENVIRONMENT.models.map((model) => [model.role, model]),
  );
  const output = licensedAssets.assets.map((asset) => {
    const approved = approvedByRole.get(asset.role);
    if (!approved || approved.fileName !== asset.fileName
      || approved.sha256 !== asset.sha256 || approved.bytes !== asset.bytes
      || typeof asset.repositoryPath !== 'string'
      || !SAFE_RELATIVE_PATH.test(asset.repositoryPath)
      || !asset.repositoryPath.endsWith(`/${asset.fileName}`)
      || !SHA256.test(asset.sha256)
      || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1) invalid();
    approvedByRole.delete(asset.role);
    return {
      modelId: asset.role,
      version: licensedAssets.runtimeRepository.revision,
      relativePath: `models/${asset.repositoryPath}`,
      sizeBytes: asset.bytes,
      licenseId: EXPECTED_LICENSE,
      artifactSha256: asset.sha256,
      acquisition: EXPECTED_ACQUISITION,
    };
  });
  if (approvedByRole.size !== 0) invalid();
  output.sort((left, right) => (
    left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0
  ));
  return deepFreeze(output);
}

const MODEL_CATALOG = buildModelCatalog();
const H3_REMOTE_ENVIRONMENT_PROFILE = deepFreeze({
  profileId: 'minimax-h3-featurize',
  profileVersion: '2.0.0',
  approvedEnvironmentSha256: MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256,
  gpu: APPROVED_LIVE_ENVIRONMENT.gpu,
  comfyUI: APPROVED_LIVE_ENVIRONMENT.comfyUI,
  runtime: APPROVED_LIVE_ENVIRONMENT.runtime,
  cudaVersion: '13.0',
});

function createH3RemoteModelCatalog() {
  return MODEL_CATALOG;
}

module.exports = Object.freeze({
  H3_REMOTE_ENVIRONMENT_PROFILE,
  createH3RemoteModelCatalog,
});
