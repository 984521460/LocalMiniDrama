import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as elementPlusIcons from '@element-plus/icons-vue'
import { vendorChunkName } from '../src/config/vendorChunks.js'
import {
  ELEMENT_PLUS_COMPONENT_NAMES,
  ELEMENT_PLUS_DIRECTIVE_NAMES,
  installElementPlus,
} from '../src/plugins/elementPlus.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.join(testDirectory, '..', 'src')

function sourceFiles(directory) {
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...sourceFiles(target))
    else if (entry.name.endsWith('.vue')) result.push(target)
  }
  return result
}

function componentName(tagName) {
  return tagName
    .split('-')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')
}

function localIconImports(source) {
  const imported = new Set()
  for (const match of source.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*['"]@element-plus\/icons-vue['"]/g,
  )) {
    for (const item of match[1].split(',')) {
      const names = item.trim().split(/\s+as\s+/)
      const localName = names[1] || names[0]
      if (localName) imported.add(localName)
    }
  }
  return imported
}

test('Element Plus bootstrap installs exactly the components and directives used by templates', () => {
  const usedComponents = new Set()
  const usedDirectives = new Set()
  for (const file of sourceFiles(sourceRoot)) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/<el-([a-z0-9-]+)\b/g)) {
      usedComponents.add(componentName(`el-${match[1]}`))
    }
    if (/\bv-loading(?:\s|=)/.test(source)) usedDirectives.add('loading')
  }

  assert.deepEqual(
    [...ELEMENT_PLUS_COMPONENT_NAMES].sort(),
    [...usedComponents].sort(),
  )
  assert.deepEqual(
    [...ELEMENT_PLUS_DIRECTIVE_NAMES].sort(),
    [...usedDirectives].sort(),
  )

  const installedComponents = []
  const installedDirectives = []
  installElementPlus({
    component(name) {
      installedComponents.push(name)
    },
    directive(name) {
      installedDirectives.push(name)
    },
  })
  assert.deepEqual(installedComponents.sort(), [...usedComponents].sort())
  assert.deepEqual(installedDirectives.sort(), [...usedDirectives].sort())
})

test('every Element Plus icon is imported by the component that renders it', () => {
  const iconNames = new Set(Object.keys(elementPlusIcons))
  const missing = []
  for (const file of sourceFiles(sourceRoot)) {
    const source = fs.readFileSync(file, 'utf8')
    const imported = localIconImports(source)
    for (const match of source.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) {
      const name = match[1]
      if (iconNames.has(name) && !imported.has(name)) {
        missing.push(`${path.relative(sourceRoot, file)}:${name}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})

test('main entry keeps locale configuration without whole-library registration', () => {
  const source = fs.readFileSync(path.join(sourceRoot, 'main.js'), 'utf8')
  assert.doesNotMatch(source, /import\s+ElementPlus\s+from\s+['"]element-plus['"]/)
  assert.doesNotMatch(source, /import\s+\*\s+as\s+ElementPlusIconsVue/)
  assert.doesNotMatch(source, /app\.use\(ElementPlus/)
  assert.match(source, /installElementPlus\(app\)/)
  assert.match(source, /locale:\s*zhCn/)
})

test('vendor chunking separates only already-referenced UI runtime modules', () => {
  assert.equal(
    vendorChunkName('D:\\project\\frontweb\\node_modules\\element-plus\\es\\index.mjs'),
    'element-plus',
  )
  assert.equal(
    vendorChunkName('/project/frontweb/node_modules/@element-plus/icons-vue/dist/index.js'),
    'element-plus',
  )
  assert.equal(
    vendorChunkName('/project/frontweb/node_modules/@vue/runtime-core/dist/runtime-core.esm-bundler.js'),
    'vue-runtime',
  )
  assert.equal(
    vendorChunkName('/project/frontweb/node_modules/vue-router/dist/vue-router.mjs'),
    'vue-runtime',
  )
  assert.equal(vendorChunkName('/project/frontweb/src/main.js'), undefined)
  assert.equal(vendorChunkName(null), undefined)

  const viteConfig = fs.readFileSync(path.join(testDirectory, '..', 'vite.config.js'), 'utf8')
  assert.match(viteConfig, /manualChunks:\s*vendorChunkName/)
  assert.doesNotMatch(viteConfig, /chunkSizeWarningLimit/)
})
