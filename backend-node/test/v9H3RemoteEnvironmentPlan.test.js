'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { APPROVED_LIVE_ENVIRONMENT } = require('../src/benchmark/mvpBenchmarkApprovedEnvironment');
const {
  H3_REMOTE_ENVIRONMENT_PROFILE,
  createH3RemoteModelCatalog,
} = require('../src/remote/h3EnvironmentProfile');
const { createInitializationPlan } = require('../src/remote/initializationPlan');

const CONNECTION_UID = '00000000-0000-4000-8000-000000009901';

test('production remote environment profile is exactly the approved H3 environment', () => {
  assert.deepEqual(H3_REMOTE_ENVIRONMENT_PROFILE.runtime, APPROVED_LIVE_ENVIRONMENT.runtime);
  assert.deepEqual(H3_REMOTE_ENVIRONMENT_PROFILE.comfyUI, APPROVED_LIVE_ENVIRONMENT.comfyUI);
  assert.equal(H3_REMOTE_ENVIRONMENT_PROFILE.approvedEnvironmentSha256,
    '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43');
});

test('production model catalog is the seven licensed runtime files and never a download plan', () => {
  const licensed = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../licenses/h3-runtime-assets.json'),
    'utf8',
  ));
  const catalog = createH3RemoteModelCatalog();
  assert.equal(catalog.length, 7);
  assert.deepEqual(
    [...catalog].sort((left, right) => left.modelId.localeCompare(right.modelId)),
    [...licensed.assets].map((asset) => ({
      modelId: asset.role,
      version: licensed.runtimeRepository.revision,
      relativePath: `models/${asset.repositoryPath}`,
      sizeBytes: asset.bytes,
      licenseId: licensed.effectiveLicense.id,
      artifactSha256: asset.sha256,
      acquisition: licensed.distribution.acquisition,
    })).sort((left, right) => left.modelId.localeCompare(right.modelId)),
  );
  assert.equal(JSON.stringify(catalog).includes('sourceUrl'), false);
});

test('initialization plan v2 exposes exact verification facts without caller commands or downloads', () => {
  const plan = createInitializationPlan({
    connectionUid: CONNECTION_UID,
    modelCatalog: createH3RemoteModelCatalog(),
  });
  assert.equal(plan.contractVersion, 'remote-initialization-plan.v2');
  assert.equal(plan.profileId, 'minimax-h3-featurize');
  assert.equal(plan.profileVersion, '2.0.0');
  assert.equal(plan.approvedEnvironmentSha256,
    '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43');
  assert.equal(plan.modelFiles.length, 7);
  assert.equal(plan.requiresModelVerificationConfirmation, true);
  assert.equal(JSON.stringify(plan).includes('download'), false);
  assert.equal(JSON.stringify(plan).includes('command'), false);
  assert.deepEqual(plan.steps.map((step) => step.action), [
    'ensure-workspace-layout',
    'verify-python-runtime',
    'verify-ffmpeg',
    'install-bundled-workflows',
    'ensure-comfyui-service',
    'verify-custom-nodes',
    'verify-environment',
  ]);
});
