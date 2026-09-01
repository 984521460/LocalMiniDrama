const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const REVIEW_REF = /^review:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const REQUEST_KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'dramaUid', 'sourceSelectionUid', 'resultType',
  'upstreamResultUid', 'upstreamResultHash', 'upstreamEnvelopeHash',
  'upstreamApprovalRef', 'durationBudget', 'style', 'assetVersions',
])
const EXECUTION_KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'requestSha256', 'request', 'expectedInputHash',
  'state', 'resultUid',
  'errorCode', 'createdAtEpochMs', 'updatedAtEpochMs',
])
const RESULT_KEYS = Object.freeze([
  'uid', 'dramaUid', 'sourceSelectionUid', 'resultType', 'taskType', 'schemaVersion',
  'inputHash', 'resultHash', 'envelopeHash', 'result', 'upstreamResultUid', 'status',
  'currentReviewUid', 'createdAt', 'updatedAt', 'staleOperationUid', 'staleReasonCode',
  'staleRootKind', 'staleRootUid', 'staledAtEpochMs',
])
const STAGES = Object.freeze(['extraction', 'adaptation', 'script', 'shot'])
const TASKS = Object.freeze({
  extraction: 'NovelExtractionTask',
  adaptation: 'EpisodeAdaptationTask',
  script: 'ScriptFormattingTask',
  shot: 'ShotPlanningTask',
})
const RESULT_SCHEMAS = Object.freeze({
  extraction: 'novel-extraction.v1',
  adaptation: 'episode-adaptation.v1',
  script: 'script-formatting.v1',
  shot: 'shot-planning.v1',
})
const FAILURE_CODES = Object.freeze(new Set([
  'NARRATIVE_EXECUTION_OUTPUT_INVALID',
  'NARRATIVE_EXECUTION_PROVIDER_FAILED',
  'NARRATIVE_EXECUTION_SOURCE_STALE',
]))
const MAP_GET = Map.prototype.get
const MAP_SET = Map.prototype.set
const SET_HAS = Set.prototype.has
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt
const STRING_TRIM = String.prototype.trim

function invalid(message = 'Narrative execution data is invalid') {
  throw new TypeError(message)
}

function exact(value, keys, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(message)
  let prototype
  let descriptors
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    invalid(message)
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) invalid(message)
  const output = Object.create(null)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(message)
    output[key] = descriptor.value
  }
  return output
}

function dense(value, maximum, message) {
  if (!Array.isArray(value)) invalid(message)
  let descriptors
  try { descriptors = Object.getOwnPropertyDescriptors(value) } catch { invalid(message) }
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum
    || Reflect.ownKeys(descriptors).length !== length + 1) invalid(message)
  const output = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(message)
    Object.defineProperty(output, String(index), {
      configurable: true, enumerable: true, value: descriptor.value, writable: true,
    })
  }
  return output
}

function uid(value, message) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(message)
  return value
}

function cleanText(value, message) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
    || Reflect.apply(STRING_TRIM, value, []) !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) invalid(message)
  let points = 0
  for (let index = 0; index < value.length; index += 1) {
    const first = Reflect.apply(STRING_CHAR_CODE_AT, value, [index])
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = Reflect.apply(STRING_CHAR_CODE_AT, value, [index + 1])
      if (second < 0xdc00 || second > 0xdfff) invalid(message)
      index += 1
    } else if (first >= 0xdc00 && first <= 0xdfff) invalid(message)
    points += 1
    if (points > 128) invalid(message)
  }
  if (new TextEncoder().encode(value).byteLength > 512) invalid(message)
  return value
}

function time(value, message) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)
    || new Date(value).toISOString() !== value) invalid(message)
  return value
}

function durationView(value, message) {
  const input = exact(value, ['targetSeconds', 'toleranceSeconds'], message)
  if (!Number.isSafeInteger(input.targetSeconds)
    || input.targetSeconds < 45 || input.targetSeconds > 75
    || !Number.isSafeInteger(input.toleranceSeconds)
    || input.toleranceSeconds < 0 || input.toleranceSeconds > 15) invalid(message)
  return Object.freeze({
    targetSeconds: input.targetSeconds,
    toleranceSeconds: input.toleranceSeconds,
  })
}

function styleView(value, message) {
  const input = exact(value, ['genre', 'tone', 'audience'], message)
  return Object.freeze({
    genre: cleanText(input.genre, message),
    tone: cleanText(input.tone, message),
    audience: cleanText(input.audience, message),
  })
}

function assetVersionView(value, message) {
  const input = exact(value, ['assetVersionRef', 'assetType', 'bindingRef'], message)
  if (typeof input.assetVersionRef !== 'string'
    || !/^asset-version:v1:[0-9a-f-]{36}$/u.test(input.assetVersionRef)
    || !UUID.test(input.assetVersionRef.slice('asset-version:v1:'.length))
    || !['character', 'scene', 'prop'].includes(input.assetType)
    || typeof input.bindingRef !== 'string'
    || !/^[a-z][a-z0-9._-]{0,127}$/u.test(input.bindingRef)) invalid(message)
  return Object.freeze({ ...input })
}

export function narrativeExecutionRequestView(value) {
  const message = 'Narrative execution request is invalid'
  const input = exact(value, REQUEST_KEYS, message)
  if (input.schemaVersion !== 'narrative-execution-request.v1'
    || !Object.hasOwn(TASKS, input.resultType)) invalid(message)
  const assets = dense(input.assetVersions, 256, message)
  const normalizedAssets = []
  const refs = new Set()
  for (let index = 0; index < assets.length; index += 1) {
    const item = assetVersionView(assets[index], message)
    if (Reflect.apply(SET_HAS, refs, [item.assetVersionRef])) invalid(message)
    refs.add(item.assetVersionRef)
    normalizedAssets.push(item)
  }
  const request = {
    schemaVersion: input.schemaVersion,
    operationUid: uid(input.operationUid, message),
    dramaUid: uid(input.dramaUid, message),
    sourceSelectionUid: uid(input.sourceSelectionUid, message),
    resultType: input.resultType,
    upstreamResultUid: input.upstreamResultUid === null
      ? null : uid(input.upstreamResultUid, message),
    upstreamResultHash: input.upstreamResultHash,
    upstreamEnvelopeHash: input.upstreamEnvelopeHash,
    upstreamApprovalRef: input.upstreamApprovalRef,
    durationBudget: input.durationBudget === null
      ? null : durationView(input.durationBudget, message),
    style: input.style === null ? null : styleView(input.style, message),
    assetVersions: Object.freeze(normalizedAssets),
  }
  const noUpstream = request.upstreamResultUid === null
    && request.upstreamResultHash === null
    && request.upstreamEnvelopeHash === null
    && request.upstreamApprovalRef === null
  if (!noUpstream && (!SHA256.test(request.upstreamResultHash)
    || !SHA256.test(request.upstreamEnvelopeHash)
    || !REVIEW_REF.test(request.upstreamApprovalRef))) invalid(message)
  if (request.resultType === 'extraction') {
    if (!noUpstream || request.durationBudget !== null || request.style !== null
      || request.assetVersions.length !== 0) invalid(message)
  } else if (noUpstream) invalid(message)
  if (request.resultType === 'adaptation') {
    if (request.durationBudget === null || request.style === null
      || request.assetVersions.length !== 0) invalid(message)
  } else if (request.durationBudget !== null || request.style !== null) invalid(message)
  if (request.resultType !== 'shot' && request.assetVersions.length !== 0) invalid(message)
  return Object.freeze(request)
}

export function narrativeResultView(value) {
  const input = exact(value, RESULT_KEYS)
  const resultType = input.resultType
  if (!Object.hasOwn(TASKS, resultType) || input.taskType !== TASKS[resultType]
    || input.schemaVersion !== RESULT_SCHEMAS[resultType]
    || !SHA256.test(input.inputHash) || !SHA256.test(input.resultHash)
    || !SHA256.test(input.envelopeHash)
    || !['pending_review', 'approved', 'rejected', 'stale'].includes(input.status)
    || !input.result || typeof input.result !== 'object' || Array.isArray(input.result)) invalid()
  const record = {
    ...input,
    uid: uid(input.uid),
    dramaUid: uid(input.dramaUid),
    sourceSelectionUid: uid(input.sourceSelectionUid),
    upstreamResultUid: input.upstreamResultUid === null ? null : uid(input.upstreamResultUid),
    currentReviewUid: input.currentReviewUid === null ? null : uid(input.currentReviewUid),
    createdAt: time(input.createdAt),
    updatedAt: time(input.updatedAt),
  }
  if ((resultType === 'extraction') !== (record.upstreamResultUid === null)
    || ((record.status === 'approved' || record.status === 'rejected')
      !== (record.currentReviewUid !== null))
    || Date.parse(record.updatedAt) < Date.parse(record.createdAt)) invalid()
  const stale = record.status === 'stale'
  const hasStaleEvidence = record.staleOperationUid !== null
    && record.staleReasonCode !== null && record.staleRootKind !== null
    && record.staleRootUid !== null && record.staledAtEpochMs !== null
  const hasNoStaleEvidence = record.staleOperationUid === null
    && record.staleReasonCode === null && record.staleRootKind === null
    && record.staleRootUid === null && record.staledAtEpochMs === null
  if ((stale && !hasStaleEvidence) || (!stale && !hasNoStaleEvidence)) invalid()
  if (stale) {
    uid(record.staleOperationUid); uid(record.staleRootUid)
    if (!Number.isSafeInteger(record.staledAtEpochMs) || record.staledAtEpochMs < 0) invalid()
  }
  return Object.freeze(record)
}

function normalizedResults(value, dramaUid, selectionUid) {
  const input = dense(value, 1000)
  const output = []
  const uids = new Set()
  for (let index = 0; index < input.length; index += 1) {
    const record = narrativeResultView(input[index])
    if (Reflect.apply(SET_HAS, uids, [record.uid])) invalid()
    uids.add(record.uid)
    if (record.dramaUid === dramaUid && record.sourceSelectionUid === selectionUid) {
      output.push(record)
    }
  }
  return output
}

function chainFor(records) {
  const byUid = new Map()
  let anchor = null
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    Reflect.apply(MAP_SET, byUid, [record.uid, record])
    const key = `${record.createdAt}\0${record.uid}`
    const anchorKey = anchor === null ? '' : `${anchor.createdAt}\0${anchor.uid}`
    if (anchor === null || key > anchorKey) anchor = record
  }
  const chain = Object.create(null)
  const seen = new Set()
  let current = anchor
  while (current !== null) {
    if (Reflect.apply(SET_HAS, seen, [current.uid])) invalid()
    seen.add(current.uid)
    if (Object.hasOwn(chain, current.resultType)) invalid()
    chain[current.resultType] = current
    current = current.upstreamResultUid === null
      ? null : (Reflect.apply(MAP_GET, byUid, [current.upstreamResultUid]) || null)
  }
  return chain
}

export function narrativeExecutionStatus({ dramaUid, sourceSelectionUid, results }) {
  const normalizedDramaUid = uid(dramaUid)
  const normalizedSelectionUid = uid(sourceSelectionUid)
  const chain = chainFor(normalizedResults(results, normalizedDramaUid, normalizedSelectionUid))
  let upstream = null
  for (let index = 0; index < STAGES.length; index += 1) {
    const resultType = STAGES[index]
    const result = chain[resultType] || null
    if (result === null || result.status === 'rejected' || result.status === 'stale') {
      return Object.freeze({ state: 'ready', resultType, upstream })
    }
    if (result.status !== 'approved') {
      return Object.freeze({ state: 'review_required', resultType, upstream, result })
    }
    upstream = result
  }
  return Object.freeze({ state: 'complete', resultType: null, upstream })
}

export function createNarrativeExecutionRequest({
  operationUid, dramaUid, sourceSelectionUid, results,
  durationBudget = null, style = null, assetVersions = [],
}) {
  const status = narrativeExecutionStatus({ dramaUid, sourceSelectionUid, results })
  if (status.state !== 'ready') invalid('Narrative execution stage is not ready')
  const upstream = status.upstream
  return narrativeExecutionRequestView({
    schemaVersion: 'narrative-execution-request.v1',
    operationUid,
    dramaUid,
    sourceSelectionUid,
    resultType: status.resultType,
    upstreamResultUid: upstream?.uid || null,
    upstreamResultHash: upstream?.resultHash || null,
    upstreamEnvelopeHash: upstream?.envelopeHash || null,
    upstreamApprovalRef: upstream ? `review:v1:${upstream.currentReviewUid}` : null,
    durationBudget: status.resultType === 'adaptation' ? durationBudget : null,
    style: status.resultType === 'adaptation' ? style : null,
    assetVersions: status.resultType === 'shot' ? assetVersions : [],
  })
}

export function narrativeExecutionResponseView(value) {
  const input = exact(value, ['execution', 'result'])
  const execution = exact(input.execution, EXECUTION_KEYS)
  const request = narrativeExecutionRequestView(execution.request)
  if (execution.schemaVersion !== 'narrative-task-execution.v1'
    || execution.operationUid !== request.operationUid
    || !SHA256.test(execution.requestSha256)
    || !SHA256.test(execution.expectedInputHash)
    || !['reserved', 'succeeded', 'failed', 'submission_unknown'].includes(execution.state)
    || !Number.isSafeInteger(execution.createdAtEpochMs) || execution.createdAtEpochMs < 0
    || !Number.isSafeInteger(execution.updatedAtEpochMs)
    || execution.updatedAtEpochMs < execution.createdAtEpochMs) invalid()
  const result = input.result === null ? null : narrativeResultView(input.result)
  if (execution.state === 'succeeded') {
    if (result === null || execution.resultUid !== result.uid || execution.errorCode !== null
      || result.dramaUid !== request.dramaUid
      || result.sourceSelectionUid !== request.sourceSelectionUid
      || result.inputHash !== execution.expectedInputHash
      || result.resultType !== request.resultType
      || result.upstreamResultUid !== request.upstreamResultUid) invalid()
  } else if (result !== null || execution.resultUid !== null) invalid()
  if (execution.state === 'reserved' && execution.errorCode !== null) invalid()
  if (execution.state === 'failed'
    && !Reflect.apply(SET_HAS, FAILURE_CODES, [execution.errorCode])) invalid()
  if (execution.state === 'submission_unknown'
    && execution.errorCode !== 'NARRATIVE_EXECUTION_SUBMISSION_UNKNOWN') invalid()
  return Object.freeze({ execution: Object.freeze({ ...execution, request }), result })
}
