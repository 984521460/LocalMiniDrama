'use strict';

const {
  canonicalNarrativeExecutionRequest,
  narrativeExecutionRequestSha256,
  parseNarrativeExecutionRequestJson,
} = require('../../narrative/execution/request');
const {
  narrativeExecutionResultMatchesRequest,
} = require('../../narrative/execution/resultBinding');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { assertDatabase, executeWrite } = require('./repositorySupport');

const ENTITY = 'narrative task execution';
const ERROR_CODES = Object.freeze(new Set([
  'NARRATIVE_EXECUTION_OUTPUT_INVALID',
  'NARRATIVE_EXECUTION_PROVIDER_FAILED',
  'NARRATIVE_EXECUTION_SOURCE_STALE',
  'NARRATIVE_EXECUTION_SUBMISSION_UNKNOWN',
]));
const EXECUTION_STATES = Object.freeze(new Set([
  'reserved', 'succeeded', 'failed', 'submission_unknown',
]));
const RESULT_STATES = Object.freeze(new Set([
  'pending_review', 'approved', 'rejected', 'stale',
]));
const SET_HAS = Set.prototype.has;
const SHA256 = /^[0-9a-f]{64}$/u;

function epoch(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) {
    throw new V2RepositoryDataError(ENTITY, 'epoch');
  }
  return value;
}

function createNarrativeExecutionRepository(database) {
  assertDatabase(database);
  const select = database.prepare(`
    SELECT execution.*,
      result.drama_uid AS result_drama_uid,
      result.source_selection_uid AS result_selection_uid,
      result.result_type AS persisted_result_type,
      result.upstream_result_uid AS result_upstream_uid,
      result.status AS result_status,
      result.current_review_uid AS result_review_uid,
      result.result_json AS persisted_result_json,
      result.input_hash AS persisted_input_hash,
      result.result_hash AS persisted_result_hash,
      result.envelope_hash AS persisted_envelope_hash,
      upstream.result_hash AS persisted_upstream_result_hash,
      upstream.envelope_hash AS persisted_upstream_envelope_hash,
      upstream.result_json AS persisted_upstream_result_json,
      upstream_review.result_uid AS upstream_review_result_uid,
      upstream_review.decision AS upstream_review_decision,
      upstream_review.result_hash AS upstream_review_result_hash,
      upstream_review.envelope_hash AS upstream_review_envelope_hash
    FROM narrative_task_executions AS execution
    LEFT JOIN narrative_results AS result ON result.uid=execution.result_uid
    LEFT JOIN narrative_results AS upstream ON upstream.uid=execution.upstream_result_uid
    LEFT JOIN narrative_review_events AS upstream_review
      ON upstream_review.uid=execution.upstream_review_uid
    WHERE execution.operation_uid=?
  `);
  const insert = database.prepare(`
    INSERT INTO narrative_task_executions
      (operation_uid, drama_uid, source_selection_uid, result_type,
       upstream_result_uid, upstream_result_hash, upstream_envelope_hash,
       upstream_review_uid, request_json, request_sha256, expected_input_hash, state)
    VALUES
      (@operationUid, @dramaUid, @sourceSelectionUid, @resultType,
       @upstreamResultUid, @upstreamResultHash, @upstreamEnvelopeHash,
       @upstreamReviewUid, @requestJson, @requestSha256, @expectedInputHash, 'reserved')
  `);
  const transition = database.prepare(`
    UPDATE narrative_task_executions
    SET state=@state, result_uid=@resultUid, error_code=@errorCode,
        updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=@operationUid AND state='reserved'
  `);
  const recover = database.prepare(`
    UPDATE narrative_task_executions
    SET state='submission_unknown',
        error_code='NARRATIVE_EXECUTION_SUBMISSION_UNKNOWN',
        updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE state='reserved'
  `);

  function map(row) {
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    let request;
    try { request = parseNarrativeExecutionRequestJson(row.request_json); } catch {
      throw new V2RepositoryDataError(ENTITY, 'request');
    }
    const requestSha256 = narrativeExecutionRequestSha256(request);
    if (request.operationUid !== row.operation_uid
      || request.dramaUid !== row.drama_uid
      || request.sourceSelectionUid !== row.source_selection_uid
      || request.resultType !== row.result_type
      || request.upstreamResultUid !== row.upstream_result_uid
      || request.upstreamResultHash !== row.upstream_result_hash
      || request.upstreamEnvelopeHash !== row.upstream_envelope_hash
      || (request.upstreamApprovalRef === null ? null
        : request.upstreamApprovalRef.slice('review:v1:'.length)) !== row.upstream_review_uid
      || requestSha256 !== row.request_sha256
      || typeof row.expected_input_hash !== 'string'
      || !SHA256.test(row.expected_input_hash)
      || !Reflect.apply(SET_HAS, EXECUTION_STATES, [row.state])) {
      throw new V2RepositoryDataError(ENTITY, 'binding');
    }
    if (request.upstreamResultUid === null) {
      if (row.persisted_upstream_result_hash !== null
        || row.persisted_upstream_envelope_hash !== null
        || row.upstream_review_result_uid !== null) {
        throw new V2RepositoryDataError(ENTITY, 'upstream');
      }
    } else if (row.persisted_upstream_result_hash !== request.upstreamResultHash
      || row.persisted_upstream_envelope_hash !== request.upstreamEnvelopeHash
      || row.upstream_review_result_uid !== request.upstreamResultUid
      || row.upstream_review_decision !== 'approve'
      || row.upstream_review_result_hash !== request.upstreamResultHash
      || row.upstream_review_envelope_hash !== request.upstreamEnvelopeHash) {
      throw new V2RepositoryDataError(ENTITY, 'upstream');
    }
    const createdAtEpochMs = epoch(row.created_at_epoch_ms);
    const updatedAtEpochMs = epoch(row.updated_at_epoch_ms);
    if (updatedAtEpochMs < createdAtEpochMs) {
      throw new V2RepositoryDataError(ENTITY, 'time');
    }
    if (row.state === 'succeeded') {
      if (typeof row.result_uid !== 'string'
        || row.error_code !== null
        || row.result_drama_uid !== row.drama_uid
        || row.result_selection_uid !== row.source_selection_uid
        || row.persisted_result_type !== row.result_type
        || row.result_upstream_uid !== row.upstream_result_uid
        || !narrativeExecutionResultMatchesRequest({
          requestJson: row.request_json,
          resultType: row.persisted_result_type,
          resultJson: row.persisted_result_json,
          expectedInputHash: row.expected_input_hash,
          inputHash: row.persisted_input_hash,
          resultHash: row.persisted_result_hash,
          envelopeHash: row.persisted_envelope_hash,
          upstreamResultJson: row.persisted_upstream_result_json,
        })
        || !Reflect.apply(SET_HAS, RESULT_STATES, [row.result_status])) {
        throw new V2RepositoryDataError(ENTITY, 'result');
      }
    } else if (row.result_uid !== null) {
      throw new V2RepositoryDataError(ENTITY, 'result');
    }
    if (row.state === 'reserved') {
      if (row.error_code !== null) throw new V2RepositoryDataError(ENTITY, 'state');
    } else if (row.state === 'failed') {
      if (!Reflect.apply(SET_HAS, ERROR_CODES, [row.error_code])
        || row.error_code === 'NARRATIVE_EXECUTION_SUBMISSION_UNKNOWN') {
        throw new V2RepositoryDataError(ENTITY, 'state');
      }
    } else if (row.state === 'submission_unknown') {
      if (row.error_code !== 'NARRATIVE_EXECUTION_SUBMISSION_UNKNOWN') {
        throw new V2RepositoryDataError(ENTITY, 'state');
      }
    } else if (row.error_code !== null) {
      throw new V2RepositoryDataError(ENTITY, 'state');
    }
    return Object.freeze({
      schemaVersion: 'narrative-task-execution.v1',
      operationUid: request.operationUid,
      requestSha256,
      request,
      expectedInputHash: row.expected_input_hash,
      state: row.state,
      resultUid: row.result_uid,
      errorCode: row.error_code,
      createdAtEpochMs,
      updatedAtEpochMs,
    });
  }

  function get(operationUid) {
    return map(select.get(operationUid));
  }

  function requireTransition(operationUid, state, errorCode, resultUid) {
    const current = get(operationUid);
    if (current.state !== 'reserved') {
      if (current.state === state && current.errorCode === errorCode
        && current.resultUid === resultUid) return current;
      throw new V2RepositoryConflictError(ENTITY, 'transitioned');
    }
    executeWrite(ENTITY, 'transitioned', () => transition.run({
      operationUid,
      state,
      resultUid,
      errorCode,
    }));
    const updated = get(operationUid);
    if (updated.state !== state || updated.errorCode !== errorCode
      || updated.resultUid !== resultUid) {
      throw new V2RepositoryDataError(ENTITY, 'transition');
    }
    return updated;
  }

  return Object.freeze({
    reserve(request, expectedInputHash) {
      if (typeof expectedInputHash !== 'string' || !SHA256.test(expectedInputHash)) {
        throw new TypeError('Narrative task execution input hash is invalid');
      }
      const requestJson = canonicalNarrativeExecutionRequest(request);
      const requestSha256 = narrativeExecutionRequestSha256(request);
      const values = {
        operationUid: request.operationUid,
        dramaUid: request.dramaUid,
        sourceSelectionUid: request.sourceSelectionUid,
        resultType: request.resultType,
        upstreamResultUid: request.upstreamResultUid,
        upstreamResultHash: request.upstreamResultHash,
        upstreamEnvelopeHash: request.upstreamEnvelopeHash,
        upstreamReviewUid: request.upstreamApprovalRef === null
          ? null : request.upstreamApprovalRef.slice('review:v1:'.length),
        requestJson,
        requestSha256,
        expectedInputHash,
      };
      try {
        insert.run(values);
      } catch {
        let existing;
        try { existing = get(request.operationUid); } catch {
          throw new V2RepositoryConflictError(ENTITY, 'reserved');
        }
        if (existing.requestSha256 !== requestSha256
          || existing.expectedInputHash !== expectedInputHash
          || canonicalNarrativeExecutionRequest(existing.request) !== requestJson) {
          throw new V2RepositoryConflictError(ENTITY, 'reserved');
        }
        return Object.freeze({ created: false, execution: existing });
      }
      return Object.freeze({ created: true, execution: get(request.operationUid) });
    },

    complete(operationUid, resultUid) {
      return requireTransition(operationUid, 'succeeded', null, resultUid);
    },

    fail(operationUid, errorCode) {
      if (errorCode !== 'NARRATIVE_EXECUTION_OUTPUT_INVALID'
        && errorCode !== 'NARRATIVE_EXECUTION_PROVIDER_FAILED'
        && errorCode !== 'NARRATIVE_EXECUTION_SOURCE_STALE') {
        throw new TypeError('Narrative task execution error code is invalid');
      }
      return requireTransition(operationUid, 'failed', errorCode, null);
    },

    get,

    markUnknown(operationUid) {
      return requireTransition(
        operationUid,
        'submission_unknown',
        'NARRATIVE_EXECUTION_SUBMISSION_UNKNOWN',
        null,
      );
    },

    recoverInterrupted() {
      try { return Object.freeze({ recoveredCount: recover.run().changes }); } catch {
        throw new V2RepositoryDataError(ENTITY, 'recovery');
      }
    },
  });
}

module.exports = Object.freeze({ createNarrativeExecutionRepository });
