const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('parseUid validates and canonicalizes RFC UUID values', () => {
  const { isUid, parseUid } = require('@local-mini-drama/domain')
  const uppercase = '6BA7B810-9DAD-41D1-80B4-00C04FD430C8'

  assert.equal(isUid(uppercase), true)
  assert.equal(parseUid(uppercase), uppercase.toLowerCase())
})

test('UID validation rejects blank, malformed, nil, and non-string values', () => {
  const { isUid, parseUid } = require('@local-mini-drama/domain')
  const invalidValues = [
    '',
    'not-a-uuid',
    '00000000-0000-0000-0000-000000000000',
    42,
    null,
    undefined,
  ]

  for (const value of invalidValues) {
    assert.equal(isUid(value), false)
    assert.throws(() => parseUid(value), {
      name: 'TypeError',
      message: 'UID must be a valid RFC UUID string',
    })
  }
})

test('createUid returns canonical UUID v4 identifiers', () => {
  const { createUid, isUid } = require('@local-mini-drama/domain')
  const first = createUid()
  const second = createUid()

  assert.equal(isUid(first), true)
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(first, second)
})

test('package consumers load compiled JavaScript with declarations', () => {
  const entryPath = require.resolve('@local-mini-drama/domain')
  const packageRoot = path.resolve(__dirname, '..')

  assert.equal(entryPath, path.join(packageRoot, 'dist', 'index.js'))
  assert.equal(fs.existsSync(path.join(packageRoot, 'dist', 'index.d.ts')), true)
  assert.equal(fs.existsSync(path.join(packageRoot, 'dist', 'uid.d.ts')), true)
})

test('Node ESM consumers receive the named public exports', async () => {
  const domain = await import('@local-mini-drama/domain')

  assert.equal(typeof domain.createUid, 'function')
  assert.equal(typeof domain.isUid, 'function')
  assert.equal(typeof domain.parseUid, 'function')
})
