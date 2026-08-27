CREATE TABLE v2_migration_0007_empty_run_guard (
  existing_run_count INTEGER NOT NULL CHECK (existing_run_count = 0)
);

INSERT INTO v2_migration_0007_empty_run_guard (existing_run_count)
SELECT count(*) FROM workflow_runs;

DROP TABLE v2_migration_0007_empty_run_guard;

ALTER TABLE workflow_runs
ADD COLUMN graph_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
  CHECK (
    typeof(graph_hash) = 'text' AND length(CAST(graph_hash AS BLOB)) = 64 AND
    graph_hash NOT GLOB '*[^0-9a-f]*'
  );

ALTER TABLE workflow_runs
ADD COLUMN graph_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(graph_revision) = 'integer' AND graph_revision >= 0);

DROP TRIGGER IF EXISTS v2_node_runs_reject_replacement;
DROP TRIGGER IF EXISTS v2_node_runs_validate_insert;
DROP TRIGGER IF EXISTS v2_node_runs_validate_update;
DROP TRIGGER IF EXISTS v2_node_runs_immutable_owner;
DROP INDEX IF EXISTS idx_v2_node_runs_status;

ALTER TABLE node_runs RENAME TO node_runs_v2_legacy;

CREATE TABLE node_runs (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  workflow_run_uid TEXT NOT NULL REFERENCES workflow_runs(uid) ON DELETE CASCADE,
  node_uid TEXT NOT NULL
    CHECK (
      typeof(node_uid) = 'text' AND length(CAST(node_uid AS BLOB)) = 36 AND
      node_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  ordinal INTEGER NOT NULL
    CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0 AND ordinal < 500),
  input_snapshot_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      typeof(input_snapshot_json) = 'text' AND
      CASE WHEN json_valid(input_snapshot_json) THEN json_type(input_snapshot_json) = 'object' ELSE 0 END
    ),
  output_json TEXT
    CHECK (
      output_json IS NULL OR (
        typeof(output_json) = 'text' AND
        CASE WHEN json_valid(output_json) THEN json_type(output_json) = 'object' ELSE 0 END
      )
    ),
  cache_key TEXT
    CHECK (
      cache_key IS NULL OR (
        typeof(cache_key) = 'text' AND length(CAST(cache_key AS BLOB)) = 64 AND
        cache_key NOT GLOB '*[^0-9a-f]*'
      )
    ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked', 'skipped')),
  retry_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(retry_count) = 'integer' AND retry_count BETWEEN 0 AND 100),
  error_code TEXT
    CHECK (
      error_code IS NULL OR (
        typeof(error_code) = 'text' AND length(CAST(error_code AS BLOB)) BETWEEN 5 AND 64 AND
        instr(error_code, char(0)) = 0 AND
        substr(error_code, 1, 4) = 'ERR_' AND error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  error_detail_ref TEXT
    CHECK (
      error_detail_ref IS NULL OR (
        typeof(error_detail_ref) = 'text' AND length(CAST(error_detail_ref AS BLOB)) = 52 AND
        substr(error_detail_ref, 1, 16) = 'error-detail:v1:' AND
        substr(error_detail_ref, 17) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      )
    ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (workflow_run_uid, node_uid),
  UNIQUE (workflow_run_uid, ordinal)
) WITHOUT ROWID;

INSERT INTO node_runs
  (uid, workflow_run_uid, node_uid, ordinal, input_snapshot_json, output_json, cache_key,
   status, retry_count, error_code, error_detail_ref, created_at, started_at, completed_at, updated_at)
SELECT
  legacy.uid,
  legacy.workflow_run_uid,
  legacy.node_uid,
  (
    SELECT count(*)
    FROM node_runs_v2_legacy AS preceding
    WHERE preceding.workflow_run_uid = legacy.workflow_run_uid
      AND (
        preceding.created_at < legacy.created_at OR
        (preceding.created_at = legacy.created_at AND preceding.uid < legacy.uid)
      )
  ),
  legacy.input_snapshot_json,
  legacy.output_json,
  CASE
    WHEN legacy.cache_key IS NULL OR (
      length(CAST(legacy.cache_key AS BLOB)) = 64 AND legacy.cache_key NOT GLOB '*[^0-9a-f]*'
    ) THEN legacy.cache_key
    ELSE NULL
  END,
  legacy.status,
  legacy.retry_count,
  legacy.error_code,
  legacy.error_detail_ref,
  legacy.created_at,
  legacy.started_at,
  legacy.completed_at,
  legacy.updated_at
FROM node_runs_v2_legacy AS legacy;

DROP TABLE node_runs_v2_legacy;

CREATE INDEX idx_v2_node_runs_status ON node_runs(status, updated_at);

CREATE TRIGGER v2_workflow_runs_validate_initial_state
BEFORE INSERT ON workflow_runs
WHEN NEW.status <> 'queued'
  OR NEW.retry_count <> 0
  OR NEW.error_code IS NOT NULL
  OR NEW.error_detail_ref IS NOT NULL
  OR NEW.started_at IS NOT NULL
  OR NEW.completed_at IS NOT NULL
  OR NEW.graph_hash IS NOT json_extract(NEW.graph_snapshot_json, '$.graphHash')
  OR NEW.graph_revision IS NOT json_extract(NEW.graph_snapshot_json, '$.graphRevision')
  OR NEW.workflow_uid IS NOT json_extract(NEW.graph_snapshot_json, '$.workflowUid')
  OR json_extract(NEW.graph_snapshot_json, '$.schemaVersion') IS NOT '4.0'
  OR json_extract(NEW.graph_snapshot_json, '$.registryVersion') IS NOT '4.0.0'
BEGIN
  SELECT RAISE(ABORT, 'workflow run initial state and snapshot binding are invalid');
END;

CREATE TRIGGER v2_workflow_runs_snapshot_immutable
BEFORE UPDATE OF uid, workflow_uid, graph_snapshot_json, graph_hash, graph_revision, trigger_type
ON workflow_runs
WHEN NEW.uid IS NOT OLD.uid
  OR NEW.workflow_uid IS NOT OLD.workflow_uid
  OR NEW.graph_snapshot_json IS NOT OLD.graph_snapshot_json
  OR NEW.graph_hash IS NOT OLD.graph_hash
  OR NEW.graph_revision IS NOT OLD.graph_revision
  OR NEW.trigger_type IS NOT OLD.trigger_type
BEGIN
  SELECT RAISE(ABORT, 'workflow run snapshot and identity are immutable');
END;

CREATE TRIGGER v2_workflow_runs_validate_transition
BEFORE UPDATE OF status, retry_count ON workflow_runs
WHEN NOT (
  (NEW.status IS OLD.status AND NEW.retry_count = OLD.retry_count) OR
  (OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'cancelled')
    AND NEW.retry_count = OLD.retry_count) OR
  (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'cancelled')
    AND NEW.retry_count = OLD.retry_count) OR
  (OLD.status = 'failed' AND NEW.status = 'running'
    AND NEW.retry_count = OLD.retry_count + 1)
)
BEGIN
  SELECT RAISE(ABORT, 'workflow run status transition is invalid');
END;

CREATE TRIGGER v2_workflow_runs_validate_state_shape
BEFORE UPDATE OF status, retry_count, error_code, error_detail_ref, started_at, completed_at
ON workflow_runs
WHEN NEW.retry_count > 100 OR NOT (
  (NEW.status = 'queued' AND NEW.retry_count = 0
    AND NEW.started_at IS NULL AND NEW.completed_at IS NULL
    AND NEW.error_code IS NULL AND NEW.error_detail_ref IS NULL) OR
  (NEW.status = 'running' AND NEW.started_at IS NOT NULL AND NEW.completed_at IS NULL
    AND NEW.error_code IS NULL AND NEW.error_detail_ref IS NULL) OR
  (NEW.status IN ('succeeded', 'cancelled') AND NEW.completed_at IS NOT NULL
    AND NEW.error_code IS NULL AND NEW.error_detail_ref IS NULL) OR
  (NEW.status = 'failed' AND NEW.completed_at IS NOT NULL AND NEW.error_code IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'workflow run state fields are inconsistent');
END;

CREATE TRIGGER v2_workflow_runs_reject_delete
BEFORE DELETE ON workflow_runs
BEGIN
  SELECT RAISE(ABORT, 'workflow runs cannot be deleted');
END;

CREATE TRIGGER v2_node_runs_reject_replacement
BEFORE INSERT ON node_runs
WHEN EXISTS (
  SELECT 1 FROM node_runs
  WHERE uid = NEW.uid
    OR (workflow_run_uid = NEW.workflow_run_uid AND node_uid = NEW.node_uid)
    OR (workflow_run_uid = NEW.workflow_run_uid AND ordinal = NEW.ordinal)
)
BEGIN
  SELECT RAISE(ABORT, 'node run identity cannot be replaced');
END;

CREATE TRIGGER v2_node_runs_validate_insert
BEFORE INSERT ON node_runs
WHEN NEW.status <> 'queued'
  OR NEW.retry_count <> 0
  OR NEW.input_snapshot_json <> '{}'
  OR NEW.output_json IS NOT NULL
  OR NEW.cache_key IS NOT NULL
  OR NEW.error_code IS NOT NULL
  OR NEW.error_detail_ref IS NOT NULL
  OR NEW.started_at IS NOT NULL
  OR NEW.completed_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM workflow_runs AS workflow_run
    WHERE workflow_run.uid = NEW.workflow_run_uid
      AND json_extract(
        workflow_run.graph_snapshot_json,
        '$.topologicalOrder[' || NEW.ordinal || ']'
      ) IS NEW.node_uid
  )
BEGIN
  SELECT RAISE(ABORT, 'node run initial state and snapshot binding are invalid');
END;

CREATE TRIGGER v2_node_runs_immutable_identity
BEFORE UPDATE OF uid, workflow_run_uid, node_uid, ordinal ON node_runs
WHEN NEW.uid IS NOT OLD.uid
  OR NEW.workflow_run_uid IS NOT OLD.workflow_run_uid
  OR NEW.node_uid IS NOT OLD.node_uid
  OR NEW.ordinal IS NOT OLD.ordinal
BEGIN
  SELECT RAISE(ABORT, 'node run identity is immutable');
END;

CREATE TRIGGER v2_node_runs_validate_transition
BEFORE UPDATE OF status, retry_count ON node_runs
WHEN NOT (
  (NEW.status IS OLD.status AND NEW.retry_count = OLD.retry_count) OR
  (OLD.status = 'queued' AND NEW.status IN ('running', 'cancelled', 'blocked', 'skipped')
    AND NEW.retry_count = OLD.retry_count) OR
  (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'cancelled')
    AND NEW.retry_count = OLD.retry_count) OR
  (OLD.status IN ('failed', 'blocked') AND NEW.status = 'queued'
    AND NEW.retry_count = OLD.retry_count + 1)
)
BEGIN
  SELECT RAISE(ABORT, 'node run status transition is invalid');
END;

CREATE TRIGGER v2_node_runs_validate_state_shape
BEFORE UPDATE OF status, retry_count, input_snapshot_json, output_json, cache_key,
  error_code, error_detail_ref, started_at, completed_at
ON node_runs
WHEN NOT (
  (NEW.status = 'queued' AND NEW.input_snapshot_json = '{}' AND NEW.output_json IS NULL
    AND NEW.cache_key IS NULL AND NEW.started_at IS NULL AND NEW.completed_at IS NULL
    AND NEW.error_code IS NULL AND NEW.error_detail_ref IS NULL) OR
  (NEW.status = 'running' AND NEW.output_json IS NULL AND NEW.started_at IS NOT NULL
    AND NEW.completed_at IS NULL AND NEW.error_code IS NULL AND NEW.error_detail_ref IS NULL) OR
  (NEW.status = 'succeeded' AND NEW.output_json IS NOT NULL AND NEW.started_at IS NOT NULL
    AND NEW.completed_at IS NOT NULL AND NEW.error_code IS NULL AND NEW.error_detail_ref IS NULL) OR
  (NEW.status IN ('cancelled', 'skipped') AND NEW.output_json IS NULL
    AND NEW.completed_at IS NOT NULL AND NEW.error_code IS NULL AND NEW.error_detail_ref IS NULL) OR
  (NEW.status IN ('failed', 'blocked') AND NEW.output_json IS NULL
    AND NEW.completed_at IS NOT NULL AND NEW.error_code IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'node run state fields are inconsistent');
END;

CREATE TRIGGER v2_node_runs_freeze_execution_data
BEFORE UPDATE OF input_snapshot_json, cache_key, output_json, error_code, error_detail_ref ON node_runs
WHEN (OLD.status <> 'queued'
  AND NOT (OLD.status IN ('failed', 'blocked') AND NEW.status = 'queued')
  AND (
    NEW.input_snapshot_json IS NOT OLD.input_snapshot_json OR
    NEW.cache_key IS NOT OLD.cache_key
  )) OR (
    NEW.status IS OLD.status AND (
      NEW.output_json IS NOT OLD.output_json OR
      NEW.error_code IS NOT OLD.error_code OR
      NEW.error_detail_ref IS NOT OLD.error_detail_ref
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'node run execution evidence is immutable');
END;

CREATE TRIGGER v2_node_runs_reject_delete
BEFORE DELETE ON node_runs
BEGIN
  SELECT RAISE(ABORT, 'node runs cannot be deleted');
END;
