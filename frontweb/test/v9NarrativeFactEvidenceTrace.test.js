import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  narrativeFactEvidenceTraceView,
  parseNarrativeFactEvidenceTraceJson,
} from '../src/narrative/factEvidenceTrace.js'

function uid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
}

function trace(overrides = {}) {
  return {
    schemaVersion: 'narrative-fact-evidence-trace.v1',
    dramaUid: uid(1),
    resultUid: uid(2),
    resultHash: 'a'.repeat(64),
    envelopeHash: 'b'.repeat(64),
    resultStatus: 'approved',
    sourceDocumentUid: uid(3),
    sourceDocumentSha256: 'c'.repeat(64),
    sourceSelectionUid: uid(4),
    selectedTextSha256: 'd'.repeat(64),
    factType: 'character',
    factId: 'character-lin-che',
    factLabel: '林澈',
    factSummary: '林澈抱着证物箱进站。',
    factSha256: 'e'.repeat(64),
    evidenceCount: 1,
    evidence: [{
      blockUid: uid(5),
      blockOrdinal: 0,
      headingPath: ['第一章'],
      blockTextSha256: 'f'.repeat(64),
      blockText: '前文｜林澈抱着证物箱进站｜后文',
      selectedBlockStartOffset: 0,
      selectedBlockEndOffset: 15,
      startOffset: 3,
      endOffset: 12,
      beforeText: '前文｜',
      quote: '林澈抱着证物箱进站',
      afterText: '｜后文',
      selectedBlockText: '前文｜林澈抱着证物箱进站｜后文',
    }],
    ...overrides,
  }
}

const expected = Object.freeze({ resultUid: uid(2), factId: 'character-lin-che' })

test('fact evidence trace accepts only exact source-bound text coordinates', () => {
  const parsed = parseNarrativeFactEvidenceTraceJson(JSON.stringify(trace()), expected)
  assert.deepEqual(parsed, trace())
  assert.deepEqual(narrativeFactEvidenceTraceView(parsed, expected), parsed)
  assert.throws(() => parseNarrativeFactEvidenceTraceJson(
    JSON.stringify(trace({ resultUid: uid(99) })), expected,
  ))
  assert.throws(() => parseNarrativeFactEvidenceTraceJson(
    JSON.stringify(trace({ evidenceCount: 2 })), expected,
  ))
  const wrongQuote = trace()
  wrongQuote.evidence[0].quote = '林澈抱着错误文字进站'
  assert.throws(() => parseNarrativeFactEvidenceTraceJson(JSON.stringify(wrongQuote), expected))
  const wrongOffset = trace()
  wrongOffset.evidence[0].endOffset = 11
  assert.throws(() => parseNarrativeFactEvidenceTraceJson(JSON.stringify(wrongOffset), expected))
  assert.throws(() => parseNarrativeFactEvidenceTraceJson(
    JSON.stringify({ ...trace(), extra: true }), expected,
  ))
})

test('public trace view rejects untrusted objects and Proxies before reflection', () => {
  const plain = structuredClone(trace())
  let reads = 0
  const hostile = new Proxy(plain, {
    getOwnPropertyDescriptor() { reads += 1; throw new Error('descriptor sentinel') },
    getPrototypeOf() { reads += 1; throw new Error('prototype sentinel') },
    ownKeys() { reads += 1; throw new Error('keys sentinel') },
  })
  assert.throws(() => narrativeFactEvidenceTraceView(plain, expected))
  assert.throws(() => narrativeFactEvidenceTraceView(hostile, expected))
  assert.equal(reads, 0)
})

test('review UI requests one fact explicitly and highlights text without HTML injection', () => {
  const api = fs.readFileSync(path.resolve('src/api/v2/narrativeReviews.js'), 'utf8')
  const workspace = fs.readFileSync(
    path.resolve('src/components/narrative/NarrativeReviewWorkspace.vue'), 'utf8',
  )
  assert.match(api, /getFactEvidence\(resultUid, factId\)/u)
  assert.match(api, /narrative-results\/\$\{expected\.resultUid\}\/evidence\/\$\{expected\.factId\}/u)
  assert.match(api, /parseNarrativeFactEvidenceTraceJson/u)
  assert.match(workspace, /'定位原文'/u)
  assert.match(workspace, /<mark>\{\{ item\.quote \}\}<\/mark>/u)
  assert.match(workspace, /@click="loadFactTrace\(fact\.factId\)"/u)
  assert.doesNotMatch(workspace, /v-html/u)
  assert.doesNotMatch(workspace, /onMounted\(loadFactTrace/u)
})
