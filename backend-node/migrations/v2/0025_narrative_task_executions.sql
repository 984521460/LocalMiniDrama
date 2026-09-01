-- Phase 9 MVP closure: durable idempotency and failure classification for
-- production narrative task execution. Raw provider responses and credentials
-- are deliberately excluded; narrative_results retains only existing hashes and
-- opaque response references after full domain validation.

CREATE TABLE narrative_task_executions (
  operation_uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(operation_uid)='text'
    AND length(CAST(operation_uid AS BLOB))=36
    AND operation_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  drama_uid TEXT NOT NULL,
  source_selection_uid TEXT NOT NULL REFERENCES source_selections(uid),
  result_type TEXT NOT NULL CHECK (result_type IN ('extraction','adaptation','script','shot')),
  upstream_result_uid TEXT REFERENCES narrative_results(uid),
  upstream_result_hash TEXT CHECK (
    upstream_result_hash IS NULL OR (
      typeof(upstream_result_hash)='text'
      AND length(CAST(upstream_result_hash AS BLOB))=64
      AND upstream_result_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  upstream_envelope_hash TEXT CHECK (
    upstream_envelope_hash IS NULL OR (
      typeof(upstream_envelope_hash)='text'
      AND length(CAST(upstream_envelope_hash AS BLOB))=64
      AND upstream_envelope_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  upstream_review_uid TEXT REFERENCES narrative_review_events(uid),
  request_json TEXT NOT NULL CHECK (
    typeof(request_json)='text'
    AND length(CAST(request_json AS BLOB)) BETWEEN 2 AND 65536
    AND json_valid(request_json)
  ),
  request_sha256 TEXT NOT NULL CHECK (
    typeof(request_sha256)='text'
    AND length(CAST(request_sha256 AS BLOB))=64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  expected_input_hash TEXT NOT NULL CHECK (
    typeof(expected_input_hash)='text'
    AND length(CAST(expected_input_hash AS BLOB))=64
    AND expected_input_hash NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('reserved','succeeded','failed','submission_unknown')),
  result_uid TEXT REFERENCES narrative_results(uid),
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'NARRATIVE_EXECUTION_OUTPUT_INVALID',
      'NARRATIVE_EXECUTION_PROVIDER_FAILED',
      'NARRATIVE_EXECUTION_SOURCE_STALE',
      'NARRATIVE_EXECUTION_SUBMISSION_UNKNOWN'
    )
  ),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000) CHECK (
    typeof(created_at_epoch_ms)='integer'
    AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  updated_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000) CHECK (
    typeof(updated_at_epoch_ms)='integer'
    AND updated_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (updated_at_epoch_ms>=created_at_epoch_ms),
  CHECK (
    (result_type='extraction' AND upstream_result_uid IS NULL
      AND upstream_result_hash IS NULL AND upstream_envelope_hash IS NULL
      AND upstream_review_uid IS NULL)
    OR
    (result_type<>'extraction' AND upstream_result_uid IS NOT NULL
      AND upstream_result_hash IS NOT NULL AND upstream_envelope_hash IS NOT NULL
      AND upstream_review_uid IS NOT NULL)
  ),
  CHECK (
    (state='succeeded' AND result_uid IS NOT NULL AND error_code IS NULL)
    OR
    (state='reserved' AND result_uid IS NULL AND error_code IS NULL)
    OR
    (state='failed' AND result_uid IS NULL AND error_code IN (
      'NARRATIVE_EXECUTION_OUTPUT_INVALID','NARRATIVE_EXECUTION_PROVIDER_FAILED',
      'NARRATIVE_EXECUTION_SOURCE_STALE'
    ))
    OR
    (state='submission_unknown' AND result_uid IS NULL
      AND error_code='NARRATIVE_EXECUTION_SUBMISSION_UNKNOWN')
  )
) WITHOUT ROWID;

CREATE INDEX idx_narrative_task_executions_source
ON narrative_task_executions(drama_uid, source_selection_uid, result_type, created_at_epoch_ms, operation_uid);

CREATE TRIGGER v2_narrative_task_executions_validate_insert
BEFORE INSERT ON narrative_task_executions
BEGIN
  SELECT CASE WHEN
    NEW.state<>'reserved'
    OR NEW.result_uid IS NOT NULL
    OR NEW.error_code IS NOT NULL
    OR NEW.created_at_epoch_ms<>NEW.updated_at_epoch_ms
    OR NEW.created_at_epoch_ms<>unixepoch('now') * 1000
    OR narrative_execution_request_sha256(NEW.request_json) IS NULL
    OR narrative_execution_request_sha256(NEW.request_json)<>NEW.request_sha256
    OR json_extract(NEW.request_json,'$.operationUid') IS NOT NEW.operation_uid
    OR json_extract(NEW.request_json,'$.dramaUid') IS NOT NEW.drama_uid
    OR json_extract(NEW.request_json,'$.sourceSelectionUid') IS NOT NEW.source_selection_uid
    OR json_extract(NEW.request_json,'$.resultType') IS NOT NEW.result_type
    OR json_extract(NEW.request_json,'$.upstreamResultUid') IS NOT NEW.upstream_result_uid
    OR json_extract(NEW.request_json,'$.upstreamResultHash') IS NOT NEW.upstream_result_hash
    OR json_extract(NEW.request_json,'$.upstreamEnvelopeHash') IS NOT NEW.upstream_envelope_hash
    OR json_extract(NEW.request_json,'$.upstreamApprovalRef')
      IS NOT CASE WHEN NEW.upstream_review_uid IS NULL
        THEN NULL ELSE 'review:v1:' || NEW.upstream_review_uid END
    OR NOT EXISTS (
      SELECT 1
      FROM source_selections AS selection
      JOIN source_documents AS document ON document.uid=selection.document_uid
      WHERE selection.uid=NEW.source_selection_uid AND document.drama_uid=NEW.drama_uid
    )
    OR (
      NEW.result_type='extraction' AND NEW.upstream_result_uid IS NOT NULL
    )
    OR (
      NEW.result_type<>'extraction' AND NOT EXISTS (
        SELECT 1
        FROM narrative_results AS upstream
        JOIN narrative_review_events AS review ON review.uid=NEW.upstream_review_uid
        WHERE upstream.uid=NEW.upstream_result_uid
          AND upstream.drama_uid=NEW.drama_uid
          AND upstream.source_selection_uid=NEW.source_selection_uid
          AND upstream.status='approved'
          AND upstream.result_hash=NEW.upstream_result_hash
          AND upstream.envelope_hash=NEW.upstream_envelope_hash
          AND upstream.current_review_uid=NEW.upstream_review_uid
          AND review.result_uid=upstream.uid
          AND review.decision='approve'
          AND review.result_hash=upstream.result_hash
          AND review.envelope_hash=upstream.envelope_hash
          AND upstream.result_type=CASE NEW.result_type
            WHEN 'adaptation' THEN 'extraction'
            WHEN 'script' THEN 'adaptation'
            WHEN 'shot' THEN 'script'
          END
      )
    )
  THEN RAISE(ABORT,'narrative task execution invalid') END;
END;

CREATE TRIGGER v2_narrative_task_executions_reject_replacement
BEFORE INSERT ON narrative_task_executions
WHEN EXISTS (
  SELECT 1 FROM narrative_task_executions WHERE operation_uid=NEW.operation_uid
)
BEGIN
  SELECT RAISE(ABORT,'narrative task executions cannot be replaced');
END;

CREATE TRIGGER v2_narrative_task_executions_validate_update
BEFORE UPDATE ON narrative_task_executions
WHEN
  OLD.state<>'reserved'
  OR NEW.operation_uid IS NOT OLD.operation_uid
  OR NEW.drama_uid IS NOT OLD.drama_uid
  OR NEW.source_selection_uid IS NOT OLD.source_selection_uid
  OR NEW.result_type IS NOT OLD.result_type
  OR NEW.upstream_result_uid IS NOT OLD.upstream_result_uid
  OR NEW.upstream_result_hash IS NOT OLD.upstream_result_hash
  OR NEW.upstream_envelope_hash IS NOT OLD.upstream_envelope_hash
  OR NEW.upstream_review_uid IS NOT OLD.upstream_review_uid
  OR NEW.request_json IS NOT OLD.request_json
  OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.expected_input_hash IS NOT OLD.expected_input_hash
  OR NEW.created_at_epoch_ms IS NOT OLD.created_at_epoch_ms
  OR NEW.updated_at_epoch_ms<OLD.updated_at_epoch_ms
  OR NEW.updated_at_epoch_ms<>unixepoch('now') * 1000
  OR NEW.state NOT IN ('succeeded','failed','submission_unknown')
  OR (
    NEW.state='succeeded' AND NOT EXISTS (
      SELECT 1
      FROM narrative_results AS result
      LEFT JOIN narrative_results AS upstream ON upstream.uid=OLD.upstream_result_uid
      WHERE result.uid=NEW.result_uid
        AND result.drama_uid=OLD.drama_uid
        AND result.source_selection_uid=OLD.source_selection_uid
        AND result.result_type=OLD.result_type
        AND result.upstream_result_uid IS OLD.upstream_result_uid
        AND result.status='pending_review'
        AND result.current_review_uid IS NULL
        AND narrative_execution_result_matches_request(
          OLD.request_json,
          result.result_type,
          result.result_json,
          OLD.expected_input_hash,
          result.input_hash,
          result.result_hash,
          result.envelope_hash,
          upstream.result_json
        )=1
    )
  )
BEGIN
  SELECT RAISE(ABORT,'narrative task execution transition invalid');
END;

CREATE TRIGGER v2_narrative_task_executions_reject_delete
BEFORE DELETE ON narrative_task_executions
BEGIN
  SELECT RAISE(ABORT,'narrative task executions are append-only');
END;
