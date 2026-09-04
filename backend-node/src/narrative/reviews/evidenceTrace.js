'use strict';

const {
  SourceEvidenceValidationError,
  assertSourceEvidenceAggregate,
} = require('../sourceDocuments/evidenceValidator');
const { codePointLength, sliceCodePoints } = require('../sourceDocuments/unicodeText');
const { assertFactReferences } = require('../tasks/novelExtractionTask');
const { assertEvidenceReferences, normalizeSource } = require('../tasks/sourceEvidence');
const { deepFreeze, sha256Canonical } = require('../tasks/jsonSnapshot');

const SCHEMA_VERSION = 'narrative-fact-evidence-trace.v1';
const FACT_GROUPS = Object.freeze([
  Object.freeze({ key: 'characters', type: 'character' }),
  Object.freeze({ key: 'scenes', type: 'scene' }),
  Object.freeze({ key: 'props', type: 'prop' }),
  Object.freeze({ key: 'relationships', type: 'relationship' }),
  Object.freeze({ key: 'events', type: 'event' }),
  Object.freeze({ key: 'dialogue', type: 'dialogue' }),
]);

class NarrativeFactEvidenceTraceError extends Error {
  constructor() {
    super('Narrative fact evidence trace is invalid');
    this.name = 'NarrativeFactEvidenceTraceError';
    Object.freeze(this);
  }
}

function invalid() {
  throw new NarrativeFactEvidenceTraceError();
}

function selectedBlocks(blocks, selection) {
  let startIndex = -1;
  let endIndex = -1;
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index].uid === selection.startBlockUid) startIndex = index;
    if (blocks[index].uid === selection.endBlockUid) endIndex = index;
  }
  if (startIndex < 0 || endIndex < startIndex) invalid();
  const output = new Array(endIndex - startIndex + 1);
  for (let index = startIndex; index <= endIndex; index += 1) {
    const block = blocks[index];
    output[index - startIndex] = Object.freeze({
      uid: block.uid,
      documentUid: block.documentUid,
      ordinal: block.ordinal,
      text: block.text,
      textSha256: block.textSha256,
    });
  }
  return Object.freeze(output);
}

function factLabel(type, fact) {
  if (type === 'character' || type === 'prop') return fact.name;
  if (type === 'scene') return `${fact.location} · ${fact.time}`;
  if (type === 'relationship') {
    return `${fact.fromCharacterFactId} → ${fact.toCharacterFactId}`;
  }
  if (type === 'event') return '事件';
  return fact.speakerCharacterFactId || '未指定说话人';
}

function factSummary(type, fact) {
  if (type === 'character' || type === 'scene' || type === 'prop') return fact.description;
  if (type === 'relationship') return fact.relationship;
  if (type === 'event') return fact.summary;
  return fact.content;
}

function findFact(output, factId) {
  let found = null;
  let foundType = null;
  const seen = new Set();
  for (let groupIndex = 0; groupIndex < FACT_GROUPS.length; groupIndex += 1) {
    const group = FACT_GROUPS[groupIndex];
    const facts = output[group.key];
    for (let index = 0; index < facts.length; index += 1) {
      const fact = facts[index];
      if (seen.has(fact.factId)) invalid();
      seen.add(fact.factId);
      if (fact.factId === factId) {
        found = fact;
        foundType = group.type;
      }
    }
  }
  return found ? Object.freeze({ fact: found, factType: foundType }) : null;
}

function createNarrativeFactEvidenceTrace({ record, document, selection, blocks, factId }) {
  try {
    if (!record || record.resultType !== 'extraction'
      || selection.uid !== record.sourceSelectionUid
      || selection.documentUid !== document.uid
      || document.dramaUid !== record.dramaUid) invalid();
    assertSourceEvidenceAggregate({ document, blocks, selections: [selection] });
    const selected = selectedBlocks(blocks, selection);
    const normalized = normalizeSource({
      documentUid: document.uid,
      blocks: selected,
      selection: {
        uid: selection.uid,
        documentUid: selection.documentUid,
        startBlockUid: selection.startBlockUid,
        endBlockUid: selection.endBlockUid,
        startOffset: selection.startOffset,
        endOffset: selection.endOffset,
        selectedTextSha256: selection.selectedTextSha256,
      },
    });
    const output = record.result.output;
    assertFactReferences(output);
    assertEvidenceReferences(normalized, output);
    const located = findFact(output, factId);
    if (!located) return null;

    const blockByUid = new Map();
    for (let index = 0; index < blocks.length; index += 1) {
      blockByUid.set(blocks[index].uid, blocks[index]);
    }
    const evidence = new Array(located.fact.evidence.length);
    for (let index = 0; index < located.fact.evidence.length; index += 1) {
      const reference = located.fact.evidence[index];
      const block = blockByUid.get(reference.blockUid);
      if (!block) invalid();
      const blockLength = codePointLength(block.text);
      const selectedStart = block.uid === selection.startBlockUid ? selection.startOffset : 0;
      const selectedEnd = block.uid === selection.endBlockUid ? selection.endOffset : blockLength;
      const beforeText = sliceCodePoints(block.text, selectedStart, reference.startOffset);
      const quote = sliceCodePoints(block.text, reference.startOffset, reference.endOffset);
      const afterText = sliceCodePoints(block.text, reference.endOffset, selectedEnd);
      const selectedBlockText = sliceCodePoints(block.text, selectedStart, selectedEnd);
      if (beforeText === null || quote !== reference.quote || afterText === null
        || selectedBlockText === null
        || `${beforeText}${quote}${afterText}` !== selectedBlockText) invalid();
      evidence[index] = Object.freeze({
        blockUid: block.uid,
        blockOrdinal: block.ordinal,
        headingPath: Object.freeze([...block.headingPath]),
        blockTextSha256: block.textSha256,
        blockText: block.text,
        selectedBlockStartOffset: selectedStart,
        selectedBlockEndOffset: selectedEnd,
        startOffset: reference.startOffset,
        endOffset: reference.endOffset,
        beforeText,
        quote,
        afterText,
        selectedBlockText,
      });
    }
    return deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      dramaUid: record.dramaUid,
      resultUid: record.uid,
      resultHash: record.resultHash,
      envelopeHash: record.envelopeHash,
      resultStatus: record.status,
      sourceDocumentUid: document.uid,
      sourceDocumentSha256: document.contentSha256,
      sourceSelectionUid: selection.uid,
      selectedTextSha256: selection.selectedTextSha256,
      factType: located.factType,
      factId: located.fact.factId,
      factLabel: factLabel(located.factType, located.fact),
      factSummary: factSummary(located.factType, located.fact),
      factSha256: sha256Canonical(located.fact),
      evidenceCount: evidence.length,
      evidence,
    });
  } catch (error) {
    if (error instanceof NarrativeFactEvidenceTraceError) throw error;
    if (error instanceof SourceEvidenceValidationError) return invalid();
    return invalid();
  }
}

module.exports = Object.freeze({
  NarrativeFactEvidenceTraceError,
  SCHEMA_VERSION,
  createNarrativeFactEvidenceTrace,
});
