import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { createRequire } from 'node:module'
import {
  MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256 as FRONTEND_APPROVED_ENVIRONMENT_SHA256,
} from '../frontweb/src/benchmark/mvpAuthorization.js'

const require = createRequire(import.meta.url)
const {
  APPROVED_LIVE_ENVIRONMENT,
  MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256,
} = require('../backend-node/src/benchmark/mvpBenchmarkApprovedEnvironment')
const { sha256Canonical } = require('../backend-node/src/h3/contract')
const {
  H3_PHASE_7_ENVIRONMENT_SHA256,
} = require('../backend-node/src/h3/realValidationEnvironment')
const { H3_PROFILE } = require('../backend-node/src/h3/profile')

const manifest = JSON.parse(fs.readFileSync(
  new URL('./h3-runtime-assets.json', import.meta.url),
  'utf8',
))
const historicalEnvironment = JSON.parse(fs.readFileSync(
  new URL('../evidence/h3/phase7/environment.json', import.meta.url),
  'utf8',
))

const CURRENT_REPOSITORY_REVISION = '4cc1d817b6184899b41293954329f576cb5ae86b'
const CURRENT_ENVIRONMENT_SHA256 =
  '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43'

test('H3 runtime asset manifest exactly binds the current approved environment', () => {
  assert.deepEqual(Object.keys(manifest), [
    'schemaVersion',
    'modelFamily',
    'approvedEnvironmentSha256',
    'distribution',
    'runtimeRepository',
    'effectiveLicense',
    'upstreamComponents',
    'assets',
  ])
  assert.equal(manifest.schemaVersion, 'h3-runtime-assets.v1')
  assert.equal(manifest.modelFamily, 'minimax-h3')
  assert.equal(manifest.approvedEnvironmentSha256, CURRENT_ENVIRONMENT_SHA256)
  assert.equal(MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256, CURRENT_ENVIRONMENT_SHA256)
  assert.equal(FRONTEND_APPROVED_ENVIRONMENT_SHA256, CURRENT_ENVIRONMENT_SHA256)
  assert.equal(sha256Canonical(APPROVED_LIVE_ENVIRONMENT), CURRENT_ENVIRONMENT_SHA256)

  assert.deepEqual(manifest.distribution, {
    acquisition: 'runtime-user-acquired',
    packaged: false,
    projectRedistributionAllowed: false,
  })
  assert.deepEqual(manifest.runtimeRepository, {
    provider: 'huggingface',
    repository: 'Comfy-Org/MiniMax-H3',
    revision: CURRENT_REPOSITORY_REVISION,
    modelCardUrl:
      `https://huggingface.co/Comfy-Org/MiniMax-H3/blob/${CURRENT_REPOSITORY_REVISION}/README.md`,
  })

  assert.equal(manifest.assets.length, 7)
  assert.equal(new Set(manifest.assets.map((asset) => asset.role)).size, 7)
  assert.equal(new Set(manifest.assets.map((asset) => asset.fileName)).size, 7)
  assert.deepEqual(
    manifest.assets.map(({ role, fileName, sha256, bytes }) => ({
      role,
      fileName,
      sha256,
      bytes,
    })),
    APPROVED_LIVE_ENVIRONMENT.models,
  )
  for (const asset of manifest.assets) {
    assert.deepEqual(Object.keys(asset), [
      'role', 'repositoryPath', 'fileName', 'sha256', 'bytes', 'sourceUrl',
    ])
    assert.equal(
      asset.sourceUrl,
      `https://huggingface.co/Comfy-Org/MiniMax-H3/blob/${CURRENT_REPOSITORY_REVISION}/${asset.repositoryPath}`,
    )
  }
})

test('H3 profile artifacts are a strict subset of the licensed current asset manifest', () => {
  const byFileName = new Map(manifest.assets.map((asset) => [asset.fileName, asset]))
  const profileModels = Object.values(H3_PROFILE.models)
  assert.equal(profileModels.length, 5)
  for (const profileModel of profileModels) {
    const asset = byFileName.get(profileModel.fileName)
    assert.ok(asset)
    assert.equal(asset.sha256, profileModel.sha256)
    assert.equal(asset.bytes, profileModel.bytes)
  }
})

test('license policy is explicit and requires operator confirmation before paid use', () => {
  assert.deepEqual(manifest.effectiveLicense, {
    id: 'MiniMax-H3-Community-License-Agreement',
    sourceRepository: 'MiniMaxAI/MiniMax-H3',
    sourceRevision: '42ed227ee7df40d41602854ae760620d6eb651fe',
    licenseUrl:
      'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE',
    operatorConfirmation: 'required-before-paid-run',
    conditions: [
      'applicable-territory-excludes-eu-uk-south-korea-usa',
      'separate-written-authorization-above-usd-20000000-annual-revenue',
      'commercial-ui-displays-minimax-h3',
      'acceptable-use-policy-and-safeguards-required',
      'downstream-users-bound-to-use-restrictions',
      'public-generated-content-clearly-disclosed-as-ai-generated',
    ],
    notLegalAdvice: true,
  })
  assert.deepEqual(
    manifest.upstreamComponents.map(({ id, licenseId }) => ({ id, licenseId })),
    [
      { id: 'minimax-h3', licenseId: 'MiniMax-H3-Community-License-Agreement' },
      { id: 'minimax-h3-turbo', licenseId: 'Apache-2.0' },
      { id: 'qwen3-vl-32b-instruct', licenseId: 'Apache-2.0' },
    ],
  )
  for (const component of manifest.upstreamComponents) {
    assert.deepEqual(Object.keys(component), [
      'id', 'repository', 'revision', 'licenseId', 'sourceUrl', 'relationship',
    ])
    assert.match(component.revision, /^[0-9a-f]{40}$/u)
    assert.ok(component.sourceUrl.includes(`/blob/${component.revision}/`))
    assert.doesNotMatch(component.sourceUrl, /\/blob\/main\//u)
  }
})

test('historical Phase 7 evidence stays immutable and separate from the current environment', () => {
  assert.equal(sha256Canonical(historicalEnvironment), H3_PHASE_7_ENVIRONMENT_SHA256)
  assert.equal(
    historicalEnvironment.models[1].sha256,
    '9255f52b160426c7bdd45d6e1ef1462f08532740606270161c6712146d165779',
  )
  assert.equal(
    historicalEnvironment.models[6].sha256,
    '5b9ab5018edb9eb3dd873d6ab955ec9558c9586991dca0f74f8403a53e7b84c',
  )
  assert.notEqual(H3_PHASE_7_ENVIRONMENT_SHA256, CURRENT_ENVIRONMENT_SHA256)
  assert.notDeepEqual(APPROVED_LIVE_ENVIRONMENT.models, historicalEnvironment.models)
})
