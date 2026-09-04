'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const { createNarrativeExecutionService } = require('../src/narrative/execution');
const { createNarrativeReviewService } = require('../src/narrative/reviews');
const {
  NarrativeFactEvidenceTraceError,
  createNarrativeFactEvidenceTrace,
} = require('../src/narrative/reviews/evidenceTrace');
const { createSourceDocumentService } = require('../src/narrative/sourceDocuments');
const { createV2Repositories } = require('../src/repositories/v2');
const narrativeReviewRoutes = require('../src/routes/v2/narrativeReviews');
const {
  validateMvpBenchmarkSourcePack,
} = require('../../scripts/validate-mvp-benchmark-source');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

const PACK_ROOT = require('node:path').resolve(__dirname, '../../benchmarks/mvp-source');

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function uidFactory(start) {
  let next = start;
  return () => uid(next++);
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

function evidence(blocks, quote) {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const unitStart = block.text.indexOf(quote);
    if (unitStart < 0) continue;
    assert.equal(block.text.lastIndexOf(quote), unitStart);
    const startOffset = Array.from(block.text.slice(0, unitStart)).length;
    return Object.freeze({
      blockUid: block.uid,
      startOffset,
      endOffset: startOffset + Array.from(quote).length,
      quote,
    });
  }
  throw new Error(`missing benchmark quote: ${quote}`);
}

function extractionOutput(blocks) {
  const linChe = evidence(blocks, '林澈抱着一只银色证物箱冲进站内');
  const xiaXian = evidence(blocks, '她在停摆的钟下看见调查员夏弦');
  const station = evidence(blocks, '旧车站突然断电');
  const caseEvidence = evidence(blocks, '一只银色证物箱');
  const partnership = evidence(blocks, '夏弦低声提醒：广播来自站内旧线路，操作者一定还在楼里');
  const power = evidence(blocks, '林澈接通备用电源，所有站台灯同时亮起');
  const target = evidence(blocks, '真正目标是箱内那块记录事故真相的存储芯片');
  return Object.freeze({
    schemaVersion: 'novel-extraction.v1',
    characters: [
      { factId: 'character-lin-che', name: '林澈', description: '修复师，携带证物箱进入旧车站。', evidence: [linChe] },
      { factId: 'character-xia-xian', name: '夏弦', description: '调查员，在车站内协助林澈。', evidence: [xiaXian] },
    ],
    scenes: [{
      factId: 'scene-old-station', location: '海城旧车站', time: '暴雨夜',
      description: '旧车站断电，应急灯亮起。', evidence: [station],
    }],
    props: [{
      factId: 'prop-evidence-case', name: '银色证物箱',
      description: '林澈带入车站的证物箱。', evidence: [caseEvidence],
    }],
    relationships: [{
      factId: 'relationship-investigation-partners',
      fromCharacterFactId: 'character-lin-che',
      toCharacterFactId: 'character-xia-xian',
      relationship: '两人在车站内协同行动并调查广播来源。',
      evidence: [partnership],
    }],
    events: [{
      factId: 'event-restore-power', summary: '林澈恢复备用电源并照亮站台。',
      characterFactIds: ['character-lin-che'], sceneFactId: 'scene-old-station',
      propFactIds: [], evidence: [power],
    }],
    dialogue: [{
      factId: 'dialogue-real-target', speakerCharacterFactId: null,
      content: '真正目标是记录事故真相的存储芯片。', evidence: [target],
    }],
  });
}

function setup(t) {
  const pack = validateMvpBenchmarkSourcePack(PACK_ROOT);
  const database = createMigratedV2Database(t);
  const dramaUid = uid(180000);
  insertDrama(database, dramaUid, '雨停之前事实追溯');
  const dramaId = database.prepare('SELECT id FROM dramas WHERE uid=?').get(dramaUid).id;
  const repositories = createV2Repositories(database);
  const sourceService = createSourceDocumentService({
    repositories,
    createUid: uidFactory(180010),
  });
  const imported = sourceService.importDocument({
    dramaId,
    fileName: pack.manifest.sourceFile,
    bytes: pack.sourceBytes,
    encoding: pack.manifest.encoding,
  });
  const selection = sourceService.createSelection({
    documentUid: imported.document.uid,
    ...selectionCoordinates(imported.blocks, pack.manifest.selection),
  });
  return Object.freeze({
    pack, database, dramaId, dramaUid, repositories, sourceService, imported, selection,
  });
}

test('source document reads fail closed when the full-text digest drifts', (t) => {
  const current = setup(t);
  current.database.exec('DROP TRIGGER v2_source_documents_immutable_evidence');
  current.database.prepare('UPDATE source_documents SET content_sha256=? WHERE uid=?')
    .run('f'.repeat(64), current.imported.document.uid);
  assert.throws(
    () => current.sourceService.getDocument(current.imported.document.uid),
    { code: 'SOURCE_DOCUMENT_DATA_INVALID' },
  );
});

test('the same benchmark extraction reopens one exact fact-to-source trace', async (t) => {
  const current = setup(t);
  const rawResponse = JSON.stringify(extractionOutput(current.imported.blocks));
  const execution = createNarrativeExecutionService({
    repositories: current.repositories,
    provider: Object.freeze({
      scope: 'configured-text',
      isAvailable: () => true,
      generate: () => Object.freeze({
        model: Object.freeze({ provider: 'synthetic', name: 'same-source-fixture' }),
        parameters: Object.freeze({ temperature: 0 }),
        promptVersion: 'mvp-source-extraction.v1',
        rawResponse,
      }),
    }),
    assetOwnership: Object.freeze({ accepts() { return true; } }),
    createUid: uidFactory(180100),
  });
  const completed = await execution.execute({
    schemaVersion: 'narrative-execution-request.v1',
    operationUid: uid(180090),
    dramaUid: current.dramaUid,
    sourceSelectionUid: current.selection.selection.uid,
    resultType: 'extraction',
    upstreamResultUid: null,
    upstreamResultHash: null,
    upstreamEnvelopeHash: null,
    upstreamApprovalRef: null,
    durationBudget: null,
    style: null,
    assetVersions: [],
  });
  const reviews = createNarrativeReviewService({
    repositories: createV2Repositories(current.database),
    createUid: uidFactory(180200),
  });
  reviews.reviewResult({ resultUid: completed.result.uid, decision: 'approve' });

  const trace = reviews.getFactEvidence(completed.result.uid, 'character-lin-che');
  assert.equal(trace.schemaVersion, 'narrative-fact-evidence-trace.v1');
  assert.equal(trace.resultUid, completed.result.uid);
  assert.equal(trace.resultStatus, 'approved');
  assert.equal(trace.sourceDocumentSha256, current.pack.manifest.contentSha256);
  assert.equal(trace.selectedTextSha256, current.pack.manifest.selection.selectedTextSha256);
  assert.equal(trace.factType, 'character');
  assert.equal(trace.factId, 'character-lin-che');
  assert.equal(trace.factLabel, '林澈');
  assert.equal(trace.evidenceCount, 1);
  assert.equal(trace.evidence[0].quote, '林澈抱着一只银色证物箱冲进站内');
  assert.equal(
    `${trace.evidence[0].beforeText}${trace.evidence[0].quote}${trace.evidence[0].afterText}`,
    trace.evidence[0].selectedBlockText,
  );
  assert.equal(sha256(trace.evidence[0].blockText), trace.evidence[0].blockTextSha256);
  assert.equal(Object.isFrozen(trace), true);
  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v9/narrative-fact-evidence-trace.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(trace), true, JSON.stringify(validate.errors));
  assert.throws(
    () => reviews.getFactEvidence(completed.result.uid, 'missing-fact'),
    { code: 'NARRATIVE_REVIEW_NOT_FOUND' },
  );
  const persistedRecord = current.repositories.narrativeReviews.getResult(completed.result.uid);
  const wrongQuote = structuredClone(persistedRecord);
  wrongQuote.result.output.characters[0].evidence[0].quote = '被协调替换的错误引文';
  assert.throws(
    () => createNarrativeFactEvidenceTrace({
      record: wrongQuote,
      document: current.imported.document,
      selection: current.selection.selection,
      blocks: current.imported.blocks,
      factId: 'character-lin-che',
    }),
    NarrativeFactEvidenceTraceError,
  );
  const wrongOffset = structuredClone(persistedRecord);
  wrongOffset.result.output.characters[0].evidence[0].startOffset += 1;
  assert.throws(
    () => createNarrativeFactEvidenceTrace({
      record: wrongOffset,
      document: current.imported.document,
      selection: current.selection.selection,
      blocks: current.imported.blocks,
      factId: 'character-lin-che',
    }),
    NarrativeFactEvidenceTraceError,
  );
  assert.throws(
    () => createNarrativeFactEvidenceTrace({
      record: { ...persistedRecord, resultType: 'adaptation' },
      document: current.imported.document,
      selection: current.selection.selection,
      blocks: current.imported.blocks,
      factId: 'character-lin-che',
    }),
    NarrativeFactEvidenceTraceError,
  );
  assert.throws(
    () => createNarrativeFactEvidenceTrace({
      record: persistedRecord,
      document: { ...current.imported.document, uid: uid(189999) },
      selection: current.selection.selection,
      blocks: current.imported.blocks,
      factId: 'character-lin-che',
    }),
    NarrativeFactEvidenceTraceError,
  );

  const app = express();
  app.use('/api/v1/v2', narrativeReviewRoutes(
    current.database,
    Object.freeze({ error() {} }),
  ));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/v2`;
  const response = await fetch(
    `${base}/narrative-results/${completed.result.uid}/evidence/character-lin-che`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(validate(body.data), true, JSON.stringify(validate.errors));
  assert.deepEqual(body.data, trace);
  const missing = await fetch(
    `${base}/narrative-results/${completed.result.uid}/evidence/missing-fact`,
  );
  assert.equal(missing.status, 404);
  const invalidFact = await fetch(
    `${base}/narrative-results/${completed.result.uid}/evidence/INVALID`,
  );
  assert.equal(invalidFact.status, 400);
});
