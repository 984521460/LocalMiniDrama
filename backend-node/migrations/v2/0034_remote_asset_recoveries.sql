CREATE TABLE remote_asset_recoveries (
  operation_uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(operation_uid)='text' AND length(CAST(operation_uid AS BLOB))=36 AND
    operation_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  drama_uid TEXT NOT NULL,
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  source_selection_uid TEXT NOT NULL REFERENCES source_selections(uid) ON DELETE RESTRICT,
  extraction_result_uid TEXT NOT NULL REFERENCES narrative_results(uid) ON DELETE RESTRICT,
  extraction_result_hash TEXT NOT NULL CHECK (
    typeof(extraction_result_hash)='text' AND length(CAST(extraction_result_hash AS BLOB))=64
    AND extraction_result_hash NOT GLOB '*[^0-9a-f]*'
  ),
  extraction_envelope_hash TEXT NOT NULL CHECK (
    typeof(extraction_envelope_hash)='text' AND length(CAST(extraction_envelope_hash AS BLOB))=64
    AND extraction_envelope_hash NOT GLOB '*[^0-9a-f]*'
  ),
  extraction_review_uid TEXT NOT NULL REFERENCES narrative_review_events(uid) ON DELETE RESTRICT,
  connection_uid TEXT NOT NULL REFERENCES remote_connections(uid) ON DELETE RESTRICT,
  connection_evidence_sha256 TEXT NOT NULL CHECK (
    typeof(connection_evidence_sha256)='text'
    AND length(CAST(connection_evidence_sha256 AS BLOB))=64
    AND connection_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  remote_task_uid TEXT NOT NULL CHECK (
    typeof(remote_task_uid)='text' AND length(CAST(remote_task_uid AS BLOB))=36 AND
    remote_task_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  request_json TEXT NOT NULL CHECK (
    typeof(request_json)='text' AND length(CAST(request_json AS BLOB)) BETWEEN 2 AND 16384
    AND json_valid(request_json)
  ),
  request_sha256 TEXT NOT NULL CHECK (
    typeof(request_sha256)='text' AND length(CAST(request_sha256 AS BLOB))=64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_json TEXT NOT NULL CHECK (
    typeof(source_json)='text' AND length(CAST(source_json AS BLOB)) BETWEEN 2 AND 65536
    AND json_valid(source_json)
  ),
  source_sha256 TEXT NOT NULL CHECK (
    typeof(source_sha256)='text' AND length(CAST(source_sha256 AS BLOB))=64
    AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_json TEXT CHECK (
    manifest_json IS NULL OR (
      typeof(manifest_json)='text' AND length(CAST(manifest_json AS BLOB)) BETWEEN 2 AND 262144
      AND json_valid(manifest_json)
    )
  ),
  manifest_sha256 TEXT CHECK (
    manifest_sha256 IS NULL OR (
      typeof(manifest_sha256)='text' AND length(CAST(manifest_sha256 AS BLOB))=64
      AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  item_count INTEGER CHECK (
    item_count IS NULL OR (typeof(item_count)='integer' AND item_count BETWEEN 1 AND 16)
  ),
  state TEXT NOT NULL CHECK (state IN ('reserved','succeeded','failed','submission_unknown')),
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'REMOTE_ASSET_RECOVERY_SOURCE_STALE',
      'REMOTE_ASSET_RECOVERY_MANIFEST_INVALID',
      'REMOTE_ASSET_RECOVERY_OUTPUT_INVALID',
      'REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE',
      'REMOTE_ASSET_RECOVERY_SUBMISSION_UNKNOWN'
    )
  ),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000) CHECK (
    typeof(created_at_epoch_ms)='integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  updated_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000) CHECK (
    typeof(updated_at_epoch_ms)='integer' AND updated_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (updated_at_epoch_ms>=created_at_epoch_ms),
  CHECK (
    (state='reserved' AND manifest_json IS NULL AND manifest_sha256 IS NULL
      AND item_count IS NULL AND error_code IS NULL) OR
    (state='succeeded' AND manifest_json IS NOT NULL AND manifest_sha256 IS NOT NULL
      AND item_count IS NOT NULL AND error_code IS NULL) OR
    (state='failed' AND manifest_json IS NULL AND manifest_sha256 IS NULL
      AND item_count IS NULL AND error_code IN (
        'REMOTE_ASSET_RECOVERY_SOURCE_STALE',
        'REMOTE_ASSET_RECOVERY_MANIFEST_INVALID',
        'REMOTE_ASSET_RECOVERY_OUTPUT_INVALID',
        'REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE'
      )) OR
    (state='submission_unknown' AND manifest_json IS NULL AND manifest_sha256 IS NULL
      AND item_count IS NULL AND error_code='REMOTE_ASSET_RECOVERY_SUBMISSION_UNKNOWN')
  ),
  UNIQUE (connection_uid, remote_task_uid, character_uid)
) WITHOUT ROWID;

CREATE INDEX idx_remote_asset_recoveries_character
ON remote_asset_recoveries(drama_uid, character_uid, created_at_epoch_ms, operation_uid);

CREATE TABLE remote_asset_recovery_items (
  operation_uid TEXT NOT NULL REFERENCES remote_asset_recoveries(operation_uid) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal)='integer' AND ordinal BETWEEN 0 AND 15),
  remote_relative_path TEXT NOT NULL CHECK (
    typeof(remote_relative_path)='text' AND length(CAST(remote_relative_path AS BLOB)) BETWEEN 1 AND 1024
    AND instr(remote_relative_path,char(0))=0 AND instr(remote_relative_path,'\\')=0
    AND substr(remote_relative_path,1,1)<>'/' AND instr(remote_relative_path,':')=0
    AND remote_relative_path NOT GLOB '*//*' AND remote_relative_path NOT IN ('.','..')
    AND remote_relative_path NOT GLOB './*' AND remote_relative_path NOT GLOB '../*'
    AND remote_relative_path NOT GLOB '*/./*' AND remote_relative_path NOT GLOB '*/../*'
    AND remote_relative_path NOT GLOB '*/.' AND remote_relative_path NOT GLOB '*/..'
    AND remote_relative_path NOT GLOB '*/'
  ),
  remote_sha256 TEXT NOT NULL CHECK (
    typeof(remote_sha256)='text' AND length(CAST(remote_sha256 AS BLOB))=64
    AND remote_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  remote_byte_length INTEGER NOT NULL CHECK (
    typeof(remote_byte_length)='integer' AND remote_byte_length BETWEEN 1 AND 16777216
  ),
  asset_uid TEXT NOT NULL UNIQUE REFERENCES assets(uid) ON DELETE RESTRICT,
  asset_version_uid TEXT NOT NULL UNIQUE REFERENCES asset_versions(uid) ON DELETE RESTRICT,
  logical_uri TEXT NOT NULL UNIQUE,
  relative_path TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (
    typeof(content_sha256)='text' AND length(CAST(content_sha256 AS BLOB))=64
    AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_length INTEGER NOT NULL CHECK (
    typeof(byte_length)='integer' AND byte_length BETWEEN 1 AND 16777216
  ),
  width INTEGER NOT NULL CHECK (typeof(width)='integer' AND width BETWEEN 256 AND 2048),
  height INTEGER NOT NULL CHECK (typeof(height)='integer' AND height BETWEEN 256 AND 2048),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000) CHECK (
    typeof(created_at_epoch_ms)='integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  PRIMARY KEY (operation_uid, ordinal),
  UNIQUE (operation_uid, remote_relative_path)
) WITHOUT ROWID;

CREATE TRIGGER v2_remote_asset_recoveries_validate_insert
BEFORE INSERT ON remote_asset_recoveries
BEGIN
  SELECT CASE WHEN
    NEW.state<>'reserved' OR NEW.error_code IS NOT NULL OR NEW.manifest_json IS NOT NULL
    OR NEW.manifest_sha256 IS NOT NULL OR NEW.item_count IS NOT NULL
    OR NEW.created_at_epoch_ms<>NEW.updated_at_epoch_ms
    OR NEW.created_at_epoch_ms<>unixepoch('now') * 1000
    OR remote_asset_recovery_request_sha256(NEW.request_json) IS NULL
    OR remote_asset_recovery_request_sha256(NEW.request_json)<>NEW.request_sha256
    OR character_candidate_source_sha256(NEW.source_json) IS NULL
    OR character_candidate_source_sha256(NEW.source_json)<>NEW.source_sha256
    OR json_extract(NEW.request_json,'$.operationUid') IS NOT NEW.operation_uid
    OR json_extract(NEW.request_json,'$.dramaUid') IS NOT NEW.drama_uid
    OR json_extract(NEW.request_json,'$.characterUid') IS NOT NEW.character_uid
    OR json_extract(NEW.request_json,'$.extractionResultUid') IS NOT NEW.extraction_result_uid
    OR json_extract(NEW.request_json,'$.connectionUid') IS NOT NEW.connection_uid
    OR json_extract(NEW.request_json,'$.connectionEvidenceSha256') IS NOT NEW.connection_evidence_sha256
    OR json_extract(NEW.request_json,'$.remoteTaskUid') IS NOT NEW.remote_task_uid
    OR json_extract(NEW.request_json,'$.characterFactId')
      IS NOT json_extract(NEW.source_json,'$.characterFactId')
    OR json_extract(NEW.source_json,'$.dramaUid') IS NOT NEW.drama_uid
    OR json_extract(NEW.source_json,'$.characterUid') IS NOT NEW.character_uid
    OR json_extract(NEW.source_json,'$.sourceSelectionUid') IS NOT NEW.source_selection_uid
    OR json_extract(NEW.source_json,'$.extractionResultUid') IS NOT NEW.extraction_result_uid
    OR json_extract(NEW.source_json,'$.extractionResultHash') IS NOT NEW.extraction_result_hash
    OR json_extract(NEW.source_json,'$.extractionEnvelopeHash') IS NOT NEW.extraction_envelope_hash
    OR json_extract(NEW.source_json,'$.extractionApprovalRef')
      IS NOT 'review:v1:' || NEW.extraction_review_uid
    OR NOT EXISTS (
      SELECT 1 FROM characters AS character
      JOIN dramas AS drama ON drama.id=character.drama_id
      WHERE character.uid=NEW.character_uid AND drama.uid=NEW.drama_uid
        AND character.deleted_at IS NULL AND drama.deleted_at IS NULL
        AND character.name=json_extract(NEW.source_json,'$.characterName')
        AND NULLIF(character.description,'') IS json_extract(NEW.source_json,'$.characterDescription')
        AND NULLIF(character.personality,'') IS json_extract(NEW.source_json,'$.characterPersonality')
        AND NULLIF(character.appearance,'') IS json_extract(NEW.source_json,'$.characterAppearance')
    )
    OR NOT EXISTS (
      SELECT 1 FROM narrative_results AS result
      JOIN narrative_review_events AS review ON review.uid=NEW.extraction_review_uid
      JOIN json_each(result.result_json,'$.output.characters') AS fact
      WHERE result.uid=NEW.extraction_result_uid AND result.drama_uid=NEW.drama_uid
        AND result.source_selection_uid=NEW.source_selection_uid
        AND result.result_type='extraction' AND result.status='approved'
        AND result.current_review_uid=NEW.extraction_review_uid
        AND result.result_hash=NEW.extraction_result_hash
        AND result.envelope_hash=NEW.extraction_envelope_hash
        AND review.result_uid=result.uid AND review.decision='approve'
        AND review.result_hash=result.result_hash AND review.envelope_hash=result.envelope_hash
        AND json_extract(fact.value,'$.factId')=json_extract(NEW.source_json,'$.characterFactId')
        AND json_extract(fact.value,'$.name')=json_extract(NEW.source_json,'$.characterFactName')
        AND json_extract(fact.value,'$.description')=json_extract(NEW.source_json,'$.characterFactDescription')
        AND json_extract(fact.value,'$.name')=json_extract(NEW.source_json,'$.characterName')
    )
    OR NOT EXISTS (
      SELECT 1 FROM remote_connections AS connection
      WHERE connection.uid=NEW.connection_uid AND connection.status='ready'
        AND mvp_benchmark_connection_evidence_sha256(
          connection.uid, connection.name, connection.host, connection.port,
          connection.username, connection.host_fingerprint, connection.credential_ref,
          connection.status, connection.created_at, connection.updated_at,
          connection.auth_method_v2, connection.comfy_host, connection.comfy_port,
          connection.remote_work_dir, connection.environment_report_json,
          connection.environment_checked_at_epoch_ms, connection.state_version
        )=NEW.connection_evidence_sha256
    )
  THEN RAISE(ABORT,'remote asset recovery invalid') END;
END;

CREATE TRIGGER v2_remote_asset_recoveries_reject_replacement
BEFORE INSERT ON remote_asset_recoveries
WHEN EXISTS (SELECT 1 FROM remote_asset_recoveries WHERE operation_uid=NEW.operation_uid)
BEGIN SELECT RAISE(ABORT,'remote asset recoveries cannot be replaced'); END;

CREATE TRIGGER v2_remote_asset_recovery_items_validate_insert
BEFORE INSERT ON remote_asset_recovery_items
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM remote_asset_recoveries AS recovery
    JOIN assets AS asset ON asset.uid=NEW.asset_uid
    JOIN asset_versions AS version ON version.uid=NEW.asset_version_uid
    WHERE recovery.operation_uid=NEW.operation_uid AND recovery.state='reserved'
      AND NEW.logical_uri='asset://characters/' || recovery.character_uid
        || '/remote-recoveries/' || recovery.operation_uid || '/' || NEW.ordinal
      AND NEW.relative_path='characters/' || recovery.character_uid
        || '/remote-recoveries/' || recovery.operation_uid || '/' || NEW.ordinal || '.png'
      AND asset.owner_type='character' AND asset.owner_uid=recovery.character_uid
      AND asset.asset_type='remote_recovery' AND asset.status='draft'
      AND asset.current_version_uid IS NULL
      AND version.asset_uid=asset.uid AND version.storage_provider='local'
      AND version.logical_uri=NEW.logical_uri AND version.relative_path=NEW.relative_path
      AND version.sha256=NEW.content_sha256 AND version.mime_type='image/png'
      AND version.width=NEW.width AND version.height=NEW.height AND version.status='ready'
  ) THEN RAISE(ABORT,'remote asset recovery item invalid') END;
END;

CREATE TRIGGER v2_remote_asset_recovery_items_reject_replacement
BEFORE INSERT ON remote_asset_recovery_items
WHEN EXISTS (
  SELECT 1 FROM remote_asset_recovery_items
  WHERE (operation_uid=NEW.operation_uid AND ordinal=NEW.ordinal)
    OR asset_uid=NEW.asset_uid OR asset_version_uid=NEW.asset_version_uid
    OR logical_uri=NEW.logical_uri OR relative_path=NEW.relative_path
)
BEGIN SELECT RAISE(ABORT,'remote asset recovery items cannot be replaced'); END;

CREATE TRIGGER v2_remote_asset_recoveries_validate_update
BEFORE UPDATE ON remote_asset_recoveries
WHEN
  OLD.state<>'reserved'
  OR NEW.operation_uid IS NOT OLD.operation_uid OR NEW.drama_uid IS NOT OLD.drama_uid
  OR NEW.character_uid IS NOT OLD.character_uid
  OR NEW.source_selection_uid IS NOT OLD.source_selection_uid
  OR NEW.extraction_result_uid IS NOT OLD.extraction_result_uid
  OR NEW.extraction_result_hash IS NOT OLD.extraction_result_hash
  OR NEW.extraction_envelope_hash IS NOT OLD.extraction_envelope_hash
  OR NEW.extraction_review_uid IS NOT OLD.extraction_review_uid
  OR NEW.connection_uid IS NOT OLD.connection_uid
  OR NEW.connection_evidence_sha256 IS NOT OLD.connection_evidence_sha256
  OR NEW.remote_task_uid IS NOT OLD.remote_task_uid
  OR NEW.request_json IS NOT OLD.request_json OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.source_json IS NOT OLD.source_json OR NEW.source_sha256 IS NOT OLD.source_sha256
  OR NEW.created_at_epoch_ms IS NOT OLD.created_at_epoch_ms
  OR NEW.updated_at_epoch_ms<>unixepoch('now') * 1000
  OR NEW.updated_at_epoch_ms<OLD.updated_at_epoch_ms
  OR NEW.state NOT IN ('succeeded','failed','submission_unknown')
  OR (NEW.state='succeeded' AND (
    NEW.error_code IS NOT NULL OR NEW.manifest_json IS NULL OR NEW.manifest_sha256 IS NULL
    OR remote_asset_recovery_manifest_sha256(NEW.manifest_json) IS NULL
    OR remote_asset_recovery_manifest_sha256(NEW.manifest_json)<>NEW.manifest_sha256
    OR json_extract(NEW.manifest_json,'$.remoteTaskUid') IS NOT OLD.remote_task_uid
    OR json_extract(NEW.manifest_json,'$.sourceManifestSha256') IS NULL
    OR NEW.item_count IS NOT json_array_length(NEW.manifest_json,'$.items')
    OR NEW.item_count<>(SELECT count(*) FROM remote_asset_recovery_items
      WHERE operation_uid=OLD.operation_uid)
  ))
  OR (NEW.state<>'succeeded' AND (
    NEW.manifest_json IS NOT NULL OR NEW.manifest_sha256 IS NOT NULL OR NEW.item_count IS NOT NULL
  ))
BEGIN SELECT RAISE(ABORT,'remote asset recovery transition invalid'); END;

CREATE TRIGGER v2_remote_asset_recovery_items_immutable_update
BEFORE UPDATE ON remote_asset_recovery_items
BEGIN SELECT RAISE(ABORT,'remote asset recovery items are immutable'); END;

CREATE TRIGGER v2_remote_asset_recovery_items_reject_delete
BEFORE DELETE ON remote_asset_recovery_items
BEGIN SELECT RAISE(ABORT,'remote asset recovery items are append-only'); END;

CREATE TRIGGER v2_remote_asset_recoveries_reject_delete
BEFORE DELETE ON remote_asset_recoveries
BEGIN SELECT RAISE(ABORT,'remote asset recoveries are append-only'); END;
