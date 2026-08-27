import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createSelectionPayload,
  previewSelection,
} from '../src/components/narrative/sourceSelection.js'

const blocks = Object.freeze([
  Object.freeze({ uid: 'block-a', ordinal: 0, text: '甲😀\n', charStart: 0, charEnd: 3 }),
  Object.freeze({ uid: 'block-b', ordinal: 1, text: '乙丙', charStart: 3, charEnd: 5 }),
])

test('builds the exact cross-block selection payload and preview by Unicode code point', () => {
  const range = {
    startBlockUid: 'block-a',
    endBlockUid: 'block-b',
    startOffset: 1,
    endOffset: 1,
  }
  assert.deepEqual(createSelectionPayload(blocks, range), range)
  assert.equal(previewSelection(blocks, range), '😀\n乙')
})

test('rejects reversed, empty and out-of-bounds selection ranges', () => {
  for (const range of [
    { startBlockUid: 'block-b', endBlockUid: 'block-a', startOffset: 0, endOffset: 1 },
    { startBlockUid: 'block-a', endBlockUid: 'block-a', startOffset: 1, endOffset: 1 },
    { startBlockUid: 'block-a', endBlockUid: 'block-b', startOffset: 4, endOffset: 1 },
    { startBlockUid: 'block-a', endBlockUid: 'block-b', startOffset: 3, endOffset: 0 },
    { startBlockUid: 'missing', endBlockUid: 'block-b', startOffset: 0, endOffset: 1 },
  ]) {
    assert.throws(() => createSelectionPayload(blocks, range), /selection range is invalid/i)
  }
})

test('keeps source document API, workflow page and legacy navigation as thin modules', () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const sourceRoot = path.join(testDirectory, '..', 'src')
  const api = fs.readFileSync(path.join(sourceRoot, 'api', 'v2', 'sourceDocuments.js'), 'utf8')
  const router = fs.readFileSync(path.join(sourceRoot, 'router', 'index.js'), 'utf8')
  const detail = fs.readFileSync(path.join(sourceRoot, 'views', 'DramaDetail.vue'), 'utf8')
  const workflow = fs.readFileSync(path.join(sourceRoot, 'views', 'NarrativeWorkflow.vue'), 'utf8')
  const selectionPanel = fs.readFileSync(
    path.join(sourceRoot, 'components', 'narrative', 'SourceSelectionPanel.vue'),
    'utf8',
  )

  assert.match(api, /importDocument/)
  assert.match(api, /createSelection/)
  assert.match(router, /\/drama\/:id\/narrative/)
  assert.match(detail, /goNarrative/)
  assert.match(workflow, /SourceSelectionPanel/)
  assert.match(selectionPanel, /createSelectionPayload/)
  assert.doesNotMatch(detail, /createSelectionPayload/)
})
