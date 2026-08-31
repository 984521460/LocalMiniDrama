-- Prepared independent-TTS intent. This table contains no secret values and
-- represents no provider side effect. Rows are immutable but may be deleted
-- before execution so an invalid direct-write reservation is recoverable.

CREATE TABLE audio_mode_intents (
  uid TEXT PRIMARY KEY,
  drama_uid TEXT NOT NULL REFERENCES dramas(uid),
  workflow_run_uid TEXT NOT NULL REFERENCES workflow_runs(uid),
  node_run_uid TEXT NOT NULL REFERENCES node_runs(uid),
  shot_result_uid TEXT NOT NULL REFERENCES narrative_results(uid),
  script_result_uid TEXT NOT NULL REFERENCES narrative_results(uid),
  request_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  plan_sha256 TEXT NOT NULL,
  created_at_epoch_ms INTEGER NOT NULL,
  UNIQUE (node_run_uid),
  CHECK (
    typeof(uid)='text'
    AND length(CAST(uid AS BLOB))=36
    AND uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  CHECK (typeof(request_json)='text' AND length(CAST(request_json AS BLOB)) BETWEEN 2 AND 4194304),
  CHECK (typeof(plan_json)='text' AND length(CAST(plan_json AS BLOB)) BETWEEN 2 AND 33554432),
  CHECK (
    typeof(plan_sha256)='text'
    AND length(CAST(plan_sha256 AS BLOB))=64
    AND plan_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    typeof(created_at_epoch_ms)='integer'
    AND created_at_epoch_ms BETWEEN 0 AND 253402300799999
  )
);

CREATE INDEX idx_audio_mode_intents_workflow_run
ON audio_mode_intents(workflow_run_uid, node_run_uid);

CREATE INDEX idx_audio_mode_intents_shot
ON audio_mode_intents(shot_result_uid, script_result_uid);

CREATE TRIGGER v2_audio_mode_intents_validate_insert
BEFORE INSERT ON audio_mode_intents
BEGIN
  SELECT CASE WHEN
    audio_mode_intent_record_valid(
      NEW.uid,
      NEW.drama_uid,
      NEW.workflow_run_uid,
      NEW.node_run_uid,
      NEW.shot_result_uid,
      NEW.script_result_uid,
      NEW.request_json,
      NEW.plan_json,
      NEW.plan_sha256,
      NEW.created_at_epoch_ms
    ) IS NOT 1
    OR NOT EXISTS (
      SELECT 1
      FROM workflow_runs AS run
      JOIN node_runs AS node
        ON node.uid=NEW.node_run_uid AND node.workflow_run_uid=run.uid
      JOIN workflow_definitions AS definition ON definition.uid=run.workflow_uid
      WHERE run.uid=NEW.workflow_run_uid
        AND definition.drama_uid=NEW.drama_uid
        AND run.status='queued'
        AND node.status='queued'
        AND EXISTS (
          SELECT 1
          FROM json_each(run.graph_snapshot_json, '$.snapshot.nodes') AS plan_node
          WHERE json_extract(plan_node.value, '$.uid')=node.node_uid
            AND json_extract(plan_node.value, '$.nodeType')='audio.tts'
            AND json_extract(plan_node.value, '$.enabled')=1
            AND json_extract(plan_node.value, '$.domainRef.type')='narrative_result'
            AND json_extract(plan_node.value, '$.domainRef.uid')=NEW.shot_result_uid
        )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM narrative_results AS shot
      JOIN narrative_review_events AS shot_review ON shot_review.uid=shot.current_review_uid
      JOIN narrative_results AS script ON script.uid=NEW.script_result_uid
      JOIN narrative_review_events AS script_review ON script_review.uid=script.current_review_uid
      WHERE shot.uid=NEW.shot_result_uid
        AND shot.drama_uid=NEW.drama_uid
        AND shot.result_type='shot'
        AND shot.status='approved'
        AND shot_review.result_uid=shot.uid
        AND shot_review.decision='approve'
        AND shot_review.result_hash=shot.result_hash
        AND shot_review.envelope_hash=shot.envelope_hash
        AND shot.upstream_result_uid=script.uid
        AND script.drama_uid=NEW.drama_uid
        AND script.result_type='script'
        AND script.status='approved'
        AND script_review.result_uid=script.uid
        AND script_review.decision='approve'
        AND script_review.result_hash=script.result_hash
        AND script_review.envelope_hash=script.envelope_hash
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.request_json, '$.deliveries') AS delivery
      WHERE NOT EXISTS (
        SELECT 1
        FROM shot_continuity_snapshots AS snapshot
        JOIN narrative_results AS shot ON shot.uid=NEW.shot_result_uid
        JOIN narrative_results AS script ON script.uid=NEW.script_result_uid
        JOIN json_each(shot.result_json, '$.output.shots') AS planned_shot
        JOIN json_each(script.result_json, '$.output.scenes') AS script_scene
        JOIN json_each(script_scene.value, '$.entries') AS script_entry
        JOIN shot_continuity_character_refs AS character_ref
          ON character_ref.snapshot_uid=snapshot.uid
         AND character_ref.fact_ref=json_extract(script_entry.value, '$.speakerCharacterFactId')
        JOIN voice_profiles AS profile
          ON profile.uid=json_extract(delivery.value, '$.voiceProfileUid')
         AND profile.character_uid=character_ref.character_uid
         AND profile.drama_uid=NEW.drama_uid
        JOIN node_runs AS node ON node.uid=NEW.node_run_uid
        JOIN workflow_runs AS run ON run.uid=NEW.workflow_run_uid
        JOIN json_each(run.graph_snapshot_json, '$.snapshot.nodes') AS plan_node
          ON json_extract(plan_node.value, '$.uid')=node.node_uid
        WHERE snapshot.uid=json_extract(delivery.value, '$.continuitySnapshotUid')
          AND snapshot.drama_uid=NEW.drama_uid
          AND snapshot.shot_result_uid=shot.uid
          AND snapshot.shot_result_hash=shot.result_hash
          AND snapshot.shot_envelope_hash=shot.envelope_hash
          AND snapshot.shot_review_uid=shot.current_review_uid
          AND snapshot.shot_id=json_extract(delivery.value, '$.shotId')
          AND json_extract(planned_shot.value, '$.shotId')=snapshot.shot_id
          AND EXISTS (
            SELECT 1
            FROM json_each(planned_shot.value, '$.dialogueEntryRefs') AS dialogue_ref
            WHERE dialogue_ref.value=json_extract(delivery.value, '$.dialogueEntryId')
          )
          AND json_extract(script_entry.value, '$.entryId')=json_extract(delivery.value, '$.dialogueEntryId')
          AND json_extract(script_entry.value, '$.type')='dialogue'
          AND json_type(script_entry.value, '$.speakerCharacterFactId')='text'
          AND audio_mode_narrative_emotion(
            json_extract(script_entry.value, '$.emotion')
          )=json_extract(delivery.value, '$.emotion')
          AND json_extract(plan_node.value, '$.nodeType')='audio.tts'
          AND json_extract(plan_node.value, '$.enabled')=1
          AND json_extract(plan_node.value, '$.domainRef.type')='narrative_result'
          AND json_extract(plan_node.value, '$.domainRef.uid')=NEW.shot_result_uid
          AND json_extract(plan_node.value, '$.config.profileUid')=profile.uid
          AND json_extract(plan_node.value, '$.config.credentialRef')=profile.credential_ref
          AND CAST(json_extract(plan_node.value, '$.config.speed') * 1000 AS INTEGER)
            =json_extract(delivery.value, '$.speedPermille')
          AND EXISTS (
            SELECT 1
            FROM voice_profile_selection_events AS selection
            WHERE selection.character_uid=profile.character_uid
              AND selection.voice_profile_uid=profile.uid
              AND selection.state_version=(
                SELECT max(latest.state_version)
                FROM voice_profile_selection_events AS latest
                WHERE latest.character_uid=profile.character_uid
              )
          )
      )
    )
  THEN RAISE(ABORT, 'audio mode intent invalid') END;
END;

CREATE TRIGGER v2_audio_mode_intents_reject_replacement
BEFORE INSERT ON audio_mode_intents
WHEN EXISTS (
  SELECT 1 FROM audio_mode_intents AS intent
  WHERE intent.uid=NEW.uid OR intent.node_run_uid=NEW.node_run_uid
)
BEGIN
  SELECT RAISE(ABORT, 'audio mode intents are immutable');
END;

CREATE TRIGGER v2_audio_mode_intents_immutable_update
BEFORE UPDATE ON audio_mode_intents
BEGIN
  SELECT RAISE(ABORT, 'audio mode intents are immutable');
END;
