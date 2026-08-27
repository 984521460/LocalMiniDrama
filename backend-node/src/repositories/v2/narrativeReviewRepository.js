const { executeWrite, requiredRow } = require('./repositorySupport');
const { mapRow, mapRows, serializeJson } = require('./rowMapping');
const { V2RepositoryConflictError, V2RepositoryDataError } = require('./errors');

const RESULT_MAP = Object.freeze({
  entity: 'narrative result',
  jsonFields: Object.freeze({ result_json: 'result' }),
  jsonKinds: Object.freeze({ result_json: 'object' }),
});
const REVIEW_MAP = Object.freeze({ entity: 'narrative review event' });
const STALE_EVENT_MAP = Object.freeze({ entity: 'narrative stale event' });

function createNarrativeReviewRepository(database) {
  const insertResult = database.prepare(`
    INSERT INTO narrative_results
      (uid, drama_uid, source_selection_uid, result_type, task_type, schema_version,
       input_hash, result_hash, envelope_hash, result_json, upstream_result_uid)
    VALUES
      (@uid, @dramaUid, @sourceSelectionUid, @resultType, @taskType, @schemaVersion,
       @inputHash, @resultHash, @envelopeHash, @resultJson, @upstreamResultUid)
  `);
  const getResultRow = database.prepare('SELECT * FROM narrative_results WHERE uid = ?');
  const listDramaRows = database.prepare(`
    SELECT * FROM narrative_results
    WHERE drama_uid = ?
    ORDER BY CASE result_type
      WHEN 'extraction' THEN 1 WHEN 'adaptation' THEN 2 WHEN 'script' THEN 3 ELSE 4 END,
      created_at, uid
  `);
  const listSelectionRows = database.prepare(`
    SELECT * FROM narrative_results
    WHERE source_selection_uid = ?
    ORDER BY CASE result_type
      WHEN 'extraction' THEN 1 WHEN 'adaptation' THEN 2 WHEN 'script' THEN 3 ELSE 4 END,
      created_at, uid
  `);
  const insertReview = database.prepare(`
    INSERT INTO narrative_review_events
      (uid, result_uid, decision, result_hash, envelope_hash, comment)
    VALUES
      (@uid, @resultUid, @decision, @resultHash, @envelopeHash, @comment)
  `);
  const updateReviewState = database.prepare(`
    UPDATE narrative_results
    SET status = @status,
        current_review_uid = @reviewUid,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @resultUid AND status <> 'stale'
  `);
  const getReviewRow = database.prepare('SELECT * FROM narrative_review_events WHERE uid = ?');
  const listReviewRows = database.prepare(`
    SELECT * FROM narrative_review_events WHERE result_uid = ? ORDER BY created_at, uid
  `);
  const listStaleEventRows = database.prepare(`
    SELECT * FROM narrative_stale_events WHERE result_uid = ? ORDER BY staled_at_epoch_ms, uid
  `);
  const listOperationEventRows = database.prepare(`
    SELECT * FROM narrative_stale_events WHERE operation_uid = ? ORDER BY result_uid
  `);
  const staleOperationExists = database.prepare(`
    SELECT 1 FROM narrative_stale_events WHERE operation_uid = ? LIMIT 1
  `);
  const candidateRows = Object.freeze({
    source_document: database.prepare(`
      SELECT result.uid
      FROM narrative_results AS result
      JOIN source_selections AS selection ON selection.uid = result.source_selection_uid
      WHERE selection.document_uid = @rootUid AND result.status <> 'stale'
      ORDER BY result.uid
    `),
    source_selection: database.prepare(`
      SELECT uid FROM narrative_results
      WHERE source_selection_uid = @rootUid AND status <> 'stale'
      ORDER BY uid
    `),
    narrative_result: database.prepare(`
      WITH RECURSIVE dependents(uid) AS (
        SELECT uid FROM narrative_results WHERE uid = @rootUid
        UNION
        SELECT child.uid
        FROM narrative_results AS child
        JOIN dependents AS parent ON child.upstream_result_uid = parent.uid
      )
      SELECT result.uid
      FROM narrative_results AS result
      JOIN dependents ON dependents.uid = result.uid
      WHERE result.status <> 'stale'
      ORDER BY result.uid
    `),
  });
  const invalidateRows = Object.freeze({
    source_document: database.prepare(`
      UPDATE narrative_results
      SET status = 'stale', current_review_uid = NULL,
          stale_operation_uid = @operationUid, stale_reason_code = @reasonCode,
          stale_root_kind = @rootKind, stale_root_uid = @rootUid,
          staled_at_epoch_ms = @staledAtEpochMs,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', @staledAtEpochMs / 1000.0, 'unixepoch')
      WHERE status <> 'stale' AND source_selection_uid IN (
        SELECT uid FROM source_selections WHERE document_uid = @rootUid
      )
    `),
    source_selection: database.prepare(`
      UPDATE narrative_results
      SET status = 'stale', current_review_uid = NULL,
          stale_operation_uid = @operationUid, stale_reason_code = @reasonCode,
          stale_root_kind = @rootKind, stale_root_uid = @rootUid,
          staled_at_epoch_ms = @staledAtEpochMs,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', @staledAtEpochMs / 1000.0, 'unixepoch')
      WHERE status <> 'stale' AND source_selection_uid = @rootUid
    `),
    narrative_result: database.prepare(`
      UPDATE narrative_results
      SET status = 'stale', current_review_uid = NULL,
          stale_operation_uid = @operationUid, stale_reason_code = @reasonCode,
          stale_root_kind = @rootKind, stale_root_uid = @rootUid,
          staled_at_epoch_ms = @staledAtEpochMs,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', @staledAtEpochMs / 1000.0, 'unixepoch')
      WHERE status <> 'stale' AND uid IN (
        WITH RECURSIVE dependents(uid) AS (
          SELECT uid FROM narrative_results WHERE uid = @rootUid
          UNION
          SELECT child.uid
          FROM narrative_results AS child
          JOIN dependents AS parent ON child.upstream_result_uid = parent.uid
        )
        SELECT uid FROM dependents
      )
    `),
  });

  const invalidateTransaction = database.transaction((input) => {
    if (staleOperationExists.get(input.operationUid)) {
      throw new V2RepositoryConflictError('narrative staleness operation', 'created');
    }
    const expected = candidateRows[input.rootKind].all(input).map((row) => row.uid);
    invalidateRows[input.rootKind].run(input);
    const events = mapRows(listOperationEventRows.all(input.operationUid), STALE_EVENT_MAP);
    const actual = events.map((event) => event.resultUid);
    if (expected.length !== actual.length
      || expected.some((uid, index) => uid !== actual[index])) {
      throw new V2RepositoryDataError('narrative staleness operation', 'audit events');
    }
    return Object.freeze({
      affectedResultUids: Object.freeze(expected),
      events,
    });
  });

  const reviewTransaction = database.transaction((input) => {
    insertReview.run(input);
    const updated = updateReviewState.run({
      resultUid: input.resultUid,
      reviewUid: input.uid,
      status: input.decision === 'approve' ? 'approved' : 'rejected',
    });
    if (updated.changes !== 1) throw new Error('NARRATIVE_REVIEW_STATE_CONFLICT');
  });

  function getResult(uid) {
    return mapRow(requiredRow(getResultRow.get(uid), 'narrative result', uid), RESULT_MAP);
  }

  function getReview(uid) {
    return mapRow(requiredRow(getReviewRow.get(uid), 'narrative review event', uid), REVIEW_MAP);
  }

  return Object.freeze({
    createResult(input) {
      executeWrite('narrative result', 'created', () => insertResult.run({
        ...input,
        resultJson: serializeJson(input.result, {}),
        upstreamResultUid: input.upstreamResultUid ?? null,
      }));
      return getResult(input.uid);
    },

    createReview(input) {
      executeWrite('narrative review event', 'created', () => reviewTransaction(input));
      return Object.freeze({
        result: getResult(input.resultUid),
        review: getReview(input.uid),
      });
    },

    getResult,
    getReview,

    listByDrama(dramaUid) {
      return mapRows(listDramaRows.all(dramaUid), RESULT_MAP);
    },

    listBySelection(selectionUid) {
      return mapRows(listSelectionRows.all(selectionUid), RESULT_MAP);
    },

    listReviews(resultUid) {
      return mapRows(listReviewRows.all(resultUid), REVIEW_MAP);
    },

    invalidate(input) {
      if (!Object.hasOwn(invalidateRows, input?.rootKind)) {
        throw new TypeError('Narrative staleness root kind is invalid');
      }
      return executeWrite(
        'narrative staleness operation',
        'created',
        () => invalidateTransaction(input),
      );
    },

    listStaleEvents(resultUid) {
      return mapRows(listStaleEventRows.all(resultUid), STALE_EVENT_MAP);
    },
  });
}

module.exports = { createNarrativeReviewRepository };
