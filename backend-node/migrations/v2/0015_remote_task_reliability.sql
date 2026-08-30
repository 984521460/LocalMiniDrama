-- P9-02: bounded retry policy and metadata-only heartbeats for formal remote tasks.

CREATE TABLE v2_remote_task_reliability_migration_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO v2_remote_task_reliability_migration_guard (valid)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM remote_tasks
  WHERE contract_version = 'remote-task.v1' AND retry_count > 10
) THEN 0 ELSE 1 END;

DROP TABLE v2_remote_task_reliability_migration_guard;

ALTER TABLE remote_tasks ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3
  CHECK (typeof(max_retries) = 'integer' AND max_retries BETWEEN 0 AND 10);

DROP TRIGGER v2_remote_tasks_formal_terminal_immutable;
DROP TRIGGER v2_remote_tasks_formal_validate_update;

UPDATE remote_tasks
SET max_retries = retry_count
WHERE contract_version = 'remote-task.v1' AND retry_count BETWEEN 4 AND 10;

CREATE TRIGGER v2_remote_tasks_formal_max_retry_immutable
BEFORE UPDATE OF max_retries ON remote_tasks
WHEN OLD.contract_version = 'remote-task.v1' AND NEW.max_retries IS NOT OLD.max_retries
BEGIN
  SELECT RAISE(ABORT, 'formal remote task retry limit is immutable');
END;

CREATE TRIGGER v2_remote_tasks_formal_terminal_immutable
BEFORE UPDATE ON remote_tasks
WHEN OLD.contract_version = 'remote-task.v1'
  AND OLD.status IN ('succeeded', 'failed', 'cancelled')
  AND NOT (
    OLD.status = 'failed' AND OLD.stage = 'failed' AND
    OLD.recovery_state = 'retryable' AND OLD.error_retryable = 1 AND
    OLD.prompt_id IS NULL AND OLD.error_phase IN ('dependency', 'upload', 'recovery') AND
    OLD.retry_count < OLD.max_retries AND
    NEW.stage = 'prepared' AND NEW.status = 'queued' AND
    NEW.retry_count = OLD.retry_count + 1 AND
    NEW.state_version = OLD.state_version + 1
  )
BEGIN
  SELECT RAISE(ABORT, 'formal remote task terminal state is immutable');
END;

CREATE TRIGGER v2_remote_tasks_formal_validate_update
BEFORE UPDATE ON remote_tasks
WHEN OLD.contract_version = 'remote-task.v1' AND NOT (
  (
    NEW.state_version = OLD.state_version + 1 AND
    NEW.state_version <= 2147483647 AND
    NEW.retry_count = OLD.retry_count AND
    CASE OLD.stage
      WHEN 'prepared' THEN NEW.stage IN ('uploading', 'submitted', 'failed', 'cancelled')
      WHEN 'uploading' THEN NEW.stage IN ('uploading', 'submitted', 'failed', 'cancelled')
      WHEN 'submitted' THEN NEW.stage IN ('submitted', 'executing', 'downloading', 'failed', 'cancelled')
      WHEN 'executing' THEN NEW.stage IN ('executing', 'downloading', 'failed', 'cancelled')
      WHEN 'downloading' THEN NEW.stage IN ('downloading', 'verifying', 'failed', 'cancelled')
      WHEN 'verifying' THEN NEW.stage IN ('verifying', 'completed', 'failed', 'cancelled')
      ELSE 0
    END AND
    CASE NEW.stage
      WHEN 'prepared' THEN NEW.status = 'queued'
      WHEN 'uploading' THEN NEW.status = 'running'
      WHEN 'submitted' THEN NEW.status = 'running'
      WHEN 'executing' THEN NEW.status = 'running'
      WHEN 'downloading' THEN NEW.status = 'running'
      WHEN 'verifying' THEN NEW.status = 'running'
      WHEN 'completed' THEN NEW.status = 'succeeded'
      WHEN 'failed' THEN NEW.status = 'failed'
      WHEN 'cancelled' THEN NEW.status = 'cancelled'
      ELSE 0
    END AND
    (NEW.prompt_id IS NULL OR (
      typeof(NEW.prompt_id) = 'text' AND
      length(CAST(NEW.prompt_id AS BLOB)) BETWEEN 1 AND 128 AND
      NEW.prompt_id NOT GLOB '*[^A-Za-z0-9._-]*'
    )) AND
    (NEW.stage NOT IN ('prepared', 'uploading') OR NEW.prompt_id IS NULL) AND
    (NEW.stage NOT IN ('executing', 'downloading', 'verifying', 'completed') OR NEW.prompt_id IS NOT NULL) AND
    (
      (NEW.stage = 'submitted' AND NEW.prompt_id IS NULL AND
       NEW.submission_lease_expires_at_epoch_ms IS NOT NULL) OR
      (NOT (NEW.stage = 'submitted' AND NEW.prompt_id IS NULL) AND
       NEW.submission_lease_expires_at_epoch_ms IS NULL)
    ) AND
    (NEW.status = 'running' OR NEW.heartbeat_at IS NULL) AND
    (NEW.heartbeat_at IS NULL OR (
      typeof(NEW.heartbeat_at) = 'text' AND length(CAST(NEW.heartbeat_at AS BLOB)) = 24 AND
      substr(NEW.heartbeat_at, 5, 1) = '-' AND substr(NEW.heartbeat_at, 8, 1) = '-' AND
      substr(NEW.heartbeat_at, 11, 1) = 'T' AND substr(NEW.heartbeat_at, 14, 1) = ':' AND
      substr(NEW.heartbeat_at, 17, 1) = ':' AND substr(NEW.heartbeat_at, 20, 1) = '.' AND
      substr(NEW.heartbeat_at, 24, 1) = 'Z' AND
      CAST(substr(NEW.heartbeat_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23 AND
      strftime('%Y-%m-%dT%H:%M:%fZ', NEW.heartbeat_at) = NEW.heartbeat_at
    )) AND
    typeof(NEW.updated_at) = 'text' AND length(CAST(NEW.updated_at AS BLOB)) = 24 AND
    date(substr(NEW.updated_at, 1, 10), '+0 days') = substr(NEW.updated_at, 1, 10) AND
    CAST(substr(NEW.updated_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23 AND
    strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at) = NEW.updated_at AND
    (NEW.started_at IS NULL OR (
      typeof(NEW.started_at) = 'text' AND length(CAST(NEW.started_at AS BLOB)) = 24 AND
      date(substr(NEW.started_at, 1, 10), '+0 days') = substr(NEW.started_at, 1, 10) AND
      CAST(substr(NEW.started_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23 AND
      strftime('%Y-%m-%dT%H:%M:%fZ', NEW.started_at) = NEW.started_at
    )) AND
    (NEW.completed_at IS NULL OR (
      typeof(NEW.completed_at) = 'text' AND length(CAST(NEW.completed_at AS BLOB)) = 24 AND
      date(substr(NEW.completed_at, 1, 10), '+0 days') = substr(NEW.completed_at, 1, 10) AND
      CAST(substr(NEW.completed_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23 AND
      strftime('%Y-%m-%dT%H:%M:%fZ', NEW.completed_at) = NEW.completed_at
    )) AND
    (NEW.status <> 'running' OR NEW.started_at IS NOT NULL) AND
    (NEW.status NOT IN ('succeeded', 'failed', 'cancelled') OR NEW.completed_at IS NOT NULL) AND
    (NEW.status IN ('succeeded', 'failed', 'cancelled') OR NEW.completed_at IS NULL) AND
    (NEW.output_asset_version_uid IS NULL OR NEW.stage = 'completed') AND
    CASE NEW.stage
      WHEN 'failed' THEN
        NEW.error_code IS NOT NULL AND NEW.error_phase IS NOT NULL AND
        NEW.error_retryable IS NOT NULL AND NEW.recovery_state IN ('retryable', 'orphaned') AND
        ((NEW.recovery_state = 'retryable' AND NEW.error_retryable = 1) OR
         (NEW.recovery_state = 'orphaned' AND NEW.error_retryable = 0))
      ELSE
        NEW.error_code IS NULL AND NEW.error_detail_ref IS NULL AND
        NEW.error_phase IS NULL AND NEW.error_retryable IS NULL AND
        (
          NEW.recovery_state = 'none' OR
          (NEW.recovery_state = 'completed' AND NEW.stage IN ('downloading', 'verifying', 'completed'))
        )
    END
  ) OR (
    NEW.state_version = OLD.state_version AND
    OLD.status = 'running' AND
    NOT (OLD.stage = 'submitted' AND OLD.prompt_id IS NULL) AND
    NEW.stage IS OLD.stage AND NEW.status IS OLD.status AND
    NEW.prompt_id IS OLD.prompt_id AND NEW.retry_count = OLD.retry_count AND
    NEW.output_asset_version_uid IS OLD.output_asset_version_uid AND
    NEW.error_code IS OLD.error_code AND NEW.error_detail_ref IS OLD.error_detail_ref AND
    NEW.error_phase IS OLD.error_phase AND NEW.error_retryable IS OLD.error_retryable AND
    NEW.recovery_state IS OLD.recovery_state AND
    NEW.submission_lease_expires_at_epoch_ms IS OLD.submission_lease_expires_at_epoch_ms AND
    NEW.started_at IS OLD.started_at AND NEW.completed_at IS OLD.completed_at AND
    typeof(NEW.heartbeat_at) = 'text' AND length(CAST(NEW.heartbeat_at AS BLOB)) = 24 AND
    date(substr(NEW.heartbeat_at, 1, 10), '+0 days') = substr(NEW.heartbeat_at, 1, 10) AND
    CAST(substr(NEW.heartbeat_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23 AND
    strftime('%Y-%m-%dT%H:%M:%fZ', NEW.heartbeat_at) = NEW.heartbeat_at AND
    (OLD.heartbeat_at IS NULL OR NEW.heartbeat_at >= OLD.heartbeat_at) AND
    typeof(NEW.updated_at) = 'text' AND length(CAST(NEW.updated_at AS BLOB)) = 24 AND
    date(substr(NEW.updated_at, 1, 10), '+0 days') = substr(NEW.updated_at, 1, 10) AND
    CAST(substr(NEW.updated_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23 AND
    strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at) = NEW.updated_at AND
    NEW.updated_at >= OLD.updated_at
  ) OR (
    OLD.status = 'failed' AND OLD.stage = 'failed' AND
    OLD.recovery_state = 'retryable' AND OLD.error_retryable = 1 AND
    OLD.prompt_id IS NULL AND OLD.error_phase IN ('dependency', 'upload', 'recovery') AND
    OLD.retry_count < OLD.max_retries AND
    NEW.state_version = OLD.state_version + 1 AND
    NEW.stage = 'prepared' AND NEW.status = 'queued' AND
    NEW.prompt_id IS NULL AND NEW.retry_count = OLD.retry_count + 1 AND
    NEW.output_asset_version_uid IS NULL AND
    NEW.error_code IS NULL AND NEW.error_detail_ref IS NULL AND
    NEW.error_phase IS NULL AND NEW.error_retryable IS NULL AND
    NEW.recovery_state = 'none' AND NEW.submission_lease_expires_at_epoch_ms IS NULL AND
    NEW.heartbeat_at IS NULL AND NEW.started_at IS NULL AND NEW.completed_at IS NULL AND
    typeof(NEW.updated_at) = 'text' AND length(CAST(NEW.updated_at AS BLOB)) = 24 AND
    date(substr(NEW.updated_at, 1, 10), '+0 days') = substr(NEW.updated_at, 1, 10) AND
    CAST(substr(NEW.updated_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23 AND
    strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at) = NEW.updated_at
  )
)
BEGIN
  SELECT RAISE(ABORT, 'formal remote task state transition is invalid');
END;
