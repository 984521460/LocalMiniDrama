'use strict';

const {
  SourceEvidenceValidationError,
  assertSourceEvidenceAggregate,
} = require('../sourceDocuments/evidenceValidator');
const {
  assertAdaptationSemantics,
  createEpisodeAdaptationInputHash,
  normalizeAdaptationDomain,
} = require('../tasks/episodeAdaptationTask');
const { assertFactReferences } = require('../tasks/novelExtractionTask');
const { assertEvidenceReferences, normalizeSource } = require('../tasks/sourceEvidence');
const { deepFreeze, sha256Canonical } = require('../tasks/jsonSnapshot');

const SCHEMA_VERSION = 'narrative-adaptation-comparison.v1';
const FACT_GROUPS = Object.freeze([
  Object.freeze({ key: 'characters', type: 'character' }),
  Object.freeze({ key: 'scenes', type: 'scene' }),
  Object.freeze({ key: 'props', type: 'prop' }),
  Object.freeze({ key: 'relationships', type: 'relationship' }),
  Object.freeze({ key: 'events', type: 'event' }),
  Object.freeze({ key: 'dialogue', type: 'dialogue' }),
]);

class NarrativeAdaptationComparisonError extends Error {
  constructor() {
    super('Narrative adaptation comparison is invalid');
    this.name = 'NarrativeAdaptationComparisonError';
    Object.freeze(this);
  }
}

function invalid() {
  throw new NarrativeAdaptationComparisonError();
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
  if (type === 'event') return '原著事件';
  return fact.speakerCharacterFactId || '原著对白';
}

function factSummary(type, fact) {
  if (type === 'character' || type === 'scene' || type === 'prop') return fact.description;
  if (type === 'relationship') return fact.relationship;
  if (type === 'event') return fact.summary;
  return fact.content;
}

function referencedFactIds(output) {
  const used = new Set();
  for (let index = 0; index < output.beats.length; index += 1) {
    const beat = output.beats[index];
    for (let factIndex = 0; factIndex < beat.factRefs.length; factIndex += 1) {
      used.add(beat.factRefs[factIndex]);
    }
  }
  for (let index = 0; index < output.adaptationDecisions.length; index += 1) {
    const decision = output.adaptationDecisions[index];
    if (decision.factRefs.length === 0) invalid();
    for (let factIndex = 0; factIndex < decision.factRefs.length; factIndex += 1) {
      used.add(decision.factRefs[factIndex]);
    }
  }
  return used;
}

function sourceFacts(extraction, used) {
  const facts = [];
  const found = new Set();
  for (let groupIndex = 0; groupIndex < FACT_GROUPS.length; groupIndex += 1) {
    const group = FACT_GROUPS[groupIndex];
    const values = extraction[group.key];
    for (let index = 0; index < values.length; index += 1) {
      const fact = values[index];
      if (!used.has(fact.factId)) continue;
      found.add(fact.factId);
      facts.push(Object.freeze({
        classification: 'source_fact',
        factType: group.type,
        factId: fact.factId,
        factLabel: factLabel(group.type, fact),
        factSummary: factSummary(group.type, fact),
        factSha256: sha256Canonical(fact),
      }));
    }
  }
  if (found.size !== used.size) invalid();
  return Object.freeze(facts);
}

function beats(output) {
  const values = new Array(output.beats.length);
  for (let index = 0; index < output.beats.length; index += 1) {
    const beat = output.beats[index];
    values[index] = Object.freeze({
      beatId: beat.beatId,
      kind: beat.kind,
      summary: beat.summary,
      classification: beat.classification,
      inferenceRationale: beat.inferenceRationale,
      estimatedDurationSeconds: beat.estimatedDurationSeconds,
      factRefs: Object.freeze([...beat.factRefs]),
      adaptationDecisionRefs: Object.freeze([...beat.adaptationDecisionRefs]),
    });
  }
  return Object.freeze(values);
}

function decisions(output) {
  const values = new Array(output.adaptationDecisions.length);
  for (let index = 0; index < output.adaptationDecisions.length; index += 1) {
    const decision = output.adaptationDecisions[index];
    values[index] = Object.freeze({
      decisionId: decision.decisionId,
      classification: decision.classification,
      category: decision.category,
      summary: decision.summary,
      rationale: decision.rationale,
      factRefs: Object.freeze([...decision.factRefs]),
    });
  }
  return Object.freeze(values);
}

function createNarrativeAdaptationComparison({
  adaptationRecord,
  extractionRecord,
  extractionApproval,
  document,
  selection,
  blocks,
}) {
  try {
    if (!adaptationRecord || adaptationRecord.resultType !== 'adaptation'
      || !extractionRecord || extractionRecord.resultType !== 'extraction'
      || extractionRecord.status !== 'approved'
      || adaptationRecord.upstreamResultUid !== extractionRecord.uid
      || adaptationRecord.dramaUid !== extractionRecord.dramaUid
      || adaptationRecord.sourceSelectionUid !== extractionRecord.sourceSelectionUid
      || selection.uid !== adaptationRecord.sourceSelectionUid
      || selection.documentUid !== document.uid
      || document.dramaUid !== adaptationRecord.dramaUid
      || adaptationRecord.result.upstreamResultHash !== extractionRecord.resultHash
      || adaptationRecord.result.approvalRef !== extractionApproval.reviewRef
      || extractionApproval.status !== 'approved'
      || extractionApproval.resultHash !== extractionRecord.resultHash) invalid();

    assertSourceEvidenceAggregate({ document, blocks, selections: [selection] });
    const selected = selectedBlocks(blocks, selection);
    const normalizedSource = normalizeSource({
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
    const extraction = extractionRecord.result.output;
    assertFactReferences(extraction);
    assertEvidenceReferences(normalizedSource, extraction);

    const domain = normalizeAdaptationDomain({
      approvedExtraction: extraction,
      approval: extractionApproval,
      durationBudget: adaptationRecord.result.durationBudget,
      style: adaptationRecord.result.style,
    });
    const output = adaptationRecord.result.output;
    assertAdaptationSemantics(domain, output);
    if (adaptationRecord.result.inputHash !== createEpisodeAdaptationInputHash(domain)) invalid();
    const used = referencedFactIds(output);

    return deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      dramaUid: adaptationRecord.dramaUid,
      sourceResultUid: extractionRecord.uid,
      sourceResultHash: extractionRecord.resultHash,
      sourceEnvelopeHash: extractionRecord.envelopeHash,
      sourceApprovalRef: extractionApproval.reviewRef,
      adaptationResultUid: adaptationRecord.uid,
      adaptationResultHash: adaptationRecord.resultHash,
      adaptationEnvelopeHash: adaptationRecord.envelopeHash,
      adaptationStatus: adaptationRecord.status,
      sourceDocumentUid: document.uid,
      sourceDocumentSha256: document.contentSha256,
      sourceSelectionUid: selection.uid,
      selectedTextSha256: selection.selectedTextSha256,
      durationSummary: output.durationSummary,
      sourceFacts: sourceFacts(extraction, used),
      beats: beats(output),
      adaptationDecisions: decisions(output),
    });
  } catch (error) {
    if (error instanceof NarrativeAdaptationComparisonError) throw error;
    if (error instanceof SourceEvidenceValidationError) return invalid();
    return invalid();
  }
}

module.exports = Object.freeze({
  NarrativeAdaptationComparisonError,
  SCHEMA_VERSION,
  createNarrativeAdaptationComparison,
});
