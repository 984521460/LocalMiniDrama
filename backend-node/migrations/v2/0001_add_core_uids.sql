-- Keep legacy integer primary keys while adding stable v2 business identifiers.
-- The pending sentinel lets legacy INSERT statements omit uid while the AFTER
-- trigger generates it. NOT NULL prevents every conflict policy from persisting
-- a missing identifier, and the trigger makes the sentinel transient.
ALTER TABLE dramas ADD COLUMN uid TEXT NOT NULL DEFAULT '__v2_uid_pending__'
  CHECK (uid = '__v2_uid_pending__' OR (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ));
ALTER TABLE episodes ADD COLUMN uid TEXT NOT NULL DEFAULT '__v2_uid_pending__'
  CHECK (uid = '__v2_uid_pending__' OR (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ));
ALTER TABLE characters ADD COLUMN uid TEXT NOT NULL DEFAULT '__v2_uid_pending__'
  CHECK (uid = '__v2_uid_pending__' OR (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ));
ALTER TABLE scenes ADD COLUMN uid TEXT NOT NULL DEFAULT '__v2_uid_pending__'
  CHECK (uid = '__v2_uid_pending__' OR (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ));
ALTER TABLE props ADD COLUMN uid TEXT NOT NULL DEFAULT '__v2_uid_pending__'
  CHECK (uid = '__v2_uid_pending__' OR (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ));
ALTER TABLE storyboards ADD COLUMN uid TEXT NOT NULL DEFAULT '__v2_uid_pending__'
  CHECK (uid = '__v2_uid_pending__' OR (
    typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ));

UPDATE dramas
SET uid = lower(
  hex(randomblob(4)) || '-' ||
  hex(randomblob(2)) || '-' ||
  '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  hex(randomblob(6))
)
WHERE uid = '__v2_uid_pending__';

UPDATE episodes
SET uid = lower(
  hex(randomblob(4)) || '-' ||
  hex(randomblob(2)) || '-' ||
  '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  hex(randomblob(6))
)
WHERE uid = '__v2_uid_pending__';

UPDATE characters
SET uid = lower(
  hex(randomblob(4)) || '-' ||
  hex(randomblob(2)) || '-' ||
  '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  hex(randomblob(6))
)
WHERE uid = '__v2_uid_pending__';

UPDATE scenes
SET uid = lower(
  hex(randomblob(4)) || '-' ||
  hex(randomblob(2)) || '-' ||
  '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  hex(randomblob(6))
)
WHERE uid = '__v2_uid_pending__';

UPDATE props
SET uid = lower(
  hex(randomblob(4)) || '-' ||
  hex(randomblob(2)) || '-' ||
  '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  hex(randomblob(6))
)
WHERE uid = '__v2_uid_pending__';

UPDATE storyboards
SET uid = lower(
  hex(randomblob(4)) || '-' ||
  hex(randomblob(2)) || '-' ||
  '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  hex(randomblob(6))
)
WHERE uid = '__v2_uid_pending__';

-- A failed assertion aborts the runner-owned transaction before indexes or triggers persist.
CREATE TABLE _v2_core_uid_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

INSERT INTO _v2_core_uid_guard (ok)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM dramas
    WHERE uid = '__v2_uid_pending__' OR typeof(uid) <> 'text' OR length(CAST(uid AS BLOB)) <> 36 OR uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  )
  AND NOT EXISTS (
    SELECT 1 FROM episodes
    WHERE uid = '__v2_uid_pending__' OR typeof(uid) <> 'text' OR length(CAST(uid AS BLOB)) <> 36 OR uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  )
  AND NOT EXISTS (
    SELECT 1 FROM characters
    WHERE uid = '__v2_uid_pending__' OR typeof(uid) <> 'text' OR length(CAST(uid AS BLOB)) <> 36 OR uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  )
  AND NOT EXISTS (
    SELECT 1 FROM scenes
    WHERE uid = '__v2_uid_pending__' OR typeof(uid) <> 'text' OR length(CAST(uid AS BLOB)) <> 36 OR uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  )
  AND NOT EXISTS (
    SELECT 1 FROM props
    WHERE uid = '__v2_uid_pending__' OR typeof(uid) <> 'text' OR length(CAST(uid AS BLOB)) <> 36 OR uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  )
  AND NOT EXISTS (
    SELECT 1 FROM storyboards
    WHERE uid = '__v2_uid_pending__' OR typeof(uid) <> 'text' OR length(CAST(uid AS BLOB)) <> 36 OR uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  )
  AND (SELECT count(*) FROM dramas) = (SELECT count(DISTINCT uid) FROM dramas)
  AND (SELECT count(*) FROM episodes) = (SELECT count(DISTINCT uid) FROM episodes)
  AND (SELECT count(*) FROM characters) = (SELECT count(DISTINCT uid) FROM characters)
  AND (SELECT count(*) FROM scenes) = (SELECT count(DISTINCT uid) FROM scenes)
  AND (SELECT count(*) FROM props) = (SELECT count(DISTINCT uid) FROM props)
  AND (SELECT count(*) FROM storyboards) = (SELECT count(DISTINCT uid) FROM storyboards)
THEN 1 ELSE 0 END;

DROP TABLE _v2_core_uid_guard;

-- A persistent, normally empty staging table captures one generated candidate
-- exactly once. Each trigger validates and checks that candidate before the
-- target UPDATE, so OR IGNORE/FAIL cannot swallow a uniqueness failure and
-- leave the pending sentinel behind.
CREATE TABLE _v2_uid_generation_candidates (
  table_name TEXT,
  row_id INTEGER,
  uid
);

CREATE UNIQUE INDEX idx_v2_dramas_uid ON dramas(uid);
CREATE UNIQUE INDEX idx_v2_episodes_uid ON episodes(uid);
CREATE UNIQUE INDEX idx_v2_characters_uid ON characters(uid);
CREATE UNIQUE INDEX idx_v2_scenes_uid ON scenes(uid);
CREATE UNIQUE INDEX idx_v2_props_uid ON props(uid);
CREATE UNIQUE INDEX idx_v2_storyboards_uid ON storyboards(uid);

CREATE TRIGGER v2_dramas_uid_validate_insert
BEFORE INSERT ON dramas
WHEN NEW.uid IS NULL OR (
  NEW.uid <> '__v2_uid_pending__' AND (
    typeof(NEW.uid) <> 'text' OR length(CAST(NEW.uid AS BLOB)) <> 36 OR
    NEW.uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid dramas uid');
END;

CREATE TRIGGER v2_dramas_uid_validate_update
BEFORE UPDATE OF uid ON dramas
WHEN NEW.uid IS NULL OR NEW.uid = '__v2_uid_pending__' OR
  typeof(NEW.uid) <> 'text' OR length(CAST(NEW.uid AS BLOB)) <> 36 OR
  NEW.uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
BEGIN
  SELECT RAISE(ABORT, 'invalid dramas uid');
END;

CREATE TRIGGER v2_dramas_uid_fill_insert
AFTER INSERT ON dramas
WHEN NEW.uid = '__v2_uid_pending__'
BEGIN
  DELETE FROM _v2_uid_generation_candidates WHERE table_name = 'dramas' AND row_id = NEW.id;
  INSERT INTO _v2_uid_generation_candidates (table_name, row_id, uid)
  VALUES ('dramas', NEW.id, lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
    substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
    substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
  ));
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM _v2_uid_generation_candidates
    WHERE table_name = 'dramas' AND row_id = NEW.id AND typeof(uid) = 'text' AND
      length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ) OR EXISTS (
    SELECT 1 FROM dramas AS target
    JOIN _v2_uid_generation_candidates AS candidate
      ON candidate.table_name = 'dramas' AND candidate.row_id = NEW.id AND target.uid = candidate.uid
    WHERE target.id <> NEW.id
  ) THEN RAISE(ABORT, 'failed to generate unique dramas uid') END;
  UPDATE dramas SET uid = (
    SELECT uid FROM _v2_uid_generation_candidates WHERE table_name = 'dramas' AND row_id = NEW.id
  ) WHERE id = NEW.id;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM dramas AS target
    JOIN _v2_uid_generation_candidates AS candidate
      ON candidate.table_name = 'dramas' AND candidate.row_id = NEW.id AND target.uid = candidate.uid
    WHERE target.id = NEW.id
  ) THEN RAISE(ABORT, 'failed to persist dramas uid') END;
  DELETE FROM _v2_uid_generation_candidates WHERE table_name = 'dramas' AND row_id = NEW.id;
END;

CREATE TRIGGER v2_episodes_uid_validate_insert
BEFORE INSERT ON episodes
WHEN NEW.uid IS NULL OR (
  NEW.uid <> '__v2_uid_pending__' AND (
    typeof(NEW.uid) <> 'text' OR length(CAST(NEW.uid AS BLOB)) <> 36 OR
    NEW.uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid episodes uid');
END;

CREATE TRIGGER v2_episodes_uid_validate_update
BEFORE UPDATE OF uid ON episodes
WHEN NEW.uid IS NULL OR NEW.uid = '__v2_uid_pending__' OR
  typeof(NEW.uid) <> 'text' OR length(CAST(NEW.uid AS BLOB)) <> 36 OR
  NEW.uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
BEGIN
  SELECT RAISE(ABORT, 'invalid episodes uid');
END;

CREATE TRIGGER v2_episodes_uid_fill_insert
AFTER INSERT ON episodes
WHEN NEW.uid = '__v2_uid_pending__'
BEGIN
  DELETE FROM _v2_uid_generation_candidates WHERE table_name = 'episodes' AND row_id = NEW.id;
  INSERT INTO _v2_uid_generation_candidates (table_name, row_id, uid)
  VALUES ('episodes', NEW.id, lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
    substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
    substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
  ));
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM _v2_uid_generation_candidates
    WHERE table_name = 'episodes' AND row_id = NEW.id AND typeof(uid) = 'text' AND
      length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ) OR EXISTS (
    SELECT 1 FROM episodes AS target
    JOIN _v2_uid_generation_candidates AS candidate
      ON candidate.table_name = 'episodes' AND candidate.row_id = NEW.id AND target.uid = candidate.uid
    WHERE target.id <> NEW.id
  ) THEN RAISE(ABORT, 'failed to generate unique episodes uid') END;
  UPDATE episodes SET uid = (
    SELECT uid FROM _v2_uid_generation_candidates WHERE table_name = 'episodes' AND row_id = NEW.id
  ) WHERE id = NEW.id;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM episodes AS target
    JOIN _v2_uid_generation_candidates AS candidate
      ON candidate.table_name = 'episodes' AND candidate.row_id = NEW.id AND target.uid = candidate.uid
    WHERE target.id = NEW.id
  ) THEN RAISE(ABORT, 'failed to persist episodes uid') END;
  DELETE FROM _v2_uid_generation_candidates WHERE table_name = 'episodes' AND row_id = NEW.id;
END;

CREATE TRIGGER v2_characters_uid_validate_insert
BEFORE INSERT ON characters
WHEN NEW.uid IS NULL OR (
  NEW.uid <> '__v2_uid_pending__' AND (
    typeof(NEW.uid) <> 'text' OR length(CAST(NEW.uid AS BLOB)) <> 36 OR
    NEW.uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid characters uid');
END;

CREATE TRIGGER v2_characters_uid_validate_update
BEFORE UPDATE OF uid ON characters
WHEN NEW.uid IS NULL OR NEW.uid = '__v2_uid_pending__' OR
  typeof(NEW.uid) <> 'text' OR length(CAST(NEW.uid AS BLOB)) <> 36 OR
  NEW.uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
BEGIN
  SELECT RAISE(ABORT, 'invalid characters uid');
END;

CREATE TRIGGER v2_characters_uid_fill_insert
AFTER INSERT ON characters
WHEN NEW.uid = '__v2_uid_pending__'
BEGIN
  DELETE FROM _v2_uid_generation_candidates WHERE table_name = 'characters' AND row_id = NEW.id;
  INSERT INTO _v2_uid_generation_candidates (table_name, row_id, uid)
  VALUES ('characters', NEW.id, lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
    substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
    substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
  ));
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM _v2_uid_generation_candidates
    WHERE table_name = 'characters' AND row_id = NEW.id AND typeof(uid) = 'text' AND
      length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ) OR EXISTS (
    SELECT 1 FROM characters AS target
    JOIN _v2_uid_generation_candidates AS candidate
      ON candidate.table_name = 'characters' AND candidate.row_id = NEW.id AND target.uid = candidate.uid
    WHERE target.id <> NEW.id
  ) THEN RAISE(ABORT, 'failed to generate unique characters uid') END;
  UPDATE characters SET uid = (
    SELECT uid FROM _v2_uid_generation_candidates WHERE table_name = 'characters' AND row_id = NEW.id
  ) WHERE id = NEW.id;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM characters AS target
    JOIN _v2_uid_generation_candidates AS candidate
      ON candidate.table_name = 'characters' AND candidate.row_id = NEW.id AND target.uid = candidate.uid
    WHERE target.id = NEW.id
  ) THEN RAISE(ABORT, 'failed to persist characters uid') END;
  DELETE FROM _v2_uid_generation_candidates WHERE table_name = 'characters' AND row_id = NEW.id;
END;

CREATE TRIGGER v2_scenes_uid_validate_insert
BEFORE INSERT ON scenes
WHEN NEW.uid IS NULL OR (
  NEW.uid <> '__v2_uid_pending__' AND (
    typeof(NEW.uid) <> 'text' OR length(CAST(NEW.uid AS BLOB)) <> 36 OR
    NEW.uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid scenes uid');
END;

CREATE TRIGGER v2_scenes_uid_validate_update
BEFORE UPDATE OF uid ON scenes
WHEN NEW.uid IS NULL OR NEW.uid = '__v2_uid_pending__' OR
  typeof(NEW.uid) <> 'text' OR length(CAST(NEW.uid AS BLOB)) <> 36 OR
  NEW.uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
BEGIN
  SELECT RAISE(ABORT, 'invalid scenes uid');
END;

CREATE TRIGGER v2_scenes_uid_fill_insert
AFTER INSERT ON scenes
WHEN NEW.uid = '__v2_uid_pending__'
BEGIN
  DELETE FROM _v2_uid_generation_candidates WHERE table_name = 'scenes' AND row_id = NEW.id;
  INSERT INTO _v2_uid_generation_candidates (table_name, row_id, uid)
  VALUES ('scenes', NEW.id, lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
    substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
    substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
  ));
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM _v2_uid_generation_candidates
    WHERE table_name = 'scenes' AND row_id = NEW.id AND typeof(uid) = 'text' AND
      length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ) OR EXISTS (
    SELECT 1 FROM scenes AS target
    JOIN _v2_uid_generation_candidates AS candidate
      ON candidate.table_name = 'scenes' AND candidate.row_id = NEW.id AND target.uid = candidate.uid
    WHERE target.id <> NEW.id
  ) THEN RAISE(ABORT, 'failed to generate unique scenes uid') END;
  UPDATE scenes SET uid = (
    SELECT uid FROM _v2_uid_generation_candidates WHERE table_name = 'scenes' AND row_id = NEW.id
  ) WHERE id = NEW.id;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM scenes AS target
    JOIN _v2_uid_generation_candidates AS candidate
      ON candidate.table_name = 'scenes' AND candidate.row_id = NEW.id AND target.uid = candidate.uid
    WHERE target.id = NEW.id
  ) THEN RAISE(ABORT, 'failed to persist scenes uid') END;
  DELETE FROM _v2_uid_generation_candidates WHERE table_name = 'scenes' AND row_id = NEW.id;
END;

CREATE TRIGGER v2_props_uid_validate_insert
BEFORE INSERT ON props
WHEN NEW.uid IS NULL OR (
  NEW.uid <> '__v2_uid_pending__' AND (
    typeof(NEW.uid) <> 'text' OR length(CAST(NEW.uid AS BLOB)) <> 36 OR
    NEW.uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid props uid');
END;

CREATE TRIGGER v2_props_uid_validate_update
BEFORE UPDATE OF uid ON props
WHEN NEW.uid IS NULL OR NEW.uid = '__v2_uid_pending__' OR
  typeof(NEW.uid) <> 'text' OR length(CAST(NEW.uid AS BLOB)) <> 36 OR
  NEW.uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
BEGIN
  SELECT RAISE(ABORT, 'invalid props uid');
END;

CREATE TRIGGER v2_props_uid_fill_insert
AFTER INSERT ON props
WHEN NEW.uid = '__v2_uid_pending__'
BEGIN
  DELETE FROM _v2_uid_generation_candidates WHERE table_name = 'props' AND row_id = NEW.id;
  INSERT INTO _v2_uid_generation_candidates (table_name, row_id, uid)
  VALUES ('props', NEW.id, lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
    substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
    substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
  ));
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM _v2_uid_generation_candidates
    WHERE table_name = 'props' AND row_id = NEW.id AND typeof(uid) = 'text' AND
      length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ) OR EXISTS (
    SELECT 1 FROM props AS target
    JOIN _v2_uid_generation_candidates AS candidate
      ON candidate.table_name = 'props' AND candidate.row_id = NEW.id AND target.uid = candidate.uid
    WHERE target.id <> NEW.id
  ) THEN RAISE(ABORT, 'failed to generate unique props uid') END;
  UPDATE props SET uid = (
    SELECT uid FROM _v2_uid_generation_candidates WHERE table_name = 'props' AND row_id = NEW.id
  ) WHERE id = NEW.id;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM props AS target
    JOIN _v2_uid_generation_candidates AS candidate
      ON candidate.table_name = 'props' AND candidate.row_id = NEW.id AND target.uid = candidate.uid
    WHERE target.id = NEW.id
  ) THEN RAISE(ABORT, 'failed to persist props uid') END;
  DELETE FROM _v2_uid_generation_candidates WHERE table_name = 'props' AND row_id = NEW.id;
END;

CREATE TRIGGER v2_storyboards_uid_validate_insert
BEFORE INSERT ON storyboards
WHEN NEW.uid IS NULL OR (
  NEW.uid <> '__v2_uid_pending__' AND (
    typeof(NEW.uid) <> 'text' OR length(CAST(NEW.uid AS BLOB)) <> 36 OR
    NEW.uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid storyboards uid');
END;

CREATE TRIGGER v2_storyboards_uid_validate_update
BEFORE UPDATE OF uid ON storyboards
WHEN NEW.uid IS NULL OR NEW.uid = '__v2_uid_pending__' OR
  typeof(NEW.uid) <> 'text' OR length(CAST(NEW.uid AS BLOB)) <> 36 OR
  NEW.uid NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
BEGIN
  SELECT RAISE(ABORT, 'invalid storyboards uid');
END;

CREATE TRIGGER v2_storyboards_uid_fill_insert
AFTER INSERT ON storyboards
WHEN NEW.uid = '__v2_uid_pending__'
BEGIN
  DELETE FROM _v2_uid_generation_candidates WHERE table_name = 'storyboards' AND row_id = NEW.id;
  INSERT INTO _v2_uid_generation_candidates (table_name, row_id, uid)
  VALUES ('storyboards', NEW.id, lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
    substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
    substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
  ));
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM _v2_uid_generation_candidates
    WHERE table_name = 'storyboards' AND row_id = NEW.id AND typeof(uid) = 'text' AND
      length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ) OR EXISTS (
    SELECT 1 FROM storyboards AS target
    JOIN _v2_uid_generation_candidates AS candidate
      ON candidate.table_name = 'storyboards' AND candidate.row_id = NEW.id AND target.uid = candidate.uid
    WHERE target.id <> NEW.id
  ) THEN RAISE(ABORT, 'failed to generate unique storyboards uid') END;
  UPDATE storyboards SET uid = (
    SELECT uid FROM _v2_uid_generation_candidates WHERE table_name = 'storyboards' AND row_id = NEW.id
  ) WHERE id = NEW.id;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM storyboards AS target
    JOIN _v2_uid_generation_candidates AS candidate
      ON candidate.table_name = 'storyboards' AND candidate.row_id = NEW.id AND target.uid = candidate.uid
    WHERE target.id = NEW.id
  ) THEN RAISE(ABORT, 'failed to persist storyboards uid') END;
  DELETE FROM _v2_uid_generation_candidates WHERE table_name = 'storyboards' AND row_id = NEW.id;
END;
