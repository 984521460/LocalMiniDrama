CREATE TABLE voice_profiles (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid)='text' AND length(CAST(uid AS BLOB))=36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  character_voice_version_uid TEXT NOT NULL REFERENCES character_voice_versions(uid) ON DELETE RESTRICT,
  voice_identity_version_uid TEXT NOT NULL REFERENCES character_identity_versions(uid) ON DELETE RESTRICT,
  voice_parent_uid TEXT REFERENCES character_voice_versions(uid) ON DELETE RESTRICT,
  parent_uid TEXT REFERENCES voice_profiles(uid) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (
    typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991
  ),
  provider TEXT NOT NULL CHECK (provider IN ('openai-compatible','minimax')),
  model TEXT NOT NULL CHECK (
    typeof(model)='text' AND length(CAST(model AS BLOB)) BETWEEN 1 AND 128 AND
    model=lower(model) AND substr(model,1,1) GLOB '[a-z0-9]' AND
    model NOT GLOB '*[^a-z0-9._/-]*' AND instr(model,char(0))=0
  ),
  voice_key TEXT NOT NULL CHECK (
    typeof(voice_key)='text' AND length(CAST(voice_key AS BLOB)) BETWEEN 1 AND 128 AND
    substr(voice_key,1,1) GLOB '[A-Za-z0-9]' AND
    voice_key NOT GLOB '*[^A-Za-z0-9._:-]*' AND instr(voice_key,char(0))=0
  ),
  credential_ref TEXT NOT NULL CHECK (
    typeof(credential_ref)='text' AND length(CAST(credential_ref AS BLOB))=50 AND
    credential_ref GLOB 'credential:v1:[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  source_kind TEXT NOT NULL CHECK (source_kind='provider-preset'),
  status TEXT NOT NULL CHECK (status='ready'),
  default_emotion TEXT NOT NULL CHECK (
    default_emotion IN ('neutral','happy','sad','angry','fearful','surprised')
  ),
  emotion_map_json TEXT NOT NULL CHECK (
    typeof(emotion_map_json)='text' AND
    length(CAST(emotion_map_json AS BLOB)) BETWEEN 2 AND 2048 AND
    CASE WHEN json_valid(emotion_map_json) THEN json_type(emotion_map_json)='object' ELSE 0 END
  ),
  minimum_speed_permille INTEGER NOT NULL CHECK (
    typeof(minimum_speed_permille)='integer' AND minimum_speed_permille BETWEEN 500 AND 2000
  ),
  default_speed_permille INTEGER NOT NULL CHECK (
    typeof(default_speed_permille)='integer' AND default_speed_permille BETWEEN 500 AND 2000
  ),
  maximum_speed_permille INTEGER NOT NULL CHECK (
    typeof(maximum_speed_permille)='integer' AND maximum_speed_permille BETWEEN 500 AND 2000
  ),
  voice_name TEXT NOT NULL CHECK (
    typeof(voice_name)='text' AND length(CAST(voice_name AS BLOB)) BETWEEN 1 AND 480 AND
    instr(voice_name,char(0))=0
  ),
  voice_language TEXT NOT NULL CHECK (
    typeof(voice_language)='text' AND length(CAST(voice_language AS BLOB)) BETWEEN 2 AND 16 AND
    instr(voice_language,char(0))=0
  ),
  voice_style TEXT NOT NULL CHECK (
    typeof(voice_style)='text' AND length(CAST(voice_style AS BLOB)) BETWEEN 1 AND 4000 AND
    instr(voice_style,char(0))=0
  ),
  voice_version_created_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(voice_version_created_at_epoch_ms)='integer' AND
    voice_version_created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  created_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(created_at_epoch_ms)='integer' AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  UNIQUE(character_uid,revision),
  CHECK (parent_uid IS NULL OR parent_uid<>uid),
  CHECK (minimum_speed_permille<=default_speed_permille),
  CHECK (default_speed_permille<=maximum_speed_permille),
  CHECK (
    lower(voice_key) NOT GLOB 'bearer *' AND
    lower(voice_key) NOT GLOB 'sk-????????*' AND
    lower(voice_key) NOT GLOB 'akia????????????*' AND
    lower(model) NOT GLOB 'bearer *' AND
    lower(model) NOT GLOB 'sk-????????*' AND
    lower(model) NOT GLOB 'akia????????????*'
  )
) WITHOUT ROWID;

CREATE INDEX idx_v2_voice_profiles_character
  ON voice_profiles(character_uid,revision,uid);

CREATE TRIGGER v2_voice_profiles_validate_insert
BEFORE INSERT ON voice_profiles
WHEN NOT (
  EXISTS (
    SELECT 1 FROM characters AS character
    JOIN dramas AS drama ON drama.id=character.drama_id
    WHERE character.uid=NEW.character_uid AND drama.uid=NEW.drama_uid
  )
  AND EXISTS (
    SELECT 1 FROM character_voice_versions AS voice
    WHERE voice.uid=NEW.character_voice_version_uid
      AND voice.character_uid=NEW.character_uid
      AND voice.identity_version_uid=NEW.voice_identity_version_uid
      AND voice.parent_uid IS NEW.voice_parent_uid
      AND NEW.voice_name=json_extract(voice.metadata_json,'$.name')
      AND NEW.voice_language=json_extract(voice.metadata_json,'$.language')
      AND NEW.voice_style=json_extract(voice.metadata_json,'$.style')
      AND NEW.voice_version_created_at_epoch_ms=voice.created_at_epoch_ms
  )
  AND NEW.emotion_map_json=json_object(
    'neutral',json_extract(NEW.emotion_map_json,'$.neutral'),
    'happy',json_extract(NEW.emotion_map_json,'$.happy'),
    'sad',json_extract(NEW.emotion_map_json,'$.sad'),
    'angry',json_extract(NEW.emotion_map_json,'$.angry'),
    'fearful',json_extract(NEW.emotion_map_json,'$.fearful'),
    'surprised',json_extract(NEW.emotion_map_json,'$.surprised')
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.emotion_map_json) AS emotion
    WHERE emotion.type<>'text'
      OR length(CAST(emotion.value AS BLOB)) NOT BETWEEN 1 AND 64
      OR substr(CAST(emotion.value AS TEXT),1,1) NOT GLOB '[A-Za-z0-9]'
      OR CAST(emotion.value AS TEXT) GLOB '*[^A-Za-z0-9._:-]*'
      OR lower(CAST(emotion.value AS TEXT)) GLOB 'bearer *'
      OR lower(CAST(emotion.value AS TEXT)) GLOB 'sk-????????*'
      OR lower(CAST(emotion.value AS TEXT)) GLOB 'akia????????????*'
  )
  AND (
    (
      NOT EXISTS (SELECT 1 FROM voice_profiles WHERE character_uid=NEW.character_uid)
      AND NEW.revision=1 AND NEW.parent_uid IS NULL
    )
    OR
    (
      EXISTS (SELECT 1 FROM voice_profiles WHERE character_uid=NEW.character_uid)
      AND NEW.revision=(
        SELECT max(revision)+1 FROM voice_profiles WHERE character_uid=NEW.character_uid
      )
      AND NEW.parent_uid=(
        SELECT uid FROM voice_profiles
        WHERE character_uid=NEW.character_uid ORDER BY revision DESC LIMIT 1
      )
    )
  )
  AND NEW.created_at_epoch_ms>=NEW.voice_version_created_at_epoch_ms
  AND (
    NEW.parent_uid IS NULL OR NEW.created_at_epoch_ms>=(
      SELECT created_at_epoch_ms FROM voice_profiles WHERE uid=NEW.parent_uid
    )
  )
)
BEGIN SELECT RAISE(ABORT,'voice profile evidence is invalid'); END;

CREATE TRIGGER v2_voice_profiles_reject_replacement
BEFORE INSERT ON voice_profiles
WHEN EXISTS (
  SELECT 1 FROM voice_profiles
  WHERE uid=NEW.uid OR (character_uid=NEW.character_uid AND revision=NEW.revision)
)
BEGIN SELECT RAISE(ABORT,'voice profile replacement is forbidden'); END;

CREATE TRIGGER v2_voice_profiles_immutable_update
BEFORE UPDATE ON voice_profiles
BEGIN SELECT RAISE(ABORT,'voice profiles are immutable'); END;

CREATE TRIGGER v2_voice_profiles_immutable_delete
BEFORE DELETE ON voice_profiles
BEGIN SELECT RAISE(ABORT,'voice profiles are append-only'); END;

CREATE TABLE voice_profile_selection_events (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid)='text' AND length(CAST(uid AS BLOB))=36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  character_uid TEXT NOT NULL REFERENCES characters(uid) ON DELETE RESTRICT,
  voice_profile_uid TEXT NOT NULL REFERENCES voice_profiles(uid) ON DELETE RESTRICT,
  previous_voice_profile_uid TEXT REFERENCES voice_profiles(uid) ON DELETE RESTRICT,
  state_version INTEGER NOT NULL CHECK (
    typeof(state_version)='integer' AND state_version BETWEEN 1 AND 9007199254740991
  ),
  changed_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(changed_at_epoch_ms)='integer' AND changed_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  UNIQUE(character_uid,state_version),
  CHECK (previous_voice_profile_uid IS NULL OR previous_voice_profile_uid<>voice_profile_uid)
) WITHOUT ROWID;

CREATE INDEX idx_v2_voice_profile_selection_character
  ON voice_profile_selection_events(character_uid,state_version,uid);

CREATE TRIGGER v2_voice_profile_selection_validate_insert
BEFORE INSERT ON voice_profile_selection_events
WHEN NOT (
  EXISTS (
    SELECT 1 FROM voice_profiles AS profile
    WHERE profile.uid=NEW.voice_profile_uid
      AND profile.drama_uid=NEW.drama_uid
      AND profile.character_uid=NEW.character_uid
      AND profile.created_at_epoch_ms<=NEW.changed_at_epoch_ms
  )
  AND (
    (
      NOT EXISTS (
        SELECT 1 FROM voice_profile_selection_events WHERE character_uid=NEW.character_uid
      )
      AND NEW.state_version=1 AND NEW.previous_voice_profile_uid IS NULL
    )
    OR
    (
      EXISTS (
        SELECT 1 FROM voice_profile_selection_events WHERE character_uid=NEW.character_uid
      )
      AND NEW.state_version=(
        SELECT max(state_version)+1 FROM voice_profile_selection_events
        WHERE character_uid=NEW.character_uid
      )
      AND NEW.previous_voice_profile_uid=(
        SELECT voice_profile_uid FROM voice_profile_selection_events
        WHERE character_uid=NEW.character_uid ORDER BY state_version DESC LIMIT 1
      )
      AND NEW.changed_at_epoch_ms>=(
        SELECT changed_at_epoch_ms FROM voice_profile_selection_events
        WHERE character_uid=NEW.character_uid ORDER BY state_version DESC LIMIT 1
      )
    )
  )
)
BEGIN SELECT RAISE(ABORT,'voice profile selection evidence is invalid'); END;

CREATE TRIGGER v2_voice_profile_selection_reject_replacement
BEFORE INSERT ON voice_profile_selection_events
WHEN EXISTS (
  SELECT 1 FROM voice_profile_selection_events
  WHERE uid=NEW.uid OR (character_uid=NEW.character_uid AND state_version=NEW.state_version)
)
BEGIN SELECT RAISE(ABORT,'voice profile selection replacement is forbidden'); END;

CREATE TRIGGER v2_voice_profile_selection_immutable_update
BEFORE UPDATE ON voice_profile_selection_events
BEGIN SELECT RAISE(ABORT,'voice profile selections are immutable'); END;

CREATE TRIGGER v2_voice_profile_selection_immutable_delete
BEFORE DELETE ON voice_profile_selection_events
BEGIN SELECT RAISE(ABORT,'voice profile selections are append-only'); END;
