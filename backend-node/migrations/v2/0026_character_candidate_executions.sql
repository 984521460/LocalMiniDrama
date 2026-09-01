CREATE TABLE character_candidate_executions (
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
  profile_json TEXT NOT NULL CHECK (
    typeof(profile_json)='text' AND length(CAST(profile_json AS BLOB)) BETWEEN 2 AND 4096
    AND json_valid(profile_json)
  ),
  profile_sha256 TEXT NOT NULL CHECK (
    typeof(profile_sha256)='text' AND length(CAST(profile_sha256 AS BLOB))=64
    AND profile_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_json TEXT NOT NULL CHECK (
    typeof(manifest_json)='text' AND length(CAST(manifest_json AS BLOB)) BETWEEN 2 AND 4096
    AND json_valid(manifest_json)
  ),
  manifest_sha256 TEXT NOT NULL CHECK (
    typeof(manifest_sha256)='text' AND length(CAST(manifest_sha256 AS BLOB))=64
    AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('reserved','succeeded','failed','submission_unknown')),
  batch_uid TEXT REFERENCES character_candidate_batches(uid) ON DELETE RESTRICT,
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID',
      'CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE',
      'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN'
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
    (state='reserved' AND batch_uid IS NULL AND error_code IS NULL) OR
    (state='succeeded' AND batch_uid=operation_uid AND error_code IS NULL) OR
    (state='failed' AND batch_uid IS NULL AND error_code IN (
      'CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID',
      'CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE'
    )) OR
    (state='submission_unknown' AND batch_uid IS NULL
      AND error_code='CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN')
  )
) WITHOUT ROWID;

CREATE INDEX idx_character_candidate_executions_character
ON character_candidate_executions(character_uid, created_at_epoch_ms, operation_uid);

CREATE TABLE character_candidate_execution_items (
  operation_uid TEXT NOT NULL REFERENCES character_candidate_executions(operation_uid) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal)='integer' AND ordinal BETWEEN 0 AND 3),
  seed INTEGER NOT NULL CHECK (typeof(seed)='integer' AND seed BETWEEN 0 AND 4294967295),
  prompt_sha256 TEXT NOT NULL CHECK (
    typeof(prompt_sha256)='text' AND length(CAST(prompt_sha256 AS BLOB))=64
    AND prompt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  provider TEXT NOT NULL CHECK (
    typeof(provider)='text' AND length(CAST(provider AS BLOB)) BETWEEN 1 AND 128
    AND provider=lower(provider) AND provider NOT GLOB '*[^a-z0-9._-]*'
  ),
  model TEXT NOT NULL CHECK (
    typeof(model)='text' AND length(CAST(model AS BLOB)) BETWEEN 1 AND 128
    AND trim(model)=model AND instr(model,char(0))=0
  ),
  parameters_json TEXT NOT NULL CHECK (
    typeof(parameters_json)='text' AND length(CAST(parameters_json AS BLOB)) BETWEEN 2 AND 4096
    AND json_valid(parameters_json)
  ),
  parameters_sha256 TEXT NOT NULL CHECK (
    typeof(parameters_sha256)='text' AND length(CAST(parameters_sha256 AS BLOB))=64
    AND parameters_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_uid TEXT NOT NULL UNIQUE REFERENCES character_candidate_results(uid) ON DELETE RESTRICT,
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
  UNIQUE (operation_uid, content_sha256)
) WITHOUT ROWID;

CREATE TRIGGER v2_character_candidate_executions_validate_insert
BEFORE INSERT ON character_candidate_executions
BEGIN
  SELECT CASE WHEN
    NEW.state<>'reserved' OR NEW.batch_uid IS NOT NULL OR NEW.error_code IS NOT NULL
    OR NEW.created_at_epoch_ms<>NEW.updated_at_epoch_ms
    OR NEW.created_at_epoch_ms<>unixepoch('now') * 1000
    OR character_candidate_execution_request_sha256(NEW.request_json) IS NULL
    OR character_candidate_execution_request_sha256(NEW.request_json)<>NEW.request_sha256
    OR character_candidate_source_sha256(NEW.source_json) IS NULL
    OR character_candidate_source_sha256(NEW.source_json)<>NEW.source_sha256
    OR character_candidate_profile_sha256(NEW.profile_json) IS NULL
    OR character_candidate_profile_sha256(NEW.profile_json)<>NEW.profile_sha256
    OR character_candidate_manifest_sha256(NEW.manifest_json) IS NULL
    OR character_candidate_manifest_sha256(NEW.manifest_json)<>NEW.manifest_sha256
    OR json_extract(NEW.request_json,'$.operationUid') IS NOT NEW.operation_uid
    OR json_extract(NEW.request_json,'$.dramaUid') IS NOT NEW.drama_uid
    OR json_extract(NEW.request_json,'$.characterUid') IS NOT NEW.character_uid
    OR json_extract(NEW.request_json,'$.extractionResultUid') IS NOT NEW.extraction_result_uid
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
      SELECT 1
      FROM characters AS character
      JOIN dramas AS drama ON drama.id=character.drama_id
      WHERE character.uid=NEW.character_uid AND drama.uid=NEW.drama_uid
        AND character.deleted_at IS NULL AND drama.deleted_at IS NULL
        AND character.name=json_extract(NEW.source_json,'$.characterName')
        AND NULLIF(character.description,'') IS json_extract(NEW.source_json,'$.characterDescription')
        AND NULLIF(character.personality,'') IS json_extract(NEW.source_json,'$.characterPersonality')
        AND NULLIF(character.appearance,'') IS json_extract(NEW.source_json,'$.characterAppearance')
    )
    OR NOT EXISTS (
      SELECT 1
      FROM narrative_results AS result
      JOIN narrative_review_events AS review ON review.uid=NEW.extraction_review_uid
      JOIN json_each(result.result_json,'$.output.characters') AS fact
      WHERE result.uid=NEW.extraction_result_uid
        AND result.drama_uid=NEW.drama_uid
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
  THEN RAISE(ABORT,'character candidate execution invalid') END;
END;

CREATE TRIGGER v2_character_candidate_executions_reject_replacement
BEFORE INSERT ON character_candidate_executions
WHEN EXISTS (SELECT 1 FROM character_candidate_executions WHERE operation_uid=NEW.operation_uid)
BEGIN SELECT RAISE(ABORT,'character candidate executions cannot be replaced'); END;

CREATE TRIGGER v2_character_candidate_execution_items_validate_insert
BEFORE INSERT ON character_candidate_execution_items
BEGIN
  SELECT CASE WHEN
    character_candidate_parameters_sha256(NEW.parameters_json) IS NULL
    OR character_candidate_parameters_sha256(NEW.parameters_json)<>NEW.parameters_sha256
    OR character_candidate_prompt_sha256(
      (SELECT source_json FROM character_candidate_executions WHERE operation_uid=NEW.operation_uid),
      (SELECT request_json FROM character_candidate_executions WHERE operation_uid=NEW.operation_uid),
      NEW.ordinal
    ) IS NULL
    OR character_candidate_prompt_sha256(
      (SELECT source_json FROM character_candidate_executions WHERE operation_uid=NEW.operation_uid),
      (SELECT request_json FROM character_candidate_executions WHERE operation_uid=NEW.operation_uid),
      NEW.ordinal
    )<>NEW.prompt_sha256
    OR json_extract(NEW.parameters_json,'$.requestedSeed') IS NOT NEW.seed
    OR json_extract(NEW.parameters_json,'$.ordinal') IS NOT NEW.ordinal
    OR json_extract(NEW.parameters_json,'$.size') IS NOT (NEW.width || 'x' || NEW.height)
    OR NOT EXISTS (
      SELECT 1
      FROM character_candidate_executions AS execution
      JOIN character_candidate_batches AS batch ON batch.uid=execution.operation_uid
      JOIN character_candidate_results AS result
        ON result.batch_uid=batch.uid AND result.ordinal=NEW.ordinal
      JOIN asset_versions AS version ON version.uid=NEW.asset_version_uid
      JOIN assets AS asset ON asset.uid=NEW.asset_uid
      WHERE execution.operation_uid=NEW.operation_uid AND execution.state='reserved'
        AND NEW.seed=(json_extract(execution.request_json,'$.seed')
          + NEW.ordinal * 2654435761) % 4294967296
        AND NEW.width=json_extract(execution.request_json,'$.width')
        AND NEW.height=json_extract(execution.request_json,'$.height')
        AND NEW.logical_uri='asset://characters/' || execution.character_uid
          || '/candidate-batches/' || execution.operation_uid || '/' || NEW.ordinal
        AND NEW.relative_path='characters/' || execution.character_uid
          || '/candidate-batches/' || execution.operation_uid || '/' || NEW.ordinal || '.png'
        AND result.uid=NEW.candidate_uid AND result.asset_uid=NEW.asset_uid
        AND result.asset_version_uid=NEW.asset_version_uid
        AND result.logical_uri=NEW.logical_uri AND result.relative_path=NEW.relative_path
        AND result.content_sha256=NEW.content_sha256 AND result.media_type='image/png'
        AND result.width=NEW.width AND result.height=NEW.height
        AND version.asset_uid=NEW.asset_uid AND version.logical_uri=NEW.logical_uri
        AND version.relative_path=NEW.relative_path AND version.sha256=NEW.content_sha256
        AND version.mime_type='image/png' AND version.width=NEW.width
        AND version.height=NEW.height AND version.status='ready'
        AND asset.owner_type='character' AND asset.owner_uid=execution.character_uid
        AND asset.asset_type='character_candidate' AND asset.current_version_uid=version.uid
        AND asset.status='ready'
    )
  THEN RAISE(ABORT,'character candidate execution item invalid') END;
END;

CREATE TRIGGER v2_character_candidate_execution_items_reject_replacement
BEFORE INSERT ON character_candidate_execution_items
WHEN EXISTS (
  SELECT 1 FROM character_candidate_execution_items
  WHERE (operation_uid=NEW.operation_uid AND ordinal=NEW.ordinal)
    OR candidate_uid=NEW.candidate_uid OR asset_uid=NEW.asset_uid
    OR asset_version_uid=NEW.asset_version_uid OR logical_uri=NEW.logical_uri
    OR relative_path=NEW.relative_path
)
BEGIN SELECT RAISE(ABORT,'character candidate execution items cannot be replaced'); END;

CREATE TRIGGER v2_character_candidate_executions_validate_update
BEFORE UPDATE ON character_candidate_executions
WHEN
  OLD.state<>'reserved'
  OR NEW.operation_uid IS NOT OLD.operation_uid
  OR NEW.drama_uid IS NOT OLD.drama_uid
  OR NEW.character_uid IS NOT OLD.character_uid
  OR NEW.source_selection_uid IS NOT OLD.source_selection_uid
  OR NEW.extraction_result_uid IS NOT OLD.extraction_result_uid
  OR NEW.extraction_result_hash IS NOT OLD.extraction_result_hash
  OR NEW.extraction_envelope_hash IS NOT OLD.extraction_envelope_hash
  OR NEW.extraction_review_uid IS NOT OLD.extraction_review_uid
  OR NEW.request_json IS NOT OLD.request_json OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.source_json IS NOT OLD.source_json OR NEW.source_sha256 IS NOT OLD.source_sha256
  OR NEW.profile_json IS NOT OLD.profile_json OR NEW.profile_sha256 IS NOT OLD.profile_sha256
  OR NEW.manifest_json IS NOT OLD.manifest_json OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
  OR NEW.created_at_epoch_ms IS NOT OLD.created_at_epoch_ms
  OR NEW.updated_at_epoch_ms<>unixepoch('now') * 1000
  OR NEW.updated_at_epoch_ms<OLD.updated_at_epoch_ms
  OR NEW.state NOT IN ('succeeded','failed','submission_unknown')
  OR (
    NEW.state='succeeded' AND (
      NEW.batch_uid IS NOT OLD.operation_uid OR NEW.error_code IS NOT NULL
      OR (SELECT count(*) FROM character_candidate_execution_items
          WHERE operation_uid=OLD.operation_uid)<>4
      OR NOT EXISTS (
        SELECT 1 FROM character_candidate_batches AS batch
        WHERE batch.uid=OLD.operation_uid AND batch.character_uid=OLD.character_uid
          AND batch.prompt_semantic_uid=OLD.extraction_result_uid
          AND batch.profile_uid=json_extract(OLD.profile_json,'$.uid')
          AND batch.manifest_uid=json_extract(OLD.manifest_json,'$.uid')
          AND batch.width=json_extract(OLD.request_json,'$.width')
          AND batch.height=json_extract(OLD.request_json,'$.height')
          AND batch.seed=json_extract(OLD.request_json,'$.seed')
          AND batch.candidate_count=4
      )
    )
  )
BEGIN SELECT RAISE(ABORT,'character candidate execution transition invalid'); END;

CREATE TRIGGER v2_character_candidate_execution_items_immutable_update
BEFORE UPDATE ON character_candidate_execution_items
BEGIN SELECT RAISE(ABORT,'character candidate execution items are immutable'); END;

CREATE TRIGGER v2_character_candidate_execution_items_reject_delete
BEFORE DELETE ON character_candidate_execution_items
BEGIN SELECT RAISE(ABORT,'character candidate execution items are append-only'); END;

CREATE TRIGGER v2_character_candidate_executions_reject_delete
BEFORE DELETE ON character_candidate_executions
BEGIN SELECT RAISE(ABORT,'character candidate executions are append-only'); END;
