'use strict';
const {createHash}=require('node:crypto');
const {createV2Repositories}=require('../../src/repositories/v2');
const {createNarrativeExecutionService}=require('../../src/narrative/execution');
const {createNarrativeReviewService}=require('../../src/narrative/reviews');
const {insertDrama,uid}=require('./v2RepositoryDatabase');
function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function seedApprovedCharacterSource(database) {
  const ids = Object.freeze({
    drama: uid(31000),
    character: uid(31001),
    document: uid(31002),
    block: uid(31003),
    selection: uid(31004),
    extractionOperation: uid(31005),
  });
  const text = '阿澜是一名二十岁的黑发剑客，身穿青色短袍。';
  const textHash = sha256(text);
  insertDrama(database, ids.drama, 'Character candidate execution fixture');
  const dramaId = database.prepare('SELECT id FROM dramas WHERE uid=?').pluck().get(ids.drama);
  database.prepare(`
    INSERT INTO characters
      (drama_id,name,description,personality,appearance,created_at,updated_at,uid)
    VALUES (?, '阿澜', '年轻剑客', '沉着坚定', '黑发，青色短袍',
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z', ?)
  `).run(dramaId, ids.character);
  database.transaction(() => {
    database.prepare(`
      INSERT INTO source_documents
        (uid,drama_uid,source_type,original_name,encoding,content_sha256,full_text,block_count)
      VALUES (?,?,'txt','character.txt','utf-8',?,?,1)
    `).run(ids.document, ids.drama, textHash, text);
    database.prepare(`
      INSERT INTO source_blocks
        (uid,document_uid,ordinal,heading_path_json,char_start,char_end,text,text_sha256)
      VALUES (?,?,0,'[]',0,?,?,?)
    `).run(ids.block, ids.document, Array.from(text).length, text, textHash);
    database.prepare(`
      INSERT INTO source_selections
        (uid,document_uid,start_block_uid,end_block_uid,start_offset,end_offset,selected_text_sha256)
      VALUES (?,?,?,?,0,?,?)
    `).run(ids.selection, ids.document, ids.block, ids.block, Array.from(text).length, textHash);
  })();
  const repositories = createV2Repositories(database);
  const rawResponse = JSON.stringify({
    schemaVersion: 'novel-extraction.v1',
    characters: [{
      factId: 'character-alan',
      name: '阿澜',
      description: '二十岁的黑发剑客，身穿青色短袍。',
      evidence: [{ blockUid: ids.block, startOffset: 0, endOffset: Array.from(text).length, quote: text }],
    }],
    scenes: [], props: [], relationships: [], events: [], dialogue: [],
  });
  const narrative = createNarrativeExecutionService({
    repositories,
    provider: Object.freeze({
      scope: 'configured-text',
      isAvailable: () => true,
      generate: () => ({
        model: { provider: 'synthetic', name: 'fixture-model' },
        parameters: { temperature: 0 },
        promptVersion: 'narrative-extraction.v1',
        rawResponse,
      }),
    }),
    assetOwnership: Object.freeze({ accepts() { return true; } }),
  });
  return narrative.execute({
    schemaVersion: 'narrative-execution-request.v1',
    operationUid: ids.extractionOperation,
    dramaUid: ids.drama,
    sourceSelectionUid: ids.selection,
    resultType: 'extraction',
    upstreamResultUid: null,
    upstreamResultHash: null,
    upstreamEnvelopeHash: null,
    upstreamApprovalRef: null,
    durationBudget: null,
    style: null,
    assetVersions: [],
  }).then(({ result }) => {
    createNarrativeReviewService({ repositories }).reviewResult({
      resultUid: result.uid,
      decision: 'approve',
      comment: 'synthetic approval',
    });
    return Object.freeze({ ids: { ...ids, extraction: result.uid }, repositories });
  });
}

function executionRequest(ids, operationUid = uid(31010)) {
  return {
    schemaVersion: 'character-candidate-execution-request.v1',
    operationUid,
    dramaUid: ids.drama,
    characterUid: ids.character,
    extractionResultUid: ids.extraction,
    characterFactId: 'character-alan',
    width: 256,
    height: 256,
    seed: 42,
  };
}


module.exports={seedApprovedCharacterSource,executionRequest};

