-- Imported source evidence is append-only. Corrections create a new document or
-- selection so downstream hashes and approvals always refer to stable records.

ALTER TABLE source_documents ADD COLUMN block_count INTEGER NOT NULL DEFAULT 0
  CHECK (
    typeof(block_count) = 'integer' AND
    block_count >= 0 AND block_count <= 100000
  );

UPDATE source_documents
SET block_count = (
  SELECT count(*) FROM source_blocks WHERE source_blocks.document_uid = source_documents.uid
);

-- Abort an upgrade instead of sealing a legacy document with no evidence blocks.
CREATE TABLE v2_source_evidence_migration_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO v2_source_evidence_migration_guard (valid)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM source_documents WHERE block_count < 1
) THEN 0 ELSE 1 END;

DROP TABLE v2_source_evidence_migration_guard;

CREATE TRIGGER v2_source_documents_require_block_count
BEFORE INSERT ON source_documents
WHEN NEW.block_count < 1
BEGIN
  SELECT RAISE(ABORT, 'source document must declare a non-empty block set');
END;

CREATE TRIGGER v2_source_documents_reject_replacement
BEFORE INSERT ON source_documents
WHEN EXISTS (SELECT 1 FROM source_documents WHERE uid = NEW.uid)
BEGIN
  SELECT RAISE(ABORT, 'source document identity cannot be replaced');
END;

CREATE TRIGGER v2_source_documents_immutable_evidence
BEFORE UPDATE OF uid, drama_uid, source_type, original_name, encoding, content_sha256, full_text, block_count, created_at
ON source_documents
WHEN NEW.uid IS NOT OLD.uid
  OR NEW.drama_uid IS NOT OLD.drama_uid
  OR NEW.source_type IS NOT OLD.source_type
  OR NEW.original_name IS NOT OLD.original_name
  OR NEW.encoding IS NOT OLD.encoding
  OR NEW.content_sha256 IS NOT OLD.content_sha256
  OR NEW.full_text IS NOT OLD.full_text
  OR NEW.block_count IS NOT OLD.block_count
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'source document identity and evidence are immutable');
END;

CREATE TRIGGER v2_source_documents_append_only
BEFORE DELETE ON source_documents
BEGIN
  SELECT RAISE(ABORT, 'source documents are append-only');
END;

CREATE TRIGGER v2_source_blocks_reject_after_complete
BEFORE INSERT ON source_blocks
WHEN EXISTS (
  SELECT 1
  FROM source_documents AS document
  WHERE document.uid = NEW.document_uid
    AND (
      NEW.ordinal >= document.block_count OR
      (SELECT count(*) FROM source_blocks WHERE document_uid = document.uid) >= document.block_count
    )
)
BEGIN
  SELECT RAISE(ABORT, 'source block cannot be replaced or appended after document is complete');
END;

CREATE TRIGGER v2_source_blocks_reject_replacement
BEFORE INSERT ON source_blocks
WHEN EXISTS (SELECT 1 FROM source_blocks WHERE uid = NEW.uid)
  OR EXISTS (
    SELECT 1 FROM source_blocks
    WHERE document_uid = NEW.document_uid AND ordinal = NEW.ordinal
  )
BEGIN
  SELECT RAISE(ABORT, 'source block identity cannot be replaced');
END;

CREATE TRIGGER v2_source_blocks_immutable_identity
BEFORE UPDATE OF uid, created_at ON source_blocks
WHEN NEW.uid IS NOT OLD.uid OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'source block identity is immutable');
END;

CREATE TRIGGER v2_source_blocks_append_only
BEFORE DELETE ON source_blocks
BEGIN
  SELECT RAISE(ABORT, 'source blocks are append-only');
END;

CREATE TRIGGER v2_source_selections_reject_replacement
BEFORE INSERT ON source_selections
WHEN EXISTS (SELECT 1 FROM source_selections WHERE uid = NEW.uid)
BEGIN
  SELECT RAISE(ABORT, 'source selection identity cannot be replaced');
END;

CREATE TRIGGER v2_source_selections_append_only
BEFORE DELETE ON source_selections
BEGIN
  SELECT RAISE(ABORT, 'source selections are append-only');
END;

CREATE TRIGGER v2_source_selections_immutable_evidence
BEFORE UPDATE OF uid, document_uid, start_block_uid, end_block_uid, start_offset, end_offset, selected_text_sha256, created_at
ON source_selections
WHEN NEW.uid IS NOT OLD.uid
  OR NEW.document_uid IS NOT OLD.document_uid
  OR NEW.start_block_uid IS NOT OLD.start_block_uid
  OR NEW.end_block_uid IS NOT OLD.end_block_uid
  OR NEW.start_offset IS NOT OLD.start_offset
  OR NEW.end_offset IS NOT OLD.end_offset
  OR NEW.selected_text_sha256 IS NOT OLD.selected_text_sha256
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'source selection identity and evidence are immutable');
END;
