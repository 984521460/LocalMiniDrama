'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const { createMigratedV2Database, insertDrama, uid } = require('./helpers/v2RepositoryDatabase');
const { createV2Repositories } = require('../src/repositories/v2');
const { createSourceDocumentService } = require('../src/narrative/sourceDocuments');
const { inspectSourceTextFile } = require('../src/narrative/sourceImport');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const text = 'A synthetic source line.\nA second line.\n';

test('LF, CRLF and UTF-8 BOM keep raw hashes distinct while persisted normalized evidence reopens', async (t) => {
  const database = createMigratedV2Database(t);
  insertDrama(database, uid(9910));
  const dramaId = database.prepare('SELECT id FROM dramas WHERE uid=?').pluck().get(uid(9910));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-source-normalized-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = createSourceDocumentService({ repositories: createV2Repositories(database) });
  const rawHashes = new Set();
  const documentUids = [];
  for (const bytes of [Buffer.from(text), Buffer.from(text.replaceAll('\n', '\r\n')),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])]) {
    const inspected = inspectSourceTextFile({ fileName: 'fixture.txt', bytes });
    assert.equal(inspected.contentSha256, hash(bytes));
    assert.equal(inspected.normalizedTextSha256, hash(text));
    rawHashes.add(inspected.contentSha256);
    const imported = sources.importDocument({ dramaId, fileName: 'fixture.txt', bytes });
    documentUids.push(imported.document.uid);
    const aggregate = sources.getDocument(imported.document.uid);
    assert.equal(aggregate.document.fullText, text);
    assert.equal(aggregate.document.contentSha256, hash(text));
    const selected = sources.createSelection({ documentUid: imported.document.uid,
      startBlockUid: aggregate.blocks[0].uid, endBlockUid: aggregate.blocks.at(-1).uid,
      startOffset: 0, endOffset: Array.from(aggregate.blocks.at(-1).text).length });
    assert.equal(selected.selection.selectedTextSha256, hash(text));
  }
  assert.equal(rawHashes.size, 3);
  const filename = path.join(root, 'persisted.sqlite');
  await database.backup(filename);
  const reopened = new Database(filename);
  require('../src/db/v2/sqlFunctions').registerV2SqlFunctions(reopened);
  try {
    const service = createSourceDocumentService({ repositories: createV2Repositories(reopened) });
    for (const documentUid of documentUids) {
      const aggregate = service.getDocument(documentUid);
      assert.equal(aggregate.document.contentSha256, hash(text));
      assert.equal(aggregate.selections.length, 1);
    }
  } finally { reopened.close(); }
});
