-- Immutable, secret-free execution anchor for one Phase 9 MVP benchmark workflow.
-- This table reserves no provider operation and proves no external or human result.

CREATE TABLE mvp_benchmark_sessions (
  uid TEXT PRIMARY KEY,
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  workflow_run_uid TEXT NOT NULL UNIQUE REFERENCES workflow_runs(uid) ON DELETE RESTRICT,
  request_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  plan_sha256 TEXT NOT NULL,
  created_at_epoch_ms INTEGER NOT NULL,
  CHECK (
    typeof(uid)='text' AND length(CAST(uid AS BLOB))=36
    AND uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  CHECK (typeof(request_json)='text' AND length(CAST(request_json AS BLOB)) BETWEEN 2 AND 65536),
  CHECK (typeof(plan_json)='text' AND length(CAST(plan_json AS BLOB)) BETWEEN 2 AND 1048576),
  CHECK (
    typeof(plan_sha256)='text' AND length(CAST(plan_sha256 AS BLOB))=64
    AND plan_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    typeof(created_at_epoch_ms)='integer'
    AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  )
);

CREATE TRIGGER v2_mvp_benchmark_sessions_validate_insert
BEFORE INSERT ON mvp_benchmark_sessions
BEGIN
  SELECT CASE WHEN
    mvp_benchmark_session_record_valid(
      NEW.uid, NEW.drama_uid, NEW.workflow_run_uid, NEW.request_json,
      NEW.plan_json, NEW.plan_sha256, NEW.created_at_epoch_ms
    ) IS NOT 1
    OR NOT EXISTS (
      SELECT 1
      FROM workflow_runs AS run
      JOIN workflow_definitions AS definition ON definition.uid=run.workflow_uid
      WHERE run.uid=NEW.workflow_run_uid
        AND definition.drama_uid=NEW.drama_uid
        AND run.status='queued'
        AND run.workflow_uid=json_extract(NEW.plan_json,'$.workflowUid')
        AND run.graph_hash=json_extract(NEW.plan_json,'$.graphHash')
        AND run.graph_revision=json_extract(NEW.plan_json,'$.graphRevision')
    )
    OR mvp_benchmark_session_source_graph_valid(
      (SELECT graph_snapshot_json FROM workflow_runs WHERE uid=NEW.workflow_run_uid),
      NEW.plan_json
    ) IS NOT 1
    OR json_array_length(NEW.plan_json,'$.h3Tasks') NOT BETWEEN 4 AND 6
    OR json_array_length(NEW.plan_json,'$.audioIntents') NOT BETWEEN 1 AND 32
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.plan_json,'$.h3Tasks') AS planned
      WHERE NOT EXISTS (
        SELECT 1
        FROM h3_generation_intents AS intent
        JOIN remote_tasks AS task ON task.uid=intent.task_uid
        JOIN node_runs AS node
          ON node.uid=json_extract(planned.value,'$.nodeRunUid')
         AND node.uid=substr(task.idempotency_key,16)
        JOIN workflow_runs AS run ON run.uid=task.workflow_run_uid
        JOIN json_each(run.graph_snapshot_json,'$.snapshot.nodes') AS graph_node
          ON json_extract(graph_node.value,'$.uid')=node.node_uid
        WHERE task.uid=json_extract(planned.value,'$.taskUid')
          AND intent.uid=json_extract(planned.value,'$.intentUid')
          AND intent.asset_uid=json_extract(planned.value,'$.assetUid')
          AND intent.manifest_uid=json_extract(planned.value,'$.manifestUid')
          AND intent.generation_spec_sha256=json_extract(planned.value,'$.generationSpecSha256')
          AND intent.plan_evidence_sha256=json_extract(planned.value,'$.planEvidenceSha256')
          AND task.workflow_run_uid=NEW.workflow_run_uid
          AND task.workflow_manifest_uid=intent.manifest_uid
          AND task.contract_version='remote-task.v1'
          AND task.stage='prepared' AND task.status='queued'
          AND task.prompt_id IS NULL AND task.output_asset_version_uid IS NULL
          AND node.workflow_run_uid=NEW.workflow_run_uid AND node.status='queued'
          AND node.node_uid=json_extract(planned.value,'$.nodeUid')
          AND json_extract(graph_node.value,'$.nodeType')='shot.video'
          AND json_extract(graph_node.value,'$.enabled')=1
          AND json_extract(graph_node.value,'$.domainRef.type')='asset'
          AND json_extract(graph_node.value,'$.domainRef.uid')=intent.asset_uid
      )
    )
    OR (
      SELECT count(*)
      FROM h3_generation_intents AS intent
      JOIN remote_tasks AS task ON task.uid=intent.task_uid
      WHERE task.workflow_run_uid=NEW.workflow_run_uid
    ) IS NOT json_array_length(NEW.plan_json,'$.h3Tasks')
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.plan_json,'$.audioIntents') AS planned
      WHERE NOT EXISTS (
        SELECT 1
        FROM audio_mode_intents AS intent
        JOIN node_runs AS node ON node.uid=intent.node_run_uid
        JOIN workflow_runs AS run ON run.uid=intent.workflow_run_uid
        JOIN json_each(run.graph_snapshot_json,'$.snapshot.nodes') AS graph_node
          ON json_extract(graph_node.value,'$.uid')=node.node_uid
        WHERE intent.uid=json_extract(planned.value,'$.intentUid')
          AND intent.workflow_run_uid=NEW.workflow_run_uid
          AND intent.node_run_uid=json_extract(planned.value,'$.nodeRunUid')
          AND intent.plan_sha256=json_extract(planned.value,'$.planSha256')
          AND node.workflow_run_uid=NEW.workflow_run_uid AND node.status='queued'
          AND node.node_uid=json_extract(planned.value,'$.nodeUid')
          AND json_extract(graph_node.value,'$.nodeType')='audio.tts'
          AND json_extract(graph_node.value,'$.enabled')=1
          AND json_extract(graph_node.value,'$.domainRef.type')='narrative_result'
          AND json_extract(graph_node.value,'$.domainRef.uid')=intent.shot_result_uid
      )
    )
    OR (
      SELECT count(*) FROM audio_mode_intents
      WHERE workflow_run_uid=NEW.workflow_run_uid
    ) IS NOT json_array_length(NEW.plan_json,'$.audioIntents')
  THEN RAISE(ABORT, 'MVP benchmark session invalid') END;
END;

CREATE TRIGGER v2_mvp_benchmark_sessions_reject_replacement
BEFORE INSERT ON mvp_benchmark_sessions
WHEN EXISTS (
  SELECT 1 FROM mvp_benchmark_sessions
  WHERE uid=NEW.uid OR workflow_run_uid=NEW.workflow_run_uid
)
BEGIN
  SELECT RAISE(ABORT, 'MVP benchmark sessions are immutable');
END;

CREATE TRIGGER v2_mvp_benchmark_sessions_immutable_update
BEFORE UPDATE ON mvp_benchmark_sessions
BEGIN
  SELECT RAISE(ABORT, 'MVP benchmark sessions are immutable');
END;

CREATE TRIGGER v2_mvp_benchmark_sessions_append_only
BEFORE DELETE ON mvp_benchmark_sessions
BEGIN
  SELECT RAISE(ABORT, 'MVP benchmark sessions are append-only');
END;
