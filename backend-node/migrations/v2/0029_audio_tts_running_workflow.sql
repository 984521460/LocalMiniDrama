-- Phase 9: allow a queued TTS node to seal after an earlier node has already
-- started the same workflow.  The node itself must remain queued; only the
-- workflow status broadens from queued to queued-or-running.

DROP TRIGGER v2_audio_tts_execution_evidence_validate_insert;

CREATE TRIGGER v2_audio_tts_execution_evidence_validate_insert
BEFORE INSERT ON audio_tts_execution_evidence
BEGIN
  SELECT CASE WHEN
    NEW.uid IS NOT audio_tts_execution_uid(NEW.intent_uid)
    OR NEW.plan_uid IS NOT NEW.intent_uid
    OR NEW.created_at_epoch_ms % 1000 <> 0
    OR NEW.created_at_epoch_ms NOT BETWEEN
      (unixepoch('now') - 1) * 1000 AND unixepoch('now') * 1000
    OR NOT EXISTS (
      SELECT 1
      FROM audio_mode_intents AS intent
      JOIN workflow_runs AS run ON run.uid=intent.workflow_run_uid
      JOIN node_runs AS node ON node.uid=intent.node_run_uid
      WHERE intent.uid=NEW.intent_uid
        AND intent.drama_uid=NEW.drama_uid
        AND intent.workflow_run_uid=NEW.workflow_run_uid
        AND intent.node_run_uid=NEW.node_run_uid
        AND intent.plan_sha256=NEW.plan_sha256
        AND run.status IN ('queued', 'running')
        AND node.workflow_run_uid=run.uid
        AND node.status='queued'
        AND audio_tts_execution_record_valid(
          intent.plan_json, NEW.evidence_json, NEW.execution_sha256
        )=1
        AND json_extract(NEW.evidence_json, '$.uid')=NEW.uid
        AND json_extract(NEW.evidence_json, '$.planUid')=NEW.plan_uid
        AND json_extract(NEW.evidence_json, '$.planSha256')=NEW.plan_sha256
        AND json_extract(NEW.evidence_json, '$.createdAtEpochMs')=NEW.created_at_epoch_ms
        AND json_array_length(NEW.evidence_json, '$.ttsOutputs')=(
          SELECT count(*) FROM audio_tts_outputs AS output
          WHERE output.intent_uid=NEW.intent_uid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(NEW.evidence_json, '$.ttsOutputs') AS evidence_output
          WHERE NOT EXISTS (
            SELECT 1
            FROM audio_tts_outputs AS output
            JOIN assets AS asset ON asset.uid=output.asset_uid
            JOIN asset_versions AS version ON version.uid=output.asset_version_uid
            WHERE output.intent_uid=NEW.intent_uid
              AND output.request_ordinal=CAST(evidence_output.key AS INTEGER)
              AND output.dialogue_delivery_uid=
                json_extract(evidence_output.value, '$.dialogueDeliveryUid')
              AND output.asset_uid=json_extract(evidence_output.value, '$.audioAsset.uid')
              AND output.asset_version_uid=
                json_extract(evidence_output.value, '$.audioVersionEvidence.uid')
              AND asset.owner_type=json_extract(evidence_output.value, '$.audioAsset.ownerType')
              AND asset.owner_uid=json_extract(evidence_output.value, '$.audioAsset.ownerUid')
              AND asset.asset_type=json_extract(evidence_output.value, '$.audioAsset.assetType')
              AND asset.current_version_uid=
                json_extract(evidence_output.value, '$.audioAsset.currentVersionUid')
              AND asset.status=json_extract(evidence_output.value, '$.audioAsset.status')
              AND asset.created_at=json_extract(evidence_output.value, '$.audioAsset.createdAt')
              AND asset.updated_at=json_extract(evidence_output.value, '$.audioAsset.updatedAt')
              AND version.asset_uid=
                json_extract(evidence_output.value, '$.audioVersionEvidence.assetUid')
              AND version.storage_provider=
                json_extract(evidence_output.value, '$.audioVersionEvidence.storageProvider')
              AND version.logical_uri=
                json_extract(evidence_output.value, '$.audioVersionEvidence.logicalUri')
              AND version.relative_path=
                json_extract(evidence_output.value, '$.audioVersionEvidence.relativePath')
              AND version.sha256=json_extract(evidence_output.value, '$.audioVersionEvidence.sha256')
              AND version.mime_type=
                json_extract(evidence_output.value, '$.audioVersionEvidence.mimeType')
              AND version.width IS json_extract(evidence_output.value, '$.audioVersionEvidence.width')
              AND version.height IS json_extract(evidence_output.value, '$.audioVersionEvidence.height')
              AND version.duration_ms IS
                json_extract(evidence_output.value, '$.audioVersionEvidence.durationMs')
              AND version.parent_uid IS
                json_extract(evidence_output.value, '$.audioVersionEvidence.parentUid')
              AND version.status=
                json_extract(evidence_output.value, '$.audioVersionEvidence.status')
              AND version.created_at=
                json_extract(evidence_output.value, '$.audioVersionEvidence.createdAt')
          )
        )
    )
  THEN RAISE(ABORT, 'audio TTS execution evidence is invalid') END;
END;
