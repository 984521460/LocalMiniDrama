'use strict';

const { createPromptSemanticVersionRecord } = require('../assets/generationHistory');
const { exactKeys, sha256Canonical, snapshot, uid } = require('./contract');
const { fail } = require('./errors');
const { validateH3GenerationSpec } = require('./generationSpec');
const { createH3TextToVideoWorkflowBundle } = require('./workflowBundle');
const { assertH3WorkflowVerified } = require('./workflowSupport');
const { compiledTaskPromptSha256 } = require('./executionBinding');

const CODE = 'H3_HISTORY_CONFLICT';
const SCHEMA_VERSION = 'h3-local-execution-intent.v1';
const MAX_EPOCH_MS = 253402300799999;
const INPUT_FIELDS = Object.freeze([
  'uid', 'taskUid', 'generationRunUid', 'historyUid', 'assetUid', 'promptSemantic',
  'generationSpec', 'manifestUid', 'parentVersionUid', 'filenamePrefix',
  'taskPromptSha256', 'planEvidenceSha256', 'createdAtEpochMs',
]);

function promptSemanticRecord(value) {
  const fields = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value)
    : [];
  if (fields.length === 3
    && fields.includes('uid') && fields.includes('semantic') && fields.includes('createdAtEpochMs')) {
    return createPromptSemanticVersionRecord(value, CODE);
  }
  exactKeys(value, [
    'schemaVersion', 'uid', 'dramaUid', 'shotResultUid', 'shotResultHash',
    'shotEnvelopeHash', 'shotApprovalRef', 'semanticSha256', 'semantic',
    'createdAtEpochMs',
  ], CODE);
  const normalized = createPromptSemanticVersionRecord({
    uid: value.uid,
    semantic: value.semantic,
    createdAtEpochMs: value.createdAtEpochMs,
  }, CODE);
  if (sha256Canonical(value) !== sha256Canonical(normalized)) fail(CODE);
  return normalized;
}

function normalizedInput(value) {
  const input = snapshot(value, CODE, {
    maxArrayLength: 512,
    maxDepth: 32,
    maxEntries: 20_000,
    maxStringBytes: 512 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
  });
  exactKeys(input, INPUT_FIELDS, CODE);
  for (const field of ['uid', 'taskUid', 'generationRunUid', 'historyUid', 'assetUid', 'manifestUid']) {
    uid(input[field], CODE);
  }
  if (input.parentVersionUid !== null) uid(input.parentVersionUid, CODE);
  for (const field of ['taskPromptSha256', 'planEvidenceSha256']) {
    if (typeof input[field] !== 'string' || !/^[0-9a-f]{64}$/u.test(input[field])) fail(CODE);
  }
  if (!Number.isSafeInteger(input.createdAtEpochMs)
    || input.createdAtEpochMs < 0 || input.createdAtEpochMs > MAX_EPOCH_MS) fail(CODE);

  let promptSemantic;
  let generationSpec;
  try {
    promptSemantic = promptSemanticRecord(input.promptSemantic);
    generationSpec = validateH3GenerationSpec(input.generationSpec);
    assertH3WorkflowVerified(generationSpec);
  } catch {
    return fail(CODE);
  }
  const officialManifest = createH3TextToVideoWorkflowBundle().manifest;
  if (input.manifestUid !== officialManifest.uid
    || promptSemantic.dramaUid !== generationSpec.prompt.dramaUid) fail(CODE);
  const matchingShots = promptSemantic.semantic.output.semanticShots.filter(
    (shot) => shot.shotId === generationSpec.prompt.shotId,
  );
  if (matchingShots.length !== 1
    || matchingShots[0].continuitySnapshotUid !== generationSpec.prompt.continuitySnapshotUid
    || sha256Canonical(matchingShots[0]) !== generationSpec.prompt.semanticSha256) fail(CODE);
  if (compiledTaskPromptSha256(generationSpec, input.filenamePrefix)
    !== input.taskPromptSha256) fail(CODE);

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    uid: input.uid,
    taskUid: input.taskUid,
    generationRunUid: input.generationRunUid,
    historyUid: input.historyUid,
    assetUid: input.assetUid,
    promptSemantic,
    generationSpec,
    manifestUid: input.manifestUid,
    parentVersionUid: input.parentVersionUid,
    filenamePrefix: input.filenamePrefix,
    taskPromptSha256: input.taskPromptSha256,
    planEvidenceSha256: input.planEvidenceSha256,
    createdAtEpochMs: input.createdAtEpochMs,
  });
}

function createH3ExecutionIntent(value) {
  return normalizedInput(value);
}

function validateH3ExecutionIntent(value) {
  const stored = snapshot(value, CODE, {
    maxArrayLength: 512,
    maxDepth: 32,
    maxEntries: 20_000,
    maxStringBytes: 512 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
  });
  exactKeys(stored, ['schemaVersion', ...INPUT_FIELDS], CODE);
  const normalized = normalizedInput(Object.fromEntries(
    INPUT_FIELDS.map((field) => [field, stored[field]]),
  ));
  if (stored.schemaVersion !== SCHEMA_VERSION
    || sha256Canonical(stored) !== sha256Canonical(normalized)) fail(CODE);
  return normalized;
}

module.exports = Object.freeze({
  createH3ExecutionIntent,
  validateH3ExecutionIntent,
});
