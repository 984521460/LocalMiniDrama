-- Immutable human audiovisual acceptance for one verified benchmark export.
-- This is local evidence only; it is not billing, release, Windows or MVP-completion evidence.

CREATE TABLE mvp_benchmark_human_av_reviews (
  uid TEXT PRIMARY KEY,
  session_uid TEXT NOT NULL REFERENCES mvp_benchmark_sessions(uid) ON DELETE RESTRICT,
  authorization_uid TEXT NOT NULL UNIQUE
    REFERENCES mvp_benchmark_external_authorizations(uid) ON DELETE RESTRICT,
  batch_sha256 TEXT NOT NULL,
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  workflow_run_uid TEXT NOT NULL UNIQUE REFERENCES workflow_runs(uid) ON DELETE RESTRICT,
  export_run_uid TEXT NOT NULL UNIQUE REFERENCES export_runs(uid) ON DELETE RESTRICT,
  export_execution_plan_sha256 TEXT NOT NULL,
  output_asset_uid TEXT NOT NULL UNIQUE REFERENCES assets(uid) ON DELETE RESTRICT,
  output_asset_version_uid TEXT NOT NULL UNIQUE REFERENCES asset_versions(uid) ON DELETE RESTRICT,
  output_sha256 TEXT NOT NULL,
  output_bytes INTEGER NOT NULL,
  output_duration_ms INTEGER NOT NULL,
  output_width INTEGER NOT NULL,
  output_height INTEGER NOT NULL,
  export_completed_at_epoch_ms INTEGER NOT NULL,
  video_playback_accepted INTEGER NOT NULL CHECK (video_playback_accepted=1),
  subtitle_sync_accepted INTEGER NOT NULL CHECK (subtitle_sync_accepted=1),
  bgm_balance_accepted INTEGER NOT NULL CHECK (bgm_balance_accepted=1),
  review_note TEXT NOT NULL,
  reviewed_at_epoch_ms INTEGER NOT NULL,
  review_json TEXT NOT NULL,
  review_sha256 TEXT NOT NULL,
  CHECK (
    typeof(uid)='text' AND length(CAST(uid AS BLOB))=36
    AND uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  CHECK (
    typeof(batch_sha256)='text' AND length(CAST(batch_sha256 AS BLOB))=64
    AND batch_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(export_execution_plan_sha256)='text'
    AND length(CAST(export_execution_plan_sha256 AS BLOB))=64
    AND export_execution_plan_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(output_sha256)='text' AND length(CAST(output_sha256 AS BLOB))=64
    AND output_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(review_sha256)='text' AND length(CAST(review_sha256 AS BLOB))=64
    AND review_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (typeof(output_bytes)='integer' AND output_bytes BETWEEN 1 AND 68719476736),
  CHECK (typeof(output_duration_ms)='integer' AND output_duration_ms BETWEEN 1 AND 3600100),
  CHECK (output_width=1920 AND output_height=1080),
  CHECK (
    typeof(export_completed_at_epoch_ms)='integer'
    AND export_completed_at_epoch_ms BETWEEN 0 AND 253402300799999
    AND typeof(reviewed_at_epoch_ms)='integer'
    AND reviewed_at_epoch_ms BETWEEN export_completed_at_epoch_ms AND 253402300799999
  ),
  CHECK (
    typeof(review_note)='text' AND length(CAST(review_note AS BLOB)) BETWEEN 1 AND 2048
    AND typeof(review_json)='text' AND length(CAST(review_json AS BLOB)) BETWEEN 2 AND 16384
  )
) WITHOUT ROWID;

CREATE TABLE mvp_benchmark_human_av_review_seals (
  review_uid TEXT PRIMARY KEY
    REFERENCES mvp_benchmark_human_av_reviews(uid) ON DELETE RESTRICT,
  review_sha256 TEXT NOT NULL CHECK (
    typeof(review_sha256)='text' AND length(CAST(review_sha256 AS BLOB))=64
    AND review_sha256 NOT GLOB '*[^0-9a-f]*'
  )
) WITHOUT ROWID;

CREATE TRIGGER v2_mvp_benchmark_human_av_reviews_validate_insert
BEFORE INSERT ON mvp_benchmark_human_av_reviews
BEGIN
  SELECT CASE WHEN
    mvp_benchmark_human_av_review_record_valid(
      NEW.uid,NEW.session_uid,NEW.authorization_uid,NEW.batch_sha256,
      NEW.drama_uid,NEW.workflow_run_uid,NEW.export_run_uid,
      NEW.export_execution_plan_sha256,NEW.output_asset_uid,
      NEW.output_asset_version_uid,NEW.output_sha256,NEW.output_bytes,
      NEW.output_duration_ms,NEW.output_width,NEW.output_height,
      NEW.export_completed_at_epoch_ms,NEW.video_playback_accepted,
      NEW.subtitle_sync_accepted,NEW.bgm_balance_accepted,NEW.review_note,
      NEW.reviewed_at_epoch_ms,NEW.review_json,NEW.review_sha256
    ) IS NOT 1
    OR NOT EXISTS (
      SELECT 1
      FROM mvp_benchmark_sessions AS session
      JOIN mvp_benchmark_external_authorizations AS authorization
        ON authorization.uid=NEW.authorization_uid
       AND authorization.session_uid=session.uid
      JOIN mvp_benchmark_execution_reservations AS first_reservation
        ON first_reservation.authorization_uid=authorization.uid
      JOIN mvp_benchmark_live_environment_attestations AS attestation
        ON attestation.uid=first_reservation.attestation_uid
      JOIN export_runs AS export_run ON export_run.uid=NEW.export_run_uid
      JOIN media_export_run_seals AS export_seal ON export_seal.uid=export_run.uid
      JOIN node_runs AS export_node ON export_node.uid=export_seal.source_node_run_uid
      JOIN workflow_runs AS workflow_run ON workflow_run.uid=export_run.workflow_run_uid
      JOIN assets AS asset ON asset.uid=export_seal.output_asset_uid
      JOIN asset_versions AS version ON version.uid=export_seal.output_asset_version_uid
      WHERE session.uid=NEW.session_uid
        AND session.drama_uid=NEW.drama_uid
        AND session.workflow_run_uid=NEW.workflow_run_uid
        AND authorization.drama_uid=NEW.drama_uid
        AND export_run.drama_uid=NEW.drama_uid
        AND export_run.workflow_run_uid=NEW.workflow_run_uid
        AND export_run.status='succeeded'
        AND workflow_run.uid=NEW.workflow_run_uid
        AND workflow_run.status='succeeded'
        AND export_node.workflow_run_uid=workflow_run.uid
        AND export_node.status='succeeded'
        AND export_seal.execution_plan_sha256=NEW.export_execution_plan_sha256
        AND export_seal.output_asset_uid=NEW.output_asset_uid
        AND export_seal.output_asset_version_uid=NEW.output_asset_version_uid
        AND export_seal.completed_at_epoch_ms=NEW.export_completed_at_epoch_ms
        AND export_seal.receipt_json IS NOT NULL
        AND media_export_receipt_matches_plan(
          export_seal.execution_plan_json,export_seal.receipt_json
        )=1
        AND json_extract(export_seal.receipt_json,'$.output.sha256')=NEW.output_sha256
        AND json_extract(export_seal.receipt_json,'$.output.bytes')=NEW.output_bytes
        AND json_extract(export_seal.receipt_json,'$.output.durationMs')=NEW.output_duration_ms
        AND json_extract(export_seal.receipt_json,'$.output.video.width')=NEW.output_width
        AND json_extract(export_seal.receipt_json,'$.output.video.height')=NEW.output_height
        AND asset.owner_type='drama' AND asset.owner_uid=NEW.drama_uid
        AND asset.asset_type='final_video' AND asset.status='ready'
        AND asset.current_version_uid=version.uid
        AND version.uid=NEW.output_asset_version_uid
        AND version.asset_uid=NEW.output_asset_uid
        AND version.sha256=NEW.output_sha256
        AND version.mime_type='video/mp4'
        AND version.width=NEW.output_width AND version.height=NEW.output_height
        AND version.duration_ms=NEW.output_duration_ms
        AND version.status='ready'
        AND (
          SELECT count(DISTINCT reservation.attestation_uid)
          FROM mvp_benchmark_execution_reservations AS reservation
          WHERE reservation.authorization_uid=authorization.uid
        )=1
        AND NEW.batch_sha256=mvp_benchmark_preflight_batch_sha256(
          authorization.authorization_json,
          session.plan_json,
          attestation.attestation_json,
          (
            SELECT json_group_array(json(reservation.reservation_json))
            FROM mvp_benchmark_execution_reservations AS reservation
            WHERE reservation.authorization_uid=authorization.uid
          )
        )
      LIMIT 1
    )
  THEN RAISE(ABORT,'MVP benchmark human audiovisual review invalid') END;
END;

CREATE TRIGGER v2_mvp_benchmark_human_av_reviews_create_seal
AFTER INSERT ON mvp_benchmark_human_av_reviews
BEGIN
  INSERT INTO mvp_benchmark_human_av_review_seals(review_uid,review_sha256)
  VALUES(NEW.uid,NEW.review_sha256);
END;

CREATE TRIGGER v2_mvp_benchmark_human_av_reviews_reject_replacement
BEFORE INSERT ON mvp_benchmark_human_av_reviews
WHEN EXISTS (
  SELECT 1 FROM mvp_benchmark_human_av_reviews AS existing
  WHERE existing.uid=NEW.uid OR existing.authorization_uid=NEW.authorization_uid
    OR existing.workflow_run_uid=NEW.workflow_run_uid
    OR existing.export_run_uid=NEW.export_run_uid
    OR existing.output_asset_uid=NEW.output_asset_uid
    OR existing.output_asset_version_uid=NEW.output_asset_version_uid
)
BEGIN
  SELECT RAISE(ABORT,'MVP benchmark human audiovisual reviews are immutable');
END;

CREATE TRIGGER v2_mvp_benchmark_human_av_reviews_immutable_update
BEFORE UPDATE ON mvp_benchmark_human_av_reviews
BEGIN
  SELECT RAISE(ABORT,'MVP benchmark human audiovisual reviews are immutable');
END;

CREATE TRIGGER v2_mvp_benchmark_human_av_reviews_append_only
BEFORE DELETE ON mvp_benchmark_human_av_reviews
BEGIN
  SELECT RAISE(ABORT,'MVP benchmark human audiovisual reviews are append-only');
END;

CREATE TRIGGER v2_mvp_benchmark_human_av_review_seals_reject_replacement
BEFORE INSERT ON mvp_benchmark_human_av_review_seals
WHEN EXISTS (
  SELECT 1 FROM mvp_benchmark_human_av_review_seals WHERE review_uid=NEW.review_uid
)
BEGIN
  SELECT RAISE(ABORT,'MVP benchmark human audiovisual review seals are immutable');
END;

CREATE TRIGGER v2_mvp_benchmark_human_av_review_seals_immutable_update
BEFORE UPDATE ON mvp_benchmark_human_av_review_seals
BEGIN
  SELECT RAISE(ABORT,'MVP benchmark human audiovisual review seals are immutable');
END;

CREATE TRIGGER v2_mvp_benchmark_human_av_review_seals_append_only
BEFORE DELETE ON mvp_benchmark_human_av_review_seals
BEGIN
  SELECT RAISE(ABORT,'MVP benchmark human audiovisual review seals are append-only');
END;
