const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const test = require('node:test');

const { createV2Repositories } = require('../src/repositories/v2');
const {
  createSourceDocumentService,
  isSourceDocumentError,
} = require('../src/narrative/sourceDocuments');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');
const sourceDocumentRoutes = require('../src/routes/v2/sourceDocuments');

function codePointLength(value) {
  return Array.from(value).length;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createUidSequence(start = 3000) {
  let current = start;
  return () => uid(current++);
}

function setup(t, createUid = createUidSequence()) {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(2900);
  insertDrama(database, dramaUid, 'Source selection drama');
  const dramaId = database.prepare('SELECT id FROM dramas WHERE uid = ?').get(dramaUid).id;
  const repositories = createV2Repositories(database);
  const service = createSourceDocumentService({ repositories, createUid });
  return { database, dramaId, dramaUid, repositories, service };
}

test('imports normalized Markdown into complete, bounded and traceable source blocks', (t) => {
  const { dramaId, dramaUid, service } = setup(t);
  const text = [
    '# 第一章',
    '',
    '甲'.repeat(1700),
    '',
    '## 第二节',
    '',
    `${'乙'.repeat(1600)}😀结尾`,
  ].join('\n');
  const bytes = Buffer.from(text, 'utf8');

  const result = service.importDocument({
    dramaId,
    fileName: 'story.md',
    bytes,
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.document.dramaUid, dramaUid);
  assert.equal(result.document.fullText, text);
  assert.equal(result.document.contentSha256, sha256(bytes));
  assert.equal(result.blocks[0].charStart, 0);
  assert.equal(result.blocks.at(-1).charEnd, codePointLength(text));
  assert.equal(result.blocks.map((block) => block.text).join(''), text);
  for (let index = 0; index < result.blocks.length; index += 1) {
    const block = result.blocks[index];
    assert.equal(block.ordinal, index);
    assert.equal(block.textSha256, sha256(block.text));
    assert.equal(codePointLength(block.text) <= 3000, true);
    if (index > 0) assert.equal(block.charStart, result.blocks[index - 1].charEnd);
  }
  assert.deepEqual(result.blocks.at(-1).headingPath, ['第一章', '第二节']);

  const aggregate = service.getDocument(result.document.uid);
  assert.deepEqual(aggregate, {
    document: result.document,
    blocks: result.blocks,
    selections: [],
  });
  const listed = service.listDocuments(dramaId);
  assert.equal(listed.length, 1);
  assert.equal(Object.hasOwn(listed[0], 'fullText'), false);
  assert.equal(listed[0].blockCount, result.blocks.length);
});

test('treats every Markdown heading as a hard block boundary and validates heading-only paths', (t) => {
  const { database, dramaId, service } = setup(t);
  const text = '# 第一章\n\n短段一。\n\n# 第二章\n\n短段二。';
  const imported = service.importDocument({
    dramaId,
    fileName: 'chapters.md',
    bytes: Buffer.from(text),
  });

  assert.equal(imported.blocks.length, 2);
  assert.deepEqual(imported.blocks.map((block) => block.headingPath), [
    ['第一章'],
    ['第二章'],
  ]);
  assert.equal(imported.blocks.map((block) => block.text).join(''), text);

  assert.throws(() => service.importDocument({
    dramaId,
    fileName: 'heading-only.md',
    bytes: Buffer.from(`# ${'章'.repeat(1001)}`),
  }), (error) => isSourceDocumentError(error)
    && error.code === 'SOURCE_DOCUMENT_LIMIT_EXCEEDED');
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_documents').get().count, 1);
});

test('returns encoding choices without writing any document rows', (t) => {
  const { database, dramaId, service } = setup(t);
  const result = service.importDocument({
    dramaId,
    fileName: 'ambiguous.txt',
    bytes: Buffer.from([0xc2, 0xa3]),
  });

  assert.equal(result.status, 'encoding_required');
  assert.deepEqual(result.encodingOptions, ['utf-8', 'gb18030', 'gbk']);
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_documents').get().count, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_blocks').get().count, 0);
});

test('creates an exact cross-block Unicode selection and rejects invalid ranges atomically', (t) => {
  const { database, dramaId, service } = setup(t);
  const text = `# 章\n\n${'甲'.repeat(2990)}😀\n${'乙'.repeat(30)}`;
  const imported = service.importDocument({
    dramaId,
    fileName: 'selection.md',
    bytes: Buffer.from(text),
  });
  assert.equal(imported.blocks.length >= 2, true);
  const startBlock = imported.blocks[0];
  const endBlock = imported.blocks[1];
  const startOffset = codePointLength(startBlock.text) - 2;
  const endOffset = 3;
  const expected = `${Array.from(startBlock.text).slice(startOffset).join('')}${Array.from(endBlock.text).slice(0, endOffset).join('')}`;

  const created = service.createSelection({
    documentUid: imported.document.uid,
    startBlockUid: startBlock.uid,
    endBlockUid: endBlock.uid,
    startOffset,
    endOffset,
  });

  assert.equal(created.selectedText, expected);
  assert.equal(created.selection.selectedTextSha256, sha256(expected));
  assert.equal(service.getDocument(imported.document.uid).selections.length, 1);

  const before = database.prepare('SELECT count(*) AS count FROM source_selections').get().count;
  for (const invalid of [
    { startBlockUid: endBlock.uid, endBlockUid: startBlock.uid, startOffset: 0, endOffset: 1 },
    { startBlockUid: startBlock.uid, endBlockUid: startBlock.uid, startOffset: 2, endOffset: 2 },
    { startBlockUid: startBlock.uid, endBlockUid: endBlock.uid, startOffset: -1, endOffset: 1 },
  ]) {
    assert.throws(() => service.createSelection({
      documentUid: imported.document.uid,
      ...invalid,
    }), (error) => isSourceDocumentError(error)
      && error.code === 'SOURCE_SELECTION_INVALID'
      && !JSON.stringify(error).includes('甲'));
  }
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_selections').get().count, before);
});

test('rolls back a document when generated block identities conflict', (t) => {
  const documentUid = uid(3900);
  const blockUid = uid(3901);
  let calls = 0;
  const { database, dramaId, service } = setup(t, () => {
    calls += 1;
    return calls === 1 ? documentUid : blockUid;
  });
  const text = `${'甲'.repeat(3000)}${'乙'.repeat(10)}`;

  assert.throws(() => service.importDocument({
    dramaId,
    fileName: 'conflict.txt',
    bytes: Buffer.from(text),
    encoding: 'utf-8',
  }));
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_documents WHERE uid = ?').get(documentUid).count, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_blocks WHERE document_uid = ?').get(documentUid).count, 0);
});

test('fails closed for unknown legacy dramas without reflecting caller-controlled values', (t) => {
  const { service } = setup(t);
  let captured;
  try {
    service.listDocuments(999999);
  } catch (error) {
    captured = error;
  }
  assert.equal(isSourceDocumentError(captured), true);
  assert.equal(captured.code, 'SOURCE_DRAMA_NOT_FOUND');
  assert.equal(JSON.stringify(captured).includes('999999'), false);
});

test('rejects persisted block drift before creating a selection', (t) => {
  const { database, dramaId, service } = setup(t);
  const imported = service.importDocument({
    dramaId,
    fileName: 'drift.txt',
    bytes: Buffer.from('stable source text'),
  });
  database.exec('DROP TRIGGER v2_source_blocks_immutable_content');
  database.prepare('UPDATE source_blocks SET text = ? WHERE uid = ?')
    .run('tampered source text', imported.blocks[0].uid);

  assert.throws(() => service.createSelection({
    documentUid: imported.document.uid,
    startBlockUid: imported.blocks[0].uid,
    endBlockUid: imported.blocks[0].uid,
    startOffset: 0,
    endOffset: 1,
  }), (error) => isSourceDocumentError(error)
    && error.code === 'SOURCE_DOCUMENT_DATA_INVALID'
    && !JSON.stringify(error).includes('tampered'));
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_selections').get().count, 0);
});

test('rebuilds persisted selections and rejects range or hash drift before returning detail', (t) => {
  const { database, dramaId, service } = setup(t);
  const imported = service.importDocument({
    dramaId,
    fileName: 'selection-drift.txt',
    bytes: Buffer.from('stable evidence text'),
  });
  const block = imported.blocks[0];
  service.createSelection({
    documentUid: imported.document.uid,
    startBlockUid: block.uid,
    endBlockUid: block.uid,
    startOffset: 0,
    endOffset: 6,
  });
  database.exec('DROP TRIGGER IF EXISTS v2_source_selections_immutable_evidence');
  database.prepare(`
    UPDATE source_selections
    SET start_offset = 1, end_offset = 4, selected_text_sha256 = ?
    WHERE document_uid = ?
  `).run('0'.repeat(64), imported.document.uid);

  assert.throws(() => service.getDocument(imported.document.uid), (error) => (
    isSourceDocumentError(error) && error.code === 'SOURCE_DOCUMENT_DATA_INVALID'
  ));
});

test('keeps imported document evidence and selection identity immutable in SQLite', (t) => {
  const { database, dramaId, service } = setup(t);
  const imported = service.importDocument({
    dramaId,
    fileName: 'immutable.txt',
    bytes: Buffer.from('immutable evidence'),
  });
  const block = imported.blocks[0];
  const created = service.createSelection({
    documentUid: imported.document.uid,
    startBlockUid: block.uid,
    endBlockUid: block.uid,
    startOffset: 0,
    endOffset: 9,
  });

  assert.throws(() => database.prepare(`
    UPDATE source_documents SET content_sha256 = ? WHERE uid = ?
  `).run('0'.repeat(64), imported.document.uid), /immutable/i);
  assert.throws(() => database.prepare(`
    UPDATE source_selections SET selected_text_sha256 = ? WHERE uid = ?
  `).run('0'.repeat(64), created.selection.uid), /immutable/i);

  const replacementCases = [
    {
      table: 'source_documents',
      columns: ['uid', 'drama_uid', 'source_type', 'original_name', 'encoding', 'content_sha256', 'full_text', 'created_at'],
    },
    {
      table: 'source_blocks',
      columns: ['uid', 'document_uid', 'ordinal', 'heading_path_json', 'char_start', 'char_end', 'text', 'text_sha256', 'created_at'],
    },
    {
      table: 'source_selections',
      columns: ['uid', 'document_uid', 'start_block_uid', 'end_block_uid', 'start_offset', 'end_offset', 'selected_text_sha256', 'created_at'],
    },
  ];
  for (const { table, columns } of replacementCases) {
    const row = database.prepare(`SELECT ${columns.join(', ')} FROM ${table} LIMIT 1`).get();
    const placeholders = columns.map(() => '?').join(', ');
    assert.throws(() => database.prepare(`
      INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
    `).run(...columns.map((column) => row[column])), /cannot be replaced/i);
  }
});

test('rejects deletion of imported source documents, blocks and selections', (t) => {
  const { database, dramaId, service } = setup(t);
  const selectedDocument = service.importDocument({
    dramaId,
    fileName: 'selected.txt',
    bytes: Buffer.from('selected evidence'),
  });
  const selectedBlock = selectedDocument.blocks[0];
  const created = service.createSelection({
    documentUid: selectedDocument.document.uid,
    startBlockUid: selectedBlock.uid,
    endBlockUid: selectedBlock.uid,
    startOffset: 0,
    endOffset: 8,
  });
  const blockOnlyDocument = service.importDocument({
    dramaId,
    fileName: 'block-only.txt',
    bytes: Buffer.from('block evidence'),
  });

  assert.throws(
    () => database.prepare('DELETE FROM source_selections WHERE uid = ?')
      .run(created.selection.uid),
    /append-only/i,
  );
  assert.throws(
    () => database.prepare('DELETE FROM source_blocks WHERE uid = ?')
      .run(blockOnlyDocument.blocks[0].uid),
    /append-only/i,
  );
  assert.throws(
    () => database.prepare('DELETE FROM source_documents WHERE uid = ?')
      .run(selectedDocument.document.uid),
    /append-only/i,
  );
});

test('rejects source block replacement through the document ordinal unique key', (t) => {
  const { database, dramaId, service } = setup(t);
  const imported = service.importDocument({
    dramaId,
    fileName: 'alternate-unique.txt',
    bytes: Buffer.from('stable block identity'),
  });
  const row = database.prepare('SELECT * FROM source_blocks WHERE uid = ?')
    .get(imported.blocks[0].uid);

  for (const [index, conflictPolicy] of ['ABORT', 'FAIL', 'IGNORE', 'REPLACE', 'ROLLBACK'].entries()) {
    assert.throws(() => database.prepare(`
      INSERT OR ${conflictPolicy} INTO source_blocks
        (uid, document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uid(3990 + index),
      row.document_uid,
      row.ordinal,
      row.heading_path_json,
      row.char_start,
      row.char_end,
      row.text,
      row.text_sha256,
      row.created_at,
    ), /cannot be replaced|document is complete/i);
  }
  assert.throws(() => database.prepare(`
    INSERT INTO source_blocks
      (uid, document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_uid, ordinal) DO UPDATE SET uid = excluded.uid
  `).run(
    uid(3995),
    row.document_uid,
    row.ordinal,
    row.heading_path_json,
    row.char_start,
    row.char_end,
    row.text,
    row.text_sha256,
    row.created_at,
  ), /cannot be replaced|document is complete|immutable/i);
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_blocks WHERE document_uid = ?')
    .get(imported.document.uid).count, 1);
  assert.equal(database.prepare('SELECT count(*) AS count FROM source_blocks WHERE uid = ?')
    .get(imported.blocks[0].uid).count, 1);
});

test('rejects appending a block after the imported document block set is complete', (t) => {
  const { database, dramaId, service } = setup(t);
  const imported = service.importDocument({
    dramaId,
    fileName: 'complete.txt',
    bytes: Buffer.from('complete evidence'),
  });
  const end = imported.blocks.at(-1).charEnd;

  assert.throws(() => database.prepare(`
    INSERT INTO source_blocks
      (uid, document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256)
    VALUES (?, ?, ?, '[]', ?, ?, '', ?)
  `).run(uid(3991), imported.document.uid, imported.blocks.length, end, end, sha256('')), /complete/i);
});

test('rejects persisted zero-length and oversized source blocks in document detail', (t) => {
  const emptyCase = setup(t);
  const emptyImported = emptyCase.service.importDocument({
    dramaId: emptyCase.dramaId,
    fileName: 'empty-drift.txt',
    bytes: Buffer.from('stable evidence'),
  });
  emptyCase.database.exec('DROP TRIGGER IF EXISTS v2_source_blocks_reject_after_complete');
  const documentColumns = emptyCase.database.prepare('PRAGMA table_info(source_documents)').all();
  if (documentColumns.some((column) => column.name === 'block_count')) {
    emptyCase.database.exec('DROP TRIGGER IF EXISTS v2_source_documents_immutable_evidence');
    emptyCase.database.prepare('UPDATE source_documents SET block_count = block_count + 1 WHERE uid = ?')
      .run(emptyImported.document.uid);
  }
  const end = emptyImported.blocks.at(-1).charEnd;
  emptyCase.database.prepare(`
    INSERT INTO source_blocks
      (uid, document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256)
    VALUES (?, ?, ?, '[]', ?, ?, '', ?)
  `).run(uid(3992), emptyImported.document.uid, emptyImported.blocks.length, end, end, sha256(''));
  assert.throws(() => emptyCase.service.getDocument(emptyImported.document.uid), (error) => (
    isSourceDocumentError(error) && error.code === 'SOURCE_DOCUMENT_DATA_INVALID'
  ));

  const oversizedCase = setup(t);
  const oversizedImported = oversizedCase.service.importDocument({
    dramaId: oversizedCase.dramaId,
    fileName: 'oversized-drift.txt',
    bytes: Buffer.from('short'),
  });
  const oversizedText = '大'.repeat(3001);
  oversizedCase.database.exec('DROP TRIGGER IF EXISTS v2_source_documents_immutable_evidence');
  oversizedCase.database.exec('DROP TRIGGER IF EXISTS v2_source_blocks_immutable_content');
  oversizedCase.database.prepare('UPDATE source_documents SET full_text = ? WHERE uid = ?')
    .run(oversizedText, oversizedImported.document.uid);
  oversizedCase.database.prepare(`
    UPDATE source_blocks
    SET char_end = ?, text = ?, text_sha256 = ?
    WHERE uid = ?
  `).run(3001, oversizedText, sha256(oversizedText), oversizedImported.blocks[0].uid);
  assert.throws(() => oversizedCase.service.getDocument(oversizedImported.document.uid), (error) => (
    isSourceDocumentError(error) && error.code === 'SOURCE_DOCUMENT_DATA_INVALID'
  ));
});

test('rejects malformed document and block identities before repository lookup', (t) => {
  const { dramaId, service } = setup(t);
  const imported = service.importDocument({
    dramaId,
    fileName: 'uid.txt',
    bytes: Buffer.from('uid evidence'),
  });

  assert.throws(() => service.getDocument('not-a-uuid'), (error) => (
    isSourceDocumentError(error) && error.code === 'SOURCE_DOCUMENT_INPUT_INVALID'
  ));
  assert.throws(() => service.createSelection({
    documentUid: imported.document.uid,
    startBlockUid: 'not-a-uuid',
    endBlockUid: imported.blocks[0].uid,
    startOffset: 0,
    endOffset: 1,
  }), (error) => isSourceDocumentError(error)
    && error.code === 'SOURCE_DOCUMENT_INPUT_INVALID');
});

test('serves the source document import, list, detail and selection API over localhost', async (t) => {
  const { database, dramaId } = setup(t);
  const logged = [];
  const app = express();
  app.use(express.json());
  app.use('/api/v1/v2', sourceDocumentRoutes(database, {
    error(event, details) { logged.push({ event, details }); },
  }));
  const server = await new Promise((resolve) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}/api/v1/v2`;

  const form = new FormData();
  form.append('file', new Blob(['# Chapter\n\nAlpha😀Beta'], { type: 'text/markdown' }), 'api.md');
  form.append('encoding', 'utf-8');
  const importedResponse = await fetch(`${origin}/dramas/${dramaId}/source-documents`, {
    method: 'POST',
    body: form,
  });
  assert.equal(importedResponse.status, 201);
  const importedPayload = await importedResponse.json();
  assert.equal(importedPayload.success, true);
  const imported = importedPayload.data;

  const listedPayload = await (await fetch(`${origin}/dramas/${dramaId}/source-documents`)).json();
  assert.equal(listedPayload.data.length, 1);
  assert.equal(Object.hasOwn(listedPayload.data[0], 'fullText'), false);

  const detailPayload = await (await fetch(`${origin}/source-documents/${imported.document.uid}`)).json();
  assert.equal(detailPayload.data.document.fullText, '# Chapter\n\nAlpha😀Beta');
  const block = detailPayload.data.blocks[0];
  const selectionResponse = await fetch(`${origin}/source-documents/${imported.document.uid}/selections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start_block_uid: block.uid,
      end_block_uid: block.uid,
      start_offset: 11,
      end_offset: 17,
    }),
  });
  assert.equal(selectionResponse.status, 201);
  const selectionPayload = await selectionResponse.json();
  assert.equal(selectionPayload.data.selectedText, 'Alpha😀');

  const malformed = await fetch(`${origin}/dramas/${dramaId}junk/source-documents`);
  assert.equal(malformed.status, 400);
  const malformedDocument = await fetch(`${origin}/source-documents/not-a-uuid`);
  assert.equal(malformedDocument.status, 400);
  assert.equal((await malformedDocument.json()).error.code, 'SOURCE_DOCUMENT_INPUT_INVALID');
  assert.equal(logged.some((entry) => JSON.stringify(entry).includes('Alpha')), false);
});
