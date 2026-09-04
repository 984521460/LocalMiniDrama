'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

const { createSourceDocumentService } = require('../../../src/narrative/sourceDocuments');
const { createV2Repositories } = require('../../../src/repositories/v2');
const {
  validateMvpBenchmarkSourcePack,
} = require('../../../../scripts/validate-mvp-benchmark-source');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('../../helpers/v2RepositoryDatabase');

const PACK_ROOT = path.resolve(__dirname, '../../../../benchmarks/mvp-source');
const DURATION_BUDGET = Object.freeze({ targetSeconds: 60, toleranceSeconds: 5 });
const STYLE = Object.freeze({ genre: '悬疑', tone: '紧张', audience: '全年龄' });

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

function evidence(blocks, quote) {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const unitStart = block.text.indexOf(quote);
    if (unitStart < 0) continue;
    if (block.text.lastIndexOf(quote) !== unitStart) {
      throw new Error('benchmark evidence quote is ambiguous');
    }
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

function createRainExtractionOutput(blocks) {
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

function createRainAdaptationOutput() {
  return Object.freeze({
    schemaVersion: 'episode-adaptation.v1',
    durationSummary: Object.freeze({ ...DURATION_BUDGET, totalSeconds: 60 }),
    beats: Object.freeze([
      Object.freeze({
        beatId: 'beat-power-restored', kind: 'hook', summary: '林澈接通备用电源，车站重新亮起。',
        classification: 'fact', inferenceRationale: null, estimatedDurationSeconds: 8,
        factRefs: ['event-restore-power'], adaptationDecisionRefs: [],
      }),
      Object.freeze({
        beatId: 'beat-broadcast-threat', kind: 'setup', summary: '广播操作者可能仍藏在车站内。',
        classification: 'inference', inferenceRationale: '由旧线路广播与夏弦的判断推断威胁仍在现场。',
        estimatedDurationSeconds: 12,
        factRefs: ['relationship-investigation-partners'], adaptationDecisionRefs: [],
      }),
      Object.freeze({
        beatId: 'beat-chip-chase', kind: 'escalation', summary: '新增追踪者抢夺存储芯片。',
        classification: 'adaptation', inferenceRationale: null, estimatedDurationSeconds: 14,
        factRefs: ['dialogue-real-target', 'prop-evidence-case'],
        adaptationDecisionRefs: ['decision-add-chip-chase'],
      }),
      Object.freeze({
        beatId: 'beat-platform-confrontation', kind: 'climax', summary: '林澈与夏弦在站台阻止追踪者。',
        classification: 'adaptation', inferenceRationale: null, estimatedDurationSeconds: 16,
        factRefs: ['character-lin-che', 'character-xia-xian'],
        adaptationDecisionRefs: ['decision-add-chip-chase'],
      }),
      Object.freeze({
        beatId: 'beat-chip-reveal', kind: 'cliffhanger', summary: '芯片中出现第二段未公开事故记录。',
        classification: 'adaptation', inferenceRationale: null, estimatedDurationSeconds: 10,
        factRefs: ['dialogue-real-target'],
        adaptationDecisionRefs: ['decision-add-chip-chase'],
      }),
    ]),
    adaptationDecisions: Object.freeze([Object.freeze({
      decisionId: 'decision-add-chip-chase',
      classification: 'adaptation',
      category: 'invented-event',
      summary: '新增追踪者抢夺芯片及站台对峙。',
      rationale: '把原文目标信息转成一分钟单集的升级、高潮与悬念。',
      factRefs: ['dialogue-real-target', 'prop-evidence-case', 'character-lin-che', 'character-xia-xian'],
    })]),
  });
}

function setupRainBeforeClearSource(t, start = 180000) {
  const pack = validateMvpBenchmarkSourcePack(PACK_ROOT);
  const database = createMigratedV2Database(t);
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

module.exports = Object.freeze({
  DURATION_BUDGET,
  STYLE,
  createRainAdaptationOutput,
  createRainExtractionOutput,
  setupRainBeforeClearSource,
  sha256,
  uidFactory,
});
