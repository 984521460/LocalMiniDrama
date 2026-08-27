const { randomUUID } = require('node:crypto');

const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2');
const { narrativeStalenessError } = require('./errors');

const CANONICAL_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_EPOCH_MILLISECONDS = 253402300799999;
const REASON_BY_ROOT = Object.freeze({
  source_document: 'source_document_superseded',
  source_selection: 'source_selection_superseded',
  narrative_result: 'narrative_result_superseded',
});

function fail(code) {
  throw narrativeStalenessError(code);
}

function snapshotInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail('NARRATIVE_STALENESS_INPUT_INVALID');
  }
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
    prototype = Object.getPrototypeOf(input);
  } catch {
    return fail('NARRATIVE_STALENESS_INPUT_INVALID');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail('NARRATIVE_STALENESS_INPUT_INVALID');
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2
    || !descriptors.rootKind
    || !descriptors.rootUid
    || keys.some((key) => typeof key !== 'string'
      || !['rootKind', 'rootUid'].includes(key)
      || !Object.hasOwn(descriptors[key], 'value'))) {
    return fail('NARRATIVE_STALENESS_INPUT_INVALID');
  }
  return Object.freeze({
    rootKind: descriptors.rootKind.value,
    rootUid: descriptors.rootUid.value,
  });
}

function assertUid(value, code = 'NARRATIVE_STALENESS_INPUT_INVALID') {
  if (typeof value !== 'string' || !CANONICAL_UID.test(value)) fail(code);
}

function assertEpochMilliseconds(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EPOCH_MILLISECONDS) {
    fail('NARRATIVE_STALENESS_DATA_INVALID');
  }
}

function createNarrativeStalenessService({
  repositories,
  createUid = randomUUID,
  nowEpochMs = Date.now,
} = {}) {
  if (!repositories?.narrativeReviews
    || !repositories?.sources
    || typeof createUid !== 'function'
    || typeof nowEpochMs !== 'function') {
    throw new TypeError('Narrative staleness service dependencies are invalid');
  }
  const reviews = repositories.narrativeReviews;
  const sources = repositories.sources;

  function translate(action, notFoundCode = 'NARRATIVE_STALENESS_NOT_FOUND') {
    try {
      return action();
    } catch (error) {
      if (error instanceof V2RepositoryNotFoundError) fail(notFoundCode);
      if (error instanceof V2RepositoryConflictError) fail('NARRATIVE_STALENESS_CONFLICT');
      if (error instanceof V2RepositoryDataError) fail('NARRATIVE_STALENESS_DATA_INVALID');
      throw error;
    }
  }

  function assertRootExists(rootKind, rootUid) {
    if (rootKind === 'source_document') {
      translate(() => sources.getDocument(rootUid));
    } else if (rootKind === 'source_selection') {
      translate(() => sources.getSelection(rootUid));
    } else {
      translate(() => reviews.getResult(rootUid));
    }
  }

  function publicEvent(event) {
    if (!event
      || typeof event !== 'object'
      || !CANONICAL_UID.test(event.uid || '')
      || !CANONICAL_UID.test(event.operationUid || '')
      || !CANONICAL_UID.test(event.resultUid || '')
      || !CANONICAL_UID.test(event.rootUid || '')
      || !Object.hasOwn(REASON_BY_ROOT, event.rootKind)
      || ![
        'source_document_superseded',
        'source_selection_superseded',
        'narrative_result_superseded',
        'upstream_review_changed',
        'legacy_stale_state',
      ].includes(event.reasonCode)) {
      fail('NARRATIVE_STALENESS_DATA_INVALID');
    }
    const expectedReason = REASON_BY_ROOT[event.rootKind];
    if (event.reasonCode !== expectedReason
      && !(event.rootKind === 'narrative_result'
        && ['upstream_review_changed', 'legacy_stale_state'].includes(event.reasonCode))) {
      fail('NARRATIVE_STALENESS_DATA_INVALID');
    }
    assertEpochMilliseconds(event.staledAtEpochMs);
    return Object.freeze({
      uid: event.uid,
      operationUid: event.operationUid,
      resultUid: event.resultUid,
      rootKind: event.rootKind,
      rootUid: event.rootUid,
      reasonCode: event.reasonCode,
      staledAt: new Date(event.staledAtEpochMs).toISOString(),
    });
  }

  return Object.freeze({
    invalidate(input) {
      const snapshot = snapshotInput(input);
      if (!Object.hasOwn(REASON_BY_ROOT, snapshot.rootKind)) {
        fail('NARRATIVE_STALENESS_INPUT_INVALID');
      }
      assertUid(snapshot.rootUid);
      assertRootExists(snapshot.rootKind, snapshot.rootUid);
      const operationUid = createUid();
      assertUid(operationUid, 'NARRATIVE_STALENESS_DATA_INVALID');
      const staledAtEpochMs = nowEpochMs();
      assertEpochMilliseconds(staledAtEpochMs);
      const reasonCode = REASON_BY_ROOT[snapshot.rootKind];
      const written = translate(() => reviews.invalidate({
        operationUid,
        reasonCode,
        rootKind: snapshot.rootKind,
        rootUid: snapshot.rootUid,
        staledAtEpochMs,
      }));
      for (const resultUid of written.affectedResultUids) {
        assertUid(resultUid, 'NARRATIVE_STALENESS_DATA_INVALID');
      }
      const events = Object.freeze(written.events.map(publicEvent));
      return Object.freeze({
        operationUid,
        reasonCode,
        rootKind: snapshot.rootKind,
        rootUid: snapshot.rootUid,
        affectedResultUids: written.affectedResultUids,
        events,
      });
    },

    listEvents(resultUid) {
      assertUid(resultUid);
      translate(() => reviews.getResult(resultUid));
      const events = translate(() => reviews.listStaleEvents(resultUid));
      return Object.freeze(events.map(publicEvent));
    },
  });
}

module.exports = { createNarrativeStalenessService };
