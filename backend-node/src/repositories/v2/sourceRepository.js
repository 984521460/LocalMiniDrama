const { executeWrite, requiredRow } = require('./repositorySupport');
const { freezeSnapshot, mapRow, mapRows, serializeJson } = require('./rowMapping');

const DOCUMENT_MAP = Object.freeze({ entity: 'source document' });
const DRAMA_MAP = Object.freeze({ entity: 'drama' });
const BLOCK_MAP = Object.freeze({
  entity: 'source block',
  jsonFields: Object.freeze({ heading_path_json: 'headingPath' }),
  jsonKinds: Object.freeze({ heading_path_json: 'array' }),
});
const SELECTION_MAP = Object.freeze({ entity: 'source selection' });

function createSourceRepository(database) {
  const insertDocument = database.prepare(`
    INSERT INTO source_documents
      (uid, drama_uid, source_type, original_name, encoding, content_sha256, full_text, block_count)
    VALUES
      (@uid, @dramaUid, @sourceType, @originalName, @encoding, @contentSha256, @fullText, @blockCount)
  `);
  const insertBlock = database.prepare(`
    INSERT INTO source_blocks
      (uid, document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256)
    VALUES
      (@uid, @documentUid, @ordinal, @headingPathJson, @charStart, @charEnd, @text, @textSha256)
  `);
  const insertSelection = database.prepare(`
    INSERT INTO source_selections
      (uid, document_uid, start_block_uid, end_block_uid, start_offset, end_offset, selected_text_sha256)
    VALUES
      (@uid, @documentUid, @startBlockUid, @endBlockUid, @startOffset, @endOffset, @selectedTextSha256)
  `);
  const getDocumentRow = database.prepare('SELECT * FROM source_documents WHERE uid = ?');
  const getBlockRow = database.prepare('SELECT * FROM source_blocks WHERE uid = ?');
  const getSelectionRow = database.prepare('SELECT * FROM source_selections WHERE uid = ?');
  const findDramaRow = database.prepare(`
    SELECT id, uid, title FROM dramas WHERE id = ? AND deleted_at IS NULL
  `);
  const listDocumentRows = database.prepare(`
    SELECT
      source_documents.uid,
      source_documents.drama_uid,
      source_documents.source_type,
      source_documents.original_name,
      source_documents.encoding,
      source_documents.content_sha256,
      source_documents.created_at,
      source_documents.block_count
    FROM source_documents
    WHERE source_documents.drama_uid = ?
    ORDER BY source_documents.created_at, source_documents.uid
  `);
  const listBlockRows = database.prepare(`
    SELECT * FROM source_blocks WHERE document_uid = ? ORDER BY ordinal, uid
  `);
  const listSelectionRows = database.prepare(`
    SELECT * FROM source_selections WHERE document_uid = ? ORDER BY created_at, uid
  `);

  const insertDocumentAndBlocks = database.transaction(({ document, blocks }) => {
    insertDocument.run(document);
    for (const block of blocks) {
      insertBlock.run({
        ...block,
        documentUid: document.uid,
        headingPathJson: serializeJson(block.headingPath, []),
      });
    }
  });

  function getDocument(uid) {
    return mapRow(requiredRow(getDocumentRow.get(uid), 'source document', uid), DOCUMENT_MAP);
  }

  function getBlock(uid) {
    return mapRow(requiredRow(getBlockRow.get(uid), 'source block', uid), BLOCK_MAP);
  }

  function getSelection(uid) {
    return mapRow(requiredRow(getSelectionRow.get(uid), 'source selection', uid), SELECTION_MAP);
  }

  function listBlocks(documentUid) {
    return mapRows(listBlockRows.all(documentUid), BLOCK_MAP);
  }

  return Object.freeze({
    createDocumentWithBlocks(input) {
      const blocks = Array.isArray(input.blocks) ? input.blocks.map((block) => ({ ...block })) : [];
      const document = { ...input.document, blockCount: blocks.length };
      executeWrite('source document', 'created', () => insertDocumentAndBlocks({ document, blocks }));
      return freezeSnapshot({ document: getDocument(document.uid), blocks: listBlocks(document.uid) });
    },

    createSelection(selection) {
      executeWrite('source selection', 'created', () => insertSelection.run(selection));
      return getSelection(selection.uid);
    },

    getBlock,
    getDocument,
    getSelection,

    findDramaByLegacyId(id) {
      return mapRow(findDramaRow.get(id), DRAMA_MAP);
    },

    listBlocks,

    listDocumentsByDrama(dramaUid) {
      return mapRows(listDocumentRows.all(dramaUid), DOCUMENT_MAP);
    },

    listSelections(documentUid) {
      return mapRows(listSelectionRows.all(documentUid), SELECTION_MAP);
    },
  });
}

module.exports = { createSourceRepository };
