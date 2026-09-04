const { randomUUID } = require('node:crypto');

const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2/errors');
const {
  normalizeNarrativeResult,
  resultContract,
  resultHashes,
} = require('./contracts');
const {
  NarrativeFactEvidenceTraceError,
  createNarrativeFactEvidenceTrace,
} = require('./evidenceTrace');
const { narrativeReviewError } = require('./errors');

const CANONICAL_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVIEW_REF = /^review:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FACT_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const TYPE_PREDECESSOR = Object.freeze({
  adaptation: 'extraction',
  script: 'adaptation',
  shot: 'script',
});

function invalidInput() {
  throw narrativeReviewError('NARRATIVE_REVIEW_INPUT_INVALID');
}

function snapshotObject(input, allowedKeys, requiredKeys = allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalidInput();
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
    prototype = Object.getPrototypeOf(input);
  } catch {
    return invalidInput();
  }
  if (prototype !== Object.prototype && prototype !== null) invalidInput();
  const allowed = new Set(allowedKeys);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string'
    || !allowed.has(key)
    || !Object.hasOwn(descriptors[key], 'value'))
    || requiredKeys.some((key) => !descriptors[key])) invalidInput();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function assertUid(value) {
  if (typeof value !== 'string' || !CANONICAL_UID.test(value)) invalidInput();
}

function normalizeComment(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > 4000
    || /[\u0000\u007f]/u.test(value)) invalidInput();
  return value;
}

function createNarrativeReviewService({ repositories, createUid = randomUUID } = {}) {
  if (!repositories?.narrativeReviews || !repositories?.sources || typeof createUid !== 'function') {
    throw new TypeError('Narrative review service dependencies are invalid');
  }
  const reviews = repositories.narrativeReviews;
  const sources = repositories.sources;

  function translateRepository(action, notFoundCode = 'NARRATIVE_REVIEW_NOT_FOUND') {
    try {
      return action();
    } catch (error) {
      if (error instanceof V2RepositoryNotFoundError) throw narrativeReviewError(notFoundCode);
      if (error instanceof V2RepositoryConflictError) throw narrativeReviewError('NARRATIVE_REVIEW_CONFLICT');
      if (error instanceof V2RepositoryDataError) throw narrativeReviewError('NARRATIVE_REVIEW_DATA_INVALID');
      if (error?.message === 'NARRATIVE_REVIEW_STATE_CONFLICT') {
        throw narrativeReviewError('NARRATIVE_REVIEW_CONFLICT');
      }
      throw error;
    }
  }

  function assertPersistedResult(record) {
    let normalized;
    try {
      normalized = normalizeNarrativeResult(record.resultType, record.result);
    } catch {
      throw narrativeReviewError('NARRATIVE_REVIEW_DATA_INVALID');
    }
    const contract = resultContract(record.resultType);
    const hashes = resultHashes(normalized);
    if (record.taskType !== contract.taskType
      || record.schemaVersion !== contract.schemaVersion
      || record.inputHash !== normalized.inputHash
      || record.resultHash !== hashes.resultHash
      || record.envelopeHash !== hashes.envelopeHash
      || !CANONICAL_UID.test(record.uid)
      || !CANONICAL_UID.test(record.dramaUid)
      || !CANONICAL_UID.test(record.sourceSelectionUid)
      || !['pending_review', 'approved', 'rejected', 'stale'].includes(record.status)) {
      throw narrativeReviewError('NARRATIVE_REVIEW_DATA_INVALID');
    }
    return record;
  }

  function boundReview(record, decision) {
    if (!CANONICAL_UID.test(record.currentReviewUid || '')) {
      throw narrativeReviewError('NARRATIVE_REVIEW_DATA_INVALID');
    }
    const review = translateRepository(
      () => reviews.getReview(record.currentReviewUid),
      'NARRATIVE_REVIEW_DATA_INVALID',
    );
    if (review.resultUid !== record.uid
      || review.decision !== decision
      || review.resultHash !== record.resultHash
      || review.envelopeHash !== record.envelopeHash) {
      throw narrativeReviewError('NARRATIVE_REVIEW_DATA_INVALID');
    }
    return review;
  }

  function assertReviewState(record) {
    if (record.status === 'pending_review' || record.status === 'stale') {
      if (record.currentReviewUid !== null) {
        throw narrativeReviewError('NARRATIVE_REVIEW_DATA_INVALID');
      }
      return record;
    }
    boundReview(record, record.status === 'approved' ? 'approve' : 'reject');
    return record;
  }

  function getRecord(uid) {
    assertUid(uid);
    return assertReviewState(assertPersistedResult(translateRepository(() => reviews.getResult(uid))));
  }

  function approvalFor(record) {
    if (record.status === 'stale') throw narrativeReviewError('NARRATIVE_REVIEW_STALE');
    if (record.status !== 'approved') throw narrativeReviewError('NARRATIVE_REVIEW_NOT_APPROVED');
    const review = boundReview(record, 'approve');
    return Object.freeze({
      status: 'approved',
      resultHash: record.resultHash,
      ...(record.resultType === 'shot' ? { envelopeHash: record.envelopeHash } : {}),
      reviewRef: `review:v1:${review.uid}`,
    });
  }

  function assertStoredAuditBinding(record, upstream) {
    if (record.resultType === 'extraction') return;
    const result = record.result;
    if (!upstream) throw narrativeReviewError('NARRATIVE_REVIEW_DATA_INVALID');
    if (record.resultType === 'adaptation') {
      if (result.upstreamResultHash !== upstream.record.resultHash
        || result.approvalRef !== upstream.approval.reviewRef) {
        throw narrativeReviewError('NARRATIVE_REVIEW_NOT_APPROVED');
      }
      return;
    }
    if (record.resultType === 'script') {
      const extraction = upstream.upstream;
      if (!extraction
        || result.upstreamExtractionHash !== extraction.record.resultHash
        || result.upstreamAdaptationHash !== upstream.record.resultHash
        || result.extractionApprovalRef !== extraction.approval.reviewRef
        || result.adaptationApprovalRef !== upstream.approval.reviewRef) {
        throw narrativeReviewError('NARRATIVE_REVIEW_NOT_APPROVED');
      }
      return;
    }
    if (result.upstreamScriptHash !== upstream.record.resultHash
      || result.scriptApprovalRef !== upstream.approval.reviewRef) {
      throw narrativeReviewError('NARRATIVE_REVIEW_NOT_APPROVED');
    }
  }

  function approvedChain(uid, expectedType, seen = new Set()) {
    if (seen.has(uid) || seen.size >= 4) throw narrativeReviewError('NARRATIVE_REVIEW_DATA_INVALID');
    seen.add(uid);
    const record = getRecord(uid);
    if (expectedType && record.resultType !== expectedType) {
      throw narrativeReviewError('NARRATIVE_REVIEW_NOT_APPROVED');
    }
    const approval = approvalFor(record);
    let upstream = null;
    if (record.resultType !== 'extraction') {
      if (!record.upstreamResultUid) throw narrativeReviewError('NARRATIVE_REVIEW_DATA_INVALID');
      upstream = approvedChain(record.upstreamResultUid, TYPE_PREDECESSOR[record.resultType], seen);
      assertStoredAuditBinding(record, upstream);
    }
    return Object.freeze({ record, approval, upstream });
  }

  function assertCurrentApprovalChain(record) {
    if (record.status === 'approved') approvedChain(record.uid, record.resultType);
    return record;
  }

  function assertApprovableAuditBinding(record) {
    if (record.resultType === 'extraction') return;
    if (!record.upstreamResultUid) throw narrativeReviewError('NARRATIVE_REVIEW_DATA_INVALID');
    const upstream = approvedChain(
      record.upstreamResultUid,
      TYPE_PREDECESSOR[record.resultType],
    );
    assertStoredAuditBinding(record, upstream);
  }

  function assertAuditBinding(resultType, result, upstream) {
    if (resultType === 'extraction') return;
    const direct = approvedChain(upstream.uid, TYPE_PREDECESSOR[resultType]);
    if (resultType === 'adaptation') {
      if (result.upstreamResultHash !== direct.record.resultHash
        || result.approvalRef !== direct.approval.reviewRef) invalidInput();
      return;
    }
    if (resultType === 'script') {
      const extraction = approvedChain(direct.record.upstreamResultUid, 'extraction');
      if (result.upstreamExtractionHash !== extraction.record.resultHash
        || result.upstreamAdaptationHash !== direct.record.resultHash
        || result.extractionApprovalRef !== extraction.approval.reviewRef
        || result.adaptationApprovalRef !== direct.approval.reviewRef) invalidInput();
      return;
    }
    if (result.upstreamScriptHash !== direct.record.resultHash
      || result.scriptApprovalRef !== direct.approval.reviewRef
      || !SHA256.test(result.assetCatalogHash)) invalidInput();
  }

  function detailFor(record) {
    const history = translateRepository(() => reviews.listReviews(record.uid));
    let approval = null;
    if (record.status === 'approved') {
      approval = approvedChain(record.uid, record.resultType).approval;
    }
    return Object.freeze({ result: record, reviews: history, approval });
  }

  return Object.freeze({
    recordResult(input) {
      const snapshot = snapshotObject(
        input,
        ['dramaUid', 'sourceSelectionUid', 'resultType', 'upstreamResultUid', 'result'],
        ['dramaUid', 'sourceSelectionUid', 'resultType', 'result'],
      );
      assertUid(snapshot.dramaUid);
      assertUid(snapshot.sourceSelectionUid);
      const contract = resultContract(snapshot.resultType);
      const result = normalizeNarrativeResult(snapshot.resultType, snapshot.result);
      let selection;
      try {
        selection = sources.getSelection(snapshot.sourceSelectionUid);
        const document = sources.getDocument(selection.documentUid);
        if (document.dramaUid !== snapshot.dramaUid) invalidInput();
      } catch (error) {
        if (error instanceof V2RepositoryNotFoundError) invalidInput();
        throw error;
      }
      if (snapshot.resultType === 'extraction') {
        if (snapshot.upstreamResultUid !== undefined) invalidInput();
      } else {
        assertUid(snapshot.upstreamResultUid);
        const upstream = getRecord(snapshot.upstreamResultUid);
        if (upstream.dramaUid !== snapshot.dramaUid
          || upstream.sourceSelectionUid !== snapshot.sourceSelectionUid) invalidInput();
        assertAuditBinding(snapshot.resultType, result, upstream);
      }
      const hashes = resultHashes(result);
      const uid = createUid();
      assertUid(uid);
      return translateRepository(() => reviews.createResult({
        uid,
        dramaUid: snapshot.dramaUid,
        sourceSelectionUid: snapshot.sourceSelectionUid,
        resultType: snapshot.resultType,
        taskType: contract.taskType,
        schemaVersion: contract.schemaVersion,
        inputHash: result.inputHash,
        ...hashes,
        result,
        upstreamResultUid: snapshot.upstreamResultUid,
      }));
    },

    reviewResult(input) {
      const snapshot = snapshotObject(
        input,
        ['resultUid', 'decision', 'comment'],
        ['resultUid', 'decision'],
      );
      assertUid(snapshot.resultUid);
      if (snapshot.decision !== 'approve' && snapshot.decision !== 'reject') invalidInput();
      const record = getRecord(snapshot.resultUid);
      if (record.status === 'stale') throw narrativeReviewError('NARRATIVE_REVIEW_STALE');
      if (snapshot.decision === 'approve') assertApprovableAuditBinding(record);
      const reviewUid = createUid();
      assertUid(reviewUid);
      const written = translateRepository(() => reviews.createReview({
        uid: reviewUid,
        resultUid: record.uid,
        decision: snapshot.decision,
        resultHash: record.resultHash,
        envelopeHash: record.envelopeHash,
        comment: normalizeComment(snapshot.comment),
      }));
      const reviewedRecord = assertPersistedResult(written.result);
      return Object.freeze({
        result: reviewedRecord,
        review: written.review,
        approval: snapshot.decision === 'approve' ? approvalFor(reviewedRecord) : null,
      });
    },

    getResult(uid) {
      return detailFor(getRecord(uid));
    },

    getFactEvidence(uid, factId) {
      assertUid(uid);
      if (typeof factId !== 'string' || !FACT_ID.test(factId)) invalidInput();
      const record = getRecord(uid);
      if (record.resultType !== 'extraction') {
        throw narrativeReviewError('NARRATIVE_REVIEW_NOT_FOUND');
      }
      try {
        const selection = sources.getSelection(record.sourceSelectionUid);
        const document = sources.getDocument(selection.documentUid);
        const blocks = sources.listBlocks(document.uid);
        const trace = createNarrativeFactEvidenceTrace({
          record, document, selection, blocks, factId,
        });
        if (!trace) throw narrativeReviewError('NARRATIVE_REVIEW_NOT_FOUND');
        return trace;
      } catch (error) {
        if (error?.code === 'NARRATIVE_REVIEW_NOT_FOUND') throw error;
        if (error instanceof NarrativeFactEvidenceTraceError
          || error instanceof V2RepositoryNotFoundError
          || error instanceof V2RepositoryDataError) {
          throw narrativeReviewError('NARRATIVE_REVIEW_DATA_INVALID');
        }
        throw error;
      }
    },

    listForDrama(dramaId) {
      if (!Number.isSafeInteger(dramaId) || dramaId < 1) invalidInput();
      const drama = sources.findDramaByLegacyId(dramaId);
      if (!drama) throw narrativeReviewError('NARRATIVE_REVIEW_NOT_FOUND');
      return Object.freeze(translateRepository(() => reviews.listByDrama(drama.uid))
        .map((record) => assertCurrentApprovalChain(
          assertReviewState(assertPersistedResult(record)),
        )));
    },

    listForSelection(selectionUid) {
      assertUid(selectionUid);
      return Object.freeze(translateRepository(() => reviews.listBySelection(selectionUid))
        .map((record) => assertCurrentApprovalChain(
          assertReviewState(assertPersistedResult(record)),
        )));
    },

    requireApproved(uid, expectedType) {
      if (expectedType !== undefined && !Object.hasOwn(TYPE_PREDECESSOR, expectedType)
        && expectedType !== 'extraction') invalidInput();
      const approved = approvedChain(uid, expectedType);
      if (!REVIEW_REF.test(approved.approval.reviewRef)) {
        throw narrativeReviewError('NARRATIVE_REVIEW_DATA_INVALID');
      }
      return Object.freeze({ result: approved.record.result, approval: approved.approval });
    },
  });
}

module.exports = { createNarrativeReviewService };
