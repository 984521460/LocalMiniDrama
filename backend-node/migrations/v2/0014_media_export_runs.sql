CREATE TABLE media_export_run_seals (
  uid TEXT PRIMARY KEY NOT NULL REFERENCES export_runs(uid) ON DELETE RESTRICT,
  source_node_run_uid TEXT NOT NULL UNIQUE REFERENCES node_runs(uid) ON DELETE RESTRICT,
  execution_plan_json TEXT NOT NULL CHECK (
    typeof(execution_plan_json)='text'
    AND length(CAST(execution_plan_json AS BLOB)) BETWEEN 2 AND 16777216
    AND json_valid(execution_plan_json)
    AND json_type(execution_plan_json)='object'
  ),
  execution_plan_sha256 TEXT NOT NULL CHECK (
    typeof(execution_plan_sha256)='text'
    AND length(CAST(execution_plan_sha256 AS BLOB))=64
    AND execution_plan_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  output_asset_uid TEXT REFERENCES assets(uid) ON DELETE RESTRICT,
  output_asset_version_uid TEXT REFERENCES asset_versions(uid) ON DELETE RESTRICT,
  receipt_json TEXT CHECK (
    receipt_json IS NULL OR (
      typeof(receipt_json)='text'
      AND length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 1048576
      AND json_valid(receipt_json)
      AND json_type(receipt_json)='object'
    )
  ),
  created_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(created_at_epoch_ms)='integer'
    AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  completed_at_epoch_ms INTEGER CHECK (
    completed_at_epoch_ms IS NULL OR (
      typeof(completed_at_epoch_ms)='integer'
      AND completed_at_epoch_ms BETWEEN created_at_epoch_ms AND 253402300799999
    )
  ),
  CHECK (
    (output_asset_uid IS NULL AND output_asset_version_uid IS NULL AND receipt_json IS NULL)
    OR
    (output_asset_uid IS NOT NULL AND output_asset_version_uid IS NOT NULL AND receipt_json IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE INDEX idx_v2_media_export_run_seals_node
  ON media_export_run_seals(source_node_run_uid);

CREATE TRIGGER v2_media_export_run_seals_validate_insert
BEFORE INSERT ON media_export_run_seals
WHEN media_export_execution_plan_sha256(NEW.execution_plan_json) IS NOT NEW.execution_plan_sha256
  OR NOT EXISTS (
    SELECT 1
    FROM export_runs AS export_run
    JOIN node_runs AS node_run ON node_run.uid=NEW.source_node_run_uid
    JOIN workflow_runs AS workflow_run ON workflow_run.uid=node_run.workflow_run_uid
    JOIN workflow_definitions AS workflow ON workflow.uid=workflow_run.workflow_uid
    WHERE export_run.uid=NEW.uid
      AND node_run.status='succeeded'
      AND workflow_run.status='succeeded'
      AND export_run.drama_uid=workflow.drama_uid
      AND export_run.workflow_run_uid=workflow_run.uid
      AND json_extract(NEW.execution_plan_json,'$.uid')=export_run.uid
      AND json_extract(NEW.execution_plan_json,'$.dramaUid')=export_run.drama_uid
      AND json_extract(NEW.execution_plan_json,'$.workflowRunUid')=workflow_run.uid
      AND export_run.timeline_snapshot_json=json_object(
        'uid',json_extract(NEW.execution_plan_json,'$.productionTimelineSnapshotUid'),
        'sha256',json_extract(NEW.execution_plan_json,'$.productionTimelineSnapshotSha256')
      )
      AND export_run.encoding_json=json_extract(NEW.execution_plan_json,'$.profile')
      AND export_run.audio_json=json_object(
        'mode',json_extract(NEW.execution_plan_json,'$.mode'),
        'uid',json_extract(NEW.execution_plan_json,'$.audioMixPlan.uid'),
        'sha256',json_extract(NEW.execution_plan_json,'$.audioMixPlan.mixSha256')
      )
      AND export_run.subtitle_json=json_object(
        'trackSha256',json_extract(NEW.execution_plan_json,'$.subtitleTrackSha256'),
        'documentSha256',json_extract(NEW.execution_plan_json,'$.subtitleDocument.documentSha256')
      )
      AND json_extract(node_run.output_json,'$.schemaVersion')='media-export-node-output.v1'
      AND media_export_execution_plan_sha256(
        json_extract(node_run.output_json,'$.executionPlan')
      )=NEW.execution_plan_sha256
      AND json_extract(node_run.output_json,'$.executionPlan.executionPlanSha256')=NEW.execution_plan_sha256
      AND media_export_source_graph_valid(
        workflow_run.graph_snapshot_json,
        workflow_run.workflow_uid,
        workflow_run.graph_hash,
        workflow_run.graph_revision,
        node_run.node_uid
      )=1
      AND media_export_iso_timestamp_valid(export_run.created_at)=1
      AND media_export_iso_timestamp_valid(export_run.updated_at)=1
      AND (
        (
          export_run.status='queued'
          AND export_run.output_asset_version_uid IS NULL
          AND export_run.validation_json='{}'
          AND export_run.error_code IS NULL
          AND export_run.error_detail_ref IS NULL
          AND export_run.started_at IS NULL
          AND export_run.completed_at IS NULL
          AND export_run.created_at<=export_run.updated_at
          AND NEW.output_asset_uid IS NULL
          AND NEW.output_asset_version_uid IS NULL
          AND NEW.receipt_json IS NULL
          AND NEW.completed_at_epoch_ms IS NULL
        )
        OR
        (
          export_run.status='failed'
          AND export_run.output_asset_version_uid IS NULL
          AND export_run.validation_json='{}'
          AND export_run.error_code IN (
            'ERR_MEDIA_EXPORT_FAILED','ERR_MEDIA_EXPORT_CLEANUP_FAILED'
          )
          AND export_run.error_detail_ref IS NULL
          AND media_export_iso_timestamp_valid(export_run.started_at)=1
          AND media_export_iso_timestamp_valid(export_run.completed_at)=1
          AND export_run.created_at<=export_run.started_at
          AND export_run.started_at<=export_run.completed_at
          AND export_run.completed_at<=export_run.updated_at
          AND NEW.output_asset_uid IS NULL
          AND NEW.output_asset_version_uid IS NULL
          AND NEW.receipt_json IS NULL
          AND NEW.completed_at_epoch_ms IS NOT NULL
          AND export_run.completed_at=media_export_epoch_iso(NEW.completed_at_epoch_ms)
        )
        OR
        (
          export_run.status='succeeded'
          AND export_run.output_asset_version_uid=NEW.output_asset_version_uid
          AND export_run.validation_json=NEW.receipt_json
          AND export_run.error_code IS NULL
          AND export_run.error_detail_ref IS NULL
          AND media_export_iso_timestamp_valid(export_run.started_at)=1
          AND media_export_iso_timestamp_valid(export_run.completed_at)=1
          AND export_run.created_at<=export_run.started_at
          AND export_run.started_at<=export_run.completed_at
          AND export_run.completed_at<=export_run.updated_at
          AND NEW.output_asset_uid IS NOT NULL
          AND NEW.output_asset_version_uid IS NOT NULL
          AND NEW.receipt_json IS NOT NULL
          AND NEW.completed_at_epoch_ms IS NOT NULL
           AND media_export_receipt_matches_plan(
             NEW.execution_plan_json,NEW.receipt_json
           )=1
           AND NEW.completed_at_epoch_ms=json_extract(NEW.receipt_json,'$.completedAtEpochMs')
           AND export_run.completed_at=media_export_receipt_completed_iso(NEW.receipt_json)
          AND EXISTS (
            SELECT 1
            FROM assets AS asset
            JOIN asset_versions AS version ON version.uid=NEW.output_asset_version_uid
            WHERE asset.uid=NEW.output_asset_uid
              AND version.asset_uid=asset.uid
              AND asset.owner_type='drama'
              AND asset.owner_uid=export_run.drama_uid
              AND asset.asset_type='final_video'
              AND asset.status='ready'
              AND asset.current_version_uid=version.uid
              AND version.storage_provider='local'
              AND version.logical_uri='asset://dramas/' || asset.owner_uid || '/final/' || asset.uid || '/' || version.uid
              AND version.relative_path=json_extract(NEW.receipt_json,'$.output.relativePath')
              AND version.sha256=json_extract(NEW.receipt_json,'$.output.sha256')
              AND version.mime_type='video/mp4'
              AND version.width=json_extract(NEW.receipt_json,'$.output.video.width')
              AND version.height=json_extract(NEW.receipt_json,'$.output.video.height')
              AND version.duration_ms=json_extract(NEW.receipt_json,'$.output.durationMs')
               AND version.parent_uid IS NULL
               AND version.status='ready'
               AND asset.created_at=media_export_receipt_completed_iso(NEW.receipt_json)
               AND asset.updated_at=media_export_receipt_completed_iso(NEW.receipt_json)
               AND version.created_at=media_export_receipt_completed_iso(NEW.receipt_json)
          )
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT,'media export run source evidence is invalid');
END;

CREATE TRIGGER v2_media_export_run_seals_reject_replacement
BEFORE INSERT ON media_export_run_seals
WHEN EXISTS (
  SELECT 1 FROM media_export_run_seals
  WHERE uid=NEW.uid OR source_node_run_uid=NEW.source_node_run_uid
)
BEGIN
  SELECT RAISE(ABORT,'media export run seal replacement is forbidden');
END;

CREATE TRIGGER v2_media_export_run_seals_immutable_delete
BEFORE DELETE ON media_export_run_seals
BEGIN
  SELECT RAISE(ABORT,'media export run seals are append-only');
END;

CREATE TRIGGER v2_media_export_run_seals_validate_update
BEFORE UPDATE ON media_export_run_seals
WHEN NEW.uid IS NOT OLD.uid
  OR NEW.source_node_run_uid IS NOT OLD.source_node_run_uid
  OR NEW.execution_plan_json IS NOT OLD.execution_plan_json
  OR NEW.execution_plan_sha256 IS NOT OLD.execution_plan_sha256
  OR NEW.created_at_epoch_ms IS NOT OLD.created_at_epoch_ms
  OR OLD.completed_at_epoch_ms IS NOT NULL
  OR NEW.completed_at_epoch_ms IS NULL
  OR NEW.completed_at_epoch_ms<NEW.created_at_epoch_ms
  OR NOT EXISTS (
    SELECT 1 FROM export_runs
    WHERE uid=OLD.uid AND status='running'
  )
  OR (
    NEW.receipt_json IS NOT NULL AND (
      media_export_receipt_matches_plan(NEW.execution_plan_json,NEW.receipt_json) IS NOT 1
      OR NEW.completed_at_epoch_ms IS NOT json_extract(NEW.receipt_json,'$.completedAtEpochMs')
      OR NOT EXISTS (
        SELECT 1
        FROM assets AS asset
        JOIN asset_versions AS version ON version.uid=NEW.output_asset_version_uid
        WHERE asset.uid=NEW.output_asset_uid
          AND version.asset_uid=asset.uid
          AND asset.owner_type='drama'
          AND asset.owner_uid=json_extract(NEW.execution_plan_json,'$.dramaUid')
          AND asset.asset_type='final_video'
          AND asset.status='ready'
          AND asset.current_version_uid=version.uid
          AND version.storage_provider='local'
          AND version.logical_uri='asset://dramas/' || asset.owner_uid || '/final/' || asset.uid || '/' || version.uid
          AND version.relative_path=json_extract(NEW.receipt_json,'$.output.relativePath')
          AND version.sha256=json_extract(NEW.receipt_json,'$.output.sha256')
          AND version.mime_type='video/mp4'
          AND version.width=json_extract(NEW.receipt_json,'$.output.video.width')
          AND version.height=json_extract(NEW.receipt_json,'$.output.video.height')
          AND version.duration_ms=json_extract(NEW.receipt_json,'$.output.durationMs')
           AND version.parent_uid IS NULL
           AND version.status='ready'
           AND asset.created_at=media_export_receipt_completed_iso(NEW.receipt_json)
           AND asset.updated_at=media_export_receipt_completed_iso(NEW.receipt_json)
           AND version.created_at=media_export_receipt_completed_iso(NEW.receipt_json)
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT,'media export run completion evidence is invalid');
END;

CREATE TRIGGER v2_media_export_runs_validate_transition
BEFORE UPDATE ON export_runs
WHEN EXISTS (SELECT 1 FROM media_export_run_seals WHERE uid=OLD.uid)
  AND (
    NEW.uid IS NOT OLD.uid
    OR NEW.drama_uid IS NOT OLD.drama_uid
    OR NEW.workflow_run_uid IS NOT OLD.workflow_run_uid
    OR NEW.timeline_snapshot_json IS NOT OLD.timeline_snapshot_json
    OR NEW.encoding_json IS NOT OLD.encoding_json
    OR NEW.audio_json IS NOT OLD.audio_json
    OR NEW.subtitle_json IS NOT OLD.subtitle_json
    OR NEW.created_at IS NOT OLD.created_at
    OR media_export_iso_timestamp_valid(NEW.created_at) IS NOT 1
    OR media_export_iso_timestamp_valid(NEW.updated_at) IS NOT 1
    OR NOT (
      (OLD.status='queued' AND NEW.status='running'
        AND NEW.output_asset_version_uid IS NULL AND NEW.validation_json='{}'
        AND NEW.error_code IS NULL AND NEW.error_detail_ref IS NULL
        AND media_export_iso_timestamp_valid(NEW.started_at)=1
        AND NEW.completed_at IS NULL
        AND NEW.created_at<=NEW.started_at AND NEW.started_at<=NEW.updated_at)
      OR
      (OLD.status='running' AND NEW.status='succeeded'
        AND NEW.output_asset_version_uid IS NOT NULL
        AND NEW.error_code IS NULL AND NEW.error_detail_ref IS NULL
        AND NEW.started_at IS OLD.started_at
        AND media_export_iso_timestamp_valid(NEW.completed_at)=1
        AND NEW.started_at<=NEW.completed_at AND NEW.completed_at<=NEW.updated_at
        AND EXISTS (
          SELECT 1 FROM media_export_run_seals AS seal
          WHERE seal.uid=OLD.uid
            AND seal.output_asset_version_uid=NEW.output_asset_version_uid
            AND seal.receipt_json=NEW.validation_json
            AND seal.completed_at_epoch_ms IS NOT NULL
        ))
      OR
      (OLD.status='running' AND NEW.status='failed'
        AND NEW.output_asset_version_uid IS NULL AND NEW.validation_json='{}'
        AND NEW.error_code IN ('ERR_MEDIA_EXPORT_FAILED','ERR_MEDIA_EXPORT_CLEANUP_FAILED')
        AND NEW.error_detail_ref IS NULL
        AND NEW.started_at IS OLD.started_at
        AND media_export_iso_timestamp_valid(NEW.completed_at)=1
        AND NEW.started_at<=NEW.completed_at AND NEW.completed_at<=NEW.updated_at
        AND EXISTS (
          SELECT 1 FROM media_export_run_seals AS seal
          WHERE seal.uid=OLD.uid
            AND seal.receipt_json IS NULL
            AND seal.completed_at_epoch_ms IS NOT NULL
        ))
    )
  )
BEGIN
  SELECT RAISE(ABORT,'media export run transition is invalid');
END;

CREATE TRIGGER v2_media_export_runs_immutable_delete
BEFORE DELETE ON export_runs
WHEN EXISTS (SELECT 1 FROM media_export_run_seals WHERE uid=OLD.uid)
BEGIN
  SELECT RAISE(ABORT,'media export runs are append-only');
END;

CREATE TRIGGER v2_media_export_runs_reject_replacement
BEFORE INSERT ON export_runs
WHEN EXISTS (
  SELECT 1 FROM media_export_run_seals WHERE uid=NEW.uid
)
BEGIN
  SELECT RAISE(ABORT,'media export run replacement is forbidden');
END;

CREATE TRIGGER v2_media_export_assets_reject_replacement
BEFORE INSERT ON assets
WHEN EXISTS (
  SELECT 1 FROM media_export_run_seals WHERE output_asset_uid=NEW.uid
)
BEGIN
  SELECT RAISE(ABORT,'media export asset replacement is forbidden');
END;

CREATE TRIGGER v2_media_export_asset_versions_reject_replacement
BEFORE INSERT ON asset_versions
WHEN EXISTS (
  SELECT 1
  FROM media_export_run_seals AS seal
  JOIN asset_versions AS version ON version.uid=seal.output_asset_version_uid
  WHERE version.uid=NEW.uid
    OR version.logical_uri=NEW.logical_uri
    OR (
      version.storage_provider=NEW.storage_provider
      AND version.relative_path=NEW.relative_path
    )
)
BEGIN
  SELECT RAISE(ABORT,'media export AssetVersion replacement is forbidden');
END;

CREATE TRIGGER v2_media_export_assets_frozen
BEFORE UPDATE ON assets
WHEN EXISTS (
  SELECT 1 FROM media_export_run_seals
  WHERE output_asset_uid=OLD.uid AND receipt_json IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT,'media export asset evidence is frozen');
END;

CREATE TRIGGER v2_media_export_assets_delete_frozen
BEFORE DELETE ON assets
WHEN EXISTS (
  SELECT 1 FROM media_export_run_seals
  WHERE output_asset_uid=OLD.uid AND receipt_json IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT,'media export asset evidence is append-only');
END;

CREATE TRIGGER v2_media_export_asset_versions_frozen
BEFORE UPDATE ON asset_versions
WHEN EXISTS (
  SELECT 1 FROM media_export_run_seals
  WHERE output_asset_version_uid=OLD.uid AND receipt_json IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT,'media export AssetVersion evidence is frozen');
END;

CREATE TRIGGER v2_media_export_asset_versions_delete_frozen
BEFORE DELETE ON asset_versions
WHEN EXISTS (
  SELECT 1 FROM media_export_run_seals
  WHERE output_asset_version_uid=OLD.uid AND receipt_json IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT,'media export AssetVersion evidence is append-only');
END;
