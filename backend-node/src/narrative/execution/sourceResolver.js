'use strict';

const { normalizeSource } = require('../tasks/sourceEvidence');

class NarrativeExecutionSourceError extends TypeError {
  constructor() {
    super('Narrative execution source is invalid');
    this.name = 'NarrativeExecutionSourceError';
    Object.freeze(this);
  }
}

function invalid() {
  throw new NarrativeExecutionSourceError();
}

function createNarrativeExecutionSourceResolver({
  repositories,
  reviewService,
  assetOwnership,
} = {}) {
  if (!repositories?.sources || !repositories?.narrativeReviews
    || !repositories?.assets || typeof reviewService?.requireApproved !== 'function'
    || typeof assetOwnership?.accepts !== 'function') {
    throw new TypeError('Narrative execution source resolver dependencies are invalid');
  }

  function approved(uid, type, request) {
    const current = reviewService.requireApproved(uid, type);
    const record = repositories.narrativeReviews.getResult(uid);
    if (record.uid !== uid || record.dramaUid !== request.dramaUid
      || record.sourceSelectionUid !== request.sourceSelectionUid
      || record.resultType !== type || record.status !== 'approved'
      || record.resultHash !== current.approval.resultHash
      || `review:v1:${record.currentReviewUid}` !== current.approval.reviewRef) invalid();
    return Object.freeze({
      approval: current.approval,
      record,
      result: current.result,
    });
  }

  function source(request) {
    const selection = repositories.sources.getSelection(request.sourceSelectionUid);
    const document = repositories.sources.getDocument(selection.documentUid);
    if (document.dramaUid !== request.dramaUid) invalid();
    const blocks = repositories.sources.listBlocks(document.uid);
    let startIndex = -1;
    let endIndex = -1;
    for (let index = 0; index < blocks.length; index += 1) {
      if (blocks[index].uid === selection.startBlockUid) startIndex = index;
      if (blocks[index].uid === selection.endBlockUid) endIndex = index;
    }
    if (startIndex < 0 || endIndex < startIndex) invalid();
    const selected = [];
    for (let index = startIndex; index <= endIndex; index += 1) {
      const block = blocks[index];
      if (index > startIndex && block.ordinal !== blocks[index - 1].ordinal + 1) invalid();
      selected.push(Object.freeze({
        uid: block.uid,
        documentUid: block.documentUid,
        ordinal: block.ordinal,
        text: block.text,
        textSha256: block.textSha256,
      }));
    }
    try {
      return normalizeSource({
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
      }).source;
    } catch {
      return invalid();
    }
  }

  function assets(request) {
    const output = [];
    for (let index = 0; index < request.assetVersions.length; index += 1) {
      const binding = request.assetVersions[index];
      const versionUid = binding.assetVersionRef.slice('asset-version:v1:'.length);
      const version = repositories.assets.getVersion(versionUid);
      const asset = repositories.assets.get(version.assetUid);
      if (version.uid !== versionUid || version.status !== 'ready'
        || asset.status !== 'ready' || asset.ownerType !== binding.assetType
        || !assetOwnership.accepts(asset, request.dramaUid, 'image')) invalid();
      output.push(binding);
    }
    return Object.freeze(output);
  }

  return Object.freeze({
    resolve(request) {
      const trustedSource = source(request);
      if (request.resultType === 'extraction') {
        return Object.freeze({ source: trustedSource, domain: null });
      }
      const directType = request.resultType === 'adaptation'
        ? 'extraction' : request.resultType === 'script' ? 'adaptation' : 'script';
      const direct = approved(request.upstreamResultUid, directType, request);
      if (direct.record.resultHash !== request.upstreamResultHash
        || direct.record.envelopeHash !== request.upstreamEnvelopeHash
        || direct.approval.reviewRef !== request.upstreamApprovalRef) invalid();

      if (request.resultType === 'adaptation') {
        return Object.freeze({
          source: trustedSource,
          domain: Object.freeze({
            approvedExtraction: direct.result.output,
            approval: direct.approval,
            durationBudget: request.durationBudget,
            style: request.style,
          }),
        });
      }
      const extraction = request.resultType === 'script'
        ? approved(direct.record.upstreamResultUid, 'extraction', request)
        : null;
      const adaptation = request.resultType === 'script'
        ? direct
        : approved(direct.record.upstreamResultUid, 'adaptation', request);
      const rootExtraction = extraction
        || approved(adaptation.record.upstreamResultUid, 'extraction', request);
      if (request.resultType === 'script') {
        return Object.freeze({
          source: trustedSource,
          domain: Object.freeze({
            approvedExtraction: rootExtraction.result.output,
            extractionApproval: rootExtraction.approval,
            adaptationResult: adaptation.result,
            adaptationApproval: adaptation.approval,
          }),
        });
      }
      return Object.freeze({
        source: trustedSource,
        domain: Object.freeze({
          approvedExtraction: rootExtraction.result.output,
          extractionApproval: rootExtraction.approval,
          adaptationResult: adaptation.result,
          adaptationApproval: adaptation.approval,
          scriptResult: direct.result,
          scriptApproval: direct.approval,
          assetVersions: assets(request),
        }),
      });
    },
  });
}

module.exports = Object.freeze({
  NarrativeExecutionSourceError,
  createNarrativeExecutionSourceResolver,
});
