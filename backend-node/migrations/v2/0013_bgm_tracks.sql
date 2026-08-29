-- Phase 8 BGM candidates. Every persisted track binds one same-drama ready
-- local AssetVersion to explicit, secret-free license metadata. Source paths
-- are represented only by the portable AssetVersion locator; user absolute
-- paths are never stored in the license projection.

CREATE TABLE bgm_licenses (
  uid TEXT PRIMARY KEY NOT NULL,
  track_uid TEXT NOT NULL UNIQUE
    REFERENCES bgm_tracks(uid) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  schema_version TEXT NOT NULL CHECK (schema_version='bgm-license.v1'),
  basis TEXT NOT NULL CHECK (basis IN ('user-owned','licensed','public-domain','provider-grant')),
  attestation_kind TEXT NOT NULL CHECK (attestation_kind='user-attestation'),
  commercial_use_allowed INTEGER NOT NULL CHECK (commercial_use_allowed IN (0,1)),
  derivatives_allowed INTEGER NOT NULL CHECK (derivatives_allowed IN (0,1)),
  attribution_required INTEGER NOT NULL CHECK (attribution_required=0),
  attribution_text TEXT CHECK (attribution_text IS NULL),
  attested_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(attested_at_epoch_ms)='integer'
    AND attested_at_epoch_ms BETWEEN 0 AND 253402300799999
  )
) WITHOUT ROWID;

CREATE TRIGGER v2_bgm_licenses_validate_contract
BEFORE INSERT ON bgm_licenses
WHEN bgm_license_valid(
  NEW.uid,
  NEW.track_uid,
  NEW.basis,
  NEW.attestation_kind,
  NEW.commercial_use_allowed,
  NEW.derivatives_allowed,
  NEW.attribution_required,
  NEW.attribution_text,
  NEW.attested_at_epoch_ms
) IS NOT 1
BEGIN
  SELECT RAISE(ABORT,'BGM license contract is invalid');
END;

CREATE TRIGGER v2_bgm_licenses_reject_replacement
BEFORE INSERT ON bgm_licenses
WHEN EXISTS (SELECT 1 FROM bgm_licenses WHERE uid=NEW.uid)
BEGIN
  SELECT RAISE(ABORT,'BGM license replacement is forbidden');
END;

CREATE TRIGGER v2_bgm_licenses_immutable_update
BEFORE UPDATE ON bgm_licenses
BEGIN
  SELECT RAISE(ABORT,'BGM licenses are immutable');
END;

CREATE TRIGGER v2_bgm_licenses_immutable_delete
BEFORE DELETE ON bgm_licenses
BEGIN
  SELECT RAISE(ABORT,'BGM licenses are append-only');
END;

CREATE TABLE bgm_tracks (
  uid TEXT PRIMARY KEY NOT NULL,
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind='local-import'),
  provider_id TEXT NOT NULL CHECK (provider_id='local-library'),
  asset_uid TEXT NOT NULL REFERENCES assets(uid) ON DELETE RESTRICT,
  asset_version_uid TEXT NOT NULL UNIQUE REFERENCES asset_versions(uid) ON DELETE RESTRICT,

  license_uid TEXT NOT NULL REFERENCES bgm_licenses(uid) ON DELETE RESTRICT,
  license_basis TEXT NOT NULL CHECK (license_basis IN ('user-owned','licensed','public-domain','provider-grant')),
  commercial_use_allowed INTEGER NOT NULL CHECK (commercial_use_allowed IN (0,1)),
  derivatives_allowed INTEGER NOT NULL CHECK (derivatives_allowed IN (0,1)),
  attribution_required INTEGER NOT NULL CHECK (attribution_required IN (0,1)),
  attribution_text TEXT,
  license_attested_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(license_attested_at_epoch_ms)='integer'
    AND license_attested_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),

  version_storage_provider TEXT NOT NULL,
  version_logical_uri TEXT NOT NULL,
  version_relative_path TEXT NOT NULL,
  version_sha256 TEXT NOT NULL,
  version_mime_type TEXT NOT NULL,
  version_width INTEGER,
  version_height INTEGER,
  version_duration_ms INTEGER NOT NULL,
  version_parent_uid TEXT,
  version_status TEXT NOT NULL,
  version_created_at TEXT NOT NULL,
  created_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(created_at_epoch_ms)='integer'
    AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
    AND created_at_epoch_ms>=license_attested_at_epoch_ms
  )
) WITHOUT ROWID;

CREATE INDEX idx_v2_bgm_tracks_drama
  ON bgm_tracks(drama_uid,created_at_epoch_ms,uid);

CREATE TRIGGER v2_bgm_tracks_validate_contract
BEFORE INSERT ON bgm_tracks
WHEN bgm_track_valid(
  NEW.uid,
  NEW.drama_uid,
  NEW.title,
  NEW.source_kind,
  NEW.provider_id,
  NEW.asset_version_uid,
  NEW.asset_uid,
  NEW.version_storage_provider,
  NEW.version_logical_uri,
  NEW.version_relative_path,
  NEW.version_sha256,
  NEW.version_mime_type,
  NEW.version_width,
  NEW.version_height,
  NEW.version_duration_ms,
  NEW.version_parent_uid,
  NEW.version_status,
  NEW.version_created_at,
  NEW.license_uid,
  NEW.license_basis,
  NEW.commercial_use_allowed,
  NEW.derivatives_allowed,
  NEW.attribution_required,
  NEW.attribution_text,
  NEW.license_attested_at_epoch_ms,
  NEW.created_at_epoch_ms
) IS NOT 1
BEGIN
  SELECT RAISE(ABORT,'BGM track contract is invalid');
END;

CREATE TRIGGER v2_bgm_tracks_validate_references
BEFORE INSERT ON bgm_tracks
WHEN NOT EXISTS (
  SELECT 1
  FROM assets AS asset
  JOIN asset_versions AS version ON version.uid=NEW.asset_version_uid
  WHERE asset.uid=NEW.asset_uid
    AND asset.owner_type='drama'
    AND asset.owner_uid=NEW.drama_uid
    AND asset.asset_type='bgm'
    AND asset.status='ready'
    AND version.asset_uid=asset.uid
    AND version.storage_provider=NEW.version_storage_provider
    AND version.logical_uri=NEW.version_logical_uri
    AND version.relative_path=NEW.version_relative_path
    AND version.sha256=NEW.version_sha256
    AND version.mime_type=NEW.version_mime_type
    AND version.width IS NEW.version_width
    AND version.height IS NEW.version_height
    AND version.duration_ms=NEW.version_duration_ms
    AND version.parent_uid IS NEW.version_parent_uid
    AND version.status=NEW.version_status
    AND version.created_at=NEW.version_created_at
)
BEGIN
  SELECT RAISE(ABORT,'BGM track source evidence is invalid');
END;

CREATE TRIGGER v2_bgm_tracks_validate_license_reference
BEFORE INSERT ON bgm_tracks
WHEN NOT EXISTS (
  SELECT 1 FROM bgm_licenses AS license
  WHERE license.uid=NEW.license_uid
    AND license.track_uid=NEW.uid
    AND license.schema_version='bgm-license.v1'
    AND license.basis=NEW.license_basis
    AND license.attestation_kind='user-attestation'
    AND license.commercial_use_allowed=NEW.commercial_use_allowed
    AND license.derivatives_allowed=NEW.derivatives_allowed
    AND license.attribution_required=NEW.attribution_required
    AND license.attribution_text IS NEW.attribution_text
    AND license.attested_at_epoch_ms=NEW.license_attested_at_epoch_ms
)
BEGIN
  SELECT RAISE(ABORT,'BGM license evidence is invalid');
END;

CREATE TRIGGER v2_bgm_tracks_reject_replacement
BEFORE INSERT ON bgm_tracks
WHEN EXISTS (
  SELECT 1 FROM bgm_tracks
  WHERE uid=NEW.uid OR asset_version_uid=NEW.asset_version_uid
)
BEGIN
  SELECT RAISE(ABORT,'BGM track replacement is forbidden');
END;

CREATE TRIGGER v2_bgm_license_identity_consistent
BEFORE INSERT ON bgm_tracks
WHEN EXISTS (
  SELECT 1 FROM bgm_tracks
  WHERE license_uid=NEW.license_uid
    AND (
      license_basis IS NOT NEW.license_basis
      OR commercial_use_allowed IS NOT NEW.commercial_use_allowed
      OR derivatives_allowed IS NOT NEW.derivatives_allowed
      OR attribution_required IS NOT NEW.attribution_required
      OR attribution_text IS NOT NEW.attribution_text
      OR license_attested_at_epoch_ms IS NOT NEW.license_attested_at_epoch_ms
    )
)
BEGIN
  SELECT RAISE(ABORT,'BGM license identity is inconsistent');
END;

CREATE TRIGGER v2_bgm_tracks_immutable_update
BEFORE UPDATE ON bgm_tracks
BEGIN
  SELECT RAISE(ABORT,'BGM tracks are immutable');
END;

CREATE TRIGGER v2_bgm_tracks_immutable_delete
BEFORE DELETE ON bgm_tracks
BEGIN
  SELECT RAISE(ABORT,'BGM tracks are append-only');
END;

CREATE TRIGGER v2_bgm_assets_frozen
BEFORE UPDATE OF uid,owner_type,owner_uid,asset_type,status ON assets
WHEN EXISTS (SELECT 1 FROM bgm_tracks WHERE asset_uid=OLD.uid)
BEGIN
  SELECT RAISE(ABORT,'BGM asset evidence is frozen');
END;

CREATE TRIGGER v2_bgm_assets_delete_frozen
BEFORE DELETE ON assets
WHEN EXISTS (SELECT 1 FROM bgm_tracks WHERE asset_uid=OLD.uid)
BEGIN
  SELECT RAISE(ABORT,'BGM asset evidence is append-only');
END;

CREATE TRIGGER v2_bgm_assets_reject_replacement
BEFORE INSERT ON assets
WHEN EXISTS (
  SELECT 1 FROM bgm_tracks AS track
  JOIN assets AS existing ON existing.uid=track.asset_uid
  WHERE existing.uid=NEW.uid
)
BEGIN
  SELECT RAISE(ABORT,'BGM asset replacement is forbidden');
END;

CREATE TRIGGER v2_bgm_asset_versions_frozen
BEFORE UPDATE ON asset_versions
WHEN EXISTS (SELECT 1 FROM bgm_tracks WHERE asset_version_uid=OLD.uid)
BEGIN
  SELECT RAISE(ABORT,'BGM AssetVersion evidence is frozen');
END;

CREATE TRIGGER v2_bgm_asset_versions_delete_frozen
BEFORE DELETE ON asset_versions
WHEN EXISTS (SELECT 1 FROM bgm_tracks WHERE asset_version_uid=OLD.uid)
BEGIN
  SELECT RAISE(ABORT,'BGM AssetVersion evidence is append-only');
END;

CREATE TRIGGER v2_bgm_asset_versions_reject_replacement
BEFORE INSERT ON asset_versions
WHEN EXISTS (
  SELECT 1
  FROM bgm_tracks AS track
  JOIN asset_versions AS existing ON existing.uid=track.asset_version_uid
  WHERE existing.uid=NEW.uid
    OR existing.logical_uri=NEW.logical_uri
    OR (
      existing.storage_provider=NEW.storage_provider
      AND existing.relative_path=NEW.relative_path
    )
)
BEGIN
  SELECT RAISE(ABORT,'BGM AssetVersion replacement is forbidden');
END;
