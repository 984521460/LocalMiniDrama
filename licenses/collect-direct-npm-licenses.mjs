import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const projects = ['backend-node', 'frontweb', 'desktop']
const dependencyGroups = ['dependencies', 'devDependencies']

const rows = []
const errors = []

for (const project of projects) {
  const projectDir = path.join(repoRoot, project)
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'),
  )
  const packageLock = JSON.parse(
    fs.readFileSync(path.join(projectDir, 'package-lock.json'), 'utf8'),
  )

  for (const group of dependencyGroups) {
    for (const name of Object.keys(packageJson[group] ?? {}).sort()) {
      const locked = packageLock.packages?.[`node_modules/${name}`]
      if (!locked?.version || !locked?.license) {
        errors.push(`${project}:${group}:${name}`)
        continue
      }

      rows.push({
        project,
        group,
        name,
        version: locked.version,
        license: locked.license,
      })
    }
  }
}

if (errors.length > 0) {
  console.error(
    `Missing locked version or license metadata for: ${errors.join(', ')}`,
  )
  process.exitCode = 1
} else {
  console.log('| 子项目 | 类型 | 包 | 锁定版本 | 声明许可证 |')
  console.log('|---|---|---|---|---|')
  for (const row of rows) {
    console.log(
      `| ${row.project} | ${row.group} | \`${row.name}\` | \`${row.version}\` | \`${row.license}\` |`,
    )
  }
}
