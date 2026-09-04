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
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger
const WEAK_SET_ADD = WeakSet.prototype.add
const WEAK_SET_HAS = WeakSet.prototype.has
const TRUSTED_TRACES = new WeakSet()
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const FACT_ID = /^[a-z][a-z0-9-]{0,63}$/u
const FACT_TYPES = FREEZE(['character', 'scene', 'prop', 'relationship', 'event', 'dialogue'])
const RESULT_STATUSES = FREEZE(['pending_review', 'approved', 'rejected', 'stale'])
const TRACE_KEYS = FREEZE([
  'schemaVersion', 'dramaUid', 'resultUid', 'resultHash', 'envelopeHash',
  'resultStatus', 'sourceDocumentUid', 'sourceDocumentSha256',
  'sourceSelectionUid', 'selectedTextSha256', 'factType', 'factId',
  'factLabel', 'factSummary', 'factSha256', 'evidenceCount', 'evidence',
])
const EVIDENCE_KEYS = FREEZE([
  'blockUid', 'blockOrdinal', 'headingPath', 'blockTextSha256', 'blockText',
  'selectedBlockStartOffset', 'selectedBlockEndOffset', 'startOffset', 'endOffset',
  'beforeText', 'quote', 'afterText', 'selectedBlockText',
])
const ERROR_MESSAGE = 'Narrative fact evidence trace is invalid'

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

function codePointLength(value) {
  let length = 0
  for (let index = 0; index < value.length; index += 1) {
    const first = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index])
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index + 1])
      if (second >= 0xdc00 && second <= 0xdfff) index += 1
    }
    length += 1
  }
  return length
}

function stringValue(value, minimum, maximum) {
  if (typeof value !== 'string') invalid()
  const length = codePointLength(value)
  if (length < minimum || length > maximum) invalid()
  return value
}

function uuid(value) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, UUID_V4, [value])) invalid()
  return value
}

function sha256(value) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, SHA256, [value])) invalid()
  return value
}

function safeInteger(value, minimum, maximum) {
  if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [value])
    || value < minimum || value > maximum) invalid()
  return value
}

function includes(list, value) {
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === value) return true
  }
  return false
}

function sliceCodePoints(value, start, end) {
  let pointIndex = 0
  let unitStart = -1
  let unitEnd = -1
  for (let unitIndex = 0; unitIndex <= value.length; unitIndex += 1) {
    if (pointIndex === start && unitStart < 0) unitStart = unitIndex
    if (pointIndex === end) {
      unitEnd = unitIndex
      break
    }
    if (unitIndex === value.length) break
    const first = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [unitIndex])
    if (first >= 0xd800 && first <= 0xdbff && unitIndex + 1 < value.length) {
      const second = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [unitIndex + 1])
      if (second >= 0xdc00 && second <= 0xdfff) unitIndex += 1
    }
    pointIndex += 1
  }
  if (unitStart < 0 || unitEnd < 0) invalid()
  return value.slice(unitStart, unitEnd)
}

function evidenceView(value) {
  const input = exactObject(value, EVIDENCE_KEYS)
  const blockText = stringValue(input.blockText, 1, 6000)
  const selectedBlockText = stringValue(input.selectedBlockText, 1, 6000)
  const selectedBlockStartOffset = safeInteger(input.selectedBlockStartOffset, 0, 3000)
  const selectedBlockEndOffset = safeInteger(input.selectedBlockEndOffset, 1, 3000)
  const startOffset = safeInteger(input.startOffset, 0, 2999)
  const endOffset = safeInteger(input.endOffset, 1, 3000)
  const beforeText = stringValue(input.beforeText, 0, 6000)
  const quote = stringValue(input.quote, 1, 4000)
  const afterText = stringValue(input.afterText, 0, 6000)
  if (!(selectedBlockStartOffset <= startOffset && startOffset < endOffset
    && endOffset <= selectedBlockEndOffset)
    || codePointLength(blockText) < selectedBlockEndOffset
    || codePointLength(beforeText) !== startOffset - selectedBlockStartOffset
    || codePointLength(quote) !== endOffset - startOffset
    || codePointLength(afterText) !== selectedBlockEndOffset - endOffset
    || `${beforeText}${quote}${afterText}` !== selectedBlockText
    || sliceCodePoints(blockText, selectedBlockStartOffset, selectedBlockEndOffset) !== selectedBlockText
    || sliceCodePoints(blockText, startOffset, endOffset) !== quote) invalid()

  const rawHeading = denseArray(input.headingPath, 0, 6)
  const headingPath = []
  for (let index = 0; index < rawHeading.length; index += 1) {
    append(headingPath, stringValue(rawHeading[index], 0, 256))
  }
  return FREEZE({
    blockUid: uuid(input.blockUid),
    blockOrdinal: safeInteger(input.blockOrdinal, 0, 2047),
    headingPath: FREEZE(headingPath),
    blockTextSha256: sha256(input.blockTextSha256),
    blockText,
    selectedBlockStartOffset,
    selectedBlockEndOffset,
    startOffset,
    endOffset,
    beforeText,
    quote,
    afterText,
    selectedBlockText,
  })
}

function project(value, expected) {
  const input = exactObject(value, TRACE_KEYS)
  if (!expected || typeof expected !== 'object'
    || input.schemaVersion !== 'narrative-fact-evidence-trace.v1'
    || uuid(input.resultUid) !== expected.resultUid
    || typeof input.factId !== 'string'
    || !REFLECT_APPLY(REGEXP_TEST, FACT_ID, [input.factId])
    || input.factId !== expected.factId
    || !includes(FACT_TYPES, input.factType)
    || !includes(RESULT_STATUSES, input.resultStatus)) invalid()
  const source = denseArray(input.evidence, 1, 16)
  if (input.evidenceCount !== source.length) invalid()
  const evidence = []
  for (let index = 0; index < source.length; index += 1) {
    append(evidence, evidenceView(source[index]))
  }
  return FREEZE({
    schemaVersion: input.schemaVersion,
    dramaUid: uuid(input.dramaUid),
    resultUid: input.resultUid,
    resultHash: sha256(input.resultHash),
    envelopeHash: sha256(input.envelopeHash),
    resultStatus: input.resultStatus,
    sourceDocumentUid: uuid(input.sourceDocumentUid),
    sourceDocumentSha256: sha256(input.sourceDocumentSha256),
    sourceSelectionUid: uuid(input.sourceSelectionUid),
    selectedTextSha256: sha256(input.selectedTextSha256),
    factType: input.factType,
    factId: input.factId,
    factLabel: stringValue(input.factLabel, 1, 1100),
    factSummary: stringValue(input.factSummary, 1, 4000),
    factSha256: sha256(input.factSha256),
    evidenceCount: source.length,
    evidence: FREEZE(evidence),
  })
}

function trust(value) {
  REFLECT_APPLY(WEAK_SET_ADD, TRUSTED_TRACES, [value])
  return value
}

export function parseNarrativeFactEvidenceTraceJson(text, expected) {
  return trust(project(parseStrictJson(text), expected))
}

export function narrativeFactEvidenceTraceView(value, expected) {
  if (!value || typeof value !== 'object'
    || !REFLECT_APPLY(WEAK_SET_HAS, TRUSTED_TRACES, [value])) invalid()
  return trust(project(value, expected))
}
