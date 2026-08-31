-- Phase 9: durable local TTS output seals and whole-plan execution evidence.
-- Provider credentials and audio bytes are never stored in SQLite.

CREATE TABLE audio_tts_outputs (
  dialogue_delivery_uid TEXT PRIMARY KEY NOT NULL
    REFERENCES audio_tts_submissions(dialogue_delivery_uid),
  intent_uid TEXT NOT NULL REFERENCES audio_mode_intents(uid),
  request_ordinal INTEGER NOT NULL CHECK (
    typeof(request_ordinal)='integer' AND request_ordinal BETWEEN 0 AND 999
  ),
  asset_uid TEXT NOT NULL UNIQUE REFERENCES assets(uid),
  asset_version_uid TEXT NOT NULL UNIQUE REFERENCES asset_versions(uid),
  response_sha256 TEXT NOT NULL CHECK (
    typeof(response_sha256)='text'
    AND length(CAST(response_sha256 AS BLOB))=64
    AND response_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  response_bytes INTEGER NOT NULL CHECK (
    typeof(response_bytes)='integer' AND response_bytes BETWEEN 1 AND 16777216
  ),
  mime_type TEXT NOT NULL CHECK (mime_type='audio/wav'),
  media_probe_json TEXT NOT NULL CHECK (
    typeof(media_probe_json)='text'
    AND length(CAST(media_probe_json AS BLOB)) BETWEEN 2 AND 1048576
  ),
  created_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(created_at_epoch_ms)='integer'
    AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  UNIQUE (intent_uid, request_ordinal)
) WITHOUT ROWID;

CREATE INDEX idx_audio_tts_outputs_intent
ON audio_tts_outputs(intent_uid, request_ordinal);

CREATE TRIGGER v2_audio_tts_outputs_validate_insert
BEFORE INSERT ON audio_tts_outputs
BEGIN
  SELECT CASE WHEN
    NEW.created_at_epoch_ms % 1000 <> 0
    OR NEW.created_at_epoch_ms NOT BETWEEN
      (unixepoch('now') - 1) * 1000 AND unixepoch('now') * 1000
    OR NEW.asset_uid IS NOT audio_tts_asset_uid(NEW.intent_uid, NEW.dialogue_delivery_uid)
    OR NEW.asset_version_uid IS NOT audio_tts_asset_version_uid(
      NEW.intent_uid, NEW.dialogue_delivery_uid
    )
    OR NOT EXISTS (
      SELECT 1
      FROM audio_tts_submissions AS submission
      JOIN audio_mode_intents AS intent ON intent.uid=submission.intent_uid
      JOIN json_each(intent.plan_json, '$.ttsRequests') AS request
        ON CAST(request.key AS INTEGER)=submission.request_ordinal
      JOIN assets AS asset ON asset.uid=NEW.asset_uid
      JOIN asset_versions AS version ON version.uid=NEW.asset_version_uid
      WHERE submission.dialogue_delivery_uid=NEW.dialogue_delivery_uid
        AND submission.intent_uid=NEW.intent_uid
        AND submission.request_ordinal=NEW.request_ordinal
        AND submission.state IN ('received', 'submission_unknown')
        AND (
          submission.state='submission_unknown'
          OR (
            submission.response_sha256=NEW.response_sha256
            AND submission.response_bytes=NEW.response_bytes
            AND submission.mime_type=NEW.mime_type
          )
        )
        AND json_extract(request.value, '$.dialogueDeliveryUid')=NEW.dialogue_delivery_uid
        AND json_extract(request.value, '$.requestSha256')=submission.request_sha256
        AND asset.owner_type='drama'
        AND asset.owner_uid=intent.drama_uid
        AND asset.asset_type='audio'
        AND asset.status='ready'
        AND asset.current_version_uid=version.uid
        AND version.asset_uid=asset.uid
        AND version.storage_provider='local'
        AND version.logical_uri=(
          'asset://dramas/' || intent.drama_uid || '/audio/tts/'
          || asset.uid || '/' || version.uid
        )
        AND version.relative_path=(
          'projects/' || intent.drama_uid || '/assets/audio/tts/'
          || asset.uid || '/' || version.uid || '.wav'
        )
        AND version.sha256=NEW.response_sha256
        AND version.mime_type=NEW.mime_type
        AND version.width IS NULL
        AND version.height IS NULL
        AND typeof(version.duration_ms)='integer'
        AND version.duration_ms BETWEEN 1 AND 600000
        AND version.parent_uid IS NULL
        AND version.status='ready'
        AND audio_tts_probe_record_valid(
          NEW.media_probe_json,
          asset.uid,
          version.uid,
          NEW.response_sha256,
          version.relative_path,
          NEW.mime_type,
          NEW.response_bytes,
          version.duration_ms
        )=1
    )
  THEN RAISE(ABORT, 'audio TTS output is invalid') END;
END;

CREATE TRIGGER v2_audio_tts_outputs_reject_replacement
BEFORE INSERT ON audio_tts_outputs
WHEN EXISTS (
  SELECT 1 FROM audio_tts_outputs AS existing
  WHERE existing.dialogue_delivery_uid=NEW.dialogue_delivery_uid
    OR (existing.intent_uid=NEW.intent_uid AND existing.request_ordinal=NEW.request_ordinal)
    OR existing.asset_uid=NEW.asset_uid
    OR existing.asset_version_uid=NEW.asset_version_uid
)
BEGIN
  SELECT RAISE(ABORT, 'audio TTS outputs cannot be replaced');
END;

CREATE TRIGGER v2_audio_tts_outputs_immutable_update
BEFORE UPDATE ON audio_tts_outputs
BEGIN
  SELECT RAISE(ABORT, 'audio TTS outputs are immutable');
END;

CREATE TRIGGER v2_audio_tts_outputs_reject_delete
BEFORE DELETE ON audio_tts_outputs
BEGIN
  SELECT RAISE(ABORT, 'audio TTS outputs are append-only');
END;

CREATE TABLE audio_tts_execution_evidence (
  uid TEXT PRIMARY KEY NOT NULL,
  intent_uid TEXT NOT NULL UNIQUE REFERENCES audio_mode_intents(uid),
  drama_uid TEXT NOT NULL REFERENCES dramas(uid),
  workflow_run_uid TEXT NOT NULL REFERENCES workflow_runs(uid),
  node_run_uid TEXT NOT NULL REFERENCES node_runs(uid),
  plan_uid TEXT NOT NULL,
  plan_sha256 TEXT NOT NULL CHECK (
    typeof(plan_sha256)='text'
    AND length(CAST(plan_sha256 AS BLOB))=64
    AND plan_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_json TEXT NOT NULL CHECK (
    typeof(evidence_json)='text'
    AND length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 33554432
  ),
  execution_sha256 TEXT NOT NULL CHECK (
    typeof(execution_sha256)='text'
    AND length(CAST(execution_sha256 AS BLOB))=64
    AND execution_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(created_at_epoch_ms)='integer'
    AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  )
) WITHOUT ROWID;

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
        AND run.status='queued'
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

CREATE TRIGGER v2_audio_tts_execution_evidence_reject_replacement
BEFORE INSERT ON audio_tts_execution_evidence
WHEN EXISTS (
  SELECT 1 FROM audio_tts_execution_evidence AS existing
  WHERE existing.uid=NEW.uid OR existing.intent_uid=NEW.intent_uid
)
BEGIN
  SELECT RAISE(ABORT, 'audio TTS execution evidence cannot be replaced');
END;

CREATE TRIGGER v2_audio_tts_execution_evidence_immutable_update
BEFORE UPDATE ON audio_tts_execution_evidence
BEGIN
  SELECT RAISE(ABORT, 'audio TTS execution evidence is immutable');
END;

CREATE TRIGGER v2_audio_tts_execution_evidence_reject_delete
BEFORE DELETE ON audio_tts_execution_evidence
BEGIN
  SELECT RAISE(ABORT, 'audio TTS execution evidence is append-only');
END;
