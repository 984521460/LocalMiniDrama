CREATE TABLE character_identity_versions (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT CHECK (
    typeof(character_uid) = 'text' AND length(CAST(character_uid AS BLOB)) = 36 AND
    character_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  parent_uid TEXT REFERENCES character_identity_versions(uid) ON DELETE RESTRICT,
  metadata_json TEXT NOT NULL CHECK (
    typeof(metadata_json) = 'text' AND
    length(CAST(metadata_json AS BLOB)) BETWEEN 2 AND 32768 AND
    CASE WHEN json_valid(metadata_json) THEN json_type(metadata_json) = 'object' ELSE 0 END
  ),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
  ) CHECK (
    typeof(created_at_epoch_ms) = 'integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (parent_uid IS NULL OR parent_uid <> uid)
) WITHOUT ROWID;

CREATE TABLE character_appearance_versions (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  identity_version_uid TEXT NOT NULL REFERENCES character_identity_versions(uid) ON DELETE RESTRICT,
  parent_uid TEXT REFERENCES character_appearance_versions(uid) ON DELETE RESTRICT,
  metadata_json TEXT NOT NULL CHECK (
    typeof(metadata_json) = 'text' AND
    length(CAST(metadata_json AS BLOB)) BETWEEN 2 AND 32768 AND
    CASE WHEN json_valid(metadata_json) THEN json_type(metadata_json) = 'object' ELSE 0 END
  ),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
  ) CHECK (
    typeof(created_at_epoch_ms) = 'integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (parent_uid IS NULL OR parent_uid <> uid)
) WITHOUT ROWID;

CREATE TABLE character_costume_versions (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  identity_version_uid TEXT NOT NULL REFERENCES character_identity_versions(uid) ON DELETE RESTRICT,
  parent_uid TEXT REFERENCES character_costume_versions(uid) ON DELETE RESTRICT,
  metadata_json TEXT NOT NULL CHECK (
    typeof(metadata_json) = 'text' AND
    length(CAST(metadata_json AS BLOB)) BETWEEN 2 AND 32768 AND
    CASE WHEN json_valid(metadata_json) THEN json_type(metadata_json) = 'object' ELSE 0 END
  ),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
  ) CHECK (
    typeof(created_at_epoch_ms) = 'integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (parent_uid IS NULL OR parent_uid <> uid)
) WITHOUT ROWID;

CREATE TABLE character_voice_versions (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  identity_version_uid TEXT NOT NULL REFERENCES character_identity_versions(uid) ON DELETE RESTRICT,
  parent_uid TEXT REFERENCES character_voice_versions(uid) ON DELETE RESTRICT,
  metadata_json TEXT NOT NULL CHECK (
    typeof(metadata_json) = 'text' AND
    length(CAST(metadata_json AS BLOB)) BETWEEN 2 AND 32768 AND
    CASE WHEN json_valid(metadata_json) THEN json_type(metadata_json) = 'object' ELSE 0 END
  ),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
  ) CHECK (
    typeof(created_at_epoch_ms) = 'integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (parent_uid IS NULL OR parent_uid <> uid)
) WITHOUT ROWID;

CREATE INDEX idx_v2_character_identity_versions_owner
  ON character_identity_versions(character_uid, created_at_epoch_ms, uid);
CREATE INDEX idx_v2_character_appearance_versions_owner
  ON character_appearance_versions(character_uid, identity_version_uid, created_at_epoch_ms, uid);
CREATE INDEX idx_v2_character_costume_versions_owner
  ON character_costume_versions(character_uid, identity_version_uid, created_at_epoch_ms, uid);
CREATE INDEX idx_v2_character_voice_versions_owner
  ON character_voice_versions(character_uid, identity_version_uid, created_at_epoch_ms, uid);

CREATE TRIGGER v2_character_identity_versions_validate_parent
BEFORE INSERT ON character_identity_versions
WHEN NEW.parent_uid IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM character_identity_versions
  WHERE uid = NEW.parent_uid AND character_uid = NEW.character_uid
)
BEGIN
  SELECT RAISE(ABORT, 'character identity parent must belong to the same character');
END;

CREATE TRIGGER v2_character_appearance_versions_validate_owner
BEFORE INSERT ON character_appearance_versions
WHEN NOT EXISTS (
  SELECT 1 FROM character_identity_versions
  WHERE uid = NEW.identity_version_uid AND character_uid = NEW.character_uid
)
OR (
  NEW.parent_uid IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM character_appearance_versions
    WHERE uid = NEW.parent_uid
      AND character_uid = NEW.character_uid
      AND identity_version_uid = NEW.identity_version_uid
  )
)
BEGIN
  SELECT RAISE(ABORT, 'character appearance owner is invalid');
END;

CREATE TRIGGER v2_character_costume_versions_validate_owner
BEFORE INSERT ON character_costume_versions
WHEN NOT EXISTS (
  SELECT 1 FROM character_identity_versions
  WHERE uid = NEW.identity_version_uid AND character_uid = NEW.character_uid
)
OR (
  NEW.parent_uid IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM character_costume_versions
    WHERE uid = NEW.parent_uid
      AND character_uid = NEW.character_uid
      AND identity_version_uid = NEW.identity_version_uid
  )
)
BEGIN
  SELECT RAISE(ABORT, 'character costume owner is invalid');
END;

CREATE TRIGGER v2_character_voice_versions_validate_owner
BEFORE INSERT ON character_voice_versions
WHEN NOT EXISTS (
  SELECT 1 FROM character_identity_versions
  WHERE uid = NEW.identity_version_uid AND character_uid = NEW.character_uid
)
OR (
  NEW.parent_uid IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM character_voice_versions
    WHERE uid = NEW.parent_uid
      AND character_uid = NEW.character_uid
      AND identity_version_uid = NEW.identity_version_uid
  )
)
BEGIN
  SELECT RAISE(ABORT, 'character voice owner is invalid');
END;

CREATE TRIGGER v2_character_identity_versions_validate_metadata
BEFORE INSERT ON character_identity_versions
WHEN typeof(NEW.metadata_json) = 'text'
  AND length(CAST(NEW.metadata_json AS BLOB)) BETWEEN 2 AND 32768
  AND json_valid(NEW.metadata_json)
  AND json_type(NEW.metadata_json) = 'object'
  AND (
    (SELECT count(*) FROM json_each(NEW.metadata_json)) <> 3
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.metadata_json)
      WHERE key NOT IN ('name', 'visualSignature', 'colorAnchors')
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.name'), '') <> 'text'
    OR length(json_extract(NEW.metadata_json, '$.name')) NOT BETWEEN 1 AND 120
    OR instr(json_extract(NEW.metadata_json, '$.name'), char(0)) > 0
    OR json_extract(NEW.metadata_json, '$.name') <> trim(
      json_extract(NEW.metadata_json, '$.name'),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(160) || char(5760) || char(8192) || char(8193) || char(8194)
      || char(8195) || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232) || char(8233)
      || char(8239) || char(8287) || char(12288) || char(65279)
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.visualSignature'), '') <> 'text'
    OR length(json_extract(NEW.metadata_json, '$.visualSignature')) NOT BETWEEN 1 AND 4000
    OR instr(json_extract(NEW.metadata_json, '$.visualSignature'), char(0)) > 0
    OR json_extract(NEW.metadata_json, '$.visualSignature') <> trim(
      json_extract(NEW.metadata_json, '$.visualSignature'),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(160) || char(5760) || char(8192) || char(8193) || char(8194)
      || char(8195) || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232) || char(8233)
      || char(8239) || char(8287) || char(12288) || char(65279)
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.colorAnchors'), '') <> 'array'
    OR json_array_length(NEW.metadata_json, '$.colorAnchors') > 16
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.metadata_json, '$.colorAnchors')
      WHERE type <> 'text'
        OR length(CAST(value AS BLOB)) <> 7
        OR value NOT GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    )
    OR (
      SELECT count(*) <> count(DISTINCT value)
      FROM json_each(NEW.metadata_json, '$.colorAnchors')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'character identity metadata is invalid');
END;

CREATE TRIGGER v2_character_appearance_versions_validate_metadata
BEFORE INSERT ON character_appearance_versions
WHEN typeof(NEW.metadata_json) = 'text'
  AND length(CAST(NEW.metadata_json AS BLOB)) BETWEEN 2 AND 32768
  AND json_valid(NEW.metadata_json)
  AND json_type(NEW.metadata_json) = 'object'
  AND (
    (SELECT count(*) FROM json_each(NEW.metadata_json)) <> 3
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.metadata_json)
      WHERE key NOT IN ('name', 'description', 'colorAnchors')
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.name'), '') <> 'text'
    OR length(json_extract(NEW.metadata_json, '$.name')) NOT BETWEEN 1 AND 120
    OR instr(json_extract(NEW.metadata_json, '$.name'), char(0)) > 0
    OR json_extract(NEW.metadata_json, '$.name') <> trim(
      json_extract(NEW.metadata_json, '$.name'),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(160) || char(5760) || char(8192) || char(8193) || char(8194)
      || char(8195) || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232) || char(8233)
      || char(8239) || char(8287) || char(12288) || char(65279)
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.description'), '') <> 'text'
    OR length(json_extract(NEW.metadata_json, '$.description')) NOT BETWEEN 1 AND 4000
    OR instr(json_extract(NEW.metadata_json, '$.description'), char(0)) > 0
    OR json_extract(NEW.metadata_json, '$.description') <> trim(
      json_extract(NEW.metadata_json, '$.description'),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(160) || char(5760) || char(8192) || char(8193) || char(8194)
      || char(8195) || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232) || char(8233)
      || char(8239) || char(8287) || char(12288) || char(65279)
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.colorAnchors'), '') <> 'array'
    OR json_array_length(NEW.metadata_json, '$.colorAnchors') > 16
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.metadata_json, '$.colorAnchors')
      WHERE type <> 'text'
        OR length(CAST(value AS BLOB)) <> 7
        OR value NOT GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    )
    OR (
      SELECT count(*) <> count(DISTINCT value)
      FROM json_each(NEW.metadata_json, '$.colorAnchors')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'character appearance metadata is invalid');
END;

CREATE TRIGGER v2_character_costume_versions_validate_metadata
BEFORE INSERT ON character_costume_versions
WHEN typeof(NEW.metadata_json) = 'text'
  AND length(CAST(NEW.metadata_json AS BLOB)) BETWEEN 2 AND 32768
  AND json_valid(NEW.metadata_json)
  AND json_type(NEW.metadata_json) = 'object'
  AND (
    (SELECT count(*) FROM json_each(NEW.metadata_json)) <> 3
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.metadata_json)
      WHERE key NOT IN ('name', 'description', 'colorAnchors')
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.name'), '') <> 'text'
    OR length(json_extract(NEW.metadata_json, '$.name')) NOT BETWEEN 1 AND 120
    OR instr(json_extract(NEW.metadata_json, '$.name'), char(0)) > 0
    OR json_extract(NEW.metadata_json, '$.name') <> trim(
      json_extract(NEW.metadata_json, '$.name'),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(160) || char(5760) || char(8192) || char(8193) || char(8194)
      || char(8195) || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232) || char(8233)
      || char(8239) || char(8287) || char(12288) || char(65279)
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.description'), '') <> 'text'
    OR length(json_extract(NEW.metadata_json, '$.description')) NOT BETWEEN 1 AND 4000
    OR instr(json_extract(NEW.metadata_json, '$.description'), char(0)) > 0
    OR json_extract(NEW.metadata_json, '$.description') <> trim(
      json_extract(NEW.metadata_json, '$.description'),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(160) || char(5760) || char(8192) || char(8193) || char(8194)
      || char(8195) || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232) || char(8233)
      || char(8239) || char(8287) || char(12288) || char(65279)
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.colorAnchors'), '') <> 'array'
    OR json_array_length(NEW.metadata_json, '$.colorAnchors') > 16
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.metadata_json, '$.colorAnchors')
      WHERE type <> 'text'
        OR length(CAST(value AS BLOB)) <> 7
        OR value NOT GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    )
    OR (
      SELECT count(*) <> count(DISTINCT value)
      FROM json_each(NEW.metadata_json, '$.colorAnchors')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'character costume metadata is invalid');
END;

CREATE TRIGGER v2_character_voice_versions_validate_metadata
BEFORE INSERT ON character_voice_versions
WHEN typeof(NEW.metadata_json) = 'text'
  AND length(CAST(NEW.metadata_json AS BLOB)) BETWEEN 2 AND 32768
  AND json_valid(NEW.metadata_json)
  AND json_type(NEW.metadata_json) = 'object'
  AND (
    (SELECT count(*) FROM json_each(NEW.metadata_json)) <> 3
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.metadata_json)
      WHERE key NOT IN ('name', 'language', 'style')
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.name'), '') <> 'text'
    OR length(json_extract(NEW.metadata_json, '$.name')) NOT BETWEEN 1 AND 120
    OR instr(json_extract(NEW.metadata_json, '$.name'), char(0)) > 0
    OR json_extract(NEW.metadata_json, '$.name') <> trim(
      json_extract(NEW.metadata_json, '$.name'),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(160) || char(5760) || char(8192) || char(8193) || char(8194)
      || char(8195) || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232) || char(8233)
      || char(8239) || char(8287) || char(12288) || char(65279)
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.language'), '') <> 'text'
    OR NOT (
      json_extract(NEW.metadata_json, '$.language') GLOB '[a-z][a-z]'
      OR json_extract(NEW.metadata_json, '$.language') GLOB '[a-z][a-z][a-z]'
      OR json_extract(NEW.metadata_json, '$.language') GLOB '[a-z][a-z]-[A-Z][A-Z]'
      OR json_extract(NEW.metadata_json, '$.language') GLOB '[a-z][a-z][a-z]-[A-Z][A-Z]'
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.style'), '') <> 'text'
    OR length(json_extract(NEW.metadata_json, '$.style')) NOT BETWEEN 1 AND 1000
    OR instr(json_extract(NEW.metadata_json, '$.style'), char(0)) > 0
    OR json_extract(NEW.metadata_json, '$.style') <> trim(
      json_extract(NEW.metadata_json, '$.style'),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(160) || char(5760) || char(8192) || char(8193) || char(8194)
      || char(8195) || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232) || char(8233)
      || char(8239) || char(8287) || char(12288) || char(65279)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'character voice metadata is invalid');
END;

CREATE TRIGGER v2_character_identity_versions_reject_replacement
BEFORE INSERT ON character_identity_versions
WHEN EXISTS (SELECT 1 FROM character_identity_versions WHERE uid = NEW.uid)
BEGIN
  SELECT RAISE(ABORT, 'character identity replacement is forbidden');
END;

CREATE TRIGGER v2_character_appearance_versions_reject_replacement
BEFORE INSERT ON character_appearance_versions
WHEN EXISTS (SELECT 1 FROM character_appearance_versions WHERE uid = NEW.uid)
BEGIN
  SELECT RAISE(ABORT, 'character appearance replacement is forbidden');
END;

CREATE TRIGGER v2_character_costume_versions_reject_replacement
BEFORE INSERT ON character_costume_versions
WHEN EXISTS (SELECT 1 FROM character_costume_versions WHERE uid = NEW.uid)
BEGIN
  SELECT RAISE(ABORT, 'character costume replacement is forbidden');
END;

CREATE TRIGGER v2_character_voice_versions_reject_replacement
BEFORE INSERT ON character_voice_versions
WHEN EXISTS (SELECT 1 FROM character_voice_versions WHERE uid = NEW.uid)
BEGIN
  SELECT RAISE(ABORT, 'character voice replacement is forbidden');
END;

CREATE TRIGGER v2_character_identity_versions_immutable_update
BEFORE UPDATE ON character_identity_versions
BEGIN SELECT RAISE(ABORT, 'character identity versions are immutable'); END;
CREATE TRIGGER v2_character_identity_versions_immutable_delete
BEFORE DELETE ON character_identity_versions
BEGIN SELECT RAISE(ABORT, 'character identity versions are append-only'); END;

CREATE TRIGGER v2_character_appearance_versions_immutable_update
BEFORE UPDATE ON character_appearance_versions
BEGIN SELECT RAISE(ABORT, 'character appearance versions are immutable'); END;
CREATE TRIGGER v2_character_appearance_versions_immutable_delete
BEFORE DELETE ON character_appearance_versions
BEGIN SELECT RAISE(ABORT, 'character appearance versions are append-only'); END;

CREATE TRIGGER v2_character_costume_versions_immutable_update
BEFORE UPDATE ON character_costume_versions
BEGIN SELECT RAISE(ABORT, 'character costume versions are immutable'); END;
CREATE TRIGGER v2_character_costume_versions_immutable_delete
BEFORE DELETE ON character_costume_versions
BEGIN SELECT RAISE(ABORT, 'character costume versions are append-only'); END;

CREATE TRIGGER v2_character_voice_versions_immutable_update
BEFORE UPDATE ON character_voice_versions
BEGIN SELECT RAISE(ABORT, 'character voice versions are immutable'); END;
CREATE TRIGGER v2_character_voice_versions_immutable_delete
BEFORE DELETE ON character_voice_versions
BEGIN SELECT RAISE(ABORT, 'character voice versions are append-only'); END;

CREATE TABLE scene_versions (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  scene_uid TEXT NOT NULL REFERENCES scenes(uid) ON DELETE RESTRICT CHECK (
    typeof(scene_uid) = 'text' AND length(CAST(scene_uid AS BLOB)) = 36 AND
    scene_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  parent_uid TEXT REFERENCES scene_versions(uid) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('draft', 'ready', 'retired')),
  metadata_json TEXT NOT NULL CHECK (
    typeof(metadata_json) = 'text' AND
    length(CAST(metadata_json AS BLOB)) BETWEEN 2 AND 32768 AND
    CASE WHEN json_valid(metadata_json) THEN json_type(metadata_json) = 'object' ELSE 0 END
  ),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
  ) CHECK (
    typeof(created_at_epoch_ms) = 'integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (parent_uid IS NULL OR parent_uid <> uid)
) WITHOUT ROWID;

CREATE TABLE prop_versions (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  prop_uid TEXT NOT NULL REFERENCES props(uid) ON DELETE RESTRICT CHECK (
    typeof(prop_uid) = 'text' AND length(CAST(prop_uid AS BLOB)) = 36 AND
    prop_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  parent_uid TEXT REFERENCES prop_versions(uid) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('draft', 'ready', 'retired')),
  metadata_json TEXT NOT NULL CHECK (
    typeof(metadata_json) = 'text' AND
    length(CAST(metadata_json AS BLOB)) BETWEEN 2 AND 32768 AND
    CASE WHEN json_valid(metadata_json) THEN json_type(metadata_json) = 'object' ELSE 0 END
  ),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
  ) CHECK (
    typeof(created_at_epoch_ms) = 'integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (parent_uid IS NULL OR parent_uid <> uid)
) WITHOUT ROWID;

CREATE INDEX idx_v2_scene_versions_owner
  ON scene_versions(scene_uid, created_at_epoch_ms, uid);
CREATE INDEX idx_v2_prop_versions_owner
  ON prop_versions(prop_uid, created_at_epoch_ms, uid);

CREATE TRIGGER v2_scene_versions_validate_parent
BEFORE INSERT ON scene_versions
WHEN NEW.parent_uid IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM scene_versions WHERE uid = NEW.parent_uid AND scene_uid = NEW.scene_uid
)
BEGIN
  SELECT RAISE(ABORT, 'scene version parent must belong to the same scene');
END;

CREATE TRIGGER v2_prop_versions_validate_parent
BEFORE INSERT ON prop_versions
WHEN NEW.parent_uid IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM prop_versions WHERE uid = NEW.parent_uid AND prop_uid = NEW.prop_uid
)
BEGIN
  SELECT RAISE(ABORT, 'prop version parent must belong to the same prop');
END;

CREATE TRIGGER v2_scene_versions_validate_metadata
BEFORE INSERT ON scene_versions
WHEN typeof(NEW.metadata_json) = 'text'
  AND length(CAST(NEW.metadata_json AS BLOB)) BETWEEN 2 AND 32768
  AND json_valid(NEW.metadata_json)
  AND json_type(NEW.metadata_json) = 'object'
  AND (
    (SELECT count(*) FROM json_each(NEW.metadata_json)) <> 4
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.metadata_json)
      WHERE key NOT IN ('name', 'visualDescription', 'lighting', 'colorAnchors')
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.name'), '') <> 'text'
    OR length(json_extract(NEW.metadata_json, '$.name')) NOT BETWEEN 1 AND 120
    OR instr(json_extract(NEW.metadata_json, '$.name'), char(0)) > 0
    OR json_extract(NEW.metadata_json, '$.name') <> trim(
      json_extract(NEW.metadata_json, '$.name'),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(160) || char(5760) || char(8192) || char(8193) || char(8194)
      || char(8195) || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232) || char(8233)
      || char(8239) || char(8287) || char(12288) || char(65279)
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.visualDescription'), '') <> 'text'
    OR length(json_extract(NEW.metadata_json, '$.visualDescription')) NOT BETWEEN 1 AND 4000
    OR instr(json_extract(NEW.metadata_json, '$.visualDescription'), char(0)) > 0
    OR json_extract(NEW.metadata_json, '$.visualDescription') <> trim(
      json_extract(NEW.metadata_json, '$.visualDescription'),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(160) || char(5760) || char(8192) || char(8193) || char(8194)
      || char(8195) || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232) || char(8233)
      || char(8239) || char(8287) || char(12288) || char(65279)
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.lighting'), '') <> 'text'
    OR length(json_extract(NEW.metadata_json, '$.lighting')) NOT BETWEEN 1 AND 1000
    OR instr(json_extract(NEW.metadata_json, '$.lighting'), char(0)) > 0
    OR json_extract(NEW.metadata_json, '$.lighting') <> trim(
      json_extract(NEW.metadata_json, '$.lighting'),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(160) || char(5760) || char(8192) || char(8193) || char(8194)
      || char(8195) || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232) || char(8233)
      || char(8239) || char(8287) || char(12288) || char(65279)
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.colorAnchors'), '') <> 'array'
    OR json_array_length(NEW.metadata_json, '$.colorAnchors') > 16
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.metadata_json, '$.colorAnchors')
      WHERE type <> 'text'
        OR length(CAST(value AS BLOB)) <> 7
        OR value NOT GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    )
    OR (
      SELECT count(*) <> count(DISTINCT value)
      FROM json_each(NEW.metadata_json, '$.colorAnchors')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'scene version metadata is invalid');
END;

CREATE TRIGGER v2_prop_versions_validate_metadata
BEFORE INSERT ON prop_versions
WHEN typeof(NEW.metadata_json) = 'text'
  AND length(CAST(NEW.metadata_json AS BLOB)) BETWEEN 2 AND 32768
  AND json_valid(NEW.metadata_json)
  AND json_type(NEW.metadata_json) = 'object'
  AND (
    (SELECT count(*) FROM json_each(NEW.metadata_json)) <> 3
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.metadata_json)
      WHERE key NOT IN ('name', 'visualDescription', 'colorAnchors')
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.name'), '') <> 'text'
    OR length(json_extract(NEW.metadata_json, '$.name')) NOT BETWEEN 1 AND 120
    OR instr(json_extract(NEW.metadata_json, '$.name'), char(0)) > 0
    OR json_extract(NEW.metadata_json, '$.name') <> trim(
      json_extract(NEW.metadata_json, '$.name'),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(160) || char(5760) || char(8192) || char(8193) || char(8194)
      || char(8195) || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232) || char(8233)
      || char(8239) || char(8287) || char(12288) || char(65279)
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.visualDescription'), '') <> 'text'
    OR length(json_extract(NEW.metadata_json, '$.visualDescription')) NOT BETWEEN 1 AND 4000
    OR instr(json_extract(NEW.metadata_json, '$.visualDescription'), char(0)) > 0
    OR json_extract(NEW.metadata_json, '$.visualDescription') <> trim(
      json_extract(NEW.metadata_json, '$.visualDescription'),
      char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
      || char(160) || char(5760) || char(8192) || char(8193) || char(8194)
      || char(8195) || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202) || char(8232) || char(8233)
      || char(8239) || char(8287) || char(12288) || char(65279)
    )
    OR COALESCE(json_type(NEW.metadata_json, '$.colorAnchors'), '') <> 'array'
    OR json_array_length(NEW.metadata_json, '$.colorAnchors') > 16
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.metadata_json, '$.colorAnchors')
      WHERE type <> 'text'
        OR length(CAST(value AS BLOB)) <> 7
        OR value NOT GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    )
    OR (
      SELECT count(*) <> count(DISTINCT value)
      FROM json_each(NEW.metadata_json, '$.colorAnchors')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'prop version metadata is invalid');
END;

CREATE TRIGGER v2_scene_versions_reject_replacement
BEFORE INSERT ON scene_versions
WHEN EXISTS (SELECT 1 FROM scene_versions WHERE uid = NEW.uid)
BEGIN SELECT RAISE(ABORT, 'scene version replacement is forbidden'); END;
CREATE TRIGGER v2_prop_versions_reject_replacement
BEFORE INSERT ON prop_versions
WHEN EXISTS (SELECT 1 FROM prop_versions WHERE uid = NEW.uid)
BEGIN SELECT RAISE(ABORT, 'prop version replacement is forbidden'); END;

CREATE TRIGGER v2_scene_versions_immutable_update
BEFORE UPDATE ON scene_versions
BEGIN SELECT RAISE(ABORT, 'scene versions are immutable'); END;
CREATE TRIGGER v2_scene_versions_immutable_delete
BEFORE DELETE ON scene_versions
BEGIN SELECT RAISE(ABORT, 'scene versions are append-only'); END;
CREATE TRIGGER v2_prop_versions_immutable_update
BEFORE UPDATE ON prop_versions
BEGIN SELECT RAISE(ABORT, 'prop versions are immutable'); END;
CREATE TRIGGER v2_prop_versions_immutable_delete
BEFORE DELETE ON prop_versions
BEGIN SELECT RAISE(ABORT, 'prop versions are append-only'); END;

CREATE TABLE character_candidate_results (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  batch_uid TEXT NOT NULL CHECK (
    typeof(batch_uid) = 'text' AND length(CAST(batch_uid AS BLOB)) = 36 AND
    batch_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 3),
  asset_version_uid TEXT NOT NULL UNIQUE REFERENCES asset_versions(uid) ON DELETE RESTRICT,
  asset_uid TEXT NOT NULL REFERENCES assets(uid) ON DELETE RESTRICT CHECK (
    typeof(asset_uid) = 'text' AND length(CAST(asset_uid AS BLOB)) = 36 AND
    asset_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  storage_provider TEXT NOT NULL CHECK (storage_provider IN ('local', 'nas', 'object')),
  relative_path TEXT NOT NULL CHECK (
    typeof(relative_path) = 'text' AND length(CAST(relative_path AS BLOB)) BETWEEN 1 AND 1024 AND
    instr(relative_path, char(0)) = 0
  ),
  duration_ms INTEGER CHECK (
    duration_ms IS NULL OR (typeof(duration_ms) = 'integer' AND duration_ms >= 0)
  ),
  asset_version_parent_uid TEXT REFERENCES asset_versions(uid) ON DELETE RESTRICT,
  asset_version_created_at TEXT NOT NULL CHECK (
    typeof(asset_version_created_at) = 'text' AND
    length(CAST(asset_version_created_at AS BLOB)) = 24 AND
    asset_version_created_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset_version_created_at)) IS asset_version_created_at
  ),
  asset_created_at TEXT NOT NULL CHECK (
    typeof(asset_created_at) = 'text' AND length(CAST(asset_created_at AS BLOB)) = 24 AND
    asset_created_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset_created_at)) IS asset_created_at
  ),
  asset_updated_at TEXT NOT NULL CHECK (
    typeof(asset_updated_at) = 'text' AND length(CAST(asset_updated_at AS BLOB)) = 24 AND
    asset_updated_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset_updated_at)) IS asset_updated_at
  ),
  logical_uri TEXT NOT NULL CHECK (
    typeof(logical_uri) = 'text' AND length(CAST(logical_uri AS BLOB)) BETWEEN 32 AND 1024 AND
    logical_uri LIKE 'asset://characters/%'
  ),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  width INTEGER NOT NULL CHECK (typeof(width) = 'integer' AND width BETWEEN 64 AND 8192),
  height INTEGER NOT NULL CHECK (typeof(height) = 'integer' AND height BETWEEN 64 AND 8192),
  content_sha256 TEXT NOT NULL CHECK (
    typeof(content_sha256) = 'text' AND length(CAST(content_sha256 AS BLOB)) = 64 AND
    content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  presentation TEXT NOT NULL CHECK (presentation = 'single_portrait'),
  UNIQUE (batch_uid, ordinal),
  UNIQUE (batch_uid, content_sha256),
  FOREIGN KEY (batch_uid) REFERENCES character_candidate_batches(uid)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;

CREATE TABLE character_candidate_batches (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  prompt_semantic_uid TEXT NOT NULL CHECK (
    typeof(prompt_semantic_uid) = 'text' AND length(CAST(prompt_semantic_uid AS BLOB)) = 36 AND
    prompt_semantic_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  profile_uid TEXT NOT NULL CHECK (
    typeof(profile_uid) = 'text' AND length(CAST(profile_uid AS BLOB)) = 36 AND
    profile_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  manifest_uid TEXT NOT NULL CHECK (
    typeof(manifest_uid) = 'text' AND length(CAST(manifest_uid AS BLOB)) = 36 AND
    manifest_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  width INTEGER NOT NULL CHECK (typeof(width) = 'integer' AND width BETWEEN 64 AND 8192),
  height INTEGER NOT NULL CHECK (typeof(height) = 'integer' AND height BETWEEN 64 AND 8192),
  seed INTEGER NOT NULL CHECK (typeof(seed) = 'integer' AND seed BETWEEN 0 AND 4294967295),
  candidate_count INTEGER NOT NULL CHECK (candidate_count = 4),
  request_sha256 TEXT NOT NULL CHECK (
    typeof(request_sha256) = 'text' AND length(CAST(request_sha256 AS BLOB)) = 64 AND
    request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
  ) CHECK (
    typeof(created_at_epoch_ms) = 'integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  )
) WITHOUT ROWID;

CREATE INDEX idx_v2_character_candidate_batches_owner
  ON character_candidate_batches(character_uid, created_at_epoch_ms, uid);
CREATE INDEX idx_v2_character_candidate_results_batch
  ON character_candidate_results(batch_uid, ordinal);

CREATE TRIGGER v2_character_candidate_results_reject_after_batch
BEFORE INSERT ON character_candidate_results
WHEN EXISTS (SELECT 1 FROM character_candidate_batches WHERE uid = NEW.batch_uid)
BEGIN SELECT RAISE(ABORT, 'candidate batch is already complete'); END;

CREATE TRIGGER v2_character_candidate_results_reject_replacement
BEFORE INSERT ON character_candidate_results
WHEN EXISTS (
  SELECT 1 FROM character_candidate_results
  WHERE uid = NEW.uid
    OR asset_version_uid = NEW.asset_version_uid
    OR (batch_uid = NEW.batch_uid AND ordinal = NEW.ordinal)
    OR (batch_uid = NEW.batch_uid AND content_sha256 = NEW.content_sha256)
)
BEGIN SELECT RAISE(ABORT, 'candidate result replacement is forbidden'); END;

CREATE TRIGGER v2_character_candidate_batches_validate_complete
BEFORE INSERT ON character_candidate_batches
WHEN (
  (SELECT count(*) FROM character_candidate_results WHERE batch_uid = NEW.uid) <> 4
  OR EXISTS (
    SELECT 1
    FROM character_candidate_results AS result
    LEFT JOIN asset_versions AS version ON version.uid = result.asset_version_uid
    LEFT JOIN assets AS asset ON asset.uid = version.asset_uid
    WHERE result.batch_uid = NEW.uid AND (
      result.character_uid <> NEW.character_uid
      OR result.logical_uri <> 'asset://characters/' || NEW.character_uid
        || '/candidate-batches/' || NEW.uid || '/' || result.ordinal
      OR result.width <> NEW.width OR result.height <> NEW.height
      OR version.uid IS NULL
      OR version.asset_uid <> result.asset_uid
      OR version.storage_provider <> result.storage_provider
      OR version.relative_path <> result.relative_path
      OR version.duration_ms IS NOT result.duration_ms
      OR version.parent_uid IS NOT result.asset_version_parent_uid
      OR version.created_at <> result.asset_version_created_at
      OR typeof(version.created_at) <> 'text'
      OR length(CAST(version.created_at AS BLOB)) <> 24
      OR version.created_at NOT BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
      OR strftime('%Y-%m-%dT%H:%M:%fZ', julianday(version.created_at)) IS NOT version.created_at
      OR version.logical_uri <> result.logical_uri
      OR version.sha256 IS NULL OR version.sha256 <> result.content_sha256
      OR version.mime_type IS NULL OR version.mime_type <> result.media_type
      OR version.width IS NULL OR version.width <> result.width
      OR version.height IS NULL OR version.height <> result.height
      OR version.status <> 'ready'
      OR asset.uid IS NULL
      OR asset.owner_type <> 'character'
      OR asset.owner_uid <> NEW.character_uid
      OR asset.asset_type <> 'character_candidate'
      OR asset.current_version_uid IS NULL OR asset.current_version_uid <> version.uid
      OR asset.status <> 'ready'
      OR asset.created_at <> result.asset_created_at
      OR asset.updated_at <> result.asset_updated_at
      OR typeof(asset.created_at) <> 'text' OR typeof(asset.updated_at) <> 'text'
      OR length(CAST(asset.created_at AS BLOB)) <> 24
      OR length(CAST(asset.updated_at AS BLOB)) <> 24
      OR asset.created_at NOT BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
      OR asset.updated_at NOT BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
      OR strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset.created_at)) IS NOT asset.created_at
      OR strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset.updated_at)) IS NOT asset.updated_at
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'candidate batch is incomplete or invalid'); END;

CREATE TRIGGER v2_character_candidate_batches_reject_replacement
BEFORE INSERT ON character_candidate_batches
WHEN EXISTS (SELECT 1 FROM character_candidate_batches WHERE uid = NEW.uid)
BEGIN SELECT RAISE(ABORT, 'candidate batch replacement is forbidden'); END;

CREATE TRIGGER v2_character_candidate_results_immutable_update
BEFORE UPDATE ON character_candidate_results
BEGIN SELECT RAISE(ABORT, 'candidate results are immutable'); END;
CREATE TRIGGER v2_character_candidate_results_immutable_delete
BEFORE DELETE ON character_candidate_results
BEGIN SELECT RAISE(ABORT, 'candidate results are append-only'); END;
CREATE TRIGGER v2_character_candidate_batches_immutable_update
BEFORE UPDATE ON character_candidate_batches
BEGIN SELECT RAISE(ABORT, 'candidate batches are immutable'); END;
CREATE TRIGGER v2_character_candidate_batches_immutable_delete
BEFORE DELETE ON character_candidate_batches
BEGIN SELECT RAISE(ABORT, 'candidate batches are append-only'); END;

CREATE TRIGGER v2_character_candidate_asset_versions_frozen
BEFORE UPDATE ON asset_versions
WHEN EXISTS (
  SELECT 1 FROM character_candidate_results WHERE asset_version_uid = OLD.uid
)
BEGIN SELECT RAISE(ABORT, 'candidate asset versions are frozen'); END;

CREATE TRIGGER v2_character_candidate_asset_versions_frozen_delete
BEFORE DELETE ON asset_versions
WHEN EXISTS (
  SELECT 1 FROM character_candidate_results WHERE asset_version_uid = OLD.uid
)
BEGIN SELECT RAISE(ABORT, 'candidate asset versions are frozen'); END;

CREATE TRIGGER v2_character_candidate_assets_frozen
BEFORE UPDATE ON assets
WHEN EXISTS (
  SELECT 1
  FROM character_candidate_results AS result
  JOIN asset_versions AS version ON version.uid = result.asset_version_uid
  WHERE version.asset_uid = OLD.uid
)
BEGIN SELECT RAISE(ABORT, 'candidate assets are frozen'); END;

CREATE TRIGGER v2_character_candidate_assets_frozen_delete
BEFORE DELETE ON assets
WHEN EXISTS (
  SELECT 1
  FROM character_candidate_results AS result
  JOIN asset_versions AS version ON version.uid = result.asset_version_uid
  WHERE version.asset_uid = OLD.uid
)
BEGIN SELECT RAISE(ABORT, 'candidate assets are frozen'); END;

CREATE TABLE character_identity_lock_events (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  candidate_uid TEXT NOT NULL REFERENCES character_candidate_results(uid) ON DELETE RESTRICT,
  identity_version_uid TEXT NOT NULL REFERENCES character_identity_versions(uid) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('lock', 'unlock')),
  state_version INTEGER NOT NULL CHECK (typeof(state_version) = 'integer' AND state_version >= 1),
  changed_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(changed_at_epoch_ms) = 'integer' AND changed_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  UNIQUE (character_uid, state_version)
) WITHOUT ROWID;

CREATE INDEX idx_v2_character_identity_lock_events_owner
  ON character_identity_lock_events(character_uid, state_version);

CREATE TRIGGER v2_character_identity_lock_events_validate
BEFORE INSERT ON character_identity_lock_events
WHEN (
  NOT EXISTS (
    SELECT 1 FROM character_candidate_results
    WHERE uid = NEW.candidate_uid AND character_uid = NEW.character_uid
  )
  OR NOT EXISTS (
    SELECT 1 FROM character_identity_versions
    WHERE uid = NEW.identity_version_uid AND character_uid = NEW.character_uid
  )
  OR NEW.state_version <> COALESCE((
    SELECT max(state_version) + 1 FROM character_identity_lock_events
    WHERE character_uid = NEW.character_uid
  ), 1)
  OR NEW.changed_at_epoch_ms < COALESCE((
    SELECT changed_at_epoch_ms FROM character_identity_lock_events
    WHERE character_uid = NEW.character_uid
    ORDER BY state_version DESC LIMIT 1
  ), 0)
  OR (
    NEW.operation = 'lock' AND COALESCE((
      SELECT operation FROM character_identity_lock_events
      WHERE character_uid = NEW.character_uid
      ORDER BY state_version DESC LIMIT 1
    ), 'unlock') <> 'unlock'
  )
  OR (
    NEW.operation = 'unlock' AND NOT EXISTS (
      SELECT 1 FROM character_identity_lock_events
      WHERE character_uid = NEW.character_uid
        AND state_version = NEW.state_version - 1
        AND operation = 'lock'
        AND candidate_uid = NEW.candidate_uid
        AND identity_version_uid = NEW.identity_version_uid
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'identity lock transition is invalid'); END;

CREATE TRIGGER v2_character_identity_lock_events_reject_replacement
BEFORE INSERT ON character_identity_lock_events
WHEN EXISTS (
  SELECT 1 FROM character_identity_lock_events
  WHERE uid = NEW.uid OR (character_uid = NEW.character_uid AND state_version = NEW.state_version)
)
BEGIN SELECT RAISE(ABORT, 'identity lock event replacement is forbidden'); END;

CREATE TRIGGER v2_character_identity_lock_events_immutable_update
BEFORE UPDATE ON character_identity_lock_events
BEGIN SELECT RAISE(ABORT, 'identity lock events are immutable'); END;
CREATE TRIGGER v2_character_identity_lock_events_immutable_delete
BEFORE DELETE ON character_identity_lock_events
BEGIN SELECT RAISE(ABORT, 'identity lock events are append-only'); END;

CREATE TABLE character_reference_package_items (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  package_uid TEXT NOT NULL CHECK (
    typeof(package_uid) = 'text' AND length(CAST(package_uid AS BLOB)) = 36 AND
    package_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 9),
  item_kind TEXT NOT NULL CHECK (item_kind IN (
    'front_half_body', 'three_quarter_face', 'left_profile', 'right_profile',
    'front_full_body', 'expression_neutral', 'expression_joy', 'expression_anger',
    'expression_sadness', 'expression_fear'
  )),
  asset_version_uid TEXT NOT NULL REFERENCES asset_versions(uid) ON DELETE RESTRICT,
  asset_uid TEXT NOT NULL REFERENCES assets(uid) ON DELETE RESTRICT,
  storage_provider TEXT NOT NULL CHECK (storage_provider IN ('local', 'nas', 'object')),
  relative_path TEXT NOT NULL CHECK (
    typeof(relative_path) = 'text' AND length(CAST(relative_path AS BLOB)) BETWEEN 1 AND 1024 AND
    instr(relative_path, char(0)) = 0
  ),
  duration_ms INTEGER CHECK (
    duration_ms IS NULL OR (typeof(duration_ms) = 'integer' AND duration_ms >= 0)
  ),
  asset_version_parent_uid TEXT REFERENCES asset_versions(uid) ON DELETE RESTRICT,
  asset_version_created_at TEXT NOT NULL CHECK (
    typeof(asset_version_created_at) = 'text' AND length(CAST(asset_version_created_at AS BLOB)) = 24 AND
    asset_version_created_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset_version_created_at)) IS asset_version_created_at
  ),
  asset_created_at TEXT NOT NULL CHECK (
    typeof(asset_created_at) = 'text' AND length(CAST(asset_created_at AS BLOB)) = 24 AND
    asset_created_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset_created_at)) IS asset_created_at
  ),
  asset_updated_at TEXT NOT NULL CHECK (
    typeof(asset_updated_at) = 'text' AND length(CAST(asset_updated_at AS BLOB)) = 24 AND
    asset_updated_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset_updated_at)) IS asset_updated_at
  ),
  logical_uri TEXT NOT NULL CHECK (
    typeof(logical_uri) = 'text' AND length(CAST(logical_uri AS BLOB)) BETWEEN 32 AND 1024 AND
    logical_uri LIKE 'asset://characters/%/reference-packages/%'
  ),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  width INTEGER NOT NULL CHECK (typeof(width) = 'integer' AND width BETWEEN 64 AND 8192),
  height INTEGER NOT NULL CHECK (typeof(height) = 'integer' AND height BETWEEN 64 AND 8192),
  content_sha256 TEXT NOT NULL CHECK (
    typeof(content_sha256) = 'text' AND length(CAST(content_sha256 AS BLOB)) = 64 AND
    content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE (package_uid, ordinal),
  UNIQUE (package_uid, item_kind),
  UNIQUE (package_uid, asset_version_uid),
  UNIQUE (package_uid, content_sha256),
  FOREIGN KEY (package_uid) REFERENCES character_reference_packages(uid)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;

CREATE TABLE character_reference_packages (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  identity_version_uid TEXT NOT NULL REFERENCES character_identity_versions(uid) ON DELETE RESTRICT,
  candidate_uid TEXT NOT NULL REFERENCES character_candidate_results(uid) ON DELETE RESTRICT,
  lock_event_uid TEXT NOT NULL REFERENCES character_identity_lock_events(uid) ON DELETE RESTRICT,
  lock_state_version INTEGER NOT NULL CHECK (
    typeof(lock_state_version) = 'integer' AND lock_state_version >= 1
  ),
  appearance_version_uid TEXT NOT NULL REFERENCES character_appearance_versions(uid) ON DELETE RESTRICT,
  costume_version_uid TEXT NOT NULL REFERENCES character_costume_versions(uid) ON DELETE RESTRICT,
  appearance_metadata_json TEXT NOT NULL CHECK (
    typeof(appearance_metadata_json) = 'text' AND
    length(CAST(appearance_metadata_json AS BLOB)) BETWEEN 2 AND 32768 AND
    CASE WHEN json_valid(appearance_metadata_json) THEN json_type(appearance_metadata_json) = 'object' ELSE 0 END
  ),
  costume_metadata_json TEXT NOT NULL CHECK (
    typeof(costume_metadata_json) = 'text' AND
    length(CAST(costume_metadata_json AS BLOB)) BETWEEN 2 AND 32768 AND
    CASE WHEN json_valid(costume_metadata_json) THEN json_type(costume_metadata_json) = 'object' ELSE 0 END
  ),
  created_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(created_at_epoch_ms) = 'integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  )
) WITHOUT ROWID;

CREATE INDEX idx_v2_character_reference_packages_owner
  ON character_reference_packages(character_uid, created_at_epoch_ms, uid);
CREATE INDEX idx_v2_character_reference_items_package
  ON character_reference_package_items(package_uid, ordinal);

CREATE TRIGGER v2_character_reference_items_reject_after_package
BEFORE INSERT ON character_reference_package_items
WHEN EXISTS (SELECT 1 FROM character_reference_packages WHERE uid = NEW.package_uid)
BEGIN SELECT RAISE(ABORT, 'character reference package is already complete'); END;

CREATE TRIGGER v2_character_reference_items_reject_replacement
BEFORE INSERT ON character_reference_package_items
WHEN EXISTS (
  SELECT 1 FROM character_reference_package_items
  WHERE uid = NEW.uid
    OR (package_uid = NEW.package_uid AND ordinal = NEW.ordinal)
    OR (package_uid = NEW.package_uid AND item_kind = NEW.item_kind)
    OR (package_uid = NEW.package_uid AND asset_version_uid = NEW.asset_version_uid)
    OR (package_uid = NEW.package_uid AND content_sha256 = NEW.content_sha256)
)
BEGIN SELECT RAISE(ABORT, 'character reference item replacement is forbidden'); END;

CREATE TRIGGER v2_character_reference_packages_validate_complete
BEFORE INSERT ON character_reference_packages
WHEN (
  (SELECT count(*) FROM character_reference_package_items WHERE package_uid = NEW.uid) <> 10
  OR EXISTS (
    SELECT 1
    FROM character_reference_package_items AS item
    LEFT JOIN asset_versions AS version ON version.uid = item.asset_version_uid
    LEFT JOIN assets AS asset ON asset.uid = version.asset_uid
    WHERE item.package_uid = NEW.uid AND (
      item.character_uid <> NEW.character_uid
      OR item.item_kind <> CASE item.ordinal
        WHEN 0 THEN 'front_half_body'
        WHEN 1 THEN 'three_quarter_face'
        WHEN 2 THEN 'left_profile'
        WHEN 3 THEN 'right_profile'
        WHEN 4 THEN 'front_full_body'
        WHEN 5 THEN 'expression_neutral'
        WHEN 6 THEN 'expression_joy'
        WHEN 7 THEN 'expression_anger'
        WHEN 8 THEN 'expression_sadness'
        WHEN 9 THEN 'expression_fear'
      END
      OR item.logical_uri <> 'asset://characters/' || NEW.character_uid
        || '/reference-packages/' || NEW.uid || '/' || item.item_kind
      OR version.uid IS NULL
      OR version.asset_uid <> item.asset_uid
      OR version.storage_provider <> item.storage_provider
      OR version.relative_path <> item.relative_path
      OR version.duration_ms IS NOT item.duration_ms
      OR version.parent_uid IS NOT item.asset_version_parent_uid
      OR version.created_at <> item.asset_version_created_at
      OR typeof(version.created_at) <> 'text'
      OR length(CAST(version.created_at AS BLOB)) <> 24
      OR version.created_at NOT BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
      OR strftime('%Y-%m-%dT%H:%M:%fZ', julianday(version.created_at)) IS NOT version.created_at
      OR version.logical_uri <> item.logical_uri
      OR version.sha256 IS NULL OR version.sha256 <> item.content_sha256
      OR version.mime_type IS NULL OR version.mime_type <> item.media_type
      OR version.width IS NULL OR version.width <> item.width
      OR version.height IS NULL OR version.height <> item.height
      OR version.status <> 'ready'
      OR asset.uid IS NULL
      OR asset.owner_type <> 'character'
      OR asset.owner_uid <> NEW.character_uid
      OR asset.asset_type <> 'character_reference'
      OR asset.current_version_uid IS NULL OR asset.current_version_uid <> version.uid
      OR asset.status <> 'ready'
      OR asset.created_at <> item.asset_created_at
      OR asset.updated_at <> item.asset_updated_at
      OR typeof(asset.created_at) <> 'text' OR typeof(asset.updated_at) <> 'text'
      OR length(CAST(asset.created_at AS BLOB)) <> 24
      OR length(CAST(asset.updated_at AS BLOB)) <> 24
      OR asset.created_at NOT BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
      OR asset.updated_at NOT BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
      OR strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset.created_at)) IS NOT asset.created_at
      OR strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset.updated_at)) IS NOT asset.updated_at
    )
  )
  OR NOT EXISTS (
    SELECT 1 FROM character_identity_lock_events AS event
    WHERE event.uid = NEW.lock_event_uid
      AND event.character_uid = NEW.character_uid
      AND event.identity_version_uid = NEW.identity_version_uid
      AND event.candidate_uid = NEW.candidate_uid
      AND event.operation = 'lock'
      AND event.state_version = NEW.lock_state_version
  )
  OR EXISTS (
    SELECT 1 FROM character_identity_lock_events
    WHERE character_uid = NEW.character_uid AND state_version > NEW.lock_state_version
  )
  OR NOT EXISTS (
    SELECT 1 FROM character_appearance_versions
    WHERE uid = NEW.appearance_version_uid
      AND character_uid = NEW.character_uid
      AND identity_version_uid = NEW.identity_version_uid
      AND metadata_json = NEW.appearance_metadata_json
  )
  OR NOT EXISTS (
    SELECT 1 FROM character_costume_versions
    WHERE uid = NEW.costume_version_uid
      AND character_uid = NEW.character_uid
      AND identity_version_uid = NEW.identity_version_uid
      AND metadata_json = NEW.costume_metadata_json
  )
)
BEGIN SELECT RAISE(ABORT, 'character reference package is incomplete or invalid'); END;

CREATE TRIGGER v2_character_reference_packages_reject_replacement
BEFORE INSERT ON character_reference_packages
WHEN EXISTS (SELECT 1 FROM character_reference_packages WHERE uid = NEW.uid)
BEGIN SELECT RAISE(ABORT, 'character reference package replacement is forbidden'); END;

CREATE TRIGGER v2_character_reference_items_immutable_update
BEFORE UPDATE ON character_reference_package_items
BEGIN SELECT RAISE(ABORT, 'character reference items are immutable'); END;
CREATE TRIGGER v2_character_reference_items_immutable_delete
BEFORE DELETE ON character_reference_package_items
BEGIN SELECT RAISE(ABORT, 'character reference items are append-only'); END;
CREATE TRIGGER v2_character_reference_packages_immutable_update
BEFORE UPDATE ON character_reference_packages
BEGIN SELECT RAISE(ABORT, 'character reference packages are immutable'); END;
CREATE TRIGGER v2_character_reference_packages_immutable_delete
BEFORE DELETE ON character_reference_packages
BEGIN SELECT RAISE(ABORT, 'character reference packages are append-only'); END;

CREATE TRIGGER v2_character_reference_asset_versions_frozen
BEFORE UPDATE ON asset_versions
WHEN EXISTS (
  SELECT 1 FROM character_reference_package_items WHERE asset_version_uid = OLD.uid
)
BEGIN SELECT RAISE(ABORT, 'character reference asset versions are frozen'); END;
CREATE TRIGGER v2_character_reference_asset_versions_frozen_delete
BEFORE DELETE ON asset_versions
WHEN EXISTS (
  SELECT 1 FROM character_reference_package_items WHERE asset_version_uid = OLD.uid
)
BEGIN SELECT RAISE(ABORT, 'character reference asset versions are frozen'); END;
CREATE TRIGGER v2_character_reference_assets_frozen
BEFORE UPDATE ON assets
WHEN EXISTS (
  SELECT 1 FROM character_reference_package_items AS item
  JOIN asset_versions AS version ON version.uid = item.asset_version_uid
  WHERE version.asset_uid = OLD.uid
)
BEGIN SELECT RAISE(ABORT, 'character reference assets are frozen'); END;
CREATE TRIGGER v2_character_reference_assets_frozen_delete
BEFORE DELETE ON assets
WHEN EXISTS (
  SELECT 1 FROM character_reference_package_items AS item
  JOIN asset_versions AS version ON version.uid = item.asset_version_uid
  WHERE version.asset_uid = OLD.uid
)
BEGIN SELECT RAISE(ABORT, 'character reference assets are frozen'); END;

-- A continuity snapshot is the immutable production fact boundary for one
-- approved planned shot. Child references are inserted first inside one
-- deferred-FK transaction; the header insert seals and validates the set.
CREATE TABLE shot_continuity_snapshots (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  shot_result_uid TEXT NOT NULL REFERENCES narrative_results(uid) ON DELETE RESTRICT,
  shot_result_hash TEXT NOT NULL CHECK (
    typeof(shot_result_hash) = 'text' AND length(CAST(shot_result_hash AS BLOB)) = 64 AND
    shot_result_hash NOT GLOB '*[^0-9a-f]*'
  ),
  shot_envelope_hash TEXT NOT NULL CHECK (
    typeof(shot_envelope_hash) = 'text' AND length(CAST(shot_envelope_hash AS BLOB)) = 64 AND
    shot_envelope_hash NOT GLOB '*[^0-9a-f]*'
  ),
  shot_review_uid TEXT NOT NULL REFERENCES narrative_review_events(uid) ON DELETE RESTRICT,
  shot_id TEXT NOT NULL CHECK (
    typeof(shot_id) = 'text' AND length(CAST(shot_id AS BLOB)) BETWEEN 1 AND 64 AND
    shot_id GLOB '[a-z]*' AND shot_id NOT GLOB '*[^a-z0-9-]*'
  ),
  shot_ordinal INTEGER NOT NULL CHECK (typeof(shot_ordinal) = 'integer' AND shot_ordinal BETWEEN 1 AND 6),
  scene_uid TEXT NOT NULL REFERENCES scenes(uid) ON DELETE RESTRICT,
  scene_version_uid TEXT NOT NULL REFERENCES scene_versions(uid) ON DELETE RESTRICT,
  scene_metadata_json TEXT NOT NULL CHECK (
    typeof(scene_metadata_json) = 'text' AND length(CAST(scene_metadata_json AS BLOB)) BETWEEN 2 AND 32768 AND
    CASE WHEN json_valid(scene_metadata_json) THEN json_type(scene_metadata_json) = 'object' ELSE 0 END
  ),
  created_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(created_at_epoch_ms) = 'integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  )
) WITHOUT ROWID;

CREATE TABLE shot_continuity_character_refs (
  snapshot_uid TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 127),
  fact_ref TEXT NOT NULL CHECK (
    typeof(fact_ref) = 'text' AND length(CAST(fact_ref AS BLOB)) BETWEEN 1 AND 64 AND
    fact_ref GLOB '[a-z]*' AND fact_ref NOT GLOB '*[^a-z0-9-]*'
  ),
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  reference_package_uid TEXT NOT NULL REFERENCES character_reference_packages(uid) ON DELETE RESTRICT,
  identity_version_uid TEXT NOT NULL REFERENCES character_identity_versions(uid) ON DELETE RESTRICT,
  costume_version_uid TEXT NOT NULL REFERENCES character_costume_versions(uid) ON DELETE RESTRICT,
  package_lock_event_uid TEXT NOT NULL REFERENCES character_identity_lock_events(uid) ON DELETE RESTRICT,
  package_lock_state_version INTEGER NOT NULL CHECK (
    typeof(package_lock_state_version) = 'integer' AND package_lock_state_version >= 1
  ),
  package_appearance_version_uid TEXT NOT NULL REFERENCES character_appearance_versions(uid) ON DELETE RESTRICT,
  package_appearance_metadata_json TEXT NOT NULL CHECK (
    typeof(package_appearance_metadata_json) = 'text' AND
    length(CAST(package_appearance_metadata_json AS BLOB)) BETWEEN 2 AND 32768 AND
    CASE WHEN json_valid(package_appearance_metadata_json) THEN
      json_type(package_appearance_metadata_json) = 'object' ELSE 0 END
  ),
  costume_metadata_json TEXT NOT NULL CHECK (
    typeof(costume_metadata_json) = 'text' AND
    length(CAST(costume_metadata_json AS BLOB)) BETWEEN 2 AND 32768 AND
    CASE WHEN json_valid(costume_metadata_json) THEN json_type(costume_metadata_json) = 'object' ELSE 0 END
  ),
  PRIMARY KEY (snapshot_uid, ordinal),
  UNIQUE (snapshot_uid, fact_ref),
  UNIQUE (snapshot_uid, character_uid),
  FOREIGN KEY (snapshot_uid) REFERENCES shot_continuity_snapshots(uid)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;

CREATE TABLE shot_continuity_prop_refs (
  snapshot_uid TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 127),
  fact_ref TEXT NOT NULL CHECK (
    typeof(fact_ref) = 'text' AND length(CAST(fact_ref AS BLOB)) BETWEEN 1 AND 64 AND
    fact_ref GLOB '[a-z]*' AND fact_ref NOT GLOB '*[^a-z0-9-]*'
  ),
  prop_uid TEXT NOT NULL REFERENCES props(uid) ON DELETE RESTRICT,
  prop_version_uid TEXT NOT NULL REFERENCES prop_versions(uid) ON DELETE RESTRICT,
  prop_metadata_json TEXT NOT NULL CHECK (
    typeof(prop_metadata_json) = 'text' AND length(CAST(prop_metadata_json AS BLOB)) BETWEEN 2 AND 32768 AND
    CASE WHEN json_valid(prop_metadata_json) THEN json_type(prop_metadata_json) = 'object' ELSE 0 END
  ),
  PRIMARY KEY (snapshot_uid, ordinal),
  UNIQUE (snapshot_uid, fact_ref),
  UNIQUE (snapshot_uid, prop_uid),
  FOREIGN KEY (snapshot_uid) REFERENCES shot_continuity_snapshots(uid)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;

CREATE INDEX idx_v2_shot_continuity_result
  ON shot_continuity_snapshots(shot_result_uid, shot_ordinal, created_at_epoch_ms, uid);

CREATE TRIGGER v2_shot_continuity_snapshots_validate_complete
BEFORE INSERT ON shot_continuity_snapshots
WHEN NOT EXISTS (
  SELECT 1
  FROM narrative_results AS result
  JOIN narrative_review_events AS review ON review.uid = NEW.shot_review_uid
  JOIN json_each(result.result_json, '$.output.shots') AS shot
  WHERE result.uid = NEW.shot_result_uid
    AND result.drama_uid = NEW.drama_uid
    AND result.result_type = 'shot'
    AND result.task_type = 'ShotPlanningTask'
    AND result.schema_version = 'shot-planning.v1'
    AND result.result_hash = NEW.shot_result_hash
    AND result.envelope_hash = NEW.shot_envelope_hash
    AND result.status = 'approved'
    AND result.current_review_uid = NEW.shot_review_uid
    AND review.result_uid = result.uid
    AND review.decision = 'approve'
    AND review.result_hash = result.result_hash
    AND review.envelope_hash = result.envelope_hash
    AND json_extract(shot.value, '$.shotId') = NEW.shot_id
    AND json_extract(shot.value, '$.ordinal') = NEW.shot_ordinal
    AND json_type(shot.value, '$.characterFactRefs') = 'array'
    AND json_type(shot.value, '$.propFactRefs') = 'array'
    AND json_array_length(json_extract(shot.value, '$.characterFactRefs')) =
      (SELECT count(*) FROM shot_continuity_character_refs WHERE snapshot_uid = NEW.uid)
    AND json_array_length(json_extract(shot.value, '$.propFactRefs')) =
      (SELECT count(*) FROM shot_continuity_prop_refs WHERE snapshot_uid = NEW.uid)
    AND NOT EXISTS (
      SELECT 1 FROM shot_continuity_character_refs AS ref
      WHERE ref.snapshot_uid = NEW.uid AND NOT EXISTS (
        SELECT 1 FROM json_each(json_extract(shot.value, '$.characterFactRefs')) AS fact
        WHERE fact.value = ref.fact_ref
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM shot_continuity_prop_refs AS ref
      WHERE ref.snapshot_uid = NEW.uid AND NOT EXISTS (
        SELECT 1 FROM json_each(json_extract(shot.value, '$.propFactRefs')) AS fact
        WHERE fact.value = ref.fact_ref
      )
    )
)
OR NOT EXISTS (
  SELECT 1
  FROM scene_versions AS version
  JOIN scenes AS scene ON scene.uid = version.scene_uid
  JOIN dramas AS drama ON drama.id = scene.drama_id
  WHERE version.uid = NEW.scene_version_uid
    AND version.scene_uid = NEW.scene_uid
    AND version.state = 'ready'
    AND version.metadata_json = NEW.scene_metadata_json
    AND drama.uid = NEW.drama_uid
    AND scene.deleted_at IS NULL
    AND drama.deleted_at IS NULL
)
OR EXISTS (
  SELECT 1
  FROM shot_continuity_character_refs AS ref
  LEFT JOIN character_reference_packages AS package ON package.uid = ref.reference_package_uid
  LEFT JOIN character_identity_lock_events AS lock_event ON lock_event.uid = ref.package_lock_event_uid
  LEFT JOIN character_appearance_versions AS appearance ON appearance.uid = ref.package_appearance_version_uid
  LEFT JOIN character_costume_versions AS costume ON costume.uid = ref.costume_version_uid
  LEFT JOIN characters AS character ON character.uid = ref.character_uid
  LEFT JOIN dramas AS drama ON drama.id = character.drama_id
  WHERE ref.snapshot_uid = NEW.uid AND (
    package.uid IS NULL OR package.character_uid <> ref.character_uid
    OR package.identity_version_uid <> ref.identity_version_uid
    OR package.lock_event_uid <> ref.package_lock_event_uid
    OR package.lock_state_version <> ref.package_lock_state_version
    OR package.appearance_version_uid <> ref.package_appearance_version_uid
    OR package.appearance_metadata_json <> ref.package_appearance_metadata_json
    OR lock_event.uid IS NULL OR lock_event.operation <> 'lock'
    OR lock_event.character_uid <> ref.character_uid
    OR lock_event.identity_version_uid <> ref.identity_version_uid
    OR lock_event.state_version <> ref.package_lock_state_version
    OR EXISTS (
      SELECT 1 FROM character_identity_lock_events AS newer
      WHERE newer.character_uid = ref.character_uid
        AND newer.state_version > ref.package_lock_state_version
    )
    OR appearance.uid IS NULL OR appearance.character_uid <> ref.character_uid
    OR appearance.identity_version_uid <> ref.identity_version_uid
    OR appearance.metadata_json <> ref.package_appearance_metadata_json
    OR costume.uid IS NULL OR costume.character_uid <> ref.character_uid
    OR costume.identity_version_uid <> ref.identity_version_uid
    OR costume.metadata_json <> ref.costume_metadata_json
    OR character.uid IS NULL OR character.deleted_at IS NOT NULL
    OR drama.uid IS NULL OR drama.uid <> NEW.drama_uid OR drama.deleted_at IS NOT NULL
  )
)
OR EXISTS (
  SELECT 1
  FROM shot_continuity_prop_refs AS ref
  LEFT JOIN prop_versions AS version ON version.uid = ref.prop_version_uid
  LEFT JOIN props AS prop ON prop.uid = ref.prop_uid
  LEFT JOIN dramas AS drama ON drama.id = prop.drama_id
  WHERE ref.snapshot_uid = NEW.uid AND (
    version.uid IS NULL OR version.prop_uid <> ref.prop_uid
    OR version.state <> 'ready' OR version.metadata_json <> ref.prop_metadata_json
    OR prop.uid IS NULL OR prop.deleted_at IS NOT NULL
    OR drama.uid IS NULL OR drama.uid <> NEW.drama_uid OR drama.deleted_at IS NOT NULL
  )
)
BEGIN SELECT RAISE(ABORT, 'shot continuity snapshot is incomplete or invalid'); END;

CREATE TRIGGER v2_shot_continuity_children_reject_after_snapshot_character
BEFORE INSERT ON shot_continuity_character_refs
WHEN EXISTS (SELECT 1 FROM shot_continuity_snapshots WHERE uid = NEW.snapshot_uid)
BEGIN SELECT RAISE(ABORT, 'shot continuity snapshot is already complete'); END;
CREATE TRIGGER v2_shot_continuity_children_reject_after_snapshot_prop
BEFORE INSERT ON shot_continuity_prop_refs
WHEN EXISTS (SELECT 1 FROM shot_continuity_snapshots WHERE uid = NEW.snapshot_uid)
BEGIN SELECT RAISE(ABORT, 'shot continuity snapshot is already complete'); END;

CREATE TRIGGER v2_shot_continuity_character_reject_replacement
BEFORE INSERT ON shot_continuity_character_refs
WHEN EXISTS (
  SELECT 1 FROM shot_continuity_character_refs
  WHERE snapshot_uid = NEW.snapshot_uid AND
    (ordinal = NEW.ordinal OR fact_ref = NEW.fact_ref OR character_uid = NEW.character_uid)
)
BEGIN SELECT RAISE(ABORT, 'shot continuity character replacement is forbidden'); END;
CREATE TRIGGER v2_shot_continuity_prop_reject_replacement
BEFORE INSERT ON shot_continuity_prop_refs
WHEN EXISTS (
  SELECT 1 FROM shot_continuity_prop_refs
  WHERE snapshot_uid = NEW.snapshot_uid AND
    (ordinal = NEW.ordinal OR fact_ref = NEW.fact_ref OR prop_uid = NEW.prop_uid)
)
BEGIN SELECT RAISE(ABORT, 'shot continuity prop replacement is forbidden'); END;
CREATE TRIGGER v2_shot_continuity_snapshot_reject_replacement
BEFORE INSERT ON shot_continuity_snapshots
WHEN EXISTS (SELECT 1 FROM shot_continuity_snapshots WHERE uid = NEW.uid)
BEGIN SELECT RAISE(ABORT, 'shot continuity snapshot replacement is forbidden'); END;

CREATE TRIGGER v2_shot_continuity_snapshots_immutable_update
BEFORE UPDATE ON shot_continuity_snapshots
BEGIN SELECT RAISE(ABORT, 'shot continuity snapshots are immutable'); END;
CREATE TRIGGER v2_shot_continuity_snapshots_immutable_delete
BEFORE DELETE ON shot_continuity_snapshots
BEGIN SELECT RAISE(ABORT, 'shot continuity snapshots are append-only'); END;
CREATE TRIGGER v2_shot_continuity_character_immutable_update
BEFORE UPDATE ON shot_continuity_character_refs
BEGIN SELECT RAISE(ABORT, 'shot continuity character refs are immutable'); END;
CREATE TRIGGER v2_shot_continuity_character_immutable_delete
BEFORE DELETE ON shot_continuity_character_refs
BEGIN SELECT RAISE(ABORT, 'shot continuity character refs are append-only'); END;
CREATE TRIGGER v2_shot_continuity_prop_immutable_update
BEFORE UPDATE ON shot_continuity_prop_refs
BEGIN SELECT RAISE(ABORT, 'shot continuity prop refs are immutable'); END;
CREATE TRIGGER v2_shot_continuity_prop_immutable_delete
BEFORE DELETE ON shot_continuity_prop_refs
BEGIN SELECT RAISE(ABORT, 'shot continuity prop refs are append-only'); END;

CREATE TRIGGER v2_shot_continuity_character_owner_frozen
BEFORE UPDATE OF uid, drama_id ON characters
WHEN EXISTS (SELECT 1 FROM shot_continuity_character_refs WHERE character_uid = OLD.uid)
BEGIN SELECT RAISE(ABORT, 'shot continuity character ownership is frozen'); END;
CREATE TRIGGER v2_shot_continuity_scene_owner_frozen
BEFORE UPDATE OF uid, drama_id ON scenes
WHEN EXISTS (SELECT 1 FROM shot_continuity_snapshots WHERE scene_uid = OLD.uid)
BEGIN SELECT RAISE(ABORT, 'shot continuity scene ownership is frozen'); END;
CREATE TRIGGER v2_shot_continuity_prop_owner_frozen
BEFORE UPDATE OF uid, drama_id ON props
WHEN EXISTS (SELECT 1 FROM shot_continuity_prop_refs WHERE prop_uid = OLD.uid)
BEGIN SELECT RAISE(ABORT, 'shot continuity prop ownership is frozen'); END;

-- P5-08: immutable Prompt Semantic versions, terminal generation history, and selection events.
CREATE TABLE prompt_semantic_versions (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  shot_result_uid TEXT NOT NULL CHECK (
    typeof(shot_result_uid) = 'text' AND length(CAST(shot_result_uid AS BLOB)) = 36 AND
    shot_result_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  shot_result_hash TEXT NOT NULL CHECK (length(CAST(shot_result_hash AS BLOB)) = 64 AND shot_result_hash NOT GLOB '*[^0-9a-f]*'),
  shot_envelope_hash TEXT NOT NULL CHECK (length(CAST(shot_envelope_hash AS BLOB)) = 64 AND shot_envelope_hash NOT GLOB '*[^0-9a-f]*'),
  shot_approval_ref TEXT NOT NULL CHECK (
    length(CAST(shot_approval_ref AS BLOB)) = 46 AND substr(shot_approval_ref, 1, 10) = 'review:v1:' AND
    substr(shot_approval_ref, 11) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  semantic_sha256 TEXT NOT NULL CHECK (length(CAST(semantic_sha256 AS BLOB)) = 64 AND semantic_sha256 NOT GLOB '*[^0-9a-f]*'),
  semantic_json TEXT NOT NULL CHECK (
    typeof(semantic_json) = 'text' AND length(CAST(semantic_json AS BLOB)) <= 1048576 AND
    CASE WHEN json_valid(semantic_json) THEN json_type(semantic_json) = 'object' ELSE 0 END
  ),
  created_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(created_at_epoch_ms) = 'integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  )
) WITHOUT ROWID;

CREATE TRIGGER v2_prompt_semantic_versions_validate_insert
BEFORE INSERT ON prompt_semantic_versions
WHEN NOT (
  (SELECT count(*) FROM json_each(NEW.semantic_json)) = 10
  AND json_extract(NEW.semantic_json, '$.taskType') = 'PromptSemanticVersioningTask'
  AND json_extract(NEW.semantic_json, '$.schemaVersion') = 'prompt-semantic-versioned.v1'
  AND json_extract(NEW.semantic_json, '$.dramaUid') = NEW.drama_uid
  AND json_extract(NEW.semantic_json, '$.shotResultUid') = NEW.shot_result_uid
  AND json_extract(NEW.semantic_json, '$.shotResultHash') = NEW.shot_result_hash
  AND json_extract(NEW.semantic_json, '$.shotEnvelopeHash') = NEW.shot_envelope_hash
  AND json_extract(NEW.semantic_json, '$.shotApprovalRef') = NEW.shot_approval_ref
  AND length(json_extract(NEW.semantic_json, '$.inputHash')) = 64
  AND json_extract(NEW.semantic_json, '$.inputHash') NOT GLOB '*[^0-9a-f]*'
  AND length(json_extract(NEW.semantic_json, '$.upstreamPromptHash')) = 64
  AND json_extract(NEW.semantic_json, '$.upstreamPromptHash') NOT GLOB '*[^0-9a-f]*'
  AND json_type(NEW.semantic_json, '$.output') = 'object'
  AND (SELECT count(*) FROM json_each(json_extract(NEW.semantic_json, '$.output'))) = 3
  AND json_extract(NEW.semantic_json, '$.output.aspectRatio') = '16:9'
  AND json_type(NEW.semantic_json, '$.output.durationSummary') = 'object'
  AND (SELECT count(*) FROM json_each(json_extract(NEW.semantic_json, '$.output.durationSummary'))) = 1
  AND typeof(json_extract(NEW.semantic_json, '$.output.durationSummary.totalSeconds')) = 'integer'
  AND json_extract(NEW.semantic_json, '$.output.durationSummary.totalSeconds') BETWEEN 45 AND 75
  AND json_type(NEW.semantic_json, '$.output.semanticShots') = 'array'
  AND json_array_length(NEW.semantic_json, '$.output.semanticShots') BETWEEN 4 AND 6
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.semantic_json, '$.output.semanticShots') AS shot
    WHERE json_type(shot.value) <> 'object'
      OR (SELECT count(*) FROM json_each(shot.value)) <> 10
      OR json_type(shot.value, '$.shotId') <> 'text'
      OR json_extract(shot.value, '$.shotId') NOT GLOB '[a-z]*'
      OR json_extract(shot.value, '$.ordinal') <> CAST(shot.key AS INTEGER) + 1
      OR typeof(json_extract(shot.value, '$.durationSeconds')) <> 'integer'
      OR json_extract(shot.value, '$.durationSeconds') NOT BETWEEN 1 AND 60
      OR length(json_extract(shot.value, '$.continuitySnapshotUid')) <> 36
      OR json_type(shot.value, '$.subjects') <> 'object'
      OR (SELECT count(*) FROM json_each(json_extract(shot.value, '$.subjects'))) <> 2
      OR json_type(shot.value, '$.subjects.description') <> 'text'
      OR length(json_extract(shot.value, '$.subjects.description')) NOT BETWEEN 1 AND 4000
      OR json_type(shot.value, '$.subjects.characters') <> 'array'
      OR json_array_length(shot.value, '$.subjects.characters') > 128
      OR json_type(shot.value, '$.environment') <> 'object'
      OR (SELECT count(*) FROM json_each(json_extract(shot.value, '$.environment'))) <> 4
      OR json_type(shot.value, '$.environment.sceneId') <> 'text'
      OR json_type(shot.value, '$.environment.description') <> 'text'
      OR length(json_extract(shot.value, '$.environment.description')) NOT BETWEEN 1 AND 4000
      OR json_type(shot.value, '$.environment.scene') <> 'object'
      OR (SELECT count(*) FROM json_each(json_extract(shot.value, '$.environment.scene'))) <> 2
      OR length(json_extract(shot.value, '$.environment.scene.sceneUid')) <> 36
      OR length(json_extract(shot.value, '$.environment.scene.versionUid')) <> 36
      OR json_type(shot.value, '$.environment.props') <> 'array'
      OR json_array_length(shot.value, '$.environment.props') > 128
      OR json_type(shot.value, '$.action') <> 'text'
      OR length(json_extract(shot.value, '$.action')) NOT BETWEEN 1 AND 4000
      OR json_type(shot.value, '$.camera') <> 'object'
      OR (SELECT count(*) FROM json_each(json_extract(shot.value, '$.camera'))) <> 4
      OR json_extract(shot.value, '$.camera.shotSize') NOT IN ('ECU','CU','MCU','MS','MLS','LS','ELS')
      OR json_extract(shot.value, '$.camera.cameraAngle') NOT IN ('eye_level','high','low','dutch','overhead','pov')
      OR json_extract(shot.value, '$.camera.cameraMovement') NOT IN ('static','pan','tilt','dolly','truck','crane','handheld','orbit')
      OR json_type(shot.value, '$.camera.composition') <> 'text'
      OR json_type(shot.value, '$.lighting') <> 'object'
      OR (SELECT count(*) FROM json_each(json_extract(shot.value, '$.lighting'))) <> 4
      OR json_extract(shot.value, '$.lighting.quality') NOT IN ('soft','hard','mixed','natural','practical')
      OR json_extract(shot.value, '$.lighting.direction') NOT IN ('front','side','back','top','ambient','mixed')
      OR json_extract(shot.value, '$.lighting.colorTemperature') NOT IN ('warm','neutral','cool','mixed')
      OR json_type(shot.value, '$.lighting.description') <> 'text'
      OR json_type(shot.value, '$.continuity') <> 'object'
      OR (SELECT count(*) FROM json_each(json_extract(shot.value, '$.continuity'))) <> 4
      OR json_extract(shot.value, '$.continuity.transitionFromPrevious') NOT IN ('start','cut','match_cut','dissolve')
      OR json_extract(shot.value, '$.continuity.screenDirection') NOT IN ('left_to_right','right_to_left','neutral')
      OR json_extract(shot.value, '$.continuity.axisStrategy') NOT IN ('establish','maintain','intentional_cross')
      OR json_type(shot.value, '$.continuity.notes') <> 'text'
      OR EXISTS (
        SELECT 1 FROM json_each(shot.value, '$.subjects.characters') AS character
        WHERE json_type(character.value) <> 'object'
          OR (SELECT count(*) FROM json_each(character.value)) <> 5
          OR json_type(character.value, '$.factRef') <> 'text'
          OR length(json_extract(character.value, '$.characterUid')) <> 36
          OR length(json_extract(character.value, '$.referencePackageUid')) <> 36
          OR length(json_extract(character.value, '$.identityVersionUid')) <> 36
          OR length(json_extract(character.value, '$.costumeVersionUid')) <> 36
      )
      OR EXISTS (
        SELECT 1 FROM json_each(shot.value, '$.environment.props') AS prop
        WHERE json_type(prop.value) <> 'object'
          OR (SELECT count(*) FROM json_each(prop.value)) <> 3
          OR json_type(prop.value, '$.factRef') <> 'text'
          OR length(json_extract(prop.value, '$.propUid')) <> 36
          OR length(json_extract(prop.value, '$.versionUid')) <> 36
      )
  )
  AND (
    SELECT sum(CAST(json_extract(shot.value, '$.durationSeconds') AS INTEGER))
    FROM json_each(NEW.semantic_json, '$.output.semanticShots') AS shot
  ) = json_extract(NEW.semantic_json, '$.output.durationSummary.totalSeconds')
  AND NOT EXISTS (
    SELECT json_extract(shot.value, '$.shotId')
    FROM json_each(NEW.semantic_json, '$.output.semanticShots') AS shot
    GROUP BY json_extract(shot.value, '$.shotId') HAVING count(*) > 1
  )
)
BEGIN SELECT RAISE(ABORT, 'prompt semantic version is invalid'); END;

CREATE TABLE asset_generation_history (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  run_uid TEXT NOT NULL UNIQUE REFERENCES generation_runs(uid) ON DELETE RESTRICT,
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  asset_uid TEXT NOT NULL REFERENCES assets(uid) ON DELETE RESTRICT,
  prompt_semantic_uid TEXT NOT NULL REFERENCES prompt_semantic_versions(uid) ON DELETE RESTRICT,
  manifest_uid TEXT NOT NULL REFERENCES workflow_manifests(uid) ON DELETE RESTRICT,
  manifest_sha256 TEXT NOT NULL CHECK (length(CAST(manifest_sha256 AS BLOB)) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  provider TEXT NOT NULL CHECK (
    typeof(provider)='text' AND provider=trim(provider) AND
    length(provider) BETWEEN 1 AND 128 AND instr(provider, char(0)) = 0
  ),
  model TEXT NOT NULL CHECK (
    typeof(model)='text' AND model=trim(model) AND
    length(model) BETWEEN 1 AND 128 AND instr(model, char(0)) = 0
  ),
  seed INTEGER CHECK (seed IS NULL OR (typeof(seed) = 'integer' AND seed BETWEEN 0 AND 4294967295)),
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json) AND json_type(parameters_json) = 'object'),
  parameters_sha256 TEXT NOT NULL CHECK (length(CAST(parameters_sha256 AS BLOB)) = 64 AND parameters_sha256 NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK (json_valid(input_json) AND json_type(input_json) = 'object'),
  input_sha256 TEXT NOT NULL CHECK (length(CAST(input_sha256 AS BLOB)) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','cancelled')),
  output_version_uid TEXT REFERENCES asset_versions(uid) ON DELETE RESTRICT,
  parent_version_uid TEXT REFERENCES asset_versions(uid) ON DELETE RESTRICT,
  output_version_evidence_json TEXT CHECK (
    output_version_evidence_json IS NULL OR (
      typeof(output_version_evidence_json)='text' AND
      length(CAST(output_version_evidence_json AS BLOB)) BETWEEN 2 AND 8192 AND
      CASE WHEN json_valid(output_version_evidence_json)
        THEN json_type(output_version_evidence_json)='object' ELSE 0 END
    )
  ),
  parent_version_evidence_json TEXT CHECK (
    parent_version_evidence_json IS NULL OR (
      typeof(parent_version_evidence_json)='text' AND
      length(CAST(parent_version_evidence_json AS BLOB)) BETWEEN 2 AND 8192 AND
      CASE WHEN json_valid(parent_version_evidence_json)
        THEN json_type(parent_version_evidence_json)='object' ELSE 0 END
    )
  ),
  error_code TEXT CHECK (error_code IS NULL OR (length(error_code) BETWEEN 5 AND 64 AND substr(error_code,1,4)='ERR_' AND error_code NOT GLOB '*[^A-Z0-9_]*')),
  error_detail_ref TEXT CHECK (error_detail_ref IS NULL OR (
    length(CAST(error_detail_ref AS BLOB))=52 AND substr(error_detail_ref,1,16)='error-detail:v1:' AND
    substr(error_detail_ref,17) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  )),
  created_at_epoch_ms INTEGER NOT NULL CHECK (typeof(created_at_epoch_ms)='integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999),
  completed_at_epoch_ms INTEGER NOT NULL CHECK (typeof(completed_at_epoch_ms)='integer' AND completed_at_epoch_ms BETWEEN created_at_epoch_ms AND 253402300799999),
  CHECK (
    (status='succeeded' AND output_version_uid IS NOT NULL
      AND output_version_evidence_json IS NOT NULL
      AND error_code IS NULL AND error_detail_ref IS NULL)
    OR (status='failed' AND output_version_uid IS NULL
      AND output_version_evidence_json IS NULL AND error_code IS NOT NULL)
    OR (status='cancelled' AND output_version_uid IS NULL
      AND output_version_evidence_json IS NULL
      AND error_code IS NULL AND error_detail_ref IS NULL)
  ),
  CHECK (
    (parent_version_uid IS NULL AND parent_version_evidence_json IS NULL)
    OR (parent_version_uid IS NOT NULL AND parent_version_evidence_json IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE INDEX idx_v2_asset_generation_history_asset
ON asset_generation_history(asset_uid, completed_at_epoch_ms, uid);

CREATE TRIGGER v2_asset_generation_history_validate_insert
BEFORE INSERT ON asset_generation_history
WHEN NOT (
  EXISTS (
    SELECT 1 FROM prompt_semantic_versions AS semantic
    WHERE semantic.uid=NEW.prompt_semantic_uid AND semantic.drama_uid=NEW.drama_uid
      AND semantic.created_at_epoch_ms<=NEW.created_at_epoch_ms
  )
  AND EXISTS (
    SELECT 1 FROM workflow_manifests AS manifest
    WHERE manifest.uid=NEW.manifest_uid AND manifest.workflow_sha256=NEW.manifest_sha256
      AND manifest.status='validated'
  )
  AND EXISTS (
    SELECT 1 FROM generation_runs AS run
    JOIN assets AS owned_asset ON owned_asset.uid=NEW.asset_uid
    WHERE run.uid=NEW.run_uid AND run.owner_type=owned_asset.owner_type
      AND run.owner_uid=owned_asset.owner_uid
      AND run.provider=NEW.provider AND run.model=NEW.model
      AND run.seed IS NEW.seed AND run.parameters_json=NEW.parameters_json
       AND run.input_json=NEW.input_json AND run.prompt_version_uid=NEW.prompt_semantic_uid
       AND run.status=NEW.status AND run.output_asset_version_uid IS NEW.output_version_uid
       AND run.error_code IS NEW.error_code AND run.error_detail_ref IS NEW.error_detail_ref
       AND run.created_at IS NOT NULL AND run.completed_at IS NOT NULL
       AND NEW.created_at_epoch_ms=(
         CAST(strftime('%s',run.created_at) AS INTEGER)*1000 + CAST(substr(run.created_at,21,3) AS INTEGER)
       )
       AND NEW.completed_at_epoch_ms=(
         CAST(strftime('%s',run.completed_at) AS INTEGER)*1000 + CAST(substr(run.completed_at,21,3) AS INTEGER)
       )
  )
  AND json_extract(NEW.input_json,'$.promptSemanticUid')=NEW.prompt_semantic_uid
  AND json_extract(NEW.input_json,'$.manifestUid')=NEW.manifest_uid
  AND EXISTS (
    SELECT 1 FROM assets AS asset WHERE asset.uid=NEW.asset_uid AND (
      (asset.owner_type='drama' AND asset.owner_uid=NEW.drama_uid)
      OR (asset.owner_type='character' AND EXISTS (
        SELECT 1 FROM characters AS owner JOIN dramas AS drama ON drama.id=owner.drama_id
        WHERE owner.uid=asset.owner_uid AND drama.uid=NEW.drama_uid
      ))
      OR (asset.owner_type='scene' AND EXISTS (
        SELECT 1 FROM scenes AS owner JOIN dramas AS drama ON drama.id=owner.drama_id
        WHERE owner.uid=asset.owner_uid AND drama.uid=NEW.drama_uid
      ))
      OR (asset.owner_type='prop' AND EXISTS (
        SELECT 1 FROM props AS owner JOIN dramas AS drama ON drama.id=owner.drama_id
        WHERE owner.uid=asset.owner_uid AND drama.uid=NEW.drama_uid
      ))
      OR (asset.owner_type='shot' AND EXISTS (
        SELECT 1 FROM narrative_results AS owner
        WHERE owner.uid=asset.owner_uid AND owner.drama_uid=NEW.drama_uid AND owner.result_type='shot'
      ))
    )
  )
  AND (
    (NEW.status='succeeded' AND EXISTS (
      SELECT 1 FROM asset_versions AS output
      WHERE output.uid=NEW.output_version_uid AND output.asset_uid=NEW.asset_uid
        AND output.parent_uid IS NEW.parent_version_uid AND output.status='ready'
        AND typeof(output.created_at)='text'
        AND length(CAST(output.created_at AS BLOB))=24
        AND output.created_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ',julianday(output.created_at)) IS output.created_at
        AND length(CAST(output.logical_uri AS BLOB)) BETWEEN 9 AND 2048
        AND output.logical_uri=trim(output.logical_uri) AND instr(output.logical_uri,char(0))=0
        AND (output.mime_type IS NULL OR (
          output.mime_type=trim(output.mime_type) AND
          length(CAST(output.mime_type AS BLOB)) BETWEEN 1 AND 255
        ))
        AND (output.width IS NULL OR output.width<=9007199254740991)
        AND (output.height IS NULL OR output.height<=9007199254740991)
        AND (output.duration_ms IS NULL OR output.duration_ms<=9007199254740991)
        AND json_extract(NEW.output_version_evidence_json,'$.uid')=output.uid
        AND json_extract(NEW.output_version_evidence_json,'$.assetUid')=output.asset_uid
        AND json_extract(NEW.output_version_evidence_json,'$.storageProvider')=output.storage_provider
        AND json_extract(NEW.output_version_evidence_json,'$.logicalUri')=output.logical_uri
        AND json_extract(NEW.output_version_evidence_json,'$.relativePath')=output.relative_path
        AND json_extract(NEW.output_version_evidence_json,'$.sha256') IS output.sha256
        AND json_extract(NEW.output_version_evidence_json,'$.mimeType') IS output.mime_type
        AND json_extract(NEW.output_version_evidence_json,'$.width') IS output.width
        AND json_extract(NEW.output_version_evidence_json,'$.height') IS output.height
        AND json_extract(NEW.output_version_evidence_json,'$.durationMs') IS output.duration_ms
        AND json_extract(NEW.output_version_evidence_json,'$.parentUid') IS output.parent_uid
        AND json_extract(NEW.output_version_evidence_json,'$.status')=output.status
        AND json_extract(NEW.output_version_evidence_json,'$.createdAt')=output.created_at
        AND (SELECT count(*) FROM json_each(NEW.output_version_evidence_json))=13
        AND (SELECT count(DISTINCT key) FROM json_each(NEW.output_version_evidence_json))=13
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.output_version_evidence_json)
          WHERE key NOT IN (
            'uid','assetUid','storageProvider','logicalUri','relativePath','sha256',
            'mimeType','width','height','durationMs','parentUid','status','createdAt'
          )
        )
    ))
    OR (NEW.status<>'succeeded' AND (
      NEW.parent_version_uid IS NULL OR EXISTS (
        SELECT 1 FROM asset_versions AS parent
        WHERE parent.uid=NEW.parent_version_uid AND parent.asset_uid=NEW.asset_uid
          AND parent.status='ready'
      )
    ))
  )
  AND (
    NEW.parent_version_uid IS NULL OR EXISTS (
      SELECT 1 FROM asset_versions AS parent
      WHERE parent.uid=NEW.parent_version_uid AND parent.asset_uid=NEW.asset_uid
        AND parent.status='ready'
        AND typeof(parent.created_at)='text'
        AND length(CAST(parent.created_at AS BLOB))=24
        AND parent.created_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ',julianday(parent.created_at)) IS parent.created_at
        AND length(CAST(parent.logical_uri AS BLOB)) BETWEEN 9 AND 2048
        AND parent.logical_uri=trim(parent.logical_uri) AND instr(parent.logical_uri,char(0))=0
        AND (parent.mime_type IS NULL OR (
          parent.mime_type=trim(parent.mime_type) AND
          length(CAST(parent.mime_type AS BLOB)) BETWEEN 1 AND 255
        ))
        AND (parent.width IS NULL OR parent.width<=9007199254740991)
        AND (parent.height IS NULL OR parent.height<=9007199254740991)
        AND (parent.duration_ms IS NULL OR parent.duration_ms<=9007199254740991)
        AND json_extract(NEW.parent_version_evidence_json,'$.uid')=parent.uid
        AND json_extract(NEW.parent_version_evidence_json,'$.assetUid')=parent.asset_uid
        AND json_extract(NEW.parent_version_evidence_json,'$.storageProvider')=parent.storage_provider
        AND json_extract(NEW.parent_version_evidence_json,'$.logicalUri')=parent.logical_uri
        AND json_extract(NEW.parent_version_evidence_json,'$.relativePath')=parent.relative_path
        AND json_extract(NEW.parent_version_evidence_json,'$.sha256') IS parent.sha256
        AND json_extract(NEW.parent_version_evidence_json,'$.mimeType') IS parent.mime_type
        AND json_extract(NEW.parent_version_evidence_json,'$.width') IS parent.width
        AND json_extract(NEW.parent_version_evidence_json,'$.height') IS parent.height
        AND json_extract(NEW.parent_version_evidence_json,'$.durationMs') IS parent.duration_ms
        AND json_extract(NEW.parent_version_evidence_json,'$.parentUid') IS parent.parent_uid
        AND json_extract(NEW.parent_version_evidence_json,'$.status')=parent.status
        AND json_extract(NEW.parent_version_evidence_json,'$.createdAt')=parent.created_at
        AND (SELECT count(*) FROM json_each(NEW.parent_version_evidence_json))=13
        AND (SELECT count(DISTINCT key) FROM json_each(NEW.parent_version_evidence_json))=13
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.parent_version_evidence_json)
          WHERE key NOT IN (
            'uid','assetUid','storageProvider','logicalUri','relativePath','sha256',
            'mimeType','width','height','durationMs','parentUid','status','createdAt'
          )
        )
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'asset generation history is invalid'); END;

CREATE TRIGGER v2_generation_runs_reject_sensitive_payload_insert
BEFORE INSERT ON generation_runs
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT key, atom, type FROM json_tree(NEW.parameters_json)
    UNION ALL
    SELECT key, atom, type FROM json_tree(NEW.input_json)
  ) AS payload
  WHERE (
    payload.key IS NOT NULL AND lower(replace(replace(replace(replace(replace(
      CAST(payload.key AS TEXT),'_',''),'-',''),' ',''),'.',''),':','')) IN (
        'apikey','apisecret','accesskey','accesssecret','authorization','bearer',
        'credential','credentialref','password','privatekey','refreshtoken','secret',
        'secretkey','sessiontoken','token'
      )
  ) OR (
    payload.type='text' AND (
      lower(CAST(payload.atom AS TEXT)) GLOB 'bearer *'
      OR lower(CAST(payload.atom AS TEXT)) GLOB 'sk-????????*'
      OR lower(CAST(payload.atom AS TEXT)) GLOB 'akia????????????*'
      OR lower(CAST(payload.atom AS TEXT)) GLOB '-----begin *private key-----*'
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'generation run payload is invalid'); END;

CREATE TRIGGER v2_generation_runs_reject_sensitive_payload_update
BEFORE UPDATE OF parameters_json,input_json ON generation_runs
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT key, atom, type FROM json_tree(NEW.parameters_json)
    UNION ALL
    SELECT key, atom, type FROM json_tree(NEW.input_json)
  ) AS payload
  WHERE (
    payload.key IS NOT NULL AND lower(replace(replace(replace(replace(replace(
      CAST(payload.key AS TEXT),'_',''),'-',''),' ',''),'.',''),':','')) IN (
        'apikey','apisecret','accesskey','accesssecret','authorization','bearer',
        'credential','credentialref','password','privatekey','refreshtoken','secret',
        'secretkey','sessiontoken','token'
      )
  ) OR (
    payload.type='text' AND (
      lower(CAST(payload.atom AS TEXT)) GLOB 'bearer *'
      OR lower(CAST(payload.atom AS TEXT)) GLOB 'sk-????????*'
      OR lower(CAST(payload.atom AS TEXT)) GLOB 'akia????????????*'
      OR lower(CAST(payload.atom AS TEXT)) GLOB '-----begin *private key-----*'
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'generation run payload is invalid'); END;

CREATE TRIGGER v2_prompt_semantic_versions_reject_sensitive_payload
BEFORE INSERT ON prompt_semantic_versions
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.semantic_json) AS payload
  WHERE payload.type='text' AND (
    lower(CAST(payload.atom AS TEXT)) GLOB 'bearer *'
    OR lower(CAST(payload.atom AS TEXT)) GLOB 'sk-????????*'
    OR lower(CAST(payload.atom AS TEXT)) GLOB 'akia????????????*'
    OR lower(CAST(payload.atom AS TEXT)) GLOB '-----begin *private key-----*'
  )
)
BEGIN SELECT RAISE(ABORT, 'prompt semantic payload is invalid'); END;

CREATE TRIGGER v2_asset_generation_history_reject_sensitive_payload
BEFORE INSERT ON asset_generation_history
WHEN lower(NEW.provider) GLOB 'bearer *'
  OR lower(NEW.provider) GLOB 'sk-????????*'
  OR lower(NEW.provider) GLOB 'akia????????????*'
  OR lower(NEW.model) GLOB 'bearer *'
  OR lower(NEW.model) GLOB 'sk-????????*'
  OR lower(NEW.model) GLOB 'akia????????????*'
  OR EXISTS (
    SELECT 1 FROM (
      SELECT key, atom, type FROM json_tree(NEW.parameters_json)
      UNION ALL
      SELECT key, atom, type FROM json_tree(NEW.input_json)
    ) AS payload
    WHERE (
      payload.key IS NOT NULL AND lower(replace(replace(replace(replace(replace(
        CAST(payload.key AS TEXT),'_',''),'-',''),' ',''),'.',''),':','')) IN (
          'apikey','apisecret','accesskey','accesssecret','authorization','bearer',
          'credential','credentialref','password','privatekey','refreshtoken','secret',
          'secretkey','sessiontoken','token'
        )
    ) OR (
      payload.type='text' AND (
        lower(CAST(payload.atom AS TEXT)) GLOB 'bearer *'
        OR lower(CAST(payload.atom AS TEXT)) GLOB 'sk-????????*'
        OR lower(CAST(payload.atom AS TEXT)) GLOB 'akia????????????*'
        OR lower(CAST(payload.atom AS TEXT)) GLOB '-----begin *private key-----*'
      )
    )
  )
BEGIN SELECT RAISE(ABORT, 'asset generation history payload is invalid'); END;

CREATE TABLE asset_version_selection_events (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  history_uid TEXT NOT NULL REFERENCES asset_generation_history(uid) ON DELETE RESTRICT,
  asset_uid TEXT NOT NULL REFERENCES assets(uid) ON DELETE RESTRICT,
  selected_version_uid TEXT NOT NULL REFERENCES asset_versions(uid) ON DELETE RESTRICT,
  previous_version_uid TEXT REFERENCES asset_versions(uid) ON DELETE RESTRICT,
  state_version INTEGER NOT NULL CHECK (typeof(state_version)='integer' AND state_version BETWEEN 1 AND 9007199254740991),
  changed_at_epoch_ms INTEGER NOT NULL CHECK (typeof(changed_at_epoch_ms)='integer' AND changed_at_epoch_ms BETWEEN 0 AND 253402300799999),
  UNIQUE(asset_uid,state_version)
) WITHOUT ROWID;

CREATE TRIGGER v2_asset_version_selection_validate_insert
BEFORE INSERT ON asset_version_selection_events
WHEN NOT (
  EXISTS (
    SELECT 1 FROM asset_generation_history AS history
    WHERE history.uid=NEW.history_uid AND history.asset_uid=NEW.asset_uid
      AND history.status='succeeded' AND history.output_version_uid=NEW.selected_version_uid
  )
  AND EXISTS (
    SELECT 1 FROM assets AS asset
    WHERE asset.uid=NEW.asset_uid AND asset.current_version_uid IS NEW.previous_version_uid
  )
  AND EXISTS (
    SELECT 1 FROM asset_versions AS version
    WHERE version.uid=NEW.selected_version_uid AND version.asset_uid=NEW.asset_uid AND version.status='ready'
  )
  AND NEW.selected_version_uid IS NOT NEW.previous_version_uid
  AND NEW.state_version=COALESCE((
    SELECT max(state_version)+1 FROM asset_version_selection_events WHERE asset_uid=NEW.asset_uid
  ),1)
  AND NEW.changed_at_epoch_ms>=COALESCE((
    SELECT max(changed_at_epoch_ms) FROM asset_version_selection_events
    WHERE asset_uid=NEW.asset_uid
  ),0)
  AND NEW.changed_at_epoch_ms>=(
    SELECT completed_at_epoch_ms FROM asset_generation_history WHERE uid=NEW.history_uid
  )
)
BEGIN SELECT RAISE(ABORT, 'asset version selection event is invalid'); END;

CREATE TRIGGER v2_asset_version_selection_apply
AFTER INSERT ON asset_version_selection_events
BEGIN
  UPDATE assets SET current_version_uid=NEW.selected_version_uid,
    status=CASE WHEN status='draft' THEN 'ready' ELSE status END,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE uid=NEW.asset_uid;
END;

CREATE TRIGGER v2_asset_version_selection_pointer_guard
BEFORE UPDATE OF current_version_uid ON assets
WHEN EXISTS (SELECT 1 FROM asset_generation_history WHERE asset_uid=OLD.uid)
  AND NEW.current_version_uid IS NOT OLD.current_version_uid
  AND NOT EXISTS (
    SELECT 1 FROM asset_version_selection_events AS event
    WHERE event.asset_uid=OLD.uid AND event.previous_version_uid IS OLD.current_version_uid
      AND event.selected_version_uid=NEW.current_version_uid
      AND event.state_version=(SELECT max(state_version) FROM asset_version_selection_events WHERE asset_uid=OLD.uid)
  )
BEGIN SELECT RAISE(ABORT, 'asset version selection requires an append-only event'); END;

CREATE TRIGGER v2_prompt_semantic_versions_reject_replacement
BEFORE INSERT ON prompt_semantic_versions
WHEN EXISTS (SELECT 1 FROM prompt_semantic_versions WHERE uid=NEW.uid)
BEGIN SELECT RAISE(ABORT, 'prompt semantic version replacement is forbidden'); END;
CREATE TRIGGER v2_asset_generation_history_reject_replacement
BEFORE INSERT ON asset_generation_history
WHEN EXISTS (SELECT 1 FROM asset_generation_history WHERE uid=NEW.uid OR run_uid=NEW.run_uid)
BEGIN SELECT RAISE(ABORT, 'asset generation history replacement is forbidden'); END;
CREATE TRIGGER v2_asset_version_selection_reject_replacement
BEFORE INSERT ON asset_version_selection_events
WHEN EXISTS (SELECT 1 FROM asset_version_selection_events WHERE uid=NEW.uid)
BEGIN SELECT RAISE(ABORT, 'asset version selection replacement is forbidden'); END;

CREATE TRIGGER v2_prompt_semantic_versions_immutable_update BEFORE UPDATE ON prompt_semantic_versions
BEGIN SELECT RAISE(ABORT, 'prompt semantic versions are immutable'); END;
CREATE TRIGGER v2_prompt_semantic_versions_immutable_delete BEFORE DELETE ON prompt_semantic_versions
BEGIN SELECT RAISE(ABORT, 'prompt semantic versions are append-only'); END;
CREATE TRIGGER v2_asset_generation_history_immutable_update BEFORE UPDATE ON asset_generation_history
BEGIN SELECT RAISE(ABORT, 'asset generation history is immutable'); END;
CREATE TRIGGER v2_asset_generation_history_immutable_delete BEFORE DELETE ON asset_generation_history
BEGIN SELECT RAISE(ABORT, 'asset generation history is append-only'); END;
CREATE TRIGGER v2_asset_version_selection_immutable_update BEFORE UPDATE ON asset_version_selection_events
BEGIN SELECT RAISE(ABORT, 'asset version selection events are immutable'); END;
CREATE TRIGGER v2_asset_version_selection_immutable_delete BEFORE DELETE ON asset_version_selection_events
BEGIN SELECT RAISE(ABORT, 'asset version selection events are append-only'); END;

CREATE TRIGGER v2_generation_runs_frozen_after_history
BEFORE UPDATE ON generation_runs
WHEN EXISTS (SELECT 1 FROM asset_generation_history WHERE run_uid=OLD.uid)
BEGIN SELECT RAISE(ABORT, 'generation run is frozen by history'); END;
CREATE TRIGGER v2_generation_runs_delete_frozen_after_history
BEFORE DELETE ON generation_runs
WHEN EXISTS (SELECT 1 FROM asset_generation_history WHERE run_uid=OLD.uid)
BEGIN SELECT RAISE(ABORT, 'generation run is frozen by history'); END;
CREATE TRIGGER v2_generation_manifests_frozen_after_history
BEFORE UPDATE ON workflow_manifests
WHEN EXISTS (SELECT 1 FROM asset_generation_history WHERE manifest_uid=OLD.uid)
BEGIN SELECT RAISE(ABORT, 'workflow manifest is frozen by generation history'); END;
CREATE TRIGGER v2_generation_manifests_delete_frozen_after_history
BEFORE DELETE ON workflow_manifests
WHEN EXISTS (SELECT 1 FROM asset_generation_history WHERE manifest_uid=OLD.uid)
BEGIN SELECT RAISE(ABORT, 'workflow manifest is frozen by generation history'); END;
CREATE TRIGGER v2_generation_assets_frozen_after_history
BEFORE UPDATE OF uid,owner_type,owner_uid,asset_type ON assets
WHEN EXISTS (SELECT 1 FROM asset_generation_history WHERE asset_uid=OLD.uid)
BEGIN SELECT RAISE(ABORT, 'generation asset ownership is frozen'); END;
CREATE TRIGGER v2_generation_asset_status_frozen_after_history
BEFORE UPDATE OF status ON assets
WHEN EXISTS (SELECT 1 FROM asset_generation_history WHERE asset_uid=OLD.uid)
  AND NEW.status IS NOT OLD.status
  AND NOT (
    OLD.status='draft' AND NEW.status='ready' AND EXISTS (
      SELECT 1 FROM asset_version_selection_events AS event
      WHERE event.asset_uid=OLD.uid AND event.previous_version_uid IS OLD.current_version_uid
        AND event.selected_version_uid=NEW.current_version_uid
        AND event.state_version=(
          SELECT max(state_version) FROM asset_version_selection_events WHERE asset_uid=OLD.uid
        )
    )
  )
BEGIN SELECT RAISE(ABORT, 'generation asset status is frozen'); END;
CREATE TRIGGER v2_generation_asset_versions_frozen_after_history
BEFORE UPDATE ON asset_versions
WHEN EXISTS (
  SELECT 1 FROM asset_generation_history
  WHERE output_version_uid=OLD.uid OR parent_version_uid=OLD.uid
)
BEGIN SELECT RAISE(ABORT, 'generation asset version evidence is frozen'); END;
CREATE TRIGGER v2_generation_asset_versions_delete_frozen_after_history
BEFORE DELETE ON asset_versions
WHEN EXISTS (
  SELECT 1 FROM asset_generation_history
  WHERE output_version_uid=OLD.uid OR parent_version_uid=OLD.uid
)
BEGIN SELECT RAISE(ABORT, 'generation asset version evidence is frozen'); END;
