CREATE TABLE _v2_remote_asset_recovery_character_guard (
  valid INTEGER NOT NULL CHECK (valid=1)
);

INSERT INTO _v2_remote_asset_recovery_character_guard (valid)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM remote_asset_recoveries
  WHERE state='succeeded' AND (
    json_extract(manifest_json,'$.characterName') IS NULL
    OR json_extract(manifest_json,'$.characterName')
      IS NOT json_extract(source_json,'$.characterName')
  )
) THEN 0 ELSE 1 END;

DROP TABLE _v2_remote_asset_recovery_character_guard;

CREATE TRIGGER v2_remote_asset_recoveries_character_binding_update
BEFORE UPDATE ON remote_asset_recoveries
WHEN NEW.state='succeeded' AND (
  json_extract(NEW.manifest_json,'$.characterName') IS NULL
  OR json_extract(NEW.manifest_json,'$.characterName')
    IS NOT json_extract(OLD.source_json,'$.characterName')
)
BEGIN SELECT RAISE(ABORT,'remote asset recovery character binding invalid'); END;
