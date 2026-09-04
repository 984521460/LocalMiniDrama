CREATE TABLE character_reference_package_executions (
  operation_uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(operation_uid)='text' AND length(CAST(operation_uid AS BLOB))=36 AND
    operation_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  drama_uid TEXT NOT NULL,
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  candidate_execution_uid TEXT NOT NULL
    REFERENCES character_candidate_executions(operation_uid) ON DELETE RESTRICT,
  candidate_uid TEXT NOT NULL REFERENCES character_candidate_results(uid) ON DELETE RESTRICT,
  request_json TEXT NOT NULL CHECK (
    typeof(request_json)='text' AND length(CAST(request_json AS BLOB)) BETWEEN 2 AND 16384
    AND json_valid(request_json)
  ),
  request_sha256 TEXT NOT NULL CHECK (
    typeof(request_sha256)='text' AND length(CAST(request_sha256 AS BLOB))=64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_execution_request_sha256 TEXT NOT NULL CHECK (
    typeof(candidate_execution_request_sha256)='text'
    AND length(CAST(candidate_execution_request_sha256 AS BLOB))=64
    AND candidate_execution_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_execution_source_sha256 TEXT NOT NULL CHECK (
    typeof(candidate_execution_source_sha256)='text'
    AND length(CAST(candidate_execution_source_sha256 AS BLOB))=64
    AND candidate_execution_source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_content_sha256 TEXT NOT NULL CHECK (
    typeof(candidate_content_sha256)='text'
    AND length(CAST(candidate_content_sha256 AS BLOB))=64
    AND candidate_content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (
    state IN ('reserved','succeeded','failed','submission_unknown')
  ),
  package_uid TEXT UNIQUE REFERENCES character_reference_packages(uid) ON DELETE RESTRICT,
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID',
      'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE',
      'CHARACTER_REFERENCE_PACKAGE_EXECUTION_CONFLICT',
      'CHARACTER_REFERENCE_PACKAGE_EXECUTION_DATA_INVALID',
      'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN'
    )
  ),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000) CHECK (
    typeof(created_at_epoch_ms)='integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  updated_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000) CHECK (
    typeof(updated_at_epoch_ms)='integer' AND updated_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (updated_at_epoch_ms>=created_at_epoch_ms),
  CHECK (
    (state='reserved' AND package_uid IS NULL AND error_code IS NULL) OR
    (state='succeeded' AND package_uid=operation_uid AND error_code IS NULL) OR
    (state='failed' AND package_uid IS NULL AND error_code IN (
      'CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID',
      'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE',
      'CHARACTER_REFERENCE_PACKAGE_EXECUTION_CONFLICT',
      'CHARACTER_REFERENCE_PACKAGE_EXECUTION_DATA_INVALID'
    )) OR
    (state='submission_unknown' AND package_uid IS NULL
      AND error_code='CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN')
  )
) WITHOUT ROWID;

CREATE INDEX idx_character_reference_package_executions_character
ON character_reference_package_executions(
  character_uid, created_at_epoch_ms, operation_uid
);

CREATE TRIGGER v2_character_reference_package_executions_validate_insert
BEFORE INSERT ON character_reference_package_executions
BEGIN
  SELECT CASE WHEN
    NEW.state<>'reserved' OR NEW.package_uid IS NOT NULL OR NEW.error_code IS NOT NULL
    OR NEW.created_at_epoch_ms<>NEW.updated_at_epoch_ms
    OR NEW.created_at_epoch_ms<>unixepoch('now') * 1000
    OR character_reference_package_execution_request_sha256(NEW.request_json) IS NULL
    OR character_reference_package_execution_request_sha256(NEW.request_json)<>NEW.request_sha256
    OR json_extract(NEW.request_json,'$.operationUid') IS NOT NEW.operation_uid
    OR json_extract(NEW.request_json,'$.dramaUid') IS NOT NEW.drama_uid
    OR json_extract(NEW.request_json,'$.characterUid') IS NOT NEW.character_uid
    OR json_extract(NEW.request_json,'$.candidateExecutionUid') IS NOT NEW.candidate_execution_uid
    OR json_extract(NEW.request_json,'$.candidateUid') IS NOT NEW.candidate_uid
    OR COALESCE((
      SELECT operation FROM character_identity_lock_events
      WHERE character_uid=NEW.character_uid ORDER BY state_version DESC LIMIT 1
    ),'unlock')<>'unlock'
    OR NOT EXISTS (
      SELECT 1
      FROM character_candidate_executions AS execution
      JOIN character_candidate_results AS result
        ON result.batch_uid=execution.batch_uid AND result.uid=NEW.candidate_uid
      JOIN asset_versions AS version ON version.uid=result.asset_version_uid
      JOIN assets AS asset ON asset.uid=result.asset_uid
      WHERE execution.operation_uid=NEW.candidate_execution_uid
        AND execution.state='succeeded' AND execution.batch_uid=execution.operation_uid
        AND execution.drama_uid=NEW.drama_uid AND execution.character_uid=NEW.character_uid
        AND execution.request_sha256=NEW.candidate_execution_request_sha256
        AND execution.source_sha256=NEW.candidate_execution_source_sha256
        AND result.character_uid=NEW.character_uid
        AND result.content_sha256=NEW.candidate_content_sha256
        AND version.asset_uid=result.asset_uid AND version.uid=result.asset_version_uid
        AND version.status='ready' AND version.sha256=result.content_sha256
        AND asset.owner_type='character' AND asset.owner_uid=NEW.character_uid
        AND asset.asset_type='character_candidate' AND asset.status='ready'
        AND asset.current_version_uid=version.uid
    )
  THEN RAISE(ABORT,'character reference package execution invalid') END;
END;

CREATE TRIGGER v2_character_reference_package_executions_reject_replacement
BEFORE INSERT ON character_reference_package_executions
WHEN EXISTS (
  SELECT 1 FROM character_reference_package_executions
  WHERE operation_uid=NEW.operation_uid
)
BEGIN
  SELECT RAISE(ABORT,'character reference package executions cannot be replaced');
END;

CREATE TRIGGER v2_character_reference_package_executions_validate_update
BEFORE UPDATE ON character_reference_package_executions
WHEN
  OLD.state<>'reserved'
  OR NEW.operation_uid IS NOT OLD.operation_uid
  OR NEW.drama_uid IS NOT OLD.drama_uid
  OR NEW.character_uid IS NOT OLD.character_uid
  OR NEW.candidate_execution_uid IS NOT OLD.candidate_execution_uid
  OR NEW.candidate_uid IS NOT OLD.candidate_uid
  OR NEW.request_json IS NOT OLD.request_json OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.candidate_execution_request_sha256 IS NOT OLD.candidate_execution_request_sha256
  OR NEW.candidate_execution_source_sha256 IS NOT OLD.candidate_execution_source_sha256
  OR NEW.candidate_content_sha256 IS NOT OLD.candidate_content_sha256
  OR NEW.created_at_epoch_ms IS NOT OLD.created_at_epoch_ms
  OR NEW.updated_at_epoch_ms<>unixepoch('now') * 1000
  OR NEW.updated_at_epoch_ms<OLD.updated_at_epoch_ms
  OR NEW.state NOT IN ('succeeded','failed','submission_unknown')
  OR (
    NEW.state='succeeded' AND (
      NEW.package_uid IS NOT OLD.operation_uid OR NEW.error_code IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM character_reference_packages AS package
        WHERE package.uid=OLD.operation_uid
          AND package.character_uid=OLD.character_uid
          AND package.candidate_uid=OLD.candidate_uid
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT,'character reference package execution transition invalid');
END;

CREATE TRIGGER v2_character_reference_package_executions_immutable_delete
BEFORE DELETE ON character_reference_package_executions
BEGIN
  SELECT RAISE(ABORT,'character reference package executions are append-only');
END;
