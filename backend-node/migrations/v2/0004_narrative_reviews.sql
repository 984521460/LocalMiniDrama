-- Narrative task results and human review decisions are append-only evidence.
-- Only review state may change; result payloads, hashes and review events are immutable.

CREATE TABLE narrative_results (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  source_selection_uid TEXT NOT NULL REFERENCES source_selections(uid) ON DELETE RESTRICT,
  result_type TEXT NOT NULL CHECK (result_type IN ('extraction', 'adaptation', 'script', 'shot')),
  task_type TEXT NOT NULL CHECK (task_type IN ('NovelExtractionTask', 'EpisodeAdaptationTask', 'ScriptFormattingTask', 'ShotPlanningTask')),
  schema_version TEXT NOT NULL CHECK (typeof(schema_version) = 'text' AND length(schema_version) BETWEEN 1 AND 128),
  input_hash TEXT NOT NULL
    CHECK (typeof(input_hash) = 'text' AND length(CAST(input_hash AS BLOB)) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  result_hash TEXT NOT NULL
    CHECK (typeof(result_hash) = 'text' AND length(CAST(result_hash AS BLOB)) = 64 AND result_hash NOT GLOB '*[^0-9a-f]*'),
  envelope_hash TEXT NOT NULL
    CHECK (typeof(envelope_hash) = 'text' AND length(CAST(envelope_hash AS BLOB)) = 64 AND envelope_hash NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL
    CHECK (
      typeof(result_json) = 'text' AND length(CAST(result_json AS BLOB)) BETWEEN 2 AND 16777216 AND
      instr(result_json, char(0)) = 0 AND
      CASE WHEN json_valid(result_json) THEN json_type(result_json) = 'object' ELSE 0 END
    ),
  upstream_result_uid TEXT REFERENCES narrative_results(uid) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'rejected', 'stale')),
  current_review_uid TEXT
    CHECK (current_review_uid IS NULL OR (
      typeof(current_review_uid) = 'text' AND length(CAST(current_review_uid AS BLOB)) = 36 AND
      current_review_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    )),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (task_type = CASE result_type
    WHEN 'extraction' THEN 'NovelExtractionTask'
    WHEN 'adaptation' THEN 'EpisodeAdaptationTask'
    WHEN 'script' THEN 'ScriptFormattingTask'
    WHEN 'shot' THEN 'ShotPlanningTask'
  END),
  CHECK ((result_type = 'extraction' AND upstream_result_uid IS NULL) OR (result_type <> 'extraction' AND upstream_result_uid IS NOT NULL)),
  CHECK (
    (status IN ('pending_review', 'stale') AND current_review_uid IS NULL)
    OR (status IN ('approved', 'rejected') AND current_review_uid IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE INDEX idx_v2_narrative_results_drama
  ON narrative_results(drama_uid, result_type, created_at, uid);
CREATE INDEX idx_v2_narrative_results_selection
  ON narrative_results(source_selection_uid, result_type, created_at, uid);
CREATE INDEX idx_v2_narrative_results_upstream
  ON narrative_results(upstream_result_uid);

CREATE TRIGGER v2_narrative_results_validate_selection
BEFORE INSERT ON narrative_results
WHEN NOT EXISTS (
  SELECT 1
  FROM source_selections AS selection
  JOIN source_documents AS document ON document.uid = selection.document_uid
  WHERE selection.uid = NEW.source_selection_uid AND document.drama_uid = NEW.drama_uid
)
BEGIN
  SELECT RAISE(ABORT, 'narrative result selection must belong to the drama');
END;

CREATE TRIGGER v2_narrative_results_require_initial_pending_state
BEFORE INSERT ON narrative_results
WHEN NEW.status <> 'pending_review' OR NEW.current_review_uid IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'narrative results must begin in pending review state');
END;

CREATE TRIGGER v2_narrative_results_validate_upstream
BEFORE INSERT ON narrative_results
WHEN NEW.result_type <> 'extraction' AND NOT EXISTS (
  SELECT 1
  FROM narrative_results AS upstream
  WHERE upstream.uid = NEW.upstream_result_uid
    AND upstream.drama_uid = NEW.drama_uid
    AND upstream.source_selection_uid = NEW.source_selection_uid
    AND upstream.status = 'approved'
    AND upstream.result_type = CASE NEW.result_type
      WHEN 'adaptation' THEN 'extraction'
      WHEN 'script' THEN 'adaptation'
      WHEN 'shot' THEN 'script'
    END
)
BEGIN
  SELECT RAISE(ABORT, 'narrative result requires the approved direct upstream result');
END;

CREATE TRIGGER v2_narrative_results_reject_replacement
BEFORE INSERT ON narrative_results
WHEN EXISTS (SELECT 1 FROM narrative_results WHERE uid = NEW.uid)
BEGIN
  SELECT RAISE(ABORT, 'narrative result identity cannot be replaced');
END;

CREATE TRIGGER v2_narrative_results_immutable_payload
BEFORE UPDATE OF uid, drama_uid, source_selection_uid, result_type, task_type, schema_version,
  input_hash, result_hash, envelope_hash, result_json, upstream_result_uid, created_at
ON narrative_results
WHEN NEW.uid IS NOT OLD.uid
  OR NEW.drama_uid IS NOT OLD.drama_uid
  OR NEW.source_selection_uid IS NOT OLD.source_selection_uid
  OR NEW.result_type IS NOT OLD.result_type
  OR NEW.task_type IS NOT OLD.task_type
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.input_hash IS NOT OLD.input_hash
  OR NEW.result_hash IS NOT OLD.result_hash
  OR NEW.envelope_hash IS NOT OLD.envelope_hash
  OR NEW.result_json IS NOT OLD.result_json
  OR NEW.upstream_result_uid IS NOT OLD.upstream_result_uid
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'narrative result payload is immutable');
END;

CREATE TRIGGER v2_narrative_results_append_only
BEFORE DELETE ON narrative_results
BEGIN
  SELECT RAISE(ABORT, 'narrative results are append-only');
END;

CREATE TABLE narrative_review_events (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  result_uid TEXT NOT NULL REFERENCES narrative_results(uid) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  result_hash TEXT NOT NULL
    CHECK (typeof(result_hash) = 'text' AND length(CAST(result_hash AS BLOB)) = 64 AND result_hash NOT GLOB '*[^0-9a-f]*'),
  envelope_hash TEXT NOT NULL
    CHECK (typeof(envelope_hash) = 'text' AND length(CAST(envelope_hash AS BLOB)) = 64 AND envelope_hash NOT GLOB '*[^0-9a-f]*'),
  comment TEXT CHECK (
    comment IS NULL OR (
      typeof(comment) = 'text' AND length(CAST(comment AS BLOB)) <= 4000 AND instr(comment, char(0)) = 0
    )
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE INDEX idx_v2_narrative_review_events_result
  ON narrative_review_events(result_uid, created_at, uid);

CREATE TRIGGER v2_narrative_review_events_validate_insert
BEFORE INSERT ON narrative_review_events
WHEN NOT EXISTS (
  SELECT 1 FROM narrative_results AS result
  WHERE result.uid = NEW.result_uid
    AND result.status <> 'stale'
    AND result.result_hash = NEW.result_hash
    AND result.envelope_hash = NEW.envelope_hash
)
BEGIN
  SELECT RAISE(ABORT, 'narrative review must bind the current non-stale result hashes');
END;

CREATE TRIGGER v2_narrative_review_events_reject_replacement
BEFORE INSERT ON narrative_review_events
WHEN EXISTS (SELECT 1 FROM narrative_review_events WHERE uid = NEW.uid)
BEGIN
  SELECT RAISE(ABORT, 'narrative review identity cannot be replaced');
END;

CREATE TRIGGER v2_narrative_review_events_immutable
BEFORE UPDATE ON narrative_review_events
BEGIN
  SELECT RAISE(ABORT, 'narrative review events are immutable');
END;

CREATE TRIGGER v2_narrative_review_events_append_only
BEFORE DELETE ON narrative_review_events
BEGIN
  SELECT RAISE(ABORT, 'narrative review events are append-only');
END;

CREATE TRIGGER v2_narrative_results_validate_review_state
BEFORE UPDATE OF status, current_review_uid ON narrative_results
WHEN (OLD.status = 'stale' AND (NEW.status <> 'stale' OR NEW.current_review_uid IS NOT OLD.current_review_uid))
  OR (NEW.status = 'pending_review' AND OLD.status <> 'pending_review')
  OR (NEW.status IN ('approved', 'rejected') AND NOT EXISTS (
    SELECT 1 FROM narrative_review_events AS review
    WHERE review.uid = NEW.current_review_uid
      AND review.result_uid = OLD.uid
      AND review.result_hash = OLD.result_hash
      AND review.envelope_hash = OLD.envelope_hash
      AND review.decision = CASE NEW.status WHEN 'approved' THEN 'approve' ELSE 'reject' END
  ))
BEGIN
  SELECT RAISE(ABORT, 'narrative result review state is invalid');
END;

CREATE TRIGGER v2_narrative_results_stale_descendants
AFTER UPDATE OF status, current_review_uid ON narrative_results
WHEN NEW.status IS NOT OLD.status OR NEW.current_review_uid IS NOT OLD.current_review_uid
BEGIN
  UPDATE narrative_results
  SET status = 'stale',
      current_review_uid = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE uid IN (
    WITH RECURSIVE descendants(uid) AS (
      SELECT uid FROM narrative_results WHERE upstream_result_uid = NEW.uid
      UNION
      SELECT child.uid
      FROM narrative_results AS child
      JOIN descendants AS parent ON child.upstream_result_uid = parent.uid
    )
    SELECT uid FROM descendants
  )
    AND status <> 'stale';
END;
