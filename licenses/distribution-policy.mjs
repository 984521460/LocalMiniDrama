import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  assertDistributionBuildConfig,
  assertNoModelWeightFiles,
} = require('../desktop/distribution-assets')

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGING_CONFIGS = Object.freeze([
  'desktop/package.json',
  'desktop/electron-builder-lite.json',
  'desktop/electron-builder-mac.json',
  'desktop/electron-builder-mac-lite.json',
])
const DISTRIBUTABLE_SOURCE_ROOTS = Object.freeze([
  'backend-node/src',
  'backend-node/configs',
  'backend-node/scripts',
  'backend-node/migrations',
  'frontweb/src',
  'frontweb/public',
  'packages',
  'schemas',
  'desktop/backend-app',
  'desktop/frontweb-dist',
])

export function verifyDistributionPolicy({ root = repoRoot } = {}) {
  for (const relativePath of PACKAGING_CONFIGS) {
    const value = JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
    assertDistributionBuildConfig(value)
  }
  const sourceRoots = DISTRIBUTABLE_SOURCE_ROOTS.map((relativePath) => path.join(root, relativePath))
  const scan = assertNoModelWeightFiles(sourceRoots)
  return Object.freeze({
    packagingConfigCount: PACKAGING_CONFIGS.length,
    scannedFileCount: scan.fileCount,
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyDistributionPolicy()
  process.stdout.write(`Distribution policy verified (${result.packagingConfigCount} configs, ${result.scannedFileCount} files).\n`)
}

export { PACKAGING_CONFIGS, DISTRIBUTABLE_SOURCE_ROOTS }
