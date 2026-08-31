-- One immutable, local-only authorization for a frozen MVP benchmark session.
-- This record grants no provider call by itself and stores no host, path, or credential reference.

CREATE TABLE mvp_benchmark_external_authorizations (
  uid TEXT PRIMARY KEY,
  session_uid TEXT NOT NULL UNIQUE REFERENCES mvp_benchmark_sessions(uid) ON DELETE RESTRICT,
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  request_json TEXT NOT NULL,
  authorization_json TEXT NOT NULL,
  authorization_sha256 TEXT NOT NULL,
  authorized_at_epoch_ms INTEGER NOT NULL,
  expires_at_epoch_ms INTEGER NOT NULL,
  CHECK (
    typeof(uid)='text' AND length(CAST(uid AS BLOB))=36
    AND uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  CHECK (typeof(request_json)='text' AND length(CAST(request_json AS BLOB)) BETWEEN 2 AND 65536),
  CHECK (typeof(authorization_json)='text' AND length(CAST(authorization_json AS BLOB)) BETWEEN 2 AND 65536),
  CHECK (
    typeof(authorization_sha256)='text' AND length(CAST(authorization_sha256 AS BLOB))=64
    AND authorization_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    typeof(authorized_at_epoch_ms)='integer'
    AND authorized_at_epoch_ms BETWEEN 0 AND 253402300799999
    AND typeof(expires_at_epoch_ms)='integer'
    AND expires_at_epoch_ms BETWEEN authorized_at_epoch_ms + 60000
      AND authorized_at_epoch_ms + 86400000
  )
);

CREATE TRIGGER v2_mvp_benchmark_external_authorizations_validate_insert
BEFORE INSERT ON mvp_benchmark_external_authorizations
BEGIN
  SELECT CASE WHEN
    mvp_benchmark_external_authorization_record_valid(
      NEW.uid, NEW.session_uid, NEW.drama_uid, NEW.request_json,
      NEW.authorization_json, NEW.authorization_sha256,
      NEW.authorized_at_epoch_ms, NEW.expires_at_epoch_ms
    ) IS NOT 1
    OR NOT EXISTS (
      SELECT 1
      FROM mvp_benchmark_sessions AS session
      JOIN workflow_runs AS run ON run.uid=session.workflow_run_uid
      WHERE session.uid=NEW.session_uid
        AND session.drama_uid=NEW.drama_uid
        AND session.plan_sha256=json_extract(NEW.authorization_json,'$.sessionPlanSha256')
        AND run.status='queued'
        AND mvp_benchmark_session_record_valid(
          session.uid, session.drama_uid, session.workflow_run_uid,
          session.request_json, session.plan_json, session.plan_sha256,
          session.created_at_epoch_ms
        )=1
        AND mvp_benchmark_session_source_graph_valid(
          run.graph_snapshot_json, session.plan_json
        )=1
        AND json_array_length(session.plan_json,'$.h3Tasks')
          =json_extract(NEW.authorization_json,'$.h3SubmissionLimit')
        AND json_array_length(session.plan_json,'$.audioIntents')
          =json_extract(NEW.authorization_json,'$.ttsSubmissionLimit')
    )
    OR NOT EXISTS (
      SELECT 1 FROM remote_connections AS connection
      WHERE connection.uid=json_extract(NEW.authorization_json,'$.connectionUid')
        AND connection.status='ready'
        AND mvp_benchmark_connection_evidence_sha256(
          connection.uid, connection.name, connection.host, connection.port,
          connection.username, connection.host_fingerprint, connection.credential_ref,
          connection.status, connection.created_at, connection.updated_at,
          connection.auth_method, connection.comfy_host, connection.comfy_port,
          connection.remote_work_dir, connection.environment_report_json,
          connection.environment_checked_at_epoch_ms, connection.state_version
        )=json_extract(NEW.authorization_json,'$.connectionEvidenceSha256')
    )
    OR EXISTS (
      SELECT 1
      FROM mvp_benchmark_sessions AS session,
           json_each(session.plan_json,'$.h3Tasks') AS planned
      WHERE session.uid=NEW.session_uid
        AND NOT EXISTS (
          SELECT 1 FROM remote_tasks AS task
          JOIN node_runs AS node ON node.uid=json_extract(planned.value,'$.nodeRunUid')
          WHERE task.uid=json_extract(planned.value,'$.taskUid')
            AND task.connection_uid=json_extract(NEW.authorization_json,'$.connectionUid')
            AND task.connection_evidence_sha256=json_extract(
              NEW.authorization_json,'$.connectionEvidenceSha256'
            )
            AND task.workflow_run_uid=session.workflow_run_uid
            AND task.stage='prepared' AND task.status='queued'
            AND task.prompt_id IS NULL AND task.output_asset_version_uid IS NULL
            AND node.workflow_run_uid=session.workflow_run_uid
            AND node.node_uid=json_extract(planned.value,'$.nodeUid')
            AND node.status='queued'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM mvp_benchmark_sessions AS session,
           json_each(session.plan_json,'$.audioIntents') AS planned
      WHERE session.uid=NEW.session_uid
        AND NOT EXISTS (
          SELECT 1 FROM audio_mode_intents AS intent
          JOIN node_runs AS node ON node.uid=intent.node_run_uid
          WHERE intent.uid=json_extract(planned.value,'$.intentUid')
            AND intent.workflow_run_uid=session.workflow_run_uid
            AND intent.node_run_uid=json_extract(planned.value,'$.nodeRunUid')
            AND intent.plan_sha256=json_extract(planned.value,'$.planSha256')
            AND node.workflow_run_uid=session.workflow_run_uid
            AND node.node_uid=json_extract(planned.value,'$.nodeUid')
            AND node.status='queued'
        )
    )
  THEN RAISE(ABORT, 'MVP benchmark external authorization invalid') END;
END;

CREATE TRIGGER v2_mvp_benchmark_external_authorizations_reject_replacement
BEFORE INSERT ON mvp_benchmark_external_authorizations
WHEN EXISTS (
  SELECT 1 FROM mvp_benchmark_external_authorizations
  WHERE uid=NEW.uid OR session_uid=NEW.session_uid
)
BEGIN
  SELECT RAISE(ABORT, 'MVP benchmark external authorizations are immutable');
END;

CREATE TRIGGER v2_mvp_benchmark_external_authorizations_immutable_update
BEFORE UPDATE ON mvp_benchmark_external_authorizations
BEGIN
  SELECT RAISE(ABORT, 'MVP benchmark external authorizations are immutable');
END;

CREATE TRIGGER v2_mvp_benchmark_external_authorizations_append_only
BEFORE DELETE ON mvp_benchmark_external_authorizations
BEGIN
  SELECT RAISE(ABORT, 'MVP benchmark external authorizations are append-only');
END;
