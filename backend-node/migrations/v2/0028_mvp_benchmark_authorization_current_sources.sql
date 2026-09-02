-- An authorization is immutable approval evidence for one frozen session.  The approval must
-- not be admitted after any current H3/audio source has drifted, even through direct SQL or a
-- conflict algorithm with recursive triggers disabled.

CREATE TRIGGER v2_mvp_benchmark_external_authorizations_current_sources_insert
AFTER INSERT ON mvp_benchmark_external_authorizations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM mvp_benchmark_execution_ready_sessions AS ready
    WHERE ready.uid=NEW.session_uid
  ) THEN RAISE(ABORT, 'MVP benchmark external authorization current sources invalid') END;
END;
