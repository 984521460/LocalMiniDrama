DROP TRIGGER v2_remote_asset_recoveries_validate_update;

CREATE TRIGGER v2_remote_asset_recoveries_validate_update
BEFORE UPDATE ON remote_asset_recoveries
WHEN NOT (
  (
    OLD.state='reserved'
    AND NEW.operation_uid IS OLD.operation_uid AND NEW.drama_uid IS OLD.drama_uid
    AND NEW.character_uid IS OLD.character_uid
    AND NEW.source_selection_uid IS OLD.source_selection_uid
    AND NEW.extraction_result_uid IS OLD.extraction_result_uid
    AND NEW.extraction_result_hash IS OLD.extraction_result_hash
    AND NEW.extraction_envelope_hash IS OLD.extraction_envelope_hash
    AND NEW.extraction_review_uid IS OLD.extraction_review_uid
    AND NEW.connection_uid IS OLD.connection_uid
    AND NEW.connection_evidence_sha256 IS OLD.connection_evidence_sha256
    AND NEW.remote_task_uid IS OLD.remote_task_uid
    AND NEW.request_json IS OLD.request_json AND NEW.request_sha256 IS OLD.request_sha256
    AND NEW.source_json IS OLD.source_json AND NEW.source_sha256 IS OLD.source_sha256
    AND NEW.created_at_epoch_ms IS OLD.created_at_epoch_ms
    AND NEW.updated_at_epoch_ms=unixepoch('now') * 1000
    AND NEW.updated_at_epoch_ms>=OLD.updated_at_epoch_ms
    AND NEW.state IN ('succeeded','failed','submission_unknown')
    AND (
      NEW.state<>'succeeded' OR (
        NEW.error_code IS NULL AND NEW.manifest_json IS NOT NULL
        AND NEW.manifest_sha256 IS NOT NULL
        AND remote_asset_recovery_manifest_sha256(NEW.manifest_json) IS NOT NULL
        AND remote_asset_recovery_manifest_sha256(NEW.manifest_json)=NEW.manifest_sha256
        AND json_extract(NEW.manifest_json,'$.remoteTaskUid') IS OLD.remote_task_uid
        AND json_extract(NEW.manifest_json,'$.sourceManifestSha256') IS NOT NULL
        AND NEW.item_count IS json_array_length(NEW.manifest_json,'$.items')
        AND NEW.item_count=(SELECT count(*) FROM remote_asset_recovery_items
          WHERE operation_uid=OLD.operation_uid)
      )
    )
    AND (
      NEW.state='succeeded' OR (
        NEW.manifest_json IS NULL AND NEW.manifest_sha256 IS NULL AND NEW.item_count IS NULL
      )
    )
  )
  OR
  (
    OLD.state='failed' AND OLD.error_code='REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE'
    AND NEW.operation_uid IS OLD.operation_uid AND NEW.drama_uid IS OLD.drama_uid
    AND NEW.character_uid IS OLD.character_uid
    AND NEW.source_selection_uid IS OLD.source_selection_uid
    AND NEW.extraction_result_uid IS OLD.extraction_result_uid
    AND NEW.extraction_result_hash IS OLD.extraction_result_hash
    AND NEW.extraction_envelope_hash IS OLD.extraction_envelope_hash
    AND NEW.extraction_review_uid IS OLD.extraction_review_uid
    AND NEW.connection_uid IS OLD.connection_uid
    AND NEW.connection_evidence_sha256 IS OLD.connection_evidence_sha256
    AND NEW.remote_task_uid IS OLD.remote_task_uid
    AND NEW.request_json IS OLD.request_json AND NEW.request_sha256 IS OLD.request_sha256
    AND NEW.source_json IS OLD.source_json AND NEW.source_sha256 IS OLD.source_sha256
    AND NEW.created_at_epoch_ms IS OLD.created_at_epoch_ms
    AND NEW.updated_at_epoch_ms=unixepoch('now') * 1000
    AND NEW.updated_at_epoch_ms>=OLD.updated_at_epoch_ms
    AND NEW.state='reserved' AND NEW.error_code IS NULL
    AND NEW.manifest_json IS NULL AND NEW.manifest_sha256 IS NULL AND NEW.item_count IS NULL
  )
)
BEGIN SELECT RAISE(ABORT,'remote asset recovery transition invalid'); END;
