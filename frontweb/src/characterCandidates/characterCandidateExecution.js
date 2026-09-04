import { narrativeResultView } from '../narrative/narrativeExecution.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const FACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const PROFILE_UID = 'c22f9231-0d79-43b9-93a6-d5e28d1d4401'
const MANIFEST_UID = '66512afd-a10f-447d-8f1f-1428b6dc1021'
const PROFILE_SHA256 = '73631e09bfab773ba0063ff16396c510104280371c6ba8ce0ac92aeec82067bc'
const MANIFEST_SHA256 = 'd6aa8979f26464e26f3251582eb24750549c218e27de23a2c0ef0e9a39383a08'
const STATES = Object.freeze(['reserved', 'succeeded', 'failed', 'submission_unknown'])
const FAILURE_CODES = Object.freeze([
  'CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID',
  'CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE',
])
const ARRAY_IS_ARRAY = Array.isArray
const MAP_GET = Map.prototype.get
const MAP_HAS = Map.prototype.has
const MAP_SET = Map.prototype.set
const SET_ADD = Set.prototype.add
const SET_HAS = Set.prototype.has
const REQUEST_KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'dramaUid', 'characterUid', 'extractionResultUid',
  'characterFactId', 'width', 'height', 'seed',
])
const SOURCE_KEYS = Object.freeze([
  'schemaVersion', 'dramaUid', 'characterUid', 'characterName', 'characterDescription',
  'characterPersonality', 'characterAppearance', 'sourceSelectionUid',
  'extractionResultUid', 'extractionResultHash', 'extractionEnvelopeHash',
  'extractionApprovalRef', 'characterFactId', 'characterFactName',
  'characterFactDescription',
])
const EXECUTION_KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'requestSha256', 'request', 'sourceSha256', 'source',
  'profileSha256', 'manifestSha256', 'state', 'batchUid', 'errorCode',
  'createdAtEpochMs', 'updatedAtEpochMs', 'items',
])
const ITEM_KEYS = Object.freeze([
  'ordinal', 'seed', 'promptSha256', 'provider', 'model', 'parameters',
  'parametersSha256', 'candidateUid', 'assetUid', 'assetVersionUid', 'logicalUri',
  'relativePath', 'contentSha256', 'byteLength', 'width', 'height', 'createdAtEpochMs',
])
const BATCH_KEYS = Object.freeze([
  'schemaVersion', 'batchUid', 'characterUid', 'requestSha256', 'request', 'candidates',
])
const BATCH_REQUEST_KEYS = Object.freeze([
  'schemaVersion', 'batchUid', 'characterUid', 'promptSemanticUid', 'profileUid',
  'manifestUid', 'width', 'height', 'seed', 'candidateCount',
])
const CANDIDATE_KEYS = Object.freeze([
  'uid', 'ordinal', 'assetVersionUid', 'logicalUri', 'mediaType', 'width', 'height',
  'contentSha256', 'presentation',
])

function invalid(message = 'Character candidate execution data is invalid') {
  throw new TypeError(message)
}

function oneOf(value, allowed) {
  for (let index = 0; index < allowed.length; index += 1) {
    if (allowed[index] === value) return true
  }
  return false
}

function exact(value, keys, message) {
  if (value === null || typeof value !== 'object' || ARRAY_IS_ARRAY(value)) invalid(message)
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
  if (!ARRAY_IS_ARRAY(value)) invalid(message)
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

function hash(value, message) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(message)
  return value
}

function integer(value, minimum, maximum, message) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(message)
  return value
}

export function characterCandidateExecutionRequestView(value) {
  const message = 'Character candidate execution request is invalid'
  const input = exact(value, REQUEST_KEYS, message)
  if (input.schemaVersion !== 'character-candidate-execution-request.v1'
    || typeof input.characterFactId !== 'string' || !FACT_ID.test(input.characterFactId)) {
    invalid(message)
  }
  const width = integer(input.width, 256, 2048, message)
  const height = integer(input.height, 256, 2048, message)
  if (width * height > 4_194_304) invalid(message)
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    operationUid: uid(input.operationUid, message),
    dramaUid: uid(input.dramaUid, message),
    characterUid: uid(input.characterUid, message),
    extractionResultUid: uid(input.extractionResultUid, message),
    characterFactId: input.characterFactId,
    width,
    height,
    seed: integer(input.seed, 0, 4_294_967_295, message),
  })
}

function sourceView(value, request) {
  const input = exact(value, SOURCE_KEYS)
  if (input.schemaVersion !== 'character-candidate-source.v1'
    || input.dramaUid !== request.dramaUid || input.characterUid !== request.characterUid
    || input.extractionResultUid !== request.extractionResultUid
    || input.characterFactId !== request.characterFactId
    || typeof input.characterName !== 'string' || input.characterName.length < 1
    || typeof input.characterFactName !== 'string'
    || input.characterFactName !== input.characterName
    || typeof input.characterFactDescription !== 'string'
    || !/^review:v1:[0-9a-f-]{36}$/u.test(input.extractionApprovalRef)) invalid()
  uid(input.sourceSelectionUid)
  hash(input.extractionResultHash)
  hash(input.extractionEnvelopeHash)
  const nullableKeys = ['characterDescription', 'characterPersonality', 'characterAppearance']
  for (let index = 0; index < nullableKeys.length; index += 1) {
    const key = nullableKeys[index]
    if (input[key] !== null && typeof input[key] !== 'string') invalid()
  }
  return Object.freeze({ ...input })
}

function itemView(value, execution, ordinal) {
  const input = exact(value, ITEM_KEYS)
  const parameters = exact(input.parameters, ['adapter', 'size', 'requestedSeed', 'ordinal'])
  const expectedSeed = (execution.request.seed + ordinal * 2_654_435_761) % 4_294_967_296
  const expectedUri = `asset://characters/${execution.request.characterUid}/candidate-batches/${execution.operationUid}/${ordinal}`
  const expectedPath = `characters/${execution.request.characterUid}/candidate-batches/${execution.operationUid}/${ordinal}.png`
  if (input.ordinal !== ordinal || input.seed !== expectedSeed
    || typeof input.provider !== 'string' || !TOKEN.test(input.provider)
    || typeof input.model !== 'string' || new TextEncoder().encode(input.model).byteLength < 1
    || new TextEncoder().encode(input.model).byteLength > 128
    || input.model.trim() !== input.model || input.model.includes('\0')
    || parameters.adapter !== 'configured-image.v1'
    || parameters.size !== `${execution.request.width}x${execution.request.height}`
    || parameters.requestedSeed !== expectedSeed || parameters.ordinal !== ordinal
    || input.logicalUri !== expectedUri || input.relativePath !== expectedPath
    || input.width !== execution.request.width || input.height !== execution.request.height) invalid()
  hash(input.promptSha256); hash(input.parametersSha256); hash(input.contentSha256)
  uid(input.candidateUid); uid(input.assetUid); uid(input.assetVersionUid)
  integer(input.byteLength, 1, 16 * 1024 * 1024)
  integer(input.createdAtEpochMs, 0, 253402300799999)
  return Object.freeze({ ...input, parameters: Object.freeze({ ...parameters }) })
}

function batchView(value, execution) {
  const input = exact(value, BATCH_KEYS)
  const request = exact(input.request, BATCH_REQUEST_KEYS)
  if (input.schemaVersion !== '5.0' || input.batchUid !== execution.operationUid
    || input.characterUid !== execution.request.characterUid
    || request.schemaVersion !== '5.0' || request.batchUid !== input.batchUid
    || request.characterUid !== input.characterUid
    || request.promptSemanticUid !== execution.request.extractionResultUid
    || request.profileUid !== PROFILE_UID || request.manifestUid !== MANIFEST_UID
    || request.width !== execution.request.width || request.height !== execution.request.height
    || request.seed !== execution.request.seed || request.candidateCount !== 4) invalid()
  hash(input.requestSha256)
  uid(request.profileUid); uid(request.manifestUid)
  const values = dense(input.candidates, 4)
  if (values.length !== 4) invalid()
  const candidates = []
  for (let ordinal = 0; ordinal < 4; ordinal += 1) {
    const candidate = exact(values[ordinal], CANDIDATE_KEYS)
    const item = execution.items[ordinal]
    if (candidate.ordinal !== ordinal || candidate.uid !== item.candidateUid
      || candidate.assetVersionUid !== item.assetVersionUid
      || candidate.logicalUri !== item.logicalUri || candidate.mediaType !== 'image/png'
      || candidate.width !== item.width || candidate.height !== item.height
      || candidate.contentSha256 !== item.contentSha256
      || candidate.presentation !== 'single_portrait') invalid()
    candidates[candidates.length] = Object.freeze({ ...candidate })
  }
  return Object.freeze({ ...input, request: Object.freeze({ ...request }), candidates: Object.freeze(candidates) })
}

export function characterCandidateExecutionResponseView(value) {
  const input = exact(value, ['execution', 'batch'])
  const rawExecution = exact(input.execution, EXECUTION_KEYS)
  const request = characterCandidateExecutionRequestView(rawExecution.request)
  if (rawExecution.schemaVersion !== 'character-candidate-execution.v1'
    || rawExecution.operationUid !== request.operationUid
    || !oneOf(rawExecution.state, STATES)) invalid()
  hash(rawExecution.requestSha256); hash(rawExecution.sourceSha256)
  if (rawExecution.profileSha256 !== PROFILE_SHA256
    || rawExecution.manifestSha256 !== MANIFEST_SHA256) invalid()
  const source = sourceView(rawExecution.source, request)
  const itemValues = dense(rawExecution.items, 4)
  const items = []
  for (let index = 0; index < itemValues.length; index += 1) {
    items[items.length] = itemView(itemValues[index], { ...rawExecution, request }, index)
  }
  const createdAtEpochMs = integer(rawExecution.createdAtEpochMs, 0, 253402300799999)
  const updatedAtEpochMs = integer(rawExecution.updatedAtEpochMs, createdAtEpochMs, 253402300799999)
  const execution = Object.freeze({
    ...rawExecution, request, source, items: Object.freeze(items), createdAtEpochMs, updatedAtEpochMs,
  })
  if (execution.state === 'succeeded') {
    if (execution.batchUid !== execution.operationUid || execution.errorCode !== null
      || execution.items.length !== 4 || input.batch === null) invalid()
    return Object.freeze({ execution, batch: batchView(input.batch, execution) })
  }
  if (execution.items.length !== 0 || execution.batchUid !== null || input.batch !== null) invalid()
  if (execution.state === 'reserved' && execution.errorCode !== null) invalid()
  if (execution.state === 'submission_unknown'
    && execution.errorCode !== 'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN') invalid()
  if (execution.state === 'failed' && !oneOf(execution.errorCode, FAILURE_CODES)) invalid()
  return Object.freeze({ execution, batch: null })
}

export function approvedCharacterCandidateOptions({ dramaUid, characters, results }) {
  uid(dramaUid)
  if (!ARRAY_IS_ARRAY(characters) || !ARRAY_IS_ARRAY(results)) invalid()
  const byName = new Map()
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]
    if (!character || typeof character !== 'object') continue
    const characterUid = character.uid
    const name = character.name
    if (typeof characterUid === 'string' && UUID.test(characterUid)
      && typeof name === 'string' && name.length > 0
      && !Reflect.apply(MAP_HAS, byName, [name])) {
      Reflect.apply(MAP_SET, byName, [name, Object.freeze({ characterUid, name })])
    }
  }
  const options = []
  const identities = new Set()
  for (let index = 0; index < results.length; index += 1) {
    let result
    try { result = narrativeResultView(results[index]) } catch { continue }
    if (result.dramaUid !== dramaUid || result.resultType !== 'extraction'
      || result.status !== 'approved') continue
    const facts = result.result?.output?.characters
    if (!ARRAY_IS_ARRAY(facts)) continue
    for (let factIndex = 0; factIndex < facts.length; factIndex += 1) {
      const fact = facts[factIndex]
      const character = Reflect.apply(MAP_GET, byName, [fact?.name])
      if (!character || typeof fact?.factId !== 'string' || !FACT_ID.test(fact.factId)) continue
      const identity = `${result.uid}\0${fact.factId}\0${character.characterUid}`
      if (Reflect.apply(SET_HAS, identities, [identity])) continue
      Reflect.apply(SET_ADD, identities, [identity])
      options[options.length] = Object.freeze({
        identity,
        characterUid: character.characterUid,
        characterName: character.name,
        extractionResultUid: result.uid,
        characterFactId: fact.factId,
      })
    }
  }
  return Object.freeze(options)
}

export function createCharacterCandidateExecutionRequest(value) {
  return characterCandidateExecutionRequestView({
    schemaVersion: 'character-candidate-execution-request.v1',
    ...value,
  })
}
