'use strict';

const {
  assetVersionEvidenceMatches,
  createAssetVersionEvidence,
  parseCanonicalAssetVersionEvidenceJson,
} = require('../assets/assetVersionEvidence');
const { createGenerationHistoryRecord } = require('../assets/generationHistory');
const { sha256Canonical } = require('./contract');
const { validateH3GenerationSpec } = require('./generationSpec');
const { validateH3VideoEvidence } = require('./outputValidation');
const { createH3TextToVideoWorkflowBundle } = require('./workflowBundle');
const { assertH3WorkflowVerified } = require('./workflowSupport');

const MAX_SPEC_BYTES = 1024 * 1024;
const MAX_HISTORY_ENVELOPE_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_PAYLOAD_BYTES = 4 * 1024 * 1024;
const REMOTE_PROMPT_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const OFFICIAL_MANIFEST_SHA256 = createH3TextToVideoWorkflowBundle().manifest.workflowSha256;
const EXPECTED_FIELDS = Object.freeze([
  'historyUid', 'generationRunUid', 'assetUid', 'promptSemanticUid', 'manifestUid',
  'parentVersionUid', 'remotePromptId', 'outputVersionUid',
  'outputVersionEvidence', 'parentVersionEvidence',
]);
const HISTORY_FIELDS = Object.freeze([
  'uid', 'runUid', 'dramaUid', 'assetUid', 'promptSemanticUid', 'manifestUid',
  'manifestSha256', 'provider', 'model', 'seed', 'parametersJson', 'parametersSha256',
  'inputJson', 'inputSha256', 'status', 'outputVersionUid', 'outputVersionEvidenceJson',
  'parentVersionUid', 'parentVersionEvidenceJson', 'errorCode', 'errorDetailRef',
  'createdAtEpochMs', 'completedAtEpochMs',
]);

function exactRecord(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new TypeError();
  }
  return value;
}

function parsedRecord(value, maximumBytes, fields) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new TypeError();
  }
  return exactRecord(JSON.parse(value), fields);
}

function canonicalPayload(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_HISTORY_PAYLOAD_BYTES) {
    throw new TypeError();
  }
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || JSON.stringify(parsed) !== value) throw new TypeError();
  return parsed;
}

function validatedHistoryRecord(history) {
  const parameters = canonicalPayload(history.parametersJson);
  const input = canonicalPayload(history.inputJson);
  const outputVersionEvidence = parseCanonicalAssetVersionEvidenceJson(
    history.outputVersionEvidenceJson,
  );
  const parentVersionEvidence = history.parentVersionEvidenceJson === null
    ? null
    : parseCanonicalAssetVersionEvidenceJson(history.parentVersionEvidenceJson);
  const record = createGenerationHistoryRecord({
    uid: history.uid,
    runUid: history.runUid,
    dramaUid: history.dramaUid,
    assetUid: history.assetUid,
    promptSemanticUid: history.promptSemanticUid,
    manifestUid: history.manifestUid,
    manifestSha256: history.manifestSha256,
    provider: history.provider,
    model: history.model,
    seed: history.seed,
    parameters,
    input,
    status: history.status,
    outputVersionUid: history.outputVersionUid,
    outputVersionEvidence,
    parentVersionUid: history.parentVersionUid,
    parentVersionEvidence,
    errorCode: history.errorCode,
    errorDetailRef: history.errorDetailRef,
    createdAtEpochMs: history.createdAtEpochMs,
    completedAtEpochMs: history.completedAtEpochMs,
  }, 'GENERATION_HISTORY_DATA_INVALID');
  if (record.parametersSha256 !== history.parametersSha256
    || record.inputSha256 !== history.inputSha256) throw new TypeError();
  return record;
}

function assertH3HistoryMatchesIntent({
  generationSpecJson,
  generationSpecSha256,
  expectedJson,
  historyJson,
}) {
  if (typeof generationSpecJson !== 'string'
    || Buffer.byteLength(generationSpecJson, 'utf8') > MAX_SPEC_BYTES) throw new TypeError();
  const parsedSpec = JSON.parse(generationSpecJson);
  if (JSON.stringify(parsedSpec) !== generationSpecJson) throw new TypeError();
  const generationSpec = validateH3GenerationSpec(parsedSpec);
  assertH3WorkflowVerified(generationSpec);
  if (sha256Canonical(generationSpec) !== generationSpecSha256) throw new TypeError();

  const expected = parsedRecord(expectedJson, 16 * 1024, EXPECTED_FIELDS);
  const history = validatedHistoryRecord(parsedRecord(
    historyJson,
    MAX_HISTORY_ENVELOPE_BYTES,
    HISTORY_FIELDS,
  ));
  const expectedOutputEvidence = createAssetVersionEvidence(expected.outputVersionEvidence);
  const expectedParentEvidence = expected.parentVersionEvidence === null
    ? null
    : createAssetVersionEvidence(expected.parentVersionEvidence);
  const input = exactRecord(history.input, [
    'promptSemanticUid', 'manifestUid', 'remotePromptId', 'generationSpec', 'videoEvidence',
  ]);
  const parameters = exactRecord(history.parameters, [
    'profileUid', 'mode', 'width', 'height', 'frames', 'fps', 'seed',
  ]);
  if (typeof expected.remotePromptId !== 'string'
    || !REMOTE_PROMPT_ID.test(expected.remotePromptId)
    || history.uid !== expected.historyUid
    || history.runUid !== expected.generationRunUid
    || history.dramaUid !== generationSpec.prompt.dramaUid
    || history.assetUid !== expected.assetUid
    || history.promptSemanticUid !== expected.promptSemanticUid
    || history.manifestUid !== expected.manifestUid
    || history.parentVersionUid !== expected.parentVersionUid
    || history.outputVersionUid !== expected.outputVersionUid
    || !assetVersionEvidenceMatches(history.outputVersionEvidence, expectedOutputEvidence)
    || ((history.parentVersionEvidence === null) !== (expectedParentEvidence === null))
    || (history.parentVersionEvidence !== null
      && !assetVersionEvidenceMatches(history.parentVersionEvidence, expectedParentEvidence))
    || history.provider !== 'local-comfy'
    || history.model !== 'MiniMax-H3'
    || history.status !== 'succeeded'
    || history.manifestSha256 !== OFFICIAL_MANIFEST_SHA256
    || history.seed !== generationSpec.seed
    || input.promptSemanticUid !== expected.promptSemanticUid
    || input.manifestUid !== expected.manifestUid
    || input.remotePromptId !== expected.remotePromptId
    || sha256Canonical(input.generationSpec) !== generationSpecSha256
    || parameters.profileUid !== generationSpec.profileUid
    || parameters.mode !== generationSpec.mode
    || parameters.width !== generationSpec.width
    || parameters.height !== generationSpec.height
    || parameters.frames !== generationSpec.frames
    || parameters.fps !== generationSpec.fps
    || parameters.seed !== generationSpec.seed) throw new TypeError();

  const videoEvidence = validateH3VideoEvidence({
    generationSpec,
    evidence: input.videoEvidence,
  });
  if (history.outputVersionEvidence.sha256 !== videoEvidence.sha256
    || history.outputVersionEvidence.mimeType !== videoEvidence.mimeType
    || history.outputVersionEvidence.width !== videoEvidence.width
    || history.outputVersionEvidence.height !== videoEvidence.height
    || history.outputVersionEvidence.durationMs !== videoEvidence.durationMs) throw new TypeError();
  return Object.freeze({ generationSpec, history, videoEvidence });
}

function h3HistoryMatchesIntent(input) {
  try {
    assertH3HistoryMatchesIntent(input);
    return 1;
  } catch {
    return 0;
  }
}

module.exports = Object.freeze({
  assertH3HistoryMatchesIntent,
  h3HistoryMatchesIntent,
});
