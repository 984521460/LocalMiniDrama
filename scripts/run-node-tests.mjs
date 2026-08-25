import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const target = process.argv[2]
const layer = process.argv[3] || 'all'
const allowedTargets = new Set(['backend-node', 'frontweb', 'desktop'])
const allowedLayers = new Set(['all', 'unit', 'integration', 'e2e'])

if (!allowedTargets.has(target) || !allowedLayers.has(layer)) {
  console.error(`Unsupported test selection: ${target ?? '<missing>'}:${layer}`)
  process.exitCode = 2
} else {
  const testDir = path.join(repoRoot, target, 'test')
  const files = fs.readdirSync(testDir)
    .filter((name) => name.endsWith('.test.js'))
    .filter((name) => {
      if (layer === 'integration') return name.endsWith('.integration.test.js')
      if (layer === 'e2e') return name.endsWith('.e2e.test.js')
      if (layer === 'unit') {
        return !name.endsWith('.integration.test.js') && !name.endsWith('.e2e.test.js')
      }
      return true
    })
    .sort()

  if (files.length === 0) {
    console.error(`No ${layer} tests found for ${target}`)
    process.exitCode = 3
    process.exit()
  }

  const result = spawnSync(
    process.execPath,
    ['--test', ...files.map((name) => path.join('test', name))],
    {
      cwd: path.join(repoRoot, target),
      stdio: 'inherit',
      shell: false,
    },
  )

  if (result.error) {
    console.error(result.error.message)
    process.exitCode = 1
  } else {
    process.exitCode = result.status ?? 1
  }
}
