CREATE TABLE local_recovery_packages (
  uid TEXT PRIMARY KEY NOT NULL,
  drama_uid TEXT NOT NULL REFERENCES dramas(uid),
  character_uid TEXT NOT NULL REFERENCES characters(uid),
  package_sha256 TEXT NOT NULL CHECK(length(package_sha256)=64 AND package_sha256 NOT GLOB '*[^0-9a-f]*'),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  remote_task_uid TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  source_sha256 TEXT NOT NULL,
  items_json TEXT NOT NULL CHECK(json_valid(items_json) AND json_array_length(items_json) BETWEEN 1 AND 16),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(character_uid, package_sha256)
);

CREATE TRIGGER local_recovery_packages_validate_insert
BEFORE INSERT ON local_recovery_packages
BEGIN
  SELECT CASE WHEN
    character_candidate_source_sha256(NEW.source_json) IS NULL
    OR character_candidate_source_sha256(NEW.source_json) IS NOT NEW.source_sha256
    OR json_extract(NEW.source_json,'$.characterUid') IS NOT NEW.character_uid
    OR json_extract(NEW.source_json,'$.dramaUid') IS NOT NEW.drama_uid
    OR NOT EXISTS (
      SELECT 1 FROM narrative_results r WHERE
      r.uid=json_extract(NEW.source_json,'$.extractionResultUid')
      AND r.drama_uid=NEW.drama_uid AND r.result_type='extraction' AND r.status='approved'
      AND r.result_hash=json_extract(NEW.source_json,'$.extractionResultHash')
      AND r.envelope_hash=json_extract(NEW.source_json,'$.extractionEnvelopeHash')
      AND 'review:v1:' || r.current_review_uid=json_extract(NEW.source_json,'$.extractionApprovalRef')
    )
    OR NOT EXISTS (
      SELECT 1 FROM characters c JOIN dramas d ON c.drama_id=d.id
      WHERE c.uid=NEW.character_uid AND d.uid=NEW.drama_uid
      AND c.deleted_at IS NULL AND d.deleted_at IS NULL
      AND c.name=json_extract(NEW.source_json,'$.characterName')
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.items_json) item
      WHERE NOT EXISTS (
        SELECT 1 FROM assets a JOIN asset_versions v ON v.asset_uid=a.uid
        WHERE a.uid=json_extract(item.value,'$.assetUid')
        AND v.uid=json_extract(item.value,'$.assetVersionUid')
        AND a.owner_type='character' AND a.owner_uid=NEW.character_uid
        AND a.asset_type='local_recovery' AND a.status='draft'
        AND a.current_version_uid IS NULL AND v.storage_provider='local'
        AND v.status='ready' AND v.mime_type='image/png'
        AND v.sha256=json_extract(item.value,'$.sha256')
        AND v.relative_path=json_extract(item.value,'$.relativePath')
      )
    )
  THEN RAISE(ABORT,'local recovery package binding invalid') END;
END;
CREATE TRIGGER local_recovery_packages_no_update BEFORE UPDATE ON local_recovery_packages
BEGIN SELECT RAISE(ABORT,'local recovery packages are immutable'); END;
CREATE TRIGGER local_recovery_packages_no_delete BEFORE DELETE ON local_recovery_packages
BEGIN SELECT RAISE(ABORT,'local recovery packages are append-only'); END;
CREATE TRIGGER local_recovery_packages_no_replace BEFORE INSERT ON local_recovery_packages
WHEN EXISTS(SELECT 1 FROM local_recovery_packages WHERE uid=NEW.uid OR
  (character_uid=NEW.character_uid AND package_sha256=NEW.package_sha256))
BEGIN SELECT RAISE(ABORT,'local recovery package already exists'); END;
