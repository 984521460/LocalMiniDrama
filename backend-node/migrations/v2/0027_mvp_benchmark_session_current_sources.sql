-- Seal a benchmark session only while every execution source still matches the
-- current-source closure introduced by migration 0022.  The AFTER trigger sees
-- NEW through the view, while RAISE(ABORT) rolls the whole INSERT statement back.

CREATE TRIGGER v2_mvp_benchmark_sessions_current_sources_insert
AFTER INSERT ON mvp_benchmark_sessions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM mvp_benchmark_execution_ready_sessions AS ready
    WHERE ready.uid=NEW.uid
  ) THEN RAISE(ABORT, 'MVP benchmark session current sources invalid') END;
END;
