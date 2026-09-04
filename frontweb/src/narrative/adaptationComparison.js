import { parseStrictJson } from '../security/strictJson.js'

const {
  create: CREATE,
  defineProperty: DEFINE_PROPERTY,
  freeze: FREEZE,
  getOwnPropertyDescriptors: GET_OWN_PROPERTY_DESCRIPTORS,
  getPrototypeOf: GET_PROTOTYPE_OF,
  hasOwn: HAS_OWN,
} = Object
const { isArray: IS_ARRAY } = Array
const { ownKeys: OWN_KEYS } = Reflect
const REFLECT_APPLY = Reflect.apply
const REGEXP_TEST = RegExp.prototype.test
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger
const WEAK_SET_ADD = WeakSet.prototype.add
const WEAK_SET_HAS = WeakSet.prototype.has
const TRUSTED_COMPARISONS = new WeakSet()
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/u
const REVIEW_REF = /^review:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const STATUSES = FREEZE(['pending_review', 'approved', 'rejected', 'stale'])
const FACT_TYPES = FREEZE(['character', 'scene', 'prop', 'relationship', 'event', 'dialogue'])
const BEAT_KINDS = FREEZE(['hook', 'setup', 'escalation', 'climax', 'cliffhanger'])
const CLASSIFICATIONS = FREEZE(['fact', 'inference', 'adaptation'])
const CATEGORIES = FREEZE([
  'invented-event', 'compressed-timeline', 'merged-character',
  'changed-setting', 'added-dialogue', 'other',
])
const ROOT_KEYS = FREEZE([
  'schemaVersion', 'dramaUid', 'sourceResultUid', 'sourceResultHash',
  'sourceEnvelopeHash', 'sourceApprovalRef', 'adaptationResultUid',
  'adaptationResultHash', 'adaptationEnvelopeHash', 'adaptationStatus',
  'sourceDocumentUid', 'sourceDocumentSha256', 'sourceSelectionUid',
  'selectedTextSha256', 'durationSummary', 'sourceFacts', 'beats',
  'adaptationDecisions',
])
const DURATION_KEYS = FREEZE(['targetSeconds', 'toleranceSeconds', 'totalSeconds'])
const FACT_KEYS = FREEZE([
  'classification', 'factType', 'factId', 'factLabel', 'factSummary', 'factSha256',
])
const BEAT_KEYS = FREEZE([
  'beatId', 'kind', 'summary', 'classification', 'inferenceRationale',
  'estimatedDurationSeconds', 'factRefs', 'adaptationDecisionRefs',
])
const DECISION_KEYS = FREEZE([
  'decisionId', 'classification', 'category', 'summary', 'rationale', 'factRefs',
])
const ERROR_MESSAGE = 'Narrative adaptation comparison is invalid'

function invalid() {
  throw new TypeError(ERROR_MESSAGE)
}

function append(target, value) {
  DEFINE_PROPERTY(target, String(target.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

function exactObject(value, expectedKeys) {
  if (!value || typeof value !== 'object' || IS_ARRAY(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = GET_PROTOTYPE_OF(value)
    descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value)
  } catch {
    invalid()
  }
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const actualKeys = OWN_KEYS(descriptors)
  if (actualKeys.length !== expectedKeys.length) invalid()
  const output = CREATE(null)
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index]
    if (!HAS_OWN(descriptors, key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !HAS_OWN(descriptor, 'value')) invalid()
    output[key] = descriptor.value
  }
  for (let index = 0; index < actualKeys.length; index += 1) {
    if (typeof actualKeys[index] !== 'string' || !HAS_OWN(output, actualKeys[index])) invalid()
  }
  return output
}

function denseArray(value, minimum, maximum) {
  if (!IS_ARRAY(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = GET_PROTOTYPE_OF(value)
    descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value)
  } catch {
    invalid()
  }
  if (prototype !== Array.prototype || !HAS_OWN(descriptors, 'length')) invalid()
  const length = descriptors.length?.value
  if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [length])
    || length < minimum || length > maximum
    || OWN_KEYS(descriptors).length !== length + 1) invalid()
  const output = []
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    if (!HAS_OWN(descriptors, key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !HAS_OWN(descriptor, 'value')) invalid()
    append(output, descriptor.value)
  }
  return output
}

function includes(values, value) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true
  }
  return false
}

function pattern(value, regex) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, regex, [value])) invalid()
  return value
}

function text(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) invalid()
  return value
}

function integer(value, minimum, maximum) {
  if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [value])
    || value < minimum || value > maximum) invalid()
  return value
}

function enumValue(value, values) {
  if (!includes(values, value)) invalid()
  return value
}

function identifierList(value, minimum, maximum) {
  const source = denseArray(value, minimum, maximum)
  const output = []
  const seen = CREATE(null)
  for (let index = 0; index < source.length; index += 1) {
    const current = pattern(source[index], IDENTIFIER)
    if (HAS_OWN(seen, current)) invalid()
    seen[current] = true
    append(output, current)
  }
  return FREEZE(output)
}

function durationView(value) {
  const input = exactObject(value, DURATION_KEYS)
  const targetSeconds = integer(input.targetSeconds, 45, 75)
  const toleranceSeconds = integer(input.toleranceSeconds, 0, 15)
  const totalSeconds = integer(input.totalSeconds, 45, 75)
  if (totalSeconds < targetSeconds - toleranceSeconds
    || totalSeconds > targetSeconds + toleranceSeconds) invalid()
  return FREEZE({ targetSeconds, toleranceSeconds, totalSeconds })
}

function factView(value) {
  const input = exactObject(value, FACT_KEYS)
  if (input.classification !== 'source_fact') invalid()
  return FREEZE({
    classification: input.classification,
    factType: enumValue(input.factType, FACT_TYPES),
    factId: pattern(input.factId, IDENTIFIER),
    factLabel: text(input.factLabel, 1, 1100),
    factSummary: text(input.factSummary, 1, 4000),
    factSha256: pattern(input.factSha256, SHA256),
  })
}

function beatView(value, expectedKind) {
  const input = exactObject(value, BEAT_KEYS)
  const classification = enumValue(input.classification, CLASSIFICATIONS)
  const factRefs = identifierList(input.factRefs, classification === 'adaptation' ? 0 : 1, 64)
  const adaptationDecisionRefs = identifierList(
    input.adaptationDecisionRefs,
    classification === 'adaptation' ? 1 : 0,
    classification === 'adaptation' ? 32 : 0,
  )
  if ((classification === 'inference' && typeof input.inferenceRationale !== 'string')
    || (classification !== 'inference' && input.inferenceRationale !== null)) invalid()
  return FREEZE({
    beatId: pattern(input.beatId, IDENTIFIER),
    kind: input.kind === expectedKind ? input.kind : invalid(),
    summary: text(input.summary, 1, 2000),
    classification,
    inferenceRationale: classification === 'inference'
      ? text(input.inferenceRationale, 1, 2000) : null,
    estimatedDurationSeconds: integer(input.estimatedDurationSeconds, 1, 60),
    factRefs,
    adaptationDecisionRefs,
  })
}

function decisionView(value) {
  const input = exactObject(value, DECISION_KEYS)
  if (input.classification !== 'adaptation') invalid()
  return FREEZE({
    decisionId: pattern(input.decisionId, IDENTIFIER),
    classification: input.classification,
    category: enumValue(input.category, CATEGORIES),
    summary: text(input.summary, 1, 4000),
    rationale: text(input.rationale, 1, 4000),
    factRefs: identifierList(input.factRefs, 1, 64),
  })
}

function assertReferenceList(values, known, used) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!HAS_OWN(known, value)) invalid()
    used[value] = true
  }
}

function project(value, expected) {
  const input = exactObject(value, ROOT_KEYS)
  if (!expected || typeof expected !== 'object'
    || input.schemaVersion !== 'narrative-adaptation-comparison.v1'
    || pattern(input.adaptationResultUid, UUID_V4) !== expected.adaptationResultUid) invalid()
  const sourceFactsInput = denseArray(input.sourceFacts, 0, 2304)
  const sourceFacts = []
  const factIds = CREATE(null)
  for (let index = 0; index < sourceFactsInput.length; index += 1) {
    const fact = factView(sourceFactsInput[index])
    if (HAS_OWN(factIds, fact.factId)) invalid()
    factIds[fact.factId] = true
    append(sourceFacts, fact)
  }
  const decisionsInput = denseArray(input.adaptationDecisions, 0, 64)
  const adaptationDecisions = []
  const decisionIds = CREATE(null)
  for (let index = 0; index < decisionsInput.length; index += 1) {
    const decision = decisionView(decisionsInput[index])
    if (HAS_OWN(decisionIds, decision.decisionId)) invalid()
    decisionIds[decision.decisionId] = true
    append(adaptationDecisions, decision)
  }
  const beatsInput = denseArray(input.beats, 5, 5)
  const beats = []
  const beatIds = CREATE(null)
  const usedFactIds = CREATE(null)
  const usedDecisionIds = CREATE(null)
  let totalSeconds = 0
  for (let index = 0; index < beatsInput.length; index += 1) {
    const beat = beatView(beatsInput[index], BEAT_KINDS[index])
    if (HAS_OWN(beatIds, beat.beatId)) invalid()
    beatIds[beat.beatId] = true
    assertReferenceList(beat.factRefs, factIds, usedFactIds)
    assertReferenceList(beat.adaptationDecisionRefs, decisionIds, usedDecisionIds)
    totalSeconds += beat.estimatedDurationSeconds
    append(beats, beat)
  }
  for (let index = 0; index < adaptationDecisions.length; index += 1) {
    assertReferenceList(adaptationDecisions[index].factRefs, factIds, usedFactIds)
  }
  const sourceFactKeys = OWN_KEYS(factIds)
  const usedFactKeys = OWN_KEYS(usedFactIds)
  const decisionKeys = OWN_KEYS(decisionIds)
  if (sourceFactKeys.length !== usedFactKeys.length
    || decisionKeys.length !== OWN_KEYS(usedDecisionIds).length) invalid()
  const durationSummary = durationView(input.durationSummary)
  if (durationSummary.totalSeconds !== totalSeconds) invalid()

  return FREEZE({
    schemaVersion: input.schemaVersion,
    dramaUid: pattern(input.dramaUid, UUID_V4),
    sourceResultUid: pattern(input.sourceResultUid, UUID_V4),
    sourceResultHash: pattern(input.sourceResultHash, SHA256),
    sourceEnvelopeHash: pattern(input.sourceEnvelopeHash, SHA256),
    sourceApprovalRef: pattern(input.sourceApprovalRef, REVIEW_REF),
    adaptationResultUid: input.adaptationResultUid,
    adaptationResultHash: pattern(input.adaptationResultHash, SHA256),
    adaptationEnvelopeHash: pattern(input.adaptationEnvelopeHash, SHA256),
    adaptationStatus: enumValue(input.adaptationStatus, STATUSES),
    sourceDocumentUid: pattern(input.sourceDocumentUid, UUID_V4),
    sourceDocumentSha256: pattern(input.sourceDocumentSha256, SHA256),
    sourceSelectionUid: pattern(input.sourceSelectionUid, UUID_V4),
    selectedTextSha256: pattern(input.selectedTextSha256, SHA256),
    durationSummary,
    sourceFacts: FREEZE(sourceFacts),
    beats: FREEZE(beats),
    adaptationDecisions: FREEZE(adaptationDecisions),
  })
}

function trust(value) {
  REFLECT_APPLY(WEAK_SET_ADD, TRUSTED_COMPARISONS, [value])
  return value
}

export function parseNarrativeAdaptationComparisonJson(text, expected) {
  return trust(project(parseStrictJson(text), expected))
}

export function narrativeAdaptationComparisonView(value, expected) {
  if (!value || typeof value !== 'object'
    || !REFLECT_APPLY(WEAK_SET_HAS, TRUSTED_COMPARISONS, [value])) invalid()
  return trust(project(value, expected))
}
