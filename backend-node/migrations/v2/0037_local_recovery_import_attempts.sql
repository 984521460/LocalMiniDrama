CREATE TABLE local_recovery_import_attempts (
  operation_uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(operation_uid)='text' AND length(CAST(operation_uid AS BLOB))=36 AND
    operation_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  package_sha256 TEXT NOT NULL CHECK (
    typeof(package_sha256)='text' AND length(CAST(package_sha256 AS BLOB))=64
    AND package_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_sha256 TEXT NOT NULL CHECK (
    typeof(manifest_sha256)='text' AND length(CAST(manifest_sha256 AS BLOB))=64
    AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  remote_task_uid TEXT NOT NULL CHECK (
    typeof(remote_task_uid)='text' AND length(CAST(remote_task_uid AS BLOB))=36 AND
    remote_task_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  source_json TEXT NOT NULL CHECK (
    typeof(source_json)='text' AND length(CAST(source_json AS BLOB)) BETWEEN 2 AND 65536
    AND json_valid(source_json)
  ),
  source_sha256 TEXT NOT NULL CHECK (
    typeof(source_sha256)='text' AND length(CAST(source_sha256 AS BLOB))=64
    AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('reserved','succeeded','failed','submission_unknown')),
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'LOCAL_PACKAGE_IMPORT_INTERRUPTED',
      'LOCAL_PACKAGE_IMPORT_FAILED',
      'LOCAL_PACKAGE_IMPORT_SUBMISSION_UNKNOWN'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(attempt_count)='integer' AND attempt_count BETWEEN 1 AND 1000
  ),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000) CHECK (
    typeof(created_at_epoch_ms)='integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  updated_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000) CHECK (
    typeof(updated_at_epoch_ms)='integer' AND updated_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (updated_at_epoch_ms>=created_at_epoch_ms),
  CHECK (
    (state IN ('reserved','succeeded') AND error_code IS NULL) OR
    (state='failed' AND error_code IN ('LOCAL_PACKAGE_IMPORT_INTERRUPTED','LOCAL_PACKAGE_IMPORT_FAILED')) OR
    (state='submission_unknown' AND error_code='LOCAL_PACKAGE_IMPORT_SUBMISSION_UNKNOWN')
  ),
  UNIQUE(character_uid, package_sha256)
) WITHOUT ROWID;

INSERT INTO local_recovery_import_attempts (
  operation_uid,drama_uid,character_uid,package_sha256,manifest_sha256,
  remote_task_uid,source_json,source_sha256,state,attempt_count,
  created_at_epoch_ms,updated_at_epoch_ms
)
SELECT uid,drama_uid,character_uid,package_sha256,manifest_sha256,
       remote_task_uid,source_json,source_sha256,'succeeded',1,
       unixepoch(created_at) * 1000,unixepoch(created_at) * 1000
FROM local_recovery_packages;

CREATE INDEX idx_local_recovery_import_attempts_state
ON local_recovery_import_attempts(state, updated_at_epoch_ms, operation_uid);

CREATE TRIGGER local_recovery_import_attempts_validate_insert
BEFORE INSERT ON local_recovery_import_attempts
BEGIN
  SELECT CASE WHEN
    NEW.state<>'reserved' OR NEW.error_code IS NOT NULL OR NEW.attempt_count<>1
    OR NEW.created_at_epoch_ms<>NEW.updated_at_epoch_ms
    OR NEW.created_at_epoch_ms<>unixepoch('now') * 1000
    OR character_candidate_source_sha256(NEW.source_json) IS NULL
    OR character_candidate_source_sha256(NEW.source_json)<>NEW.source_sha256
    OR json_extract(NEW.source_json,'$.characterUid') IS NOT NEW.character_uid
    OR json_extract(NEW.source_json,'$.dramaUid') IS NOT NEW.drama_uid
    OR NOT EXISTS (
      SELECT 1 FROM narrative_results result
      WHERE result.uid=json_extract(NEW.source_json,'$.extractionResultUid')
        AND result.drama_uid=NEW.drama_uid AND result.result_type='extraction'
        AND result.status='approved'
        AND result.result_hash=json_extract(NEW.source_json,'$.extractionResultHash')
        AND result.envelope_hash=json_extract(NEW.source_json,'$.extractionEnvelopeHash')
        AND 'review:v1:' || result.current_review_uid=json_extract(NEW.source_json,'$.extractionApprovalRef')
    )
    OR NOT EXISTS (
      SELECT 1 FROM characters character JOIN dramas drama ON character.drama_id=drama.id
      WHERE character.uid=NEW.character_uid AND drama.uid=NEW.drama_uid
        AND character.deleted_at IS NULL AND drama.deleted_at IS NULL
        AND character.name=json_extract(NEW.source_json,'$.characterName')
    )
    OR EXISTS (
      SELECT 1 FROM local_recovery_packages package
      WHERE package.uid=NEW.operation_uid
        OR (package.character_uid=NEW.character_uid AND package.package_sha256=NEW.package_sha256)
    )
  THEN RAISE(ABORT,'local recovery import attempt invalid') END;
END;

CREATE TRIGGER local_recovery_packages_require_attempt
BEFORE INSERT ON local_recovery_packages
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM local_recovery_import_attempts attempt
    WHERE attempt.operation_uid=NEW.uid AND attempt.state='reserved'
      AND attempt.drama_uid=NEW.drama_uid AND attempt.character_uid=NEW.character_uid
      AND attempt.package_sha256=NEW.package_sha256
      AND attempt.manifest_sha256=NEW.manifest_sha256
      AND attempt.remote_task_uid=NEW.remote_task_uid
      AND attempt.source_json=NEW.source_json AND attempt.source_sha256=NEW.source_sha256
  ) THEN RAISE(ABORT,'local recovery package attempt missing') END;
END;

CREATE TRIGGER local_recovery_import_attempts_validate_update
BEFORE UPDATE ON local_recovery_import_attempts
WHEN
  NEW.operation_uid IS NOT OLD.operation_uid OR NEW.drama_uid IS NOT OLD.drama_uid
  OR NEW.character_uid IS NOT OLD.character_uid
  OR NEW.package_sha256 IS NOT OLD.package_sha256
  OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
  OR NEW.remote_task_uid IS NOT OLD.remote_task_uid
  OR NEW.source_json IS NOT OLD.source_json OR NEW.source_sha256 IS NOT OLD.source_sha256
  OR NEW.created_at_epoch_ms IS NOT OLD.created_at_epoch_ms
  OR NEW.updated_at_epoch_ms<>unixepoch('now') * 1000
  OR NEW.updated_at_epoch_ms<OLD.updated_at_epoch_ms
  OR NOT (
    (OLD.state='reserved' AND NEW.attempt_count=OLD.attempt_count AND (
      (NEW.state='succeeded' AND NEW.error_code IS NULL AND EXISTS (
        SELECT 1 FROM local_recovery_packages package WHERE package.uid=OLD.operation_uid
      ))
      OR (NEW.state='failed' AND NEW.error_code IN (
        'LOCAL_PACKAGE_IMPORT_INTERRUPTED','LOCAL_PACKAGE_IMPORT_FAILED'
      ))
      OR (NEW.state='submission_unknown'
        AND NEW.error_code='LOCAL_PACKAGE_IMPORT_SUBMISSION_UNKNOWN')
    ))
    OR (OLD.state='failed' AND NEW.state='reserved' AND NEW.error_code IS NULL
      AND NEW.attempt_count=OLD.attempt_count+1)
  )
BEGIN SELECT RAISE(ABORT,'local recovery import attempt transition invalid'); END;

CREATE TRIGGER local_recovery_import_attempts_reject_delete
BEFORE DELETE ON local_recovery_import_attempts
BEGIN SELECT RAISE(ABORT,'local recovery import attempts are append-only'); END;
