'use strict';

const { createHash } = require('node:crypto');

const {
  normalizeNarrativeResult,
  resultContract,
  resultHashes,
} = require('../../narrative/reviews/contracts');
const {
  canonicalCharacterCandidateExecutionRequest,
  characterCandidateExecutionRequestSha256,
  parseCharacterCandidateExecutionRequestJson,
} = require('../../characterCandidates/execution/request');
const {
  canonicalCharacterCandidateSource,
  characterCandidateSourceSha256,
  parseCharacterCandidateSourceJson,
} = require('../../characterCandidates/execution/source');
const {
  MANIFEST_JSON,
  MANIFEST_SHA256,
  PROFILE_JSON,
  PROFILE_SHA256,
  parseConfiguredCharacterCandidateManifest,
  parseConfiguredCharacterCandidateProfile,
} = require('../../characterCandidates/execution/profile');
const { createCharacterCandidatePrompt } = require('../../characterCandidates/execution/prompt');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { assertDatabase, executeWrite } = require('./repositorySupport');

const ENTITY = 'character candidate execution';
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STATES = new Set(['reserved', 'succeeded', 'failed', 'submission_unknown']);
const ERROR_CODES = new Set([
  'CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID',
  'CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE',
  'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN',
]);
const SET_HAS = Set.prototype.has;
const STRING_INCLUDES = String.prototype.includes;
const STRING_SLICE = String.prototype.slice;
const STRING_TRIM = String.prototype.trim;

function dataError(reason) {
  throw new V2RepositoryDataError(ENTITY, reason);
}

function epoch(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) dataError('epoch');
  return value;
}

function nullable(value) {
  return value === null || value === '' ? null : value;
}

function createCharacterCandidateExecutionRepository(database) {
  assertDatabase(database);
  const characterSource = database.prepare(`
    SELECT character.uid, drama.uid AS drama_uid, character.name, character.description,
           character.personality, character.appearance
    FROM characters AS character
    JOIN dramas AS drama ON drama.id=character.drama_id
    WHERE character.uid=? AND character.deleted_at IS NULL AND drama.deleted_at IS NULL
  `);
  const select = database.prepare(`
    SELECT execution.*,
      character.name AS current_character_name,
      NULLIF(character.description,'') AS current_character_description,
      NULLIF(character.personality,'') AS current_character_personality,
      NULLIF(character.appearance,'') AS current_character_appearance,
      drama.uid AS current_drama_uid,
      result.drama_uid AS current_result_drama_uid,
      result.source_selection_uid AS current_result_selection_uid,
      result.result_type AS current_result_type,
      result.task_type AS current_result_task_type,
      result.schema_version AS current_result_schema_version,
      result.status AS current_result_status,
      result.current_review_uid AS current_result_review_uid,
      result.input_hash AS current_result_input_hash,
      result.result_hash AS current_result_hash,
      result.envelope_hash AS current_result_envelope_hash,
      result.result_json AS current_result_json,
      review.result_uid AS current_review_result_uid,
      review.decision AS current_review_decision,
      review.result_hash AS current_review_result_hash,
      review.envelope_hash AS current_review_envelope_hash
    FROM character_candidate_executions AS execution
    LEFT JOIN characters AS character ON character.uid=execution.character_uid
    LEFT JOIN dramas AS drama ON drama.id=character.drama_id
    LEFT JOIN narrative_results AS result ON result.uid=execution.extraction_result_uid
    LEFT JOIN narrative_review_events AS review ON review.uid=execution.extraction_review_uid
    WHERE execution.operation_uid=?
  `);
  const selectItems = database.prepare(`
    SELECT item.*,
      result.batch_uid AS current_batch_uid,
      result.character_uid AS current_character_uid,
      result.ordinal AS current_ordinal,
      result.asset_version_uid AS current_result_version_uid,
      result.asset_uid AS current_result_asset_uid,
      result.relative_path AS current_result_relative_path,
      result.logical_uri AS current_result_logical_uri,
      result.media_type AS current_result_media_type,
      result.width AS current_result_width,
      result.height AS current_result_height,
      result.content_sha256 AS current_result_sha256,
      version.asset_uid AS current_version_asset_uid,
      version.storage_provider AS current_storage_provider,
      version.logical_uri AS current_version_logical_uri,
      version.relative_path AS current_version_relative_path,
      version.sha256 AS current_version_sha256,
      version.mime_type AS current_version_mime_type,
      version.width AS current_version_width,
      version.height AS current_version_height,
      version.status AS current_version_status,
      asset.owner_type AS current_owner_type,
      asset.owner_uid AS current_owner_uid,
      asset.asset_type AS current_asset_type,
      asset.current_version_uid AS current_asset_version_uid,
      asset.status AS current_asset_status
    FROM character_candidate_execution_items AS item
    LEFT JOIN character_candidate_results AS result ON result.uid=item.candidate_uid
    LEFT JOIN asset_versions AS version ON version.uid=item.asset_version_uid
    LEFT JOIN assets AS asset ON asset.uid=item.asset_uid
    WHERE item.operation_uid=? ORDER BY item.ordinal
  `);
  const insert = database.prepare(`
    INSERT INTO character_candidate_executions
      (operation_uid, drama_uid, character_uid, source_selection_uid,
       extraction_result_uid, extraction_result_hash, extraction_envelope_hash,
       extraction_review_uid, request_json, request_sha256, source_json, source_sha256,
       profile_json, profile_sha256, manifest_json, manifest_sha256, state)
    VALUES
      (@operationUid, @dramaUid, @characterUid, @sourceSelectionUid,
       @extractionResultUid, @extractionResultHash, @extractionEnvelopeHash,
       @extractionReviewUid, @requestJson, @requestSha256, @sourceJson, @sourceSha256,
       @profileJson, @profileSha256, @manifestJson, @manifestSha256, 'reserved')
  `);
  const insertItem = database.prepare(`
    INSERT INTO character_candidate_execution_items
      (operation_uid, ordinal, seed, prompt_sha256, provider, model,
       parameters_json, parameters_sha256, candidate_uid, asset_uid, asset_version_uid,
       logical_uri, relative_path, content_sha256, byte_length, width, height)
    VALUES
      (@operationUid, @ordinal, @seed, @promptSha256, @provider, @model,
       @parametersJson, @parametersSha256, @candidateUid, @assetUid, @assetVersionUid,
       @logicalUri, @relativePath, @contentSha256, @byteLength, @width, @height)
  `);
  const transition = database.prepare(`
    UPDATE character_candidate_executions
    SET state=@state, batch_uid=@batchUid, error_code=@errorCode,
        updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=@operationUid AND state='reserved'
  `);
  const recover = database.prepare(`
    UPDATE character_candidate_executions
    SET state='submission_unknown',
        error_code='CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN',
        updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE state='reserved'
  `);

  function getCharacterSource(characterUid) {
    if (typeof characterUid !== 'string' || !UUID_V4.test(characterUid)) {
      throw new TypeError('Character candidate character UID is invalid');
    }
    const row = characterSource.get(characterUid);
    if (!row) throw new V2RepositoryNotFoundError('character', characterUid);
    if (!UUID_V4.test(row.drama_uid) || typeof row.name !== 'string' || row.name.length < 1) {
      dataError('character');
    }
    return Object.freeze({
      uid: row.uid,
      dramaUid: row.drama_uid,
      name: row.name,
      description: nullable(row.description),
      personality: nullable(row.personality),
      appearance: nullable(row.appearance),
    });
  }

  function mapItems(operation, rows) {
    const output = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      let parameters;
      try { parameters = JSON.parse(row.parameters_json); } catch { dataError('parameters'); }
      const parametersSha256 = createHash('sha256').update(row.parameters_json, 'utf8').digest('hex');
      const expectedSeed = (operation.request.seed + index * 2_654_435_761) % 4_294_967_296;
      const expectedPrompt = createCharacterCandidatePrompt(operation.source, index, expectedSeed);
      if (row.operation_uid !== operation.operationUid || row.ordinal !== index
        || row.seed !== expectedSeed
        || row.prompt_sha256 !== expectedPrompt.promptSha256
        || typeof row.provider !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(row.provider)
        || typeof row.model !== 'string' || Buffer.byteLength(row.model, 'utf8') < 1
        || Buffer.byteLength(row.model, 'utf8') > 128
        || Reflect.apply(STRING_TRIM, row.model, []) !== row.model
        || Reflect.apply(STRING_INCLUDES, row.model, ['\0'])
        || JSON.stringify(parameters) !== row.parameters_json
        || parametersSha256 !== row.parameters_sha256
        || parameters.adapter !== 'configured-image.v1'
        || parameters.size !== `${operation.request.width}x${operation.request.height}`
        || parameters.requestedSeed !== row.seed || parameters.ordinal !== row.ordinal
        || !UUID_V4.test(row.candidate_uid) || !UUID_V4.test(row.asset_uid)
        || !UUID_V4.test(row.asset_version_uid)
        || row.logical_uri !== `asset://characters/${operation.request.characterUid}/candidate-batches/${operation.operationUid}/${index}`
        || row.relative_path !== `characters/${operation.request.characterUid}/candidate-batches/${operation.operationUid}/${index}.png`
        || typeof row.content_sha256 !== 'string' || !SHA256.test(row.content_sha256)
        || !Number.isSafeInteger(row.byte_length) || row.byte_length < 1 || row.byte_length > 16 * 1024 * 1024
        || row.width !== operation.request.width || row.height !== operation.request.height
        || row.current_batch_uid !== operation.operationUid
        || row.current_character_uid !== operation.request.characterUid
        || row.current_ordinal !== row.ordinal
        || row.current_result_version_uid !== row.asset_version_uid
        || row.current_result_asset_uid !== row.asset_uid
        || row.current_result_relative_path !== row.relative_path
        || row.current_result_logical_uri !== row.logical_uri
        || row.current_result_media_type !== 'image/png'
        || row.current_result_width !== row.width || row.current_result_height !== row.height
        || row.current_result_sha256 !== row.content_sha256
        || row.current_version_asset_uid !== row.asset_uid
        || row.current_storage_provider !== 'local'
        || row.current_version_logical_uri !== row.logical_uri
        || row.current_version_relative_path !== row.relative_path
        || row.current_version_sha256 !== row.content_sha256
        || row.current_version_mime_type !== 'image/png'
        || row.current_version_width !== row.width || row.current_version_height !== row.height
        || row.current_version_status !== 'ready'
        || row.current_owner_type !== 'character'
        || row.current_owner_uid !== operation.request.characterUid
        || row.current_asset_type !== 'character_candidate'
        || row.current_asset_version_uid !== row.asset_version_uid
        || row.current_asset_status !== 'ready') dataError('item binding');
      output[output.length] = Object.freeze({
        ordinal: row.ordinal,
        seed: row.seed,
        promptSha256: row.prompt_sha256,
        provider: row.provider,
        model: row.model,
        parameters: Object.freeze(parameters),
        parametersSha256,
        candidateUid: row.candidate_uid,
        assetUid: row.asset_uid,
        assetVersionUid: row.asset_version_uid,
        logicalUri: row.logical_uri,
        relativePath: row.relative_path,
        contentSha256: row.content_sha256,
        byteLength: row.byte_length,
        width: row.width,
        height: row.height,
        createdAtEpochMs: epoch(row.created_at_epoch_ms),
      });
    }
    return Object.freeze(output);
  }

  function map(row) {
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    let request;
    let source;
    try {
      request = parseCharacterCandidateExecutionRequestJson(row.request_json);
      source = parseCharacterCandidateSourceJson(row.source_json);
      parseConfiguredCharacterCandidateProfile(row.profile_json);
      parseConfiguredCharacterCandidateManifest(row.manifest_json);
    } catch {
      return dataError('contract');
    }
    const requestSha256 = characterCandidateExecutionRequestSha256(request);
    const sourceSha256 = characterCandidateSourceSha256(source);
    if (request.operationUid !== row.operation_uid || request.dramaUid !== row.drama_uid
      || request.characterUid !== row.character_uid
      || request.extractionResultUid !== row.extraction_result_uid
      || source.dramaUid !== row.drama_uid || source.characterUid !== row.character_uid
      || source.sourceSelectionUid !== row.source_selection_uid
      || source.extractionResultUid !== row.extraction_result_uid
      || source.extractionResultHash !== row.extraction_result_hash
      || source.extractionEnvelopeHash !== row.extraction_envelope_hash
      || source.extractionApprovalRef !== `review:v1:${row.extraction_review_uid}`
      || request.characterFactId !== source.characterFactId
      || requestSha256 !== row.request_sha256 || sourceSha256 !== row.source_sha256
      || row.profile_json !== PROFILE_JSON || row.profile_sha256 !== PROFILE_SHA256
      || row.manifest_json !== MANIFEST_JSON || row.manifest_sha256 !== MANIFEST_SHA256
      || !Reflect.apply(SET_HAS, STATES, [row.state])) dataError('binding');
    if (row.current_drama_uid !== row.drama_uid
      || row.current_character_name !== source.characterName
      || row.current_character_description !== source.characterDescription
      || row.current_character_personality !== source.characterPersonality
      || row.current_character_appearance !== source.characterAppearance) dataError('character source');

    let persistedResult;
    try {
      persistedResult = normalizeNarrativeResult('extraction', JSON.parse(row.current_result_json));
    } catch {
      return dataError('narrative source');
    }
    const contract = resultContract('extraction');
    const hashes = resultHashes(persistedResult);
    if (row.current_result_drama_uid !== row.drama_uid
      || row.current_result_selection_uid !== row.source_selection_uid
      || row.current_result_type !== 'extraction'
      || row.current_result_task_type !== contract.taskType
      || row.current_result_schema_version !== contract.schemaVersion
      || row.current_result_status !== 'approved'
      || row.current_result_review_uid !== row.extraction_review_uid
      || row.current_result_input_hash !== persistedResult.inputHash
      || row.current_result_hash !== row.extraction_result_hash
      || row.current_result_envelope_hash !== row.extraction_envelope_hash
      || hashes.resultHash !== row.extraction_result_hash
      || hashes.envelopeHash !== row.extraction_envelope_hash
      || row.current_review_result_uid !== row.extraction_result_uid
      || row.current_review_decision !== 'approve'
      || row.current_review_result_hash !== row.extraction_result_hash
      || row.current_review_envelope_hash !== row.extraction_envelope_hash) dataError('narrative source');
    let matchingFact = 0;
    for (let index = 0; index < persistedResult.output.characters.length; index += 1) {
      const fact = persistedResult.output.characters[index];
      if (fact.factId !== source.characterFactId) continue;
      matchingFact += 1;
      if (fact.name !== source.characterFactName
        || fact.description !== source.characterFactDescription
        || fact.name !== source.characterName) dataError('character fact');
    }
    if (matchingFact !== 1) dataError('character fact');
    const createdAtEpochMs = epoch(row.created_at_epoch_ms);
    const updatedAtEpochMs = epoch(row.updated_at_epoch_ms);
    if (updatedAtEpochMs < createdAtEpochMs) dataError('time');
    const operation = {
      schemaVersion: 'character-candidate-execution.v1',
      operationUid: request.operationUid,
      requestSha256,
      request,
      sourceSha256,
      source,
      profileSha256: PROFILE_SHA256,
      manifestSha256: MANIFEST_SHA256,
      state: row.state,
      batchUid: row.batch_uid,
      errorCode: row.error_code,
      createdAtEpochMs,
      updatedAtEpochMs,
    };
    const items = mapItems(operation, selectItems.all(row.operation_uid));
    if (row.state === 'succeeded') {
      if (row.batch_uid !== row.operation_uid || row.error_code !== null || items.length !== 4) {
        dataError('state');
      }
    } else if (items.length !== 0 || row.batch_uid !== null) dataError('state');
    if (row.state === 'reserved' && row.error_code !== null) dataError('state');
    if (row.state === 'failed'
      && (!Reflect.apply(SET_HAS, ERROR_CODES, [row.error_code])
        || row.error_code === 'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN')) dataError('state');
    if (row.state === 'submission_unknown'
      && row.error_code !== 'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN') dataError('state');
    if (row.state === 'succeeded' && row.error_code !== null) dataError('state');
    return Object.freeze({ ...operation, items });
  }

  function get(operationUid) {
    return map(select.get(operationUid));
  }

  function requireTransition(operationUid, state, errorCode, batchUid) {
    const current = get(operationUid);
    if (current.state !== 'reserved') {
      if (current.state === state && current.errorCode === errorCode
        && current.batchUid === batchUid) return current;
      throw new V2RepositoryConflictError(ENTITY, 'transitioned');
    }
    executeWrite(ENTITY, 'transitioned', () => transition.run({
      operationUid, state, batchUid, errorCode,
    }));
    const updated = get(operationUid);
    if (updated.state !== state || updated.errorCode !== errorCode
      || updated.batchUid !== batchUid) dataError('transition');
    return updated;
  }

  return Object.freeze({
    reserve(value) {
      if (!value || typeof value !== 'object') throw new TypeError('Character candidate reservation is invalid');
      const requestJson = canonicalCharacterCandidateExecutionRequest(value.request);
      const sourceJson = canonicalCharacterCandidateSource(value.source);
      const values = {
        operationUid: value.request.operationUid,
        dramaUid: value.request.dramaUid,
        characterUid: value.request.characterUid,
        sourceSelectionUid: value.source.sourceSelectionUid,
        extractionResultUid: value.source.extractionResultUid,
        extractionResultHash: value.source.extractionResultHash,
        extractionEnvelopeHash: value.source.extractionEnvelopeHash,
        extractionReviewUid: Reflect.apply(
          STRING_SLICE,
          value.source.extractionApprovalRef,
          ['review:v1:'.length],
        ),
        requestJson,
        requestSha256: value.requestSha256,
        sourceJson,
        sourceSha256: value.sourceSha256,
        profileJson: value.profileJson,
        profileSha256: value.profileSha256,
        manifestJson: value.manifestJson,
        manifestSha256: value.manifestSha256,
      };
      if (values.requestSha256 !== characterCandidateExecutionRequestSha256(value.request)
        || values.sourceSha256 !== characterCandidateSourceSha256(value.source)
        || values.profileJson !== PROFILE_JSON || values.profileSha256 !== PROFILE_SHA256
        || values.manifestJson !== MANIFEST_JSON || values.manifestSha256 !== MANIFEST_SHA256) {
        throw new TypeError('Character candidate reservation is invalid');
      }
      try { insert.run(values); } catch {
        let existing;
        try { existing = get(values.operationUid); } catch {
          throw new V2RepositoryConflictError(ENTITY, 'reserved');
        }
        if (existing.requestSha256 !== values.requestSha256
          || existing.sourceSha256 !== values.sourceSha256) {
          throw new V2RepositoryConflictError(ENTITY, 'reserved');
        }
        return Object.freeze({ created: false, execution: existing });
      }
      return Object.freeze({ created: true, execution: get(values.operationUid) });
    },

    complete(operationUid, batchUid, items) {
      const current = get(operationUid);
      if (current.state === 'succeeded') return current;
      if (current.state !== 'reserved' || batchUid !== operationUid
        || !Array.isArray(items) || items.length !== 4) {
        throw new V2RepositoryConflictError(ENTITY, 'completed');
      }
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const parametersSha256 = createHash('sha256')
          .update(item.parametersJson, 'utf8').digest('hex');
        executeWrite(ENTITY, 'item recorded', () => insertItem.run({
          operationUid,
          ordinal: item.ordinal,
          seed: item.seed,
          promptSha256: item.promptSha256,
          provider: item.provider,
          model: item.model,
          parametersJson: item.parametersJson,
          parametersSha256,
          candidateUid: item.candidateUid,
          assetUid: item.assetUid,
          assetVersionUid: item.assetVersionUid,
          logicalUri: `asset://characters/${current.request.characterUid}/candidate-batches/${operationUid}/${item.ordinal}`,
          relativePath: item.relativePath,
          contentSha256: item.contentSha256,
          byteLength: item.bytes,
          width: current.request.width,
          height: current.request.height,
        }));
      }
      executeWrite(ENTITY, 'completed', () => transition.run({
        operationUid,
        state: 'succeeded',
        batchUid,
        errorCode: null,
      }));
      const completed = get(operationUid);
      if (completed.state !== 'succeeded' || completed.batchUid !== batchUid
        || completed.errorCode !== null || completed.items.length !== 4) {
        dataError('completion');
      }
      return completed;
    },

    fail(operationUid, errorCode) {
      if (errorCode !== 'CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID'
        && errorCode !== 'CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE') {
        throw new TypeError('Character candidate execution error code is invalid');
      }
      return requireTransition(operationUid, 'failed', errorCode, null);
    },

    get,
    getCharacterSource,

    markUnknown(operationUid) {
      return requireTransition(
        operationUid,
        'submission_unknown',
        'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN',
        null,
      );
    },

    recoverInterrupted() {
      try { return Object.freeze({ recoveredCount: recover.run().changes }); } catch {
        dataError('recovery');
      }
    },
  });
}

module.exports = Object.freeze({ createCharacterCandidateExecutionRepository });
