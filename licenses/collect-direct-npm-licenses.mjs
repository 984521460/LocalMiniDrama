import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  extractContiguousMarkdownTable,
  markdownTablesEqual,
} from './direct-dependency-table.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const projects = [
  { name: 'root', directory: '.' },
  { name: 'backend-node', directory: 'backend-node' },
  { name: 'frontweb', directory: 'frontweb' },
  { name: 'desktop', directory: 'desktop' },
]
const dependencyGroups = ['dependencies', 'devDependencies']

const firstPartyWorkspaceDependencies = new Map()
const packagesDirectory = path.join(repoRoot, 'packages')
for (const entry of fs.readdirSync(packagesDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue

  const packageDirectory = path.join(packagesDirectory, entry.name)
  const packageJsonPath = path.join(packageDirectory, 'package.json')
  if (!fs.existsSync(packageJsonPath)) continue

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  if (packageJson.private === true && typeof packageJson.name === 'string') {
    firstPartyWorkspaceDependencies.set(packageJson.name, packageDirectory)
  }
}

const rows = []
const errors = []

for (const project of projects) {
  const projectDir = path.join(repoRoot, project.directory)
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'),
  )
  const packageLock = JSON.parse(
    fs.readFileSync(path.join(projectDir, 'package-lock.json'), 'utf8'),
  )

  for (const group of dependencyGroups) {
    for (const name of Object.keys(packageJson[group] ?? {}).sort()) {
      const locked = packageLock.packages?.[`node_modules/${name}`]
      const workspaceDirectory = firstPartyWorkspaceDependencies.get(name)
      const isBoundFirstPartyWorkspace = (
        workspaceDirectory
        && locked?.link === true
        && typeof locked.resolved === 'string'
        && path.resolve(projectDir, locked.resolved) === workspaceDirectory
      )
      if (isBoundFirstPartyWorkspace) continue

      if (!locked?.version || !locked?.license) {
        errors.push(`${project.name}:${group}:${name}`)
        continue
      }

      rows.push({
        project: project.name,
        group,
        name,
        version: locked.version,
        license: locked.license,
      })
    }
  }
}

const tableLines = [
  '| 子项目 | 类型 | 包 | 锁定版本 | 声明许可证 |',
  '|---|---|---|---|---|',
  ...rows.map((row) => (
    `| ${row.project} | ${row.group} | \`${row.name}\` | \`${row.version}\` | \`${row.license}\` |`
  )),
]
const noticesLines = fs
  .readFileSync(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  .replaceAll('\r\n', '\n')
  .split('\n')
const noticeTable = extractContiguousMarkdownTable(noticesLines, tableLines[0])

if (!markdownTablesEqual(noticeTable, tableLines)) {
  errors.push('THIRD_PARTY_NOTICES direct dependency table drift')
}

if (errors.length > 0) {
  console.error(`License inventory check failed: ${errors.join(', ')}`)
  process.exitCode = 1
} else {
  console.log(tableLines.join('\n'))
}
