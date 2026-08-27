const {
  SourceEvidenceValidationError,
  assertSourceEvidenceAggregate,
} = require('../narrative/sourceDocuments/evidenceValidator');

function invalid() {
  throw new SourceEvidenceValidationError();
}

function parseHeadingPath(value) {
  if (typeof value !== 'string') invalid();
  try {
    return JSON.parse(value);
  } catch {
    return invalid();
  }
}

function assertProjectArchiveSourceEvidence(records) {
  if (!records
    || typeof records !== 'object'
    || !Array.isArray(records.sourceDocuments)
    || !Array.isArray(records.sourceBlocks)
    || !Array.isArray(records.sourceSelections)) invalid();

  const blocksByDocument = new Map();
  const selectionsByDocument = new Map();
  for (const document of records.sourceDocuments) {
    if (!document || typeof document.uid !== 'string' || blocksByDocument.has(document.uid)) invalid();
    blocksByDocument.set(document.uid, []);
    selectionsByDocument.set(document.uid, []);
  }
  for (const block of records.sourceBlocks) {
    const target = blocksByDocument.get(block?.document_uid);
    if (!target) invalid();
    target.push(block);
  }
  for (const selection of records.sourceSelections) {
    const target = selectionsByDocument.get(selection?.document_uid);
    if (!target) invalid();
    target.push(selection);
  }

  for (const documentRow of records.sourceDocuments) {
    const blockRows = [...blocksByDocument.get(documentRow.uid)].sort((left, right) => (
      Number(left.ordinal) - Number(right.ordinal)
    ));
    const blocks = blockRows.map((row) => ({
      uid: row.uid,
      documentUid: row.document_uid,
      ordinal: row.ordinal,
      headingPath: parseHeadingPath(row.heading_path_json),
      charStart: row.char_start,
      charEnd: row.char_end,
      text: row.text,
      textSha256: row.text_sha256,
    }));
    const selections = selectionsByDocument.get(documentRow.uid).map((row) => ({
      uid: row.uid,
      documentUid: row.document_uid,
      startBlockUid: row.start_block_uid,
      endBlockUid: row.end_block_uid,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      selectedTextSha256: row.selected_text_sha256,
    }));
    assertSourceEvidenceAggregate({
      document: {
        uid: documentRow.uid,
        fullText: documentRow.full_text,
        contentSha256: documentRow.content_sha256,
        blockCount: Object.hasOwn(documentRow, 'block_count')
          ? documentRow.block_count
          : blocks.length,
      },
      blocks,
      selections,
    });
  }
  return true;
}

function projectArchiveRecordsForManifest(records) {
  return {
    ...records,
    sourceDocuments: records.sourceDocuments.map((document) => {
      const { block_count: internalBlockCount, ...portableDocument } = document;
      return portableDocument;
    }),
  };
}

module.exports = {
  assertProjectArchiveSourceEvidence,
  projectArchiveRecordsForManifest,
};
