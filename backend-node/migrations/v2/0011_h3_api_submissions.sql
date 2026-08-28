-- Phase 7: reserve chargeable MiniMax H3 API submissions before remote side effects.

CREATE TABLE h3_api_submissions (
  operation_uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(operation_uid)='text' AND length(CAST(operation_uid AS BLOB))=36 AND
    operation_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    typeof(request_sha256)='text' AND length(CAST(request_sha256 AS BLOB))=64 AND
    request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  config_id INTEGER NOT NULL CHECK (typeof(config_id)='integer' AND config_id > 0),
  config_evidence_sha256 TEXT NOT NULL CHECK (
    typeof(config_evidence_sha256)='text' AND
    length(CAST(config_evidence_sha256 AS BLOB))=64 AND
    config_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('submitting', 'accepted', 'submission_unknown')),
  provider_task_id TEXT UNIQUE CHECK (
    provider_task_id IS NULL OR (
      typeof(provider_task_id)='text' AND
      length(CAST(provider_task_id AS BLOB)) BETWEEN 1 AND 128 AND
      provider_task_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000) CHECK (
    typeof(created_at_epoch_ms)='integer' AND
    created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  updated_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000) CHECK (
    typeof(updated_at_epoch_ms)='integer' AND
    updated_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (
    (state='accepted' AND provider_task_id IS NOT NULL) OR
    (state IN ('submitting', 'submission_unknown') AND provider_task_id IS NULL)
  )
) WITHOUT ROWID;

CREATE TRIGGER v2_h3_api_submissions_validate_insert
BEFORE INSERT ON h3_api_submissions
WHEN NEW.state<>'submitting' OR NEW.provider_task_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'H3 API submissions must begin in submitting state');
END;

CREATE TRIGGER v2_h3_api_submissions_reject_replacement
BEFORE INSERT ON h3_api_submissions
WHEN EXISTS (
  SELECT 1 FROM h3_api_submissions AS existing
  WHERE existing.operation_uid=NEW.operation_uid OR
        (NEW.provider_task_id IS NOT NULL AND existing.provider_task_id=NEW.provider_task_id)
)
BEGIN
  SELECT RAISE(ABORT, 'H3 API submissions cannot be replaced');
END;

CREATE TRIGGER v2_h3_api_submissions_validate_update
BEFORE UPDATE ON h3_api_submissions
WHEN
  NEW.operation_uid IS NOT OLD.operation_uid OR
  NEW.request_sha256 IS NOT OLD.request_sha256 OR
  NEW.config_id IS NOT OLD.config_id OR
  NEW.config_evidence_sha256 IS NOT OLD.config_evidence_sha256 OR
  NEW.created_at_epoch_ms IS NOT OLD.created_at_epoch_ms OR
  OLD.state<>'submitting' OR
  NEW.state NOT IN ('accepted', 'submission_unknown') OR
  NEW.updated_at_epoch_ms < OLD.updated_at_epoch_ms
BEGIN
  SELECT RAISE(ABORT, 'H3 API submission transition is invalid');
END;

CREATE TRIGGER v2_h3_api_submissions_reject_task_rebinding
BEFORE UPDATE ON h3_api_submissions
WHEN NEW.provider_task_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM h3_api_submissions AS existing
  WHERE existing.provider_task_id=NEW.provider_task_id
    AND existing.operation_uid<>OLD.operation_uid
)
BEGIN
  SELECT RAISE(ABORT, 'H3 API provider task identity is already reserved');
END;

CREATE TRIGGER v2_h3_api_submissions_reject_delete
BEFORE DELETE ON h3_api_submissions
BEGIN
  SELECT RAISE(ABORT, 'H3 API submissions are append-only');
END;
