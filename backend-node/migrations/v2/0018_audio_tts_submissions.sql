-- Phase 9: reserve synchronous TTS provider submissions before any chargeable call.
-- Rows contain request identities and bounded response summaries only; never credentials
-- or audio bytes. A received transition is reserved for the later durable media sink.

CREATE TABLE audio_tts_submissions (
  dialogue_delivery_uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(dialogue_delivery_uid)='text'
    AND length(CAST(dialogue_delivery_uid AS BLOB))=36
    AND dialogue_delivery_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  intent_uid TEXT NOT NULL REFERENCES audio_mode_intents(uid),
  request_ordinal INTEGER NOT NULL CHECK (
    typeof(request_ordinal)='integer' AND request_ordinal BETWEEN 0 AND 999
  ),
  request_sha256 TEXT NOT NULL CHECK (
    typeof(request_sha256)='text'
    AND length(CAST(request_sha256 AS BLOB))=64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  voice_profile_uid TEXT NOT NULL REFERENCES voice_profiles(uid),
  provider TEXT NOT NULL CHECK (provider IN ('openai-compatible', 'minimax')),
  state TEXT NOT NULL CHECK (state IN ('submitting', 'received', 'submission_unknown')),
  response_sha256 TEXT CHECK (
    response_sha256 IS NULL OR (
      typeof(response_sha256)='text'
      AND length(CAST(response_sha256 AS BLOB))=64
      AND response_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  response_bytes INTEGER CHECK (
    response_bytes IS NULL OR (
      typeof(response_bytes)='integer' AND response_bytes BETWEEN 1 AND 33554432
    )
  ),
  mime_type TEXT CHECK (
    mime_type IS NULL OR mime_type IN (
      'audio/aac', 'audio/flac', 'audio/mpeg', 'audio/wav', 'audio/x-wav'
    )
  ),
  created_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000) CHECK (
    typeof(created_at_epoch_ms)='integer'
    AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  updated_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000) CHECK (
    typeof(updated_at_epoch_ms)='integer'
    AND updated_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  UNIQUE (intent_uid, request_ordinal),
  CHECK (updated_at_epoch_ms >= created_at_epoch_ms),
  CHECK (
    (state='received' AND response_sha256 IS NOT NULL
      AND response_bytes IS NOT NULL AND mime_type IS NOT NULL)
    OR
    (state IN ('submitting', 'submission_unknown') AND response_sha256 IS NULL
      AND response_bytes IS NULL AND mime_type IS NULL)
  )
) WITHOUT ROWID;

CREATE INDEX idx_audio_tts_submissions_intent
ON audio_tts_submissions(intent_uid, request_ordinal);

CREATE TRIGGER v2_audio_tts_submissions_validate_insert
BEFORE INSERT ON audio_tts_submissions
BEGIN
  SELECT CASE WHEN
    NEW.state<>'submitting'
    OR NEW.response_sha256 IS NOT NULL
    OR NEW.response_bytes IS NOT NULL
    OR NEW.mime_type IS NOT NULL
    OR NEW.created_at_epoch_ms<>NEW.updated_at_epoch_ms
    OR NEW.created_at_epoch_ms<>unixepoch('now') * 1000
    OR NOT EXISTS (
      SELECT 1
      FROM audio_mode_intents AS intent
      JOIN json_each(intent.plan_json, '$.ttsRequests') AS request
        ON CAST(request.key AS INTEGER)=NEW.request_ordinal
      WHERE intent.uid=NEW.intent_uid
        AND json_extract(intent.plan_json, '$.mode')='independent_tts'
        AND json_extract(request.value, '$.dialogueDeliveryUid')=NEW.dialogue_delivery_uid
        AND json_extract(request.value, '$.requestSha256')=NEW.request_sha256
        AND json_extract(request.value, '$.voiceProfileUid')=NEW.voice_profile_uid
        AND json_extract(request.value, '$.provider')=NEW.provider
    )
  THEN RAISE(ABORT, 'audio TTS submission invalid') END;
END;

CREATE TRIGGER v2_audio_tts_submissions_reject_replacement
BEFORE INSERT ON audio_tts_submissions
WHEN EXISTS (
  SELECT 1 FROM audio_tts_submissions AS existing
  WHERE existing.dialogue_delivery_uid=NEW.dialogue_delivery_uid
    OR (existing.intent_uid=NEW.intent_uid AND existing.request_ordinal=NEW.request_ordinal)
)
BEGIN
  SELECT RAISE(ABORT, 'audio TTS submissions cannot be replaced');
END;

CREATE TRIGGER v2_audio_tts_submissions_validate_update
BEFORE UPDATE ON audio_tts_submissions
WHEN
  NEW.dialogue_delivery_uid IS NOT OLD.dialogue_delivery_uid
  OR NEW.intent_uid IS NOT OLD.intent_uid
  OR NEW.request_ordinal IS NOT OLD.request_ordinal
  OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.voice_profile_uid IS NOT OLD.voice_profile_uid
  OR NEW.provider IS NOT OLD.provider
  OR NEW.created_at_epoch_ms IS NOT OLD.created_at_epoch_ms
  OR OLD.state<>'submitting'
  OR NEW.state NOT IN ('received', 'submission_unknown')
  OR NEW.updated_at_epoch_ms < OLD.updated_at_epoch_ms
  OR NEW.updated_at_epoch_ms<>unixepoch('now') * 1000
BEGIN
  SELECT RAISE(ABORT, 'audio TTS submission transition is invalid');
END;

CREATE TRIGGER v2_audio_tts_submissions_reject_delete
BEFORE DELETE ON audio_tts_submissions
BEGIN
  SELECT RAISE(ABORT, 'audio TTS submissions are append-only');
END;
