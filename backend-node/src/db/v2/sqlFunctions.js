'use strict';

const { validateH3GenerationSpec } = require('../../h3/generationSpec');
const { sha256Canonical } = require('../../h3/contract');
const { createPromptSemanticVersionRecord } = require('../../assets/generationHistory');
const { createH3TextToVideoWorkflowBundle } = require('../../h3/workflowBundle');
const { createH3ExecutionBinding } = require('../../h3/executionBinding');
const { h3HistoryMatchesIntent } = require('../../h3/historyCompletion');
const { createRemoteConnectionRecord } = require('../../remote/connectionProfile');

const MAXIMUM_SPEC_BYTES = 1024 * 1024;
const MAXIMUM_SEMANTIC_BYTES = 1024 * 1024;
const MAXIMUM_MANIFEST_JSON_BYTES = 1024 * 1024;
const OFFICIAL_H3_MANIFEST = createH3TextToVideoWorkflowBundle().manifest;

function canonicalJson(value) {
  if (typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > MAXIMUM_MANIFEST_JSON_BYTES) return null;
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed) === value ? parsed : null;
  } catch {
    return null;
  }
}

function h3OfficialManifestMatches(
  uid,
  manifestId,
  version,
  engine,
  workflowFile,
  workflowSha256,
  modelFamily,
  requirementsJson,
  inputsJson,
  outputsJson,
  validationJson,
  status,
) {
  const requirements = canonicalJson(requirementsJson);
  const inputs = canonicalJson(inputsJson);
  const outputs = canonicalJson(outputsJson);
  const validation = canonicalJson(validationJson);
  if (requirements === null || inputs === null || outputs === null || validation === null) return 0;
  try {
    const candidate = {
      schemaVersion: 'comfy-workflow-manifest.v1',
      uid,
      manifestId,
      version,
      engine,
      workflowFile,
      workflowSha256,
      modelFamily,
      requirements,
      inputs,
      outputs,
      validation,
      status,
    };
    return sha256Canonical(candidate) === sha256Canonical(OFFICIAL_H3_MANIFEST) ? 1 : 0;
  } catch {
    return 0;
  }
}

function parsedObject(value, maximumBytes) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function h3PlanEvidenceSha256(
  graphSnapshotJson,
  nodeUid,
  taskJson,
  connectionJson,
  assetJson,
  generationSpecJson,
  manifestUid,
  filenamePrefix,
) {
  const graphSnapshot = parsedObject(graphSnapshotJson, 16 * 1024 * 1024);
  const task = parsedObject(taskJson, 16 * 1024);
  const connectionInput = parsedObject(connectionJson, 64 * 1024);
  const asset = parsedObject(assetJson, 16 * 1024);
  const generationSpec = parsedObject(generationSpecJson, MAXIMUM_SPEC_BYTES);
  if (!graphSnapshot || !task || !connectionInput || !asset || !generationSpec
    || JSON.stringify(graphSnapshot) !== graphSnapshotJson
    || JSON.stringify(generationSpec) !== generationSpecJson) return null;
  try {
    const connection = createRemoteConnectionRecord(connectionInput);
    return createH3ExecutionBinding({
      graphSnapshot,
      nodeUid,
      task,
      connection,
      asset,
      generationSpec,
      manifestUid,
      filenamePrefix,
    }).planEvidenceSha256;
  } catch {
    return null;
  }
}

function h3GenerationSpecSha256(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAXIMUM_SPEC_BYTES) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (JSON.stringify(parsed) !== value) return null;
    return sha256Canonical(validateH3GenerationSpec(parsed));
  } catch {
    return null;
  }
}

function h3SemanticShotSha256(
  value,
  uid,
  createdAtEpochMs,
  dramaUid,
  shotResultUid,
  shotResultHash,
  shotEnvelopeHash,
  shotApprovalRef,
  semanticSha256,
  shotId,
  continuitySnapshotUid,
) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAXIMUM_SEMANTIC_BYTES
    || typeof shotId !== 'string' || typeof continuitySnapshotUid !== 'string') return null;
  try {
    const semantic = JSON.parse(value);
    if (JSON.stringify(semantic) !== value) return null;
    const record = createPromptSemanticVersionRecord({ uid, semantic, createdAtEpochMs });
    if (record.dramaUid !== dramaUid
      || record.shotResultUid !== shotResultUid
      || record.shotResultHash !== shotResultHash
      || record.shotEnvelopeHash !== shotEnvelopeHash
      || record.shotApprovalRef !== shotApprovalRef
      || record.semanticSha256 !== semanticSha256) return null;
    const matches = record.semantic.output.semanticShots.filter(
      (shot) => shot && typeof shot === 'object' && !Array.isArray(shot)
        && shot.shotId === shotId,
    );
    if (matches.length !== 1
      || matches[0].continuitySnapshotUid !== continuitySnapshotUid) return null;
    return sha256Canonical(matches[0]);
  } catch {
    return null;
  }
}

function registerV2SqlFunctions(database) {
  database.function(
    'h3_generation_spec_sha256',
    { deterministic: true },
    h3GenerationSpecSha256,
  );
  database.function(
    'h3_semantic_shot_sha256',
    { deterministic: true },
    h3SemanticShotSha256,
  );
  database.function(
    'h3_official_manifest_matches',
    { deterministic: true },
    h3OfficialManifestMatches,
  );
  database.function(
    'h3_plan_evidence_sha256',
    { deterministic: true },
    h3PlanEvidenceSha256,
  );
  database.function(
    'h3_history_matches_intent',
    { deterministic: true },
    (generationSpecJson, generationSpecSha256, expectedJson, historyJson) => (
      h3HistoryMatchesIntent({
        generationSpecJson,
        generationSpecSha256,
        expectedJson,
        historyJson,
      })
    ),
  );
}

module.exports = Object.freeze({
  h3GenerationSpecSha256,
  h3HistoryMatchesIntent,
  h3OfficialManifestMatches,
  h3PlanEvidenceSha256,
  h3SemanticShotSha256,
  registerV2SqlFunctions,
});
