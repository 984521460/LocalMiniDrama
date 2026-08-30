'use strict';

const { sha256, uid } = require('./contract');
const { fail } = require('./errors');

const CODE = 'H3_API_REQUEST_INVALID';
const STATES = Object.freeze(new Set(['submitting', 'accepted', 'submission_unknown']));
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function mapRow(row) {
  if (!row || typeof row !== 'object' || !STATES.has(row.state)
    || !Number.isSafeInteger(row.config_id) || row.config_id < 1
    || !Number.isSafeInteger(row.created_at_epoch_ms)
    || !Number.isSafeInteger(row.updated_at_epoch_ms)) fail('H3_API_UNAVAILABLE');
  const operationUid = uid(row.operation_uid, 'H3_API_UNAVAILABLE');
  const requestSha256 = sha256(row.request_sha256, 'H3_API_UNAVAILABLE');
  const configEvidenceSha256 = sha256(row.config_evidence_sha256, 'H3_API_UNAVAILABLE');
  const providerTaskId = row.provider_task_id;
  if ((row.state === 'accepted') !== (typeof providerTaskId === 'string')
    || (providerTaskId !== null && !TASK_ID.test(providerTaskId))) fail('H3_API_UNAVAILABLE');
  return Object.freeze({
    operationUid,
    requestSha256,
    configId: row.config_id,
    configEvidenceSha256,
    state: row.state,
    providerTaskId,
    createdAtEpochMs: row.created_at_epoch_ms,
    updatedAtEpochMs: row.updated_at_epoch_ms,
  });
}

function createH3ApiSubmissionStore(database) {
  const getRow = database.prepare('SELECT * FROM h3_api_submissions WHERE operation_uid=?');
  const getByTaskRow = database.prepare('SELECT * FROM h3_api_submissions WHERE provider_task_id=?');
  const insert = database.prepare(`
    INSERT INTO h3_api_submissions
      (operation_uid, request_sha256, config_id, config_evidence_sha256, state)
    VALUES (?, ?, ?, ?, 'submitting')
  `);
  const accept = database.prepare(`
    UPDATE h3_api_submissions
    SET state='accepted', provider_task_id=?, updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=? AND state='submitting' AND request_sha256=?
      AND config_evidence_sha256=?
  `);
  const markUnknown = database.prepare(`
    UPDATE h3_api_submissions
    SET state='submission_unknown', updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=? AND state='submitting' AND request_sha256=?
      AND config_evidence_sha256=?
  `);
  const recoverInterrupted = database.prepare(`
    UPDATE h3_api_submissions
    SET state='submission_unknown', updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE state='submitting'
  `);

  function get(operationUid) {
    const row = getRow.get(uid(operationUid, CODE));
    return row ? mapRow(row) : null;
  }

  return Object.freeze({
    reserve({ operationUid, requestSha256, configId, configEvidenceSha256 }) {
      const identity = {
        operationUid: uid(operationUid, CODE),
        requestSha256: sha256(requestSha256, CODE),
        configId,
        configEvidenceSha256: sha256(configEvidenceSha256, CODE),
      };
      if (!Number.isSafeInteger(configId) || configId < 1) fail(CODE);
      const existing = get(identity.operationUid);
      if (existing) return Object.freeze({ created: false, submission: existing });
      try {
        insert.run(
          identity.operationUid,
          identity.requestSha256,
          identity.configId,
          identity.configEvidenceSha256,
        );
      } catch {
        const raced = get(identity.operationUid);
        if (!raced) fail('H3_API_UNAVAILABLE');
        return Object.freeze({ created: false, submission: raced });
      }
      return Object.freeze({ created: true, submission: get(identity.operationUid) });
    },

    accept(operationUid, requestSha256, configEvidenceSha256, providerTaskId) {
      if (typeof providerTaskId !== 'string' || !TASK_ID.test(providerTaskId)) {
        fail('H3_API_RESPONSE_INVALID');
      }
      let result;
      try {
        result = accept.run(
          providerTaskId,
          uid(operationUid, CODE),
          sha256(requestSha256, CODE),
          sha256(configEvidenceSha256, CODE),
        );
      } catch {
        fail('H3_API_SUBMISSION_UNKNOWN');
      }
      if (result.changes !== 1) fail('H3_API_SUBMISSION_UNKNOWN');
      return get(operationUid);
    },

    markUnknown(operationUid, requestSha256, configEvidenceSha256) {
      try {
        markUnknown.run(
          uid(operationUid, CODE),
          sha256(requestSha256, CODE),
          sha256(configEvidenceSha256, CODE),
        );
      } catch {
        fail('H3_API_SUBMISSION_UNKNOWN');
      }
      return get(operationUid);
    },

    recoverInterrupted() {
      try {
        const result = recoverInterrupted.run();
        return Object.freeze({ recoveredCount: result.changes });
      } catch {
        fail('H3_API_UNAVAILABLE');
      }
    },

    getByProviderTaskId(providerTaskId) {
      if (typeof providerTaskId !== 'string' || !TASK_ID.test(providerTaskId)) fail(CODE);
      const row = getByTaskRow.get(providerTaskId);
      return row ? mapRow(row) : null;
    },
  });
}

module.exports = Object.freeze({ createH3ApiSubmissionStore });
