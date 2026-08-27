-- Narrative evidence is immutable; corrections invalidate the old result branch.
-- Every first transition to stale carries one immutable, machine-auditable reason.

ALTER TABLE narrative_results ADD COLUMN stale_operation_uid TEXT;
ALTER TABLE narrative_results ADD COLUMN stale_reason_code TEXT;
ALTER TABLE narrative_results ADD COLUMN stale_root_kind TEXT;
ALTER TABLE narrative_results ADD COLUMN stale_root_uid TEXT;
ALTER TABLE narrative_results ADD COLUMN staled_at_epoch_ms INTEGER;

CREATE TABLE narrative_stale_events (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  operation_uid TEXT NOT NULL
    CHECK (
      typeof(operation_uid) = 'text' AND length(CAST(operation_uid AS BLOB)) = 36 AND
      operation_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  result_uid TEXT NOT NULL UNIQUE REFERENCES narrative_results(uid) ON DELETE RESTRICT,
  root_kind TEXT NOT NULL CHECK (root_kind IN ('source_document', 'source_selection', 'narrative_result')),
  root_uid TEXT NOT NULL
    CHECK (
      typeof(root_uid) = 'text' AND length(CAST(root_uid AS BLOB)) = 36 AND
      root_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'source_document_superseded',
    'source_selection_superseded',
    'narrative_result_superseded',
    'upstream_review_changed',
    'legacy_stale_state'
  )),
  staled_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(staled_at_epoch_ms) = 'integer' AND
    staled_at_epoch_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (
    (root_kind = 'source_document' AND reason_code = 'source_document_superseded') OR
    (root_kind = 'source_selection' AND reason_code = 'source_selection_superseded') OR
    (root_kind = 'narrative_result' AND reason_code IN (
      'narrative_result_superseded', 'upstream_review_changed', 'legacy_stale_state'
    ))
  )
) WITHOUT ROWID;

CREATE INDEX idx_v2_narrative_stale_events_operation
  ON narrative_stale_events(operation_uid, result_uid);
CREATE INDEX idx_v2_narrative_stale_events_root
  ON narrative_stale_events(root_kind, root_uid, result_uid);

-- Databases upgraded from 0004 may already contain terminal stale rows.
UPDATE narrative_results
SET stale_operation_uid = uid,
    stale_reason_code = 'legacy_stale_state',
    stale_root_kind = 'narrative_result',
    stale_root_uid = uid,
    staled_at_epoch_ms = COALESCE(
      CAST(strftime('%s', updated_at) AS INTEGER) * 1000 +
        CAST(substr(strftime('%f', updated_at), 4, 3) AS INTEGER),
      CAST(strftime('%s', created_at) AS INTEGER) * 1000 +
        CAST(substr(strftime('%f', created_at), 4, 3) AS INTEGER),
      CAST(strftime('%s', 'now') AS INTEGER) * 1000 +
        CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
    )
WHERE status = 'stale';

INSERT INTO narrative_stale_events
  (uid, operation_uid, result_uid, root_kind, root_uid, reason_code, staled_at_epoch_ms)
SELECT lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
    substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
    substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
  ),
  stale_operation_uid,
  uid,
  stale_root_kind,
  stale_root_uid,
  stale_reason_code,
  staled_at_epoch_ms
FROM narrative_results
WHERE status = 'stale';

DROP TRIGGER v2_narrative_results_stale_descendants;

CREATE TRIGGER v2_narrative_results_require_initial_stale_metadata_empty
BEFORE INSERT ON narrative_results
WHEN NEW.stale_operation_uid IS NOT NULL OR NEW.stale_reason_code IS NOT NULL OR
  NEW.stale_root_kind IS NOT NULL OR NEW.stale_root_uid IS NOT NULL OR NEW.staled_at_epoch_ms IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'narrative results must begin without stale metadata');
END;

CREATE TRIGGER v2_narrative_results_validate_stale_metadata
BEFORE UPDATE OF status, stale_operation_uid, stale_reason_code, stale_root_kind, stale_root_uid, staled_at_epoch_ms
ON narrative_results
WHEN
  (OLD.status = 'stale' AND (
    NEW.stale_operation_uid IS NOT OLD.stale_operation_uid OR
    NEW.stale_reason_code IS NOT OLD.stale_reason_code OR
    NEW.stale_root_kind IS NOT OLD.stale_root_kind OR
    NEW.stale_root_uid IS NOT OLD.stale_root_uid OR
    NEW.staled_at_epoch_ms IS NOT OLD.staled_at_epoch_ms
  ))
  OR (NEW.status <> 'stale' AND (
    NEW.stale_operation_uid IS NOT NULL OR NEW.stale_reason_code IS NOT NULL OR
    NEW.stale_root_kind IS NOT NULL OR NEW.stale_root_uid IS NOT NULL OR NEW.staled_at_epoch_ms IS NOT NULL
  ))
  OR (NEW.status = 'stale' AND NOT (
    NEW.current_review_uid IS NULL AND
    typeof(NEW.stale_operation_uid) = 'text' AND length(CAST(NEW.stale_operation_uid AS BLOB)) = 36 AND
    NEW.stale_operation_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND
    typeof(NEW.stale_root_uid) = 'text' AND length(CAST(NEW.stale_root_uid AS BLOB)) = 36 AND
    NEW.stale_root_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND
    typeof(NEW.staled_at_epoch_ms) = 'integer' AND
    NEW.staled_at_epoch_ms BETWEEN 0 AND 253402300799999 AND
    (
      (NEW.stale_root_kind = 'source_document' AND
       NEW.stale_reason_code = 'source_document_superseded' AND EXISTS (
         SELECT 1 FROM source_selections AS selection
         WHERE selection.uid = NEW.source_selection_uid AND selection.document_uid = NEW.stale_root_uid
       ))
      OR
      (NEW.stale_root_kind = 'source_selection' AND
       NEW.stale_reason_code = 'source_selection_superseded' AND
       NEW.source_selection_uid = NEW.stale_root_uid)
      OR
      (NEW.stale_root_kind = 'narrative_result' AND
       NEW.stale_reason_code IN ('narrative_result_superseded', 'upstream_review_changed', 'legacy_stale_state') AND
       EXISTS (
         WITH RECURSIVE lineage(uid, upstream_result_uid) AS (
           SELECT uid, upstream_result_uid FROM narrative_results WHERE uid = NEW.uid
           UNION
           SELECT parent.uid, parent.upstream_result_uid
           FROM narrative_results AS parent
           JOIN lineage AS child ON parent.uid = child.upstream_result_uid
         )
         SELECT 1 FROM lineage WHERE uid = NEW.stale_root_uid
       ) AND
       (NEW.stale_reason_code <> 'upstream_review_changed' OR (
         NEW.stale_root_uid <> NEW.uid AND EXISTS (
           SELECT 1 FROM narrative_review_events AS review
           WHERE review.uid = NEW.stale_operation_uid AND review.result_uid = NEW.stale_root_uid
         )
       )) AND
       (NEW.stale_reason_code <> 'legacy_stale_state' OR (
         NEW.stale_root_uid = NEW.uid AND NEW.stale_operation_uid = NEW.uid
       )))
    )
  ))
BEGIN
  SELECT RAISE(ABORT, 'narrative stale metadata is invalid or immutable');
END;

CREATE TRIGGER v2_narrative_stale_events_validate_insert
BEFORE INSERT ON narrative_stale_events
WHEN NOT EXISTS (
  SELECT 1 FROM narrative_results AS result
  WHERE result.uid = NEW.result_uid
    AND result.status = 'stale'
    AND result.stale_operation_uid = NEW.operation_uid
    AND result.stale_reason_code = NEW.reason_code
    AND result.stale_root_kind = NEW.root_kind
    AND result.stale_root_uid = NEW.root_uid
    AND result.staled_at_epoch_ms = NEW.staled_at_epoch_ms
)
BEGIN
  SELECT RAISE(ABORT, 'narrative stale event must match the terminal result state');
END;

CREATE TRIGGER v2_narrative_stale_events_reject_replacement
BEFORE INSERT ON narrative_stale_events
WHEN EXISTS (
  SELECT 1 FROM narrative_stale_events
  WHERE uid = NEW.uid OR result_uid = NEW.result_uid
)
BEGIN
  SELECT RAISE(ABORT, 'narrative stale event identity cannot be replaced');
END;

CREATE TRIGGER v2_narrative_stale_events_validate_operation_identity
BEFORE INSERT ON narrative_stale_events
WHEN EXISTS (
  SELECT 1 FROM narrative_stale_events AS existing
  WHERE existing.operation_uid = NEW.operation_uid
    AND (
      existing.root_kind IS NOT NEW.root_kind OR
      existing.root_uid IS NOT NEW.root_uid OR
      existing.reason_code IS NOT NEW.reason_code OR
      existing.staled_at_epoch_ms IS NOT NEW.staled_at_epoch_ms
    )
)
BEGIN
  SELECT RAISE(ABORT, 'narrative stale operation identity must be consistent');
END;

CREATE TRIGGER v2_narrative_stale_events_immutable
BEFORE UPDATE ON narrative_stale_events
BEGIN
  SELECT RAISE(ABORT, 'narrative stale events are immutable');
END;

CREATE TRIGGER v2_narrative_stale_events_append_only
BEFORE DELETE ON narrative_stale_events
BEGIN
  SELECT RAISE(ABORT, 'narrative stale events are append-only');
END;

CREATE TRIGGER v2_narrative_results_audit_stale_transition
AFTER UPDATE OF status ON narrative_results
WHEN OLD.status <> 'stale' AND NEW.status = 'stale'
BEGIN
  INSERT INTO narrative_stale_events
    (uid, operation_uid, result_uid, root_kind, root_uid, reason_code, staled_at_epoch_ms)
  VALUES (lower(
      hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' ||
      '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
      substr('89ab', ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1, 1) ||
      substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
    ),
    NEW.stale_operation_uid,
    NEW.uid,
    NEW.stale_root_kind,
    NEW.stale_root_uid,
    NEW.stale_reason_code,
    NEW.staled_at_epoch_ms
  );
END;

CREATE TRIGGER v2_narrative_results_stale_descendants
AFTER UPDATE OF status, current_review_uid ON narrative_results
WHEN NEW.status IS NOT OLD.status OR NEW.current_review_uid IS NOT OLD.current_review_uid
BEGIN
  UPDATE narrative_results
  SET status = 'stale',
      current_review_uid = NULL,
      stale_operation_uid = CASE
        WHEN NEW.status = 'stale' THEN NEW.stale_operation_uid ELSE NEW.current_review_uid
      END,
      stale_reason_code = CASE
        WHEN NEW.status = 'stale' THEN NEW.stale_reason_code ELSE 'upstream_review_changed'
      END,
      stale_root_kind = CASE
        WHEN NEW.status = 'stale' THEN NEW.stale_root_kind ELSE 'narrative_result'
      END,
      stale_root_uid = CASE
        WHEN NEW.status = 'stale' THEN NEW.stale_root_uid ELSE NEW.uid
      END,
      staled_at_epoch_ms = CASE
        WHEN NEW.status = 'stale' THEN NEW.staled_at_epoch_ms ELSE
          CAST(strftime('%s', 'now') AS INTEGER) * 1000 +
          CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
      END,
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
