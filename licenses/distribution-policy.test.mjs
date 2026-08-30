import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

import { verifyDistributionPolicy } from './distribution-policy.mjs'

const require = createRequire(import.meta.url)
const {
  DISTRIBUTION_ASSET_ERROR,
  assertArchiveDistributionEntries,
  assertDistributionBuildConfig,
  assertNoModelWeightFiles,
} = require('../desktop/distribution-assets')

function rejectsContract(fn) {
  assert.throws(fn, (error) => error && error.code === DISTRIBUTION_ASSET_ERROR)
}

test('current packaging configs and generated inputs exclude unreviewed distribution assets', () => {
  const result = verifyDistributionPolicy()
  assert.equal(result.packagingConfigCount, 4)
  assert.ok(result.scannedFileCount > 0)

  const mainSource = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8')
  assert.doesNotMatch(mainSource, /process\.resourcesPath, 'ffmpeg'/u)
  assert.doesNotMatch(mainSource, /process\.resourcesPath, 'example_drama'/u)
})

test('packaging config accepts only the reviewed frontend resource', () => {
  const valid = {
    files: ['main.js', 'distribution-assets.js', 'windows-release-contract.js'],
    extraResources: [
      { from: 'frontweb-dist', to: 'frontweb/dist', filter: ['**/*'] },
      { from: '../LICENSE', to: 'licenses/LICENSE' },
      { from: '../THIRD_PARTY_NOTICES.md', to: 'licenses/THIRD_PARTY_NOTICES.md' },
    ],
  }
  assert.deepEqual(assertDistributionBuildConfig(valid), { extraResourceCount: 3 })
  for (const resource of [
    { from: '../backend-node/tools/ffmpeg', to: 'ffmpeg', filter: ['**/*'] },
    { from: '../example_drama', to: 'example_drama', filter: ['**/*'] },
    { from: '../models', to: 'models', filter: ['**/*'] },
  ]) {
    rejectsContract(() => assertDistributionBuildConfig({
      extraResources: [...valid.extraResources, resource],
    }))
  }
})

test('archive gate rejects FFmpeg, demo material and model weights', () => {
  assert.deepEqual(assertArchiveDistributionEntries([
    'resources/app.asar',
    'resources/frontweb/dist/index.html',
  ]), { entryCount: 2 })
  for (const entry of [
    'resources/ffmpeg',
    'resources/ffmpeg/ffmpeg.exe',
    'resources/example_drama',
    'resources/example_drama/synthetic.zip',
    'ffmpeg/ffmpeg.exe',
    'example_drama/synthetic.zip',
    'backend-app/tools/ffmpeg/ffmpeg.exe',
    'resources/frontweb/dist/model.safetensors',
    'resources/app.asar.unpacked/backend-app/model.onnx',
    'resources/app.asar.unpacked/backend-app/pytorch_model.bin',
    'resources/frontweb/dist/models/custom.pb',
  ]) {
    rejectsContract(() => assertArchiveDistributionEntries(['resources/app.asar', entry]))
  }
})

test('source scanner rejects model weights before packaging', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-drama-p9-07-license-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'safe.json'), '{}')
  assert.deepEqual(assertNoModelWeightFiles([root]), { fileCount: 1 })
  fs.writeFileSync(path.join(root, 'weights.gguf'), 'synthetic')
  rejectsContract(() => assertNoModelWeightFiles([root]))
  fs.rmSync(path.join(root, 'weights.gguf'))
  const bundledFfmpeg = path.join(root, 'backend-app', 'tools', 'ffmpeg')
  fs.mkdirSync(bundledFfmpeg, { recursive: true })
  fs.writeFileSync(path.join(bundledFfmpeg, 'ffmpeg.exe'), 'synthetic')
  rejectsContract(() => assertNoModelWeightFiles([root]))
  fs.rmSync(path.join(root, 'backend-app'), { recursive: true, force: true })
  const bundledExample = path.join(root, 'example_drama')
  fs.mkdirSync(bundledExample)
  fs.writeFileSync(path.join(bundledExample, 'synthetic.zip'), 'synthetic')
  rejectsContract(() => assertNoModelWeightFiles([root]))
})
