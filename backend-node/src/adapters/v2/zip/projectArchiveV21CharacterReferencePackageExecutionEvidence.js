'use strict';

const {
  canonicalCharacterReferencePackageExecutionRequest,
  characterReferencePackageExecutionRequestSha256,
  parseCharacterReferencePackageExecutionRequest,
} = require('../../../characterCandidates/referencePackage/request');

const FAILURE_CODES = new Set([
  'CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID',
  'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE',
  'CHARACTER_REFERENCE_PACKAGE_EXECUTION_CONFLICT',
  'CHARACTER_REFERENCE_PACKAGE_EXECUTION_DATA_INVALID',
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const JSON_PARSE = JSON.parse;
const REFLECT_APPLY = Reflect.apply;

function fail(invalid) {
  invalid();
}

function indexBy(rows, key, invalid) {
  const result = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const identity = rows[index][key];
    if (result.has(identity)) fail(invalid);
    result.set(identity, rows[index]);
  }
  return result;
}

function assertState(row, packages, invalid) {
  if (row.state === 'reserved') {
    if (row.package_uid !== null || row.error_code !== null) fail(invalid);
    return;
  }
  if (row.state === 'succeeded') {
    const packageRecord = packages.get(row.package_uid);
    if (row.package_uid !== row.operation_uid || row.error_code !== null
      || !packageRecord || packageRecord.character_uid !== row.character_uid
      || packageRecord.candidate_uid !== row.candidate_uid) fail(invalid);
    return;
  }
  if (row.state === 'failed') {
    if (row.package_uid !== null || !FAILURE_CODES.has(row.error_code)) fail(invalid);
    return;
  }
  if (row.state === 'submission_unknown') {
    if (row.package_uid !== null
      || row.error_code !== 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN') {
      fail(invalid);
    }
    return;
  }
  fail(invalid);
}

function assertProjectArchiveV21CharacterReferencePackageExecutionStructured(records, invalid) {
  const candidateExecutions = indexBy(
    records.characterCandidateExecutions,
    'operation_uid',
    invalid,
  );
  const candidates = indexBy(records.characterCandidateResults, 'uid', invalid);
  const packages = indexBy(records.characterReferencePackages, 'uid', invalid);
  for (let index = 0;
    index < records.characterReferencePackageExecutions.length;
    index += 1) {
    const row = records.characterReferencePackageExecutions[index];
    let request;
    try {
      if (typeof row.request_json !== 'string') fail(invalid);
      request = parseCharacterReferencePackageExecutionRequest(
        REFLECT_APPLY(JSON_PARSE, JSON, [row.request_json]),
      );
    } catch {
      return fail(invalid);
    }
    const execution = candidateExecutions.get(row.candidate_execution_uid);
    const candidate = candidates.get(row.candidate_uid);
    if (request.operationUid !== row.operation_uid || request.dramaUid !== row.drama_uid
      || request.characterUid !== row.character_uid
      || request.candidateExecutionUid !== row.candidate_execution_uid
      || request.candidateUid !== row.candidate_uid
      || canonicalCharacterReferencePackageExecutionRequest(request) !== row.request_json
      || characterReferencePackageExecutionRequestSha256(request) !== row.request_sha256
      || !SHA256.test(row.candidate_execution_request_sha256)
      || !SHA256.test(row.candidate_execution_source_sha256)
      || !SHA256.test(row.candidate_content_sha256)
      || !Number.isSafeInteger(row.created_at_epoch_ms)
      || !Number.isSafeInteger(row.updated_at_epoch_ms)
      || row.updated_at_epoch_ms < row.created_at_epoch_ms
      || !execution || execution.state !== 'succeeded'
      || execution.batch_uid !== execution.operation_uid
      || execution.request_sha256 !== row.candidate_execution_request_sha256
      || execution.source_sha256 !== row.candidate_execution_source_sha256
      || execution.drama_uid !== row.drama_uid
      || execution.character_uid !== row.character_uid
      || !candidate || candidate.batch_uid !== row.candidate_execution_uid
      || candidate.character_uid !== row.character_uid
      || candidate.content_sha256 !== row.candidate_content_sha256) fail(invalid);
    assertState(row, packages, invalid);
  }
}

module.exports = Object.freeze({
  assertProjectArchiveV21CharacterReferencePackageExecutionStructured,
});
