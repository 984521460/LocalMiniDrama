import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractContiguousMarkdownTable,
  markdownTablesEqual,
} from './direct-dependency-table.mjs'

const EXPECTED = [
  '| 子项目 | 类型 | 包 | 锁定版本 | 声明许可证 |',
  '|---|---|---|---|---|',
  '| root | devDependencies | `ajv` | `8.20.0` | `MIT` |',
]

test('direct dependency table accepts an exact contiguous table', () => {
  const actual = extractContiguousMarkdownTable([...EXPECTED, '', 'next section'], EXPECTED[0])
  assert.equal(markdownTablesEqual(actual, EXPECTED), true)
})

test('direct dependency table rejects a missing final dependency row', () => {
  const actual = extractContiguousMarkdownTable(EXPECTED.slice(0, -1), EXPECTED[0])
  assert.equal(markdownTablesEqual(actual, EXPECTED), false)
})

test('direct dependency table rejects a stale trailing dependency row', () => {
  const actual = extractContiguousMarkdownTable([
    ...EXPECTED,
    '| root | devDependencies | `stale-package` | `1.0.0` | `MIT` |',
    '',
  ], EXPECTED[0])
  assert.equal(actual.length, EXPECTED.length + 1)
  assert.equal(markdownTablesEqual(actual, EXPECTED), false)
})

test('direct dependency table rejects a separated duplicate inventory table', () => {
  const actual = extractContiguousMarkdownTable([
    ...EXPECTED,
    '',
    'unrelated section',
    '',
    ...EXPECTED,
    '| root | devDependencies | `stale-package` | `1.0.0` | `MIT` |',
  ], EXPECTED[0])
  assert.equal(markdownTablesEqual(actual, EXPECTED), false)
})

for (const [name, duplicateHeader] of [
  ['leading whitespace', `  ${EXPECTED[0]}`],
  ['trailing whitespace', `${EXPECTED[0]}  `],
  ['cell whitespace', '| 子项目  | 类型 | 包 | 锁定版本 | 声明许可证 |'],
]) {
  test(`direct dependency table rejects a duplicate header with ${name}`, () => {
    const actual = extractContiguousMarkdownTable([
      ...EXPECTED,
      '',
      duplicateHeader,
      EXPECTED[1],
      EXPECTED[2],
    ], EXPECTED[0])
    assert.equal(markdownTablesEqual(actual, EXPECTED), false)
  })
}

for (const [name, duplicateHeader] of [
  ['left outer pipe omitted', '子项目 | 类型 | 包 | 锁定版本 | 声明许可证 |'],
  ['right outer pipe omitted', '| 子项目 | 类型 | 包 | 锁定版本 | 声明许可证'],
  ['both outer pipes omitted', '子项目 | 类型 | 包 | 锁定版本 | 声明许可证'],
]) {
  test(`direct dependency table rejects a duplicate header with ${name}`, () => {
    const actual = extractContiguousMarkdownTable([
      ...EXPECTED,
      '',
      duplicateHeader,
      EXPECTED[1],
      EXPECTED[2],
    ], EXPECTED[0])
    assert.equal(markdownTablesEqual(actual, EXPECTED), false)
  })
}
