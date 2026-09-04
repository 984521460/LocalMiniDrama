'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createSourceDocumentService } = require('../src/narrative/sourceDocuments');
const sourceDocumentRoutes = require('../src/routes/v2/sourceDocuments');
const { createV2Repositories } = require('../src/repositories/v2');
const {
  validateMvpBenchmarkSourceArtifacts,
  validateMvpBenchmarkSourcePack,
} = require('../../scripts/validate-mvp-benchmark-source');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

const PACK_ROOT = path.resolve(__dirname, '../../benchmarks/mvp-source');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function setup(t, start = 160000) {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(159999);
  insertDrama(database, dramaUid, '雨停之前 MVP 基准项目');
  const dramaId = database.prepare('SELECT id FROM dramas WHERE uid=?').get(dramaUid).id;
  let next = start;
  const service = createSourceDocumentService({
    repositories: createV2Repositories(database),
    createUid: () => uid(next++),
  });
  return Object.freeze({ database, dramaId, dramaUid, service });
}

function selectionCoordinates(blocks, selection) {
  const start = blocks.find((block) => (
    block.charStart <= selection.startCodePoint && selection.startCodePoint < block.charEnd
  ));
  const end = blocks.find((block) => (
    block.charStart < selection.endCodePoint && selection.endCodePoint <= block.charEnd
  ));
  assert.ok(start);
  assert.ok(end);
  return Object.freeze({
    startBlockUid: start.uid,
    endBlockUid: end.uid,
    startOffset: selection.startCodePoint - start.charStart,
    endOffset: selection.endCodePoint - end.charStart,
  });
}

test('the repository-owned MVP source pack is canonical, content-addressed, and licensed', () => {
  const pack = validateMvpBenchmarkSourcePack(PACK_ROOT);
  assert.equal(pack.manifest.sourceId, 'rain-before-clear-v1');
  assert.equal(pack.manifest.title, '雨停之前');
  assert.equal(pack.manifest.selection.targetNarrativeDurationSeconds, 60);
  assert.equal(pack.selectedText.startsWith('暴雨压住海城最后一班列车。'), true);
  assert.equal(pack.selectedText.endsWith('远处警笛穿过雨幕，车站警报重新亮起。'), true);
  assert.equal(pack.licenseText.includes('original synthetic story'), true);

  const sourceBytes = Buffer.from(pack.sourceBytes);
  sourceBytes[0] ^= 1;
  assert.throws(() => validateMvpBenchmarkSourceArtifacts({
    manifest: pack.manifest,
    sourceBytes,
    licenseBytes: pack.licenseBytes,
  }), { code: 'MVP_BENCHMARK_SOURCE_INVALID' });
});

test('the same benchmark source imports, selects, and reopens with exact evidence', (t) => {
  const pack = validateMvpBenchmarkSourcePack(PACK_ROOT);
  const current = setup(t);
  const imported = current.service.importDocument({
    dramaId: current.dramaId,
    fileName: pack.manifest.sourceFile,
    bytes: pack.sourceBytes,
    encoding: pack.manifest.encoding,
  });
  assert.equal(imported.status, 'ready');
  assert.equal(imported.document.contentSha256, pack.manifest.contentSha256);
  const coordinates = selectionCoordinates(imported.blocks, pack.manifest.selection);
  const selected = current.service.createSelection({
    documentUid: imported.document.uid,
    ...coordinates,
  });
  assert.equal(selected.selectedText, pack.selectedText);
  assert.equal(
    selected.selection.selectedTextSha256,
    pack.manifest.selection.selectedTextSha256,
  );
  const selectedBlock = imported.blocks.find((block) => block.uid === coordinates.startBlockUid);
  assert.deepEqual(selectedBlock.headingPath, pack.manifest.selection.expectedHeadingPath);

  const reopenedService = createSourceDocumentService({
    repositories: createV2Repositories(current.database),
    createUid: () => uid(169999),
  });
  const reopened = reopenedService.getDocument(imported.document.uid);
  assert.equal(reopened.document.contentSha256, pack.manifest.contentSha256);
  assert.equal(reopened.selections.length, 1);
  assert.equal(reopened.selections[0].selectedTextSha256, pack.manifest.selection.selectedTextSha256);

  const probe = Buffer.from(pack.manifest.encodingProbe.bytesHex, 'hex');
  const pending = current.service.importDocument({
    dramaId: current.dramaId,
    fileName: pack.manifest.encodingProbe.fileName,
    bytes: probe,
  });
  assert.equal(pending.status, 'encoding_required');
  assert.deepEqual(pending.encodingOptions, pack.manifest.encodingProbe.expectedOptions);
  const decoded = current.service.importDocument({
    dramaId: current.dramaId,
    fileName: pack.manifest.encodingProbe.fileName,
    bytes: probe,
    encoding: pack.manifest.encodingProbe.selectedEncoding,
  });
  assert.equal(
    sha256(Buffer.from(decoded.document.fullText, 'utf8')),
    pack.manifest.encodingProbe.decodedTextSha256,
  );
});

test('the localhost source API consumes the exact benchmark bytes and persists its range', async (t) => {
  const pack = validateMvpBenchmarkSourcePack(PACK_ROOT);
  const current = setup(t, 170000);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/v2', sourceDocumentRoutes(current.database, Object.freeze({})));
  const server = await new Promise((resolve) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/v2`;
  const form = new FormData();
  form.append('file', new Blob([pack.sourceBytes], { type: 'text/markdown' }), pack.manifest.sourceFile);
  form.append('encoding', pack.manifest.encoding);
  const importedResponse = await fetch(`${base}/dramas/${current.dramaId}/source-documents`, {
    method: 'POST',
    body: form,
  });
  assert.equal(importedResponse.status, 201);
  const imported = (await importedResponse.json()).data;
  const coordinates = selectionCoordinates(imported.blocks, pack.manifest.selection);
  const selectionResponse = await fetch(
    `${base}/source-documents/${imported.document.uid}/selections`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_block_uid: coordinates.startBlockUid,
        end_block_uid: coordinates.endBlockUid,
        start_offset: coordinates.startOffset,
        end_offset: coordinates.endOffset,
      }),
    },
  );
  assert.equal(selectionResponse.status, 201);
  assert.equal(
    (await selectionResponse.json()).data.selection.selectedTextSha256,
    pack.manifest.selection.selectedTextSha256,
  );
});
