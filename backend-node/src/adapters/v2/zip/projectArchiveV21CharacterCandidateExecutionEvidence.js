'use strict';

const { createHash } = require('node:crypto');

const {
  normalizeNarrativeResult,
  resultContract,
  resultHashes,
} = require('../../../narrative/reviews/contracts');
const {
  characterCandidateExecutionRequestSha256,
  parseCharacterCandidateExecutionRequestJson,
} = require('../../../characterCandidates/execution/request');
const {
  characterCandidateSourceSha256,
  parseCharacterCandidateSourceJson,
} = require('../../../characterCandidates/execution/source');
const {
  MANIFEST,
  MANIFEST_JSON,
  MANIFEST_SHA256,
  PROFILE,
  PROFILE_JSON,
  PROFILE_SHA256,
  parseConfiguredCharacterCandidateManifest,
  parseConfiguredCharacterCandidateProfile,
} = require('../../../characterCandidates/execution/profile');
const {
  createCharacterCandidatePrompt,
} = require('../../../characterCandidates/execution/prompt');

const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_SORT = Array.prototype.sort;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const MAP_GET = Map.prototype.get;
const MAP_HAS = Map.prototype.has;
const MAP_SET = Map.prototype.set;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_EXEC = RegExp.prototype.exec;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const STRING_INCLUDES = String.prototype.includes;
const STRING_TRIM = String.prototype.trim;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const FAILURE_CODES = new Set([
  'CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID',
  'CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE',
]);
const STATES = new Set(['reserved', 'succeeded', 'failed', 'submission_unknown']);
const UNKNOWN_CODE = 'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN';

function apply(method, receiver, args) {
  return Reflect.apply(method, receiver, args);
}

function fail(invalid) {
  invalid();
  throw new TypeError('Project archive candidate execution evidence is invalid');
}

function setHas(set, value) {
  return apply(SET_HAS, set, [value]);
}

function setAdd(set, value) {
  return apply(SET_ADD, set, [value]);
}

function mapGet(map, key) {
  return apply(MAP_GET, map, [key]);
}

function mapHas(map, key) {
  return apply(MAP_HAS, map, [key]);
}

function mapSet(map, key, value) {
  return apply(MAP_SET, map, [key, value]);
}

function regexTest(expression, value) {
  return apply(REGEXP_EXEC, expression, [value]) !== null;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function epoch(value, invalid) {
  if (!apply(NUMBER_IS_SAFE_INTEGER, Number, [value])
    || value < 0 || value > 253_402_300_799_999) {
    fail(invalid);
  }
  return value;
}

function nullableText(value) {
  return value === null || value === '' ? null : value;
}

function parametersJson(value, width, height, seed, ordinal, invalid) {
  if (typeof value !== 'string'
    || apply(BUFFER_BYTE_LENGTH, Buffer, [value, 'utf8']) > 4096) fail(invalid);
  let parsed;
  try { parsed = apply(JSON_PARSE, JSON, [value]); } catch { return fail(invalid); }
  if (!parsed || typeof parsed !== 'object' || apply(ARRAY_IS_ARRAY, Array, [parsed])
    || apply(OBJECT_GET_PROTOTYPE, Object, [parsed]) !== Object.prototype) fail(invalid);
  const descriptors = apply(OBJECT_GET_DESCRIPTORS, Object, [parsed]);
  const keys = apply(REFLECT_OWN_KEYS, Reflect, [descriptors]);
  const expectedKeys = ['adapter', 'size', 'requestedSeed', 'ordinal'];
  if (keys.length !== expectedKeys.length) fail(invalid);
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index];
    const descriptor = descriptors[key];
    if (keys[index] !== key || !descriptor?.enumerable
      || !apply(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) fail(invalid);
  }
  if (descriptors.adapter.value !== 'configured-image.v1'
    || descriptors.size.value !== `${width}x${height}`
    || descriptors.requestedSeed.value !== seed
    || descriptors.ordinal.value !== ordinal) fail(invalid);
  const expected = `{"adapter":"configured-image.v1","size":${apply(
    JSON_STRINGIFY,
    JSON,
    [descriptors.size.value],
  )},"requestedSeed":${seed},"ordinal":${ordinal}}`;
  if (expected !== value) fail(invalid);
  return parsed;
}

function indexBy(rows, key, invalid) {
  const result = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const identity = rows[index][key];
    if (mapHas(result, identity)) fail(invalid);
    mapSet(result, identity, rows[index]);
  }
  return result;
}

function itemsByExecution(rows, invalid) {
  const result = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    let items = mapGet(result, row.operation_uid);
    if (items === undefined) {
      items = [];
      mapSet(result, row.operation_uid, items);
    }
    items[items.length] = row;
  }
  for (let index = 0; index < rows.length; index += 1) {
    const items = mapGet(result, rows[index].operation_uid);
    if (items && items[0] === rows[index]) apply(ARRAY_SORT, items, [
      (left, right) => left.ordinal - right.ordinal,
    ]);
  }
  return result;
}

function narrativeEvidence(result, cache, invalid) {
  if (mapHas(cache, result.uid)) return mapGet(cache, result.uid);
  let normalized;
  try { normalized = normalizeNarrativeResult('extraction', result.result_json); } catch {
    return fail(invalid);
  }
  const facts = new Map();
  for (let index = 0; index < normalized.output.characters.length; index += 1) {
    const fact = normalized.output.characters[index];
    const current = mapGet(facts, fact.factId);
    if (current === undefined) {
      mapSet(facts, fact.factId, { count: 1, fact });
    } else {
      current.count += 1;
    }
  }
  const evidence = apply(OBJECT_FREEZE, Object, [{
    normalized,
    contract: resultContract('extraction'),
    hashes: resultHashes(normalized),
    facts,
  }]);
  mapSet(cache, result.uid, evidence);
  return evidence;
}

function assertNarrativeSource(
  execution,
  source,
  narrativeResults,
  narrativeReviews,
  narrativeEvidenceByUid,
  invalid,
) {
  const result = mapGet(narrativeResults, execution.extraction_result_uid);
  const review = mapGet(narrativeReviews, execution.extraction_review_uid);
  if (!result || !review) fail(invalid);
  const evidence = narrativeEvidence(result, narrativeEvidenceByUid, invalid);
  if (result.drama_uid !== execution.drama_uid
    || result.source_selection_uid !== execution.source_selection_uid
    || result.result_type !== 'extraction' || result.task_type !== evidence.contract.taskType
    || result.schema_version !== evidence.contract.schemaVersion || result.status !== 'approved'
    || result.current_review_uid !== execution.extraction_review_uid
    || result.input_hash !== evidence.normalized.inputHash
    || result.result_hash !== execution.extraction_result_hash
    || result.envelope_hash !== execution.extraction_envelope_hash
    || evidence.hashes.resultHash !== execution.extraction_result_hash
    || evidence.hashes.envelopeHash !== execution.extraction_envelope_hash
    || review.result_uid !== execution.extraction_result_uid || review.decision !== 'approve'
    || review.result_hash !== execution.extraction_result_hash
    || review.envelope_hash !== execution.extraction_envelope_hash) fail(invalid);
  const factEvidence = mapGet(evidence.facts, source.characterFactId);
  if (!factEvidence || factEvidence.count !== 1
    || factEvidence.fact.name !== source.characterFactName
    || factEvidence.fact.description !== source.characterFactDescription
    || factEvidence.fact.name !== source.characterName) fail(invalid);
}

function assertState(execution, itemCount, invalid) {
  if (!setHas(STATES, execution.state)) {
    fail(invalid);
  }
  if (execution.state === 'succeeded') {
    if (execution.batch_uid !== execution.operation_uid || execution.error_code !== null
      || itemCount !== 4) fail(invalid);
    return;
  }
  if (execution.batch_uid !== null || itemCount !== 0) fail(invalid);
  if (execution.state === 'reserved' && execution.error_code !== null) fail(invalid);
  if (execution.state === 'failed'
    && !setHas(FAILURE_CODES, execution.error_code)) fail(invalid);
  if (execution.state === 'submission_unknown'
    && execution.error_code !== UNKNOWN_CODE) fail(invalid);
}

function assertItem(execution, item, result, seen, invalid) {
  const ordinal = item.ordinal;
  const expectedSeed = (execution.request.seed + ordinal * 2_654_435_761) % 4_294_967_296;
  const prompt = createCharacterCandidatePrompt(execution.source, ordinal, expectedSeed);
  parametersJson(
    item.parameters_json,
    execution.request.width,
    execution.request.height,
    expectedSeed,
    ordinal,
    invalid,
  );
  if (item.seed !== expectedSeed || item.prompt_sha256 !== prompt.promptSha256
    || typeof item.provider !== 'string' || !regexTest(PROVIDER, item.provider)
    || typeof item.model !== 'string'
    || apply(BUFFER_BYTE_LENGTH, Buffer, [item.model, 'utf8']) < 1
    || apply(BUFFER_BYTE_LENGTH, Buffer, [item.model, 'utf8']) > 128
    || apply(STRING_TRIM, item.model, []) !== item.model
    || apply(STRING_INCLUDES, item.model, ['\0'])
    || item.parameters_sha256 !== sha256(item.parameters_json)
    || item.width !== execution.request.width || item.height !== execution.request.height
    || item.logical_uri !== `asset://characters/${execution.character_uid}/candidate-batches/${execution.operation_uid}/${ordinal}`
    || item.relative_path !== `characters/${execution.character_uid}/candidate-batches/${execution.operation_uid}/${ordinal}.png`
    || typeof item.content_sha256 !== 'string' || !regexTest(SHA256, item.content_sha256)
    || !apply(NUMBER_IS_SAFE_INTEGER, Number, [item.byte_length]) || item.byte_length < 1
    || item.byte_length > 16 * 1024 * 1024
    || epoch(item.created_at_epoch_ms, invalid) < execution.createdAtEpochMs
    || item.created_at_epoch_ms > execution.updatedAtEpochMs) fail(invalid);
  const identities = [
    ['candidate', item.candidate_uid], ['asset', item.asset_uid],
    ['version', item.asset_version_uid], ['logical', item.logical_uri],
    ['path', item.relative_path], ['content', `${execution.operation_uid}:${item.content_sha256}`],
  ];
  for (let index = 0; index < identities.length; index += 1) {
    const kind = identities[index][0];
    const value = identities[index][1];
    if (setHas(seen[kind], value)) fail(invalid);
    setAdd(seen[kind], value);
  }
  if (!result || result.batch_uid !== execution.operation_uid
    || result.character_uid !== execution.character_uid || result.ordinal !== ordinal
    || result.asset_version_uid !== item.asset_version_uid
    || result.asset_uid !== item.asset_uid || result.storage_provider !== 'local'
    || result.relative_path !== item.relative_path || result.logical_uri !== item.logical_uri
    || result.media_type !== 'image/png' || result.width !== item.width
    || result.height !== item.height || result.content_sha256 !== item.content_sha256
    || result.presentation !== 'single_portrait') fail(invalid);
}

function assertProjectArchiveV21CharacterCandidateExecutionStructured(records, invalid) {
  const executions = records.characterCandidateExecutions;
  const items = records.characterCandidateExecutionItems;
  const executionByUid = indexBy(executions, 'operation_uid', invalid);
  const itemRows = itemsByExecution(items, invalid);
  const batchByUid = indexBy(records.characterCandidateBatches, 'uid', invalid);
  const resultByUid = indexBy(records.characterCandidateResults, 'uid', invalid);
  const narrativeResultByUid = indexBy(records.narrativeResults, 'uid', invalid);
  const narrativeReviewByUid = indexBy(records.narrativeReviewEvents, 'uid', invalid);
  const narrativeEvidenceByUid = new Map();
  const seen = {
    candidate: new Set(), asset: new Set(), version: new Set(),
    logical: new Set(), path: new Set(), content: new Set(),
  };

  for (let index = 0; index < executions.length; index += 1) {
    const row = executions[index];
    let request;
    let source;
    try {
      request = parseCharacterCandidateExecutionRequestJson(row.request_json);
      source = parseCharacterCandidateSourceJson(row.source_json);
      parseConfiguredCharacterCandidateProfile(row.profile_json);
      parseConfiguredCharacterCandidateManifest(row.manifest_json);
    } catch {
      return fail(invalid);
    }
    if (request.operationUid !== row.operation_uid || request.dramaUid !== row.drama_uid
      || request.characterUid !== row.character_uid
      || request.extractionResultUid !== row.extraction_result_uid
      || source.dramaUid !== row.drama_uid || source.characterUid !== row.character_uid
      || source.sourceSelectionUid !== row.source_selection_uid
      || source.extractionResultUid !== row.extraction_result_uid
      || source.extractionResultHash !== row.extraction_result_hash
      || source.extractionEnvelopeHash !== row.extraction_envelope_hash
      || source.extractionApprovalRef !== `review:v1:${row.extraction_review_uid}`
      || source.characterFactId !== request.characterFactId
      || characterCandidateExecutionRequestSha256(request) !== row.request_sha256
      || characterCandidateSourceSha256(source) !== row.source_sha256
      || row.profile_json !== PROFILE_JSON || row.profile_sha256 !== PROFILE_SHA256
      || row.manifest_json !== MANIFEST_JSON || row.manifest_sha256 !== MANIFEST_SHA256) {
      fail(invalid);
    }
    const createdAtEpochMs = epoch(row.created_at_epoch_ms, invalid);
    const updatedAtEpochMs = epoch(row.updated_at_epoch_ms, invalid);
    if (updatedAtEpochMs < createdAtEpochMs) fail(invalid);
    const operation = apply(OBJECT_FREEZE, Object, [{
      operation_uid: row.operation_uid,
      character_uid: row.character_uid,
      request,
      source,
      createdAtEpochMs,
      updatedAtEpochMs,
    }]);
    const operationItems = mapGet(itemRows, row.operation_uid) || [];
    assertState(row, operationItems.length, invalid);
    assertNarrativeSource(
      row,
      source,
      narrativeResultByUid,
      narrativeReviewByUid,
      narrativeEvidenceByUid,
      invalid,
    );
    if (row.state === 'succeeded') {
      const batch = mapGet(batchByUid, row.operation_uid);
      if (!batch || batch.character_uid !== row.character_uid
        || batch.prompt_semantic_uid !== row.extraction_result_uid
        || batch.profile_uid !== PROFILE.uid || batch.manifest_uid !== MANIFEST.uid
        || batch.width !== request.width || batch.height !== request.height
        || batch.seed !== request.seed || batch.candidate_count !== 4) fail(invalid);
      for (let ordinal = 0; ordinal < operationItems.length; ordinal += 1) {
        const item = operationItems[ordinal];
        if (item.ordinal !== ordinal) fail(invalid);
        assertItem(operation, item, mapGet(resultByUid, item.candidate_uid), seen, invalid);
      }
    } else if (mapHas(batchByUid, row.operation_uid)) fail(invalid);
  }

  for (let index = 0; index < items.length; index += 1) {
    if (!mapHas(executionByUid, items[index].operation_uid)) fail(invalid);
  }
  for (let index = 0; index < records.characterCandidateBatches.length; index += 1) {
    const batch = records.characterCandidateBatches[index];
    if (batch.profile_uid !== PROFILE.uid && batch.manifest_uid !== MANIFEST.uid) continue;
    const execution = mapGet(executionByUid, batch.uid);
    if (!execution || execution.state !== 'succeeded'
      || batch.profile_uid !== PROFILE.uid || batch.manifest_uid !== MANIFEST.uid) fail(invalid);
  }
}

function assertProjectArchiveV21CharacterCandidateExecutionBase(
  records,
  structured,
  legacyRecords,
  mediaBindings,
  invalid,
) {
  const characters = indexBy(legacyRecords.characters, 'uid', invalid);
  const selections = indexBy(records.sourceSelections, 'uid', invalid);
  const assets = indexBy(records.assets, 'uid', invalid);
  const versions = indexBy(records.assetVersions, 'uid', invalid);
  const bindings = indexBy(mediaBindings, 'asset_version_uid', invalid);
  const executions = indexBy(structured.characterCandidateExecutions, 'operation_uid', invalid);
  const promptUids = new Set();
  const manifestUids = new Set();
  for (let index = 0; index < records.promptSemanticVersions.length; index += 1) {
    setAdd(promptUids, records.promptSemanticVersions[index].uid);
  }
  for (let index = 0; index < records.workflowManifests.length; index += 1) {
    setAdd(manifestUids, records.workflowManifests[index].uid);
  }

  for (let index = 0; index < structured.characterCandidateExecutions.length; index += 1) {
    const execution = structured.characterCandidateExecutions[index];
    const source = parseCharacterCandidateSourceJson(execution.source_json);
    const character = mapGet(characters, execution.character_uid);
    if (!character || !mapHas(selections, execution.source_selection_uid)
      || character.name !== source.characterName
      || nullableText(character.description) !== source.characterDescription
      || nullableText(character.personality) !== source.characterPersonality
      || nullableText(character.appearance) !== source.characterAppearance) fail(invalid);
  }

  for (let index = 0; index < structured.characterCandidateBatches.length; index += 1) {
    const batch = structured.characterCandidateBatches[index];
    const execution = mapGet(executions, batch.uid);
    if (execution?.state === 'succeeded') {
      if (batch.prompt_semantic_uid !== execution.extraction_result_uid
        || batch.profile_uid !== PROFILE.uid || batch.manifest_uid !== MANIFEST.uid) fail(invalid);
    } else if (!setHas(promptUids, batch.prompt_semantic_uid)
      || !setHas(manifestUids, batch.manifest_uid)) fail(invalid);
  }

  for (let index = 0; index < structured.characterCandidateExecutionItems.length; index += 1) {
    const item = structured.characterCandidateExecutionItems[index];
    const execution = mapGet(executions, item.operation_uid);
    const asset = mapGet(assets, item.asset_uid);
    const version = mapGet(versions, item.asset_version_uid);
    const binding = mapGet(bindings, item.asset_version_uid);
    if (!execution || execution.state !== 'succeeded' || !asset || !version || !binding
      || asset.owner_type !== 'character' || asset.owner_uid !== execution.character_uid
      || asset.asset_type !== 'character_candidate' || asset.current_version_uid !== version.uid
      || asset.status !== 'ready' || version.asset_uid !== asset.uid
      || version.storage_provider !== 'local' || version.logical_uri !== item.logical_uri
      || version.relative_path !== item.relative_path || version.sha256 !== item.content_sha256
      || version.mime_type !== 'image/png' || version.width !== item.width
      || version.height !== item.height || version.duration_ms !== null
      || version.status !== 'ready' || binding.binding_state !== 'content_addressed'
      || binding.byte_length !== item.byte_length || binding.sha256 !== item.content_sha256) {
      fail(invalid);
    }
  }
}

module.exports = Object.freeze({
  assertProjectArchiveV21CharacterCandidateExecutionBase,
  assertProjectArchiveV21CharacterCandidateExecutionStructured,
});
