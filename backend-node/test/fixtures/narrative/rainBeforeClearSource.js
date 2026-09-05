'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

const {
  DURATION_BUDGET,
  STYLE,
  createRainAdaptationOutput,
  createRainExtractionOutput,
  createRainScriptOutput,
  createRainShotOutput,
} = require('../../../src/benchmark/rainBeforeClearNarrativePlan');
const { createNarrativeReviewService } = require('../../../src/narrative/reviews');
const { createSourceDocumentService } = require('../../../src/narrative/sourceDocuments');
const {
  createEpisodeAdaptationTask,
  createNovelExtractionTask,
  createScriptFormattingTask,
} = require('../../../src/narrative/tasks');
const { createV2Repositories } = require('../../../src/repositories/v2');
const {
  validateMvpBenchmarkSourcePack,
} = require('../../../../scripts/validate-mvp-benchmark-source');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('../../helpers/v2RepositoryDatabase');
const { completionMetadata } = require('./benchmarkFixture');

const PACK_ROOT = path.resolve(__dirname, '../../../../benchmarks/mvp-source');

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
  if (!start || !end) throw new Error('benchmark selection coordinates are invalid');
  return Object.freeze({
    startBlockUid: start.uid,
    endBlockUid: end.uid,
    startOffset: selection.startCodePoint - start.charStart,
    endOffset: selection.endCodePoint - end.charStart,
  });
}

function setupRainBeforeClearSource(t, start = 180000, existingDatabase = null) {
  const pack = validateMvpBenchmarkSourcePack(PACK_ROOT);
  const database = existingDatabase ?? createMigratedV2Database(t);
  const dramaUid = uid(start);
  insertDrama(database, dramaUid, '雨停之前同源叙事证据');
  const dramaId = database.prepare('SELECT id FROM dramas WHERE uid=?').get(dramaUid).id;
  const repositories = createV2Repositories(database);
  const sourceService = createSourceDocumentService({
    repositories,
    createUid: uidFactory(start + 10),
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

function persistApprovedRainNarrativeChain(current, start = 180500) {
  if (!current?.repositories || !current?.selection?.selection || !current?.imported?.document) {
    throw new TypeError('rain narrative fixture is invalid');
  }
  const reviews = createNarrativeReviewService({
    repositories: current.repositories,
    createUid: uidFactory(start),
  });
  const approve = (resultType, result, upstreamResultUid) => {
    const stored = reviews.recordResult({
      dramaUid: current.dramaUid,
      sourceSelectionUid: current.selection.selection.uid,
      resultType,
      ...(upstreamResultUid ? { upstreamResultUid } : {}),
      result,
    });
    return reviews.reviewResult({ resultUid: stored.uid, decision: 'approve' });
  };
  const startIndex = current.imported.blocks.findIndex((block) => (
    block.uid === current.selection.selection.startBlockUid
  ));
  const endIndex = current.imported.blocks.findIndex((block) => (
    block.uid === current.selection.selection.endBlockUid
  ));
  if (startIndex < 0 || endIndex < startIndex) {
    throw new TypeError('rain narrative source selection is invalid');
  }
  const source = Object.freeze({
    documentUid: current.imported.document.uid,
    blocks: Object.freeze(current.imported.blocks.slice(startIndex, endIndex + 1)
      .map((block) => Object.freeze({
        uid: block.uid,
        documentUid: block.documentUid,
        ordinal: block.ordinal,
        text: block.text,
        textSha256: block.textSha256,
      }))),
    selection: Object.freeze({
      uid: current.selection.selection.uid,
      documentUid: current.selection.selection.documentUid,
      startBlockUid: current.selection.selection.startBlockUid,
      endBlockUid: current.selection.selection.endBlockUid,
      startOffset: current.selection.selection.startOffset,
      endOffset: current.selection.selection.endOffset,
      selectedTextSha256: current.selection.selection.selectedTextSha256,
    }),
  });
  const extractionOutput = createRainExtractionOutput(current.imported.blocks);
  const extractionResult = createNovelExtractionTask().complete({
    source,
    ...completionMetadata('novel-extraction', start + 100, extractionOutput),
  });
  const extraction = approve('extraction', extractionResult);
  const adaptationOutput = createRainAdaptationOutput();
  const adaptationResult = createEpisodeAdaptationTask().complete({
    approvedExtraction: extractionResult.output,
    approval: extraction.approval,
    durationBudget: DURATION_BUDGET,
    style: STYLE,
    ...completionMetadata('episode-adaptation', start + 101, adaptationOutput),
  });
  const adaptation = approve('adaptation', adaptationResult, extraction.result.uid);
  const scriptOutput = createRainScriptOutput();
  const scriptResult = createScriptFormattingTask().complete({
    approvedExtraction: extractionResult.output,
    extractionApproval: extraction.approval,
    adaptationResult,
    adaptationApproval: adaptation.approval,
    ...completionMetadata('script-formatting', start + 102, scriptOutput),
  });
  const script = approve('script', scriptResult, adaptation.result.uid);
  return Object.freeze({ adaptation, extraction, script });
}

function insertRainMainCharacters(current, start = 180100) {
  if (!current?.database || !Number.isSafeInteger(current.dramaId)) {
    throw new TypeError('rain character fixture is invalid');
  }
  const characters = Object.freeze([
    Object.freeze({
      uid: uid(start), name: '林澈', description: '旧设备修复师，携带证物箱进入海城旧车站。',
      personality: '冷静、果断，对事故真相执着。',
      appearance: '二十多岁，黑色短发，深灰工作夹克，随身携带银色证物箱。',
      factId: 'character-lin-che',
    }),
    Object.freeze({
      uid: uid(start + 1), name: '夏弦', description: '调查员，在车站内协助林澈追查广播来源。',
      personality: '敏锐、克制，擅长现场判断。',
      appearance: '二十多岁，深棕长发束起，藏蓝调查员外套，佩戴便携照明灯。',
      factId: 'character-xia-xian',
    }),
  ]);
  const insert = current.database.prepare(`
    INSERT INTO characters
      (drama_id,name,description,personality,appearance,created_at,updated_at,uid)
    VALUES (@dramaId,@name,@description,@personality,@appearance,
      '2026-09-04T00:00:00.000Z','2026-09-04T00:00:00.000Z',@uid)
  `);
  current.database.transaction(() => {
    for (let index = 0; index < characters.length; index += 1) {
      insert.run({ dramaId: current.dramaId, ...characters[index] });
    }
  })();
  return characters;
}

module.exports = Object.freeze({
  DURATION_BUDGET,
  STYLE,
  createRainAdaptationOutput,
  createRainExtractionOutput,
  createRainScriptOutput,
  createRainShotOutput,
  insertRainMainCharacters,
  persistApprovedRainNarrativeChain,
  setupRainBeforeClearSource,
  sha256,
  uidFactory,
});
