-- Bind each immutable execution reservation to the frozen request evidence in its MVP session.
-- Batch atomicity is provided by the repository's BEGIN IMMEDIATE transaction; this trigger
-- keeps direct SQL, conflict algorithms, and recursive_triggers=OFF on the same trust boundary.

CREATE TRIGGER v2_mvp_benchmark_execution_reservations_bind_frozen_request
BEFORE INSERT ON mvp_benchmark_execution_reservations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM mvp_benchmark_sessions AS session
    WHERE session.uid=NEW.session_uid
      AND (
        (
          NEW.item_kind='h3'
          AND 1=(
            SELECT count(*)
            FROM json_each(session.plan_json,'$.h3Tasks') AS planned
            WHERE json_extract(planned.value,'$.taskUid')=NEW.item_uid
              AND json_extract(planned.value,'$.planEvidenceSha256')=NEW.request_sha256
          )
        )
        OR
        (
          NEW.item_kind='tts'
          AND 1=(
            SELECT count(*)
            FROM json_each(session.plan_json,'$.audioIntents') AS planned
            WHERE json_extract(planned.value,'$.intentUid')=NEW.item_uid
              AND json_extract(planned.value,'$.planSha256')=NEW.request_sha256
          )
        )
      )
  )
  THEN RAISE(ABORT,'MVP benchmark execution reservation request is not frozen') END;
END;
