'use strict';

const {
  canonicalCharacterReferencePackageExecutionRequest,
  characterReferencePackageExecutionRequestSha256,
  parseCharacterReferencePackageExecutionRequest,
} = require('../../characterCandidates/referencePackage/request');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { executeWrite } = require('./repositorySupport');

const ENTITY = 'character reference package execution';
const ERROR_CODES = new Set([
  'CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID',
  'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE',
  'CHARACTER_REFERENCE_PACKAGE_EXECUTION_CONFLICT',
  'CHARACTER_REFERENCE_PACKAGE_EXECUTION_DATA_INVALID',
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HISTORY_PAGE_SIZE = 16;

function createCharacterReferencePackageExecutionRepository(database, dependencies = {}) {
  const candidateExecutions = dependencies.characterCandidateExecutions;
  const referencePackages = dependencies.characterReferencePackages;
  if (!candidateExecutions || typeof candidateExecutions.get !== 'function'
    || typeof candidateExecutions.getHistory !== 'function'
    || !referencePackages || typeof referencePackages.get !== 'function'
    || typeof referencePackages.getHistory !== 'function') {
    throw new TypeError('Character reference package execution dependencies are invalid');
  }
  const insert = database.prepare(`
    INSERT INTO character_reference_package_executions
      (operation_uid,drama_uid,character_uid,candidate_execution_uid,candidate_uid,
       request_json,request_sha256,candidate_execution_request_sha256,
       candidate_execution_source_sha256,candidate_content_sha256,state,package_uid,error_code)
    VALUES
      (@operationUid,@dramaUid,@characterUid,@candidateExecutionUid,@candidateUid,
       @requestJson,@requestSha256,@candidateExecutionRequestSha256,
       @candidateExecutionSourceSha256,@candidateContentSha256,'reserved',NULL,NULL)
  `);
  const select = database.prepare(
    'SELECT * FROM character_reference_package_executions WHERE operation_uid=?',
  );
  const listHistoryFirst = database.prepare(`
    SELECT operation_uid,created_at_epoch_ms
    FROM character_reference_package_executions
    WHERE drama_uid=@dramaUid AND character_uid=@characterUid
    ORDER BY created_at_epoch_ms DESC,operation_uid DESC
    LIMIT 17
  `);
  const listHistoryAfter = database.prepare(`
    SELECT operation_uid,created_at_epoch_ms
    FROM character_reference_package_executions
    WHERE drama_uid=@dramaUid AND character_uid=@characterUid
      AND (created_at_epoch_ms < @cursorEpochMs
        OR (created_at_epoch_ms = @cursorEpochMs AND operation_uid < @cursorOperationUid))
    ORDER BY created_at_epoch_ms DESC,operation_uid DESC
    LIMIT 17
  `);
  const transition = database.prepare(`
    UPDATE character_reference_package_executions
    SET state=@state,package_uid=@packageUid,error_code=@errorCode,
        updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=@operationUid
  `);
  const recover = database.prepare(`
    UPDATE character_reference_package_executions
    SET state='submission_unknown',package_uid=NULL,
        error_code='CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN',
        updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE state='reserved'
  `);

  function dataError() {
    throw new V2RepositoryDataError(ENTITY, 'persisted record');
  }

  function currentCandidate(row, request, historical = false) {
    let execution;
    try {
      execution = historical
        ? candidateExecutions.getHistory(row.candidate_execution_uid)
        : candidateExecutions.get(row.candidate_execution_uid);
    } catch {
      return dataError();
    }
    if (execution.state !== 'succeeded' || execution.operationUid !== request.candidateExecutionUid
      || execution.request.dramaUid !== request.dramaUid
      || execution.request.characterUid !== request.characterUid
      || execution.requestSha256 !== row.candidate_execution_request_sha256
      || execution.sourceSha256 !== row.candidate_execution_source_sha256) dataError();
    let candidate = null;
    for (let index = 0; index < execution.items.length; index += 1) {
      if (execution.items[index].candidateUid === request.candidateUid) {
        candidate = execution.items[index];
      }
    }
    if (!candidate || candidate.contentSha256 !== row.candidate_content_sha256) dataError();
    return Object.freeze({ execution, candidate });
  }

  function map(row, historical = false) {
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    let request;
    try {
      request = parseCharacterReferencePackageExecutionRequest(JSON.parse(row.request_json));
      if (canonicalCharacterReferencePackageExecutionRequest(request) !== row.request_json) dataError();
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return dataError();
    }
    const requestSha256 = characterReferencePackageExecutionRequestSha256(request);
    if (request.operationUid !== row.operation_uid || request.dramaUid !== row.drama_uid
      || request.characterUid !== row.character_uid
      || request.candidateExecutionUid !== row.candidate_execution_uid
      || request.candidateUid !== row.candidate_uid
      || requestSha256 !== row.request_sha256
      || !SHA256.test(row.candidate_execution_request_sha256)
      || !SHA256.test(row.candidate_execution_source_sha256)
      || !SHA256.test(row.candidate_content_sha256)
      || !Number.isSafeInteger(row.created_at_epoch_ms)
      || !Number.isSafeInteger(row.updated_at_epoch_ms)
      || row.updated_at_epoch_ms < row.created_at_epoch_ms) dataError();
    const source = currentCandidate(row, request, historical);
    const candidateSourceCurrent = historical
      ? source.execution.sourceCurrent === true && source.candidate.currentVersion === true
      : true;
    let packageRecord = null;
    let packageCurrent = null;
    if (row.state === 'reserved') {
      if (row.package_uid !== null || row.error_code !== null) dataError();
    } else if (row.state === 'succeeded') {
      if (row.package_uid !== row.operation_uid || row.error_code !== null) dataError();
      try {
        if (historical) {
          const history = referencePackages.getHistory(row.package_uid);
          packageRecord = history.package;
          packageCurrent = history.current;
        } else packageRecord = referencePackages.get(row.package_uid);
      } catch { return dataError(); }
      if (packageRecord.packageUid !== row.operation_uid
        || packageRecord.characterUid !== row.character_uid
        || packageRecord.candidateUid !== row.candidate_uid) dataError();
      if (historical) {
        for (let index = 0; index < packageRecord.items.length; index += 1) {
          if (packageRecord.items[index].mediaType !== 'image/png') dataError();
        }
      }
    } else if (row.state === 'failed') {
      if (row.package_uid !== null || !ERROR_CODES.has(row.error_code)) dataError();
    } else if (row.state === 'submission_unknown') {
      if (row.package_uid !== null
        || row.error_code !== 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN') {
        dataError();
      }
    } else dataError();
    const execution = {
      schemaVersion: historical
        ? 'character-reference-package-execution-history-entry.v1'
        : 'character-reference-package-execution.v1',
      operationUid: row.operation_uid,
      request,
      requestSha256,
      candidateExecutionRequestSha256: row.candidate_execution_request_sha256,
      candidateExecutionSourceSha256: row.candidate_execution_source_sha256,
      candidateContentSha256: row.candidate_content_sha256,
      state: row.state,
      packageUid: row.package_uid,
      errorCode: row.error_code,
      createdAtEpochMs: row.created_at_epoch_ms,
      updatedAtEpochMs: row.updated_at_epoch_ms,
    };
    if (historical) {
      execution.candidateSourceCurrent = candidateSourceCurrent;
      execution.packageCurrent = packageCurrent;
      execution.package = packageRecord;
    }
    return Object.freeze(execution);
  }

  function get(operationUid) {
    if (typeof operationUid !== 'string' || !UUID_V4.test(operationUid)) {
      throw new TypeError('Character reference package execution UID is invalid');
    }
    return map(select.get(operationUid));
  }

  function getHistory(operationUid) {
    if (typeof operationUid !== 'string' || !UUID_V4.test(operationUid)) {
      throw new TypeError('Character reference package execution UID is invalid');
    }
    return map(select.get(operationUid), true);
  }

  function historyCursor(value) {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length > 64) dataError();
    const match = /^([0-9]{1,15}):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(value);
    if (!match) dataError();
    const cursorEpochMs = Number(match[1]);
    if (!Number.isSafeInteger(cursorEpochMs) || cursorEpochMs < 0
      || cursorEpochMs > 253_402_300_799_999) dataError();
    return Object.freeze({ cursorEpochMs, cursorOperationUid: match[2] });
  }

  function listHistory({ dramaUid, characterUid, cursor }) {
    if (typeof dramaUid !== 'string' || !UUID_V4.test(dramaUid)
      || typeof characterUid !== 'string' || !UUID_V4.test(characterUid)) dataError();
    const parsedCursor = historyCursor(cursor);
    const rows = parsedCursor === null
      ? listHistoryFirst.all({ dramaUid, characterUid })
      : listHistoryAfter.all({ dramaUid, characterUid, ...parsedCursor });
    const entries = [];
    const count = Math.min(rows.length, HISTORY_PAGE_SIZE);
    for (let index = 0; index < count; index += 1) {
      entries[index] = map(select.get(rows[index].operation_uid), true);
    }
    const last = entries[entries.length - 1];
    const nextCursor = rows.length > HISTORY_PAGE_SIZE
      ? `${last.createdAtEpochMs}:${last.operationUid}`
      : null;
    return Object.freeze({
      schemaVersion: 'character-reference-package-execution-history-page.v1',
      dramaUid,
      characterUid,
      entries: Object.freeze(entries),
      nextCursor,
    });
  }

  function requireTransition(operationUid, state, packageUid, errorCode) {
    const current = get(operationUid);
    if (current.state !== 'reserved') {
      if (current.state === state && current.packageUid === packageUid
        && current.errorCode === errorCode) return current;
      throw new V2RepositoryConflictError(ENTITY, 'transitioned');
    }
    executeWrite(ENTITY, 'transitioned', () => transition.run({
      operationUid, state, packageUid, errorCode,
    }));
    const updated = get(operationUid);
    if (updated.state !== state || updated.packageUid !== packageUid
      || updated.errorCode !== errorCode) dataError();
    return updated;
  }

  return Object.freeze({
    reserve(value) {
      if (!value || typeof value !== 'object') {
        throw new TypeError('Character reference package reservation is invalid');
      }
      const request = parseCharacterReferencePackageExecutionRequest(value.request);
      const requestJson = canonicalCharacterReferencePackageExecutionRequest(request);
      const requestSha256 = characterReferencePackageExecutionRequestSha256(request);
      const execution = value.candidateExecution;
      const candidate = value.candidate;
      if (!execution || execution.state !== 'succeeded'
        || execution.operationUid !== request.candidateExecutionUid
        || execution.request.dramaUid !== request.dramaUid
        || execution.request.characterUid !== request.characterUid
        || !candidate || candidate.uid !== request.candidateUid
        || !SHA256.test(execution.requestSha256) || !SHA256.test(execution.sourceSha256)
        || !SHA256.test(candidate.contentSha256)) {
        throw new TypeError('Character reference package reservation is invalid');
      }
      const values = {
        operationUid: request.operationUid,
        dramaUid: request.dramaUid,
        characterUid: request.characterUid,
        candidateExecutionUid: request.candidateExecutionUid,
        candidateUid: request.candidateUid,
        requestJson,
        requestSha256,
        candidateExecutionRequestSha256: execution.requestSha256,
        candidateExecutionSourceSha256: execution.sourceSha256,
        candidateContentSha256: candidate.contentSha256,
      };
      try { insert.run(values); } catch {
        let existing;
        try { existing = get(request.operationUid); } catch {
          throw new V2RepositoryConflictError(ENTITY, 'reserved');
        }
        if (existing.requestSha256 !== requestSha256
          || existing.candidateExecutionRequestSha256 !== execution.requestSha256
          || existing.candidateExecutionSourceSha256 !== execution.sourceSha256
          || existing.candidateContentSha256 !== candidate.contentSha256) {
          throw new V2RepositoryConflictError(ENTITY, 'reserved');
        }
        return Object.freeze({ created: false, execution: existing });
      }
      return Object.freeze({ created: true, execution: get(request.operationUid) });
    },

    complete(operationUid, packageUid) {
      if (operationUid !== packageUid) {
        throw new TypeError('Character reference package completion is invalid');
      }
      return requireTransition(operationUid, 'succeeded', packageUid, null);
    },

    fail(operationUid, errorCode) {
      if (!ERROR_CODES.has(errorCode)) {
        throw new TypeError('Character reference package execution error is invalid');
      }
      return requireTransition(operationUid, 'failed', null, errorCode);
    },

    get,
    getHistory,
    listHistory,

    markUnknown(operationUid) {
      return requireTransition(
        operationUid,
        'submission_unknown',
        null,
        'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN',
      );
    },

    recoverInterrupted() {
      try { return Object.freeze({ recoveredCount: recover.run().changes }); } catch {
        return dataError();
      }
    },
  });
}

module.exports = Object.freeze({ createCharacterReferencePackageExecutionRepository });
