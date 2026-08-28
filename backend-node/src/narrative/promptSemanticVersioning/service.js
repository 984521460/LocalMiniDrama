const {
  createNarrativeReviewService,
  isNarrativeReviewError,
} = require('../reviews');
const { types: { isProxy } } = require('node:util');
const { narrativeTaskError } = require('../tasks/errors');
const { exactObjectValues } = require('../tasks/structuredTask');
const { createVersionedPromptSemanticTask } = require('../tasks/versionedPromptSemanticTask');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2/errors');

const CANONICAL_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INTERNAL_RESULTS = new WeakSet();

function isPromptSemanticVersioningResult(value) {
  return value !== null && typeof value === 'object' && INTERNAL_RESULTS.has(value);
}

function invalidInput() {
  throw narrativeTaskError('NARRATIVE_TASK_INPUT_INVALID');
}

function invalidReference() {
  throw narrativeTaskError('NARRATIVE_TASK_REFERENCE_INVALID');
}

function snapshotUids(value) {
  let descriptors;
  try {
    if (!Array.isArray(value) || isProxy(value)) invalidInput();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error?.code === 'NARRATIVE_TASK_INPUT_INVALID') throw error;
    return invalidInput();
  }
  const length = descriptors.length?.value;
  const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
  if (!Number.isSafeInteger(length)
    || length < 4
    || length > 6
    || keys.length !== length) invalidInput();
  return Object.freeze(Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string'
      || !CANONICAL_UID.test(descriptor.value)) invalidInput();
    return descriptor.value;
  }));
}

function createPromptSemanticVersioningService({ repositories } = {}) {
  if (!repositories?.shotContinuitySnapshots
    || !repositories?.narrativeReviews
    || !repositories?.sources) {
    throw new TypeError('Prompt Semantic versioning service dependencies are invalid');
  }
  const reviews = createNarrativeReviewService({ repositories });
  const task = createVersionedPromptSemanticTask();

  return Object.freeze({
    complete(input) {
      const values = exactObjectValues(input, ['promptInput', 'continuitySnapshotUids']);
      const uids = snapshotUids(values.continuitySnapshotUids);
      try {
        const snapshots = Object.freeze(
          uids.map((snapshotUid) => repositories.shotContinuitySnapshots.get(snapshotUid)),
        );
        const first = snapshots[0];
        const approved = reviews.requireApproved(first.shotResultUid, 'shot');
        if (approved.approval.resultHash !== first.shotResultHash
          || approved.approval.envelopeHash !== first.shotEnvelopeHash
          || approved.approval.reviewRef !== first.shotApprovalRef) invalidReference();
        const result = task.complete({
          promptInput: values.promptInput,
          continuitySnapshots: snapshots,
        });
        INTERNAL_RESULTS.add(result);
        return result;
      } catch (error) {
        if (error?.code === 'NARRATIVE_TASK_INPUT_INVALID'
          || error?.code === 'NARRATIVE_TASK_RESPONSE_INVALID'
          || error?.code === 'NARRATIVE_TASK_REFERENCE_INVALID') throw error;
        if (isNarrativeReviewError(error)
          || error instanceof V2RepositoryConflictError
          || error instanceof V2RepositoryDataError
          || error instanceof V2RepositoryNotFoundError) invalidReference();
        throw error;
      }
    },
  });
}

module.exports = {
  createPromptSemanticVersioningService,
  isPromptSemanticVersioningResult,
};
