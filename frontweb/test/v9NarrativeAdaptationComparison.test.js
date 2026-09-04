import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import Ajv2020 from 'ajv/dist/2020.js'

import {
  narrativeAdaptationComparisonView,
  parseNarrativeAdaptationComparisonJson,
} from '../src/narrative/adaptationComparison.js'

function uid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
}

function sourceFact(factId, factType, factLabel, letter) {
  return {
    classification: 'source_fact',
    factType,
    factId,
    factLabel,
    factSummary: `${factLabel}来自同一份已批准原著事实。`,
    factSha256: letter.repeat(64),
  }
}

function comparison(overrides = {}) {
  return {
    schemaVersion: 'narrative-adaptation-comparison.v1',
    dramaUid: uid(1),
    sourceResultUid: uid(2),
    sourceResultHash: '1'.repeat(64),
    sourceEnvelopeHash: '2'.repeat(64),
    sourceApprovalRef: `review:v1:${uid(3)}`,
    adaptationResultUid: uid(4),
    adaptationResultHash: '3'.repeat(64),
    adaptationEnvelopeHash: '4'.repeat(64),
    adaptationStatus: 'pending_review',
    sourceDocumentUid: uid(5),
    sourceDocumentSha256: '5'.repeat(64),
    sourceSelectionUid: uid(6),
    selectedTextSha256: '6'.repeat(64),
    durationSummary: { targetSeconds: 60, toleranceSeconds: 5, totalSeconds: 60 },
    sourceFacts: [
      sourceFact('event-restore-power', 'event', '恢复备用电源', 'a'),
      sourceFact('relationship-investigation-partners', 'relationship', '协同调查', 'b'),
      sourceFact('dialogue-real-target', 'dialogue', '真正目标', 'c'),
      sourceFact('prop-evidence-case', 'prop', '银色证物箱', 'd'),
      sourceFact('character-lin-che', 'character', '林澈', 'e'),
      sourceFact('character-xia-xian', 'character', '夏弦', 'f'),
    ],
    beats: [
      {
        beatId: 'beat-power-restored', kind: 'hook', summary: '林澈接通备用电源。',
        classification: 'fact', inferenceRationale: null, estimatedDurationSeconds: 8,
        factRefs: ['event-restore-power'], adaptationDecisionRefs: [],
      },
      {
        beatId: 'beat-broadcast-threat', kind: 'setup', summary: '威胁可能仍在现场。',
        classification: 'inference', inferenceRationale: '由旧线路广播与现场判断推断。',
        estimatedDurationSeconds: 12,
        factRefs: ['relationship-investigation-partners'], adaptationDecisionRefs: [],
      },
      {
        beatId: 'beat-chip-chase', kind: 'escalation', summary: '新增追踪者抢夺芯片。',
        classification: 'adaptation', inferenceRationale: null, estimatedDurationSeconds: 14,
        factRefs: ['dialogue-real-target', 'prop-evidence-case'],
        adaptationDecisionRefs: ['decision-add-chip-chase'],
      },
      {
        beatId: 'beat-platform-confrontation', kind: 'climax', summary: '站台对峙。',
        classification: 'adaptation', inferenceRationale: null, estimatedDurationSeconds: 16,
        factRefs: ['character-lin-che', 'character-xia-xian'],
        adaptationDecisionRefs: ['decision-add-chip-chase'],
      },
      {
        beatId: 'beat-chip-reveal', kind: 'cliffhanger', summary: '芯片揭示新记录。',
        classification: 'adaptation', inferenceRationale: null, estimatedDurationSeconds: 10,
        factRefs: ['dialogue-real-target'],
        adaptationDecisionRefs: ['decision-add-chip-chase'],
      },
    ],
    adaptationDecisions: [{
      decisionId: 'decision-add-chip-chase',
      classification: 'adaptation',
      category: 'invented-event',
      summary: '新增追踪者抢夺芯片及站台对峙。',
      rationale: '把原著目标信息转成一分钟单集的升级、高潮与悬念。',
      factRefs: [
        'dialogue-real-target', 'prop-evidence-case',
        'character-lin-che', 'character-xia-xian',
      ],
    }],
    ...overrides,
  }
}

const expected = Object.freeze({ adaptationResultUid: uid(4) })

test('adaptation comparison accepts one exact source/fact/inference/adaptation projection', () => {
  const value = comparison()
  const parsed = parseNarrativeAdaptationComparisonJson(JSON.stringify(value), expected)
  assert.deepEqual(parsed, value)
  assert.deepEqual(
    parsed.beats.map((beat) => beat.classification),
    ['fact', 'inference', 'adaptation', 'adaptation', 'adaptation'],
  )
  assert.ok(parsed.sourceFacts.every((fact) => fact.classification === 'source_fact'))
  assert.ok(parsed.adaptationDecisions.every((decision) => decision.classification === 'adaptation'))
  assert.deepEqual(narrativeAdaptationComparisonView(parsed, expected), parsed)

  const schemaPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../schemas/v9/narrative-adaptation-comparison.schema.json',
  )
  const validate = new Ajv2020({ strict: true }).compile(
    JSON.parse(fs.readFileSync(schemaPath, 'utf8')),
  )
  assert.equal(validate(value), true, JSON.stringify(validate.errors))
})

test('adaptation comparison rejects unbound, duplicate, and unclassified evidence', () => {
  const wrongFact = comparison()
  wrongFact.beats[0].factRefs = ['missing-fact']
  assert.throws(() => parseNarrativeAdaptationComparisonJson(JSON.stringify(wrongFact), expected))

  const wrongDecision = comparison()
  wrongDecision.beats[2].adaptationDecisionRefs = ['missing-decision']
  assert.throws(() => parseNarrativeAdaptationComparisonJson(JSON.stringify(wrongDecision), expected))

  const duplicateBeat = comparison()
  duplicateBeat.beats[1].beatId = duplicateBeat.beats[0].beatId
  assert.throws(() => parseNarrativeAdaptationComparisonJson(JSON.stringify(duplicateBeat), expected))

  const unusedFact = comparison()
  unusedFact.sourceFacts.push(sourceFact('unused-fact', 'event', '未分类事实', '0'))
  assert.throws(() => parseNarrativeAdaptationComparisonJson(JSON.stringify(unusedFact), expected))

  const ungroundedDecision = comparison()
  ungroundedDecision.adaptationDecisions[0].factRefs = []
  assert.throws(() => parseNarrativeAdaptationComparisonJson(
    JSON.stringify(ungroundedDecision), expected,
  ))

  const wrongDuration = comparison()
  wrongDuration.durationSummary.totalSeconds = 59
  assert.throws(() => parseNarrativeAdaptationComparisonJson(JSON.stringify(wrongDuration), expected))
})

test('public comparison view rejects untrusted objects and Proxies before reflection', () => {
  const plain = comparison()
  let reads = 0
  const hostile = new Proxy(plain, {
    getOwnPropertyDescriptor() { reads += 1; throw new Error('descriptor sentinel') },
    getPrototypeOf() { reads += 1; throw new Error('prototype sentinel') },
    ownKeys() { reads += 1; throw new Error('keys sentinel') },
  })
  assert.throws(() => narrativeAdaptationComparisonView(plain, expected))
  assert.throws(() => narrativeAdaptationComparisonView(hostile, expected))
  assert.equal(reads, 0)
})

test('review UI explicitly separates source facts, inference, and adaptation decisions', () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const api = fs.readFileSync(
    path.resolve(testDirectory, '../src/api/v2/narrativeReviews.js'), 'utf8',
  )
  const workspace = fs.readFileSync(
    path.resolve(testDirectory, '../src/components/narrative/NarrativeReviewWorkspace.vue'), 'utf8',
  )
  assert.match(api, /getAdaptationComparison\(resultUid\)/u)
  assert.match(api, /narrative-results\/\$\{expected\.resultUid\}\/adaptation-comparison/u)
  assert.match(api, /parseNarrativeAdaptationComparisonJson/u)
  assert.match(workspace, /原著事实与改编决策/u)
  assert.match(workspace, /原著事实/u)
  assert.match(workspace, /推断依据/u)
  assert.match(workspace, /改编决策/u)
  assert.match(workspace, /@click="loadAdaptationComparison"/u)
  assert.match(
    workspace,
    /@click="loadFactTrace\(fact\.factId, activeComparison\.sourceResultUid\)"/u,
  )
  assert.doesNotMatch(workspace, /v-html/u)
  assert.doesNotMatch(workspace, /onMounted\(loadAdaptationComparison/u)
})
