import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  PRODUCT_IDENTITY,
  PRODUCT_LEGACY_NAME,
  PRODUCT_NAME,
  formatDocumentTitle,
} from '../src/config/productIdentity.js'

test('product identity keeps the approved display name and compatibility identifiers', () => {
  assert.equal(PRODUCT_NAME, 'AI漫剧工作台')
  assert.equal(PRODUCT_LEGACY_NAME, 'LocalMiniDrama')
  assert.equal(PRODUCT_IDENTITY.appId, 'com.localminidrama.desktop')
  assert.equal(PRODUCT_IDENTITY.userDataDirectory, 'localminidrama-desktop')
})

test('document titles use the approved product name', () => {
  assert.equal(formatDocumentTitle('项目列表'), '项目列表 - AI漫剧工作台')
  assert.equal(formatDocumentTitle('  '), 'AI漫剧工作台')
})

test('visible header surfaces do not render the legacy product name', () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  for (const viewName of ['AiConfig', 'DramaDetail', 'FilmCreate', 'FilmList']) {
    const source = fs.readFileSync(
      path.join(testDirectory, '..', 'src', 'views', `${viewName}.vue`),
      'utf8',
    )
    assert.doesNotMatch(source, /PRODUCT_LEGACY_NAME/, viewName)
    assert.doesNotMatch(source, />LocalMiniDrama</, viewName)
  }
})
