'use strict';

const { validateH3GenerationSpec } = require('../../h3/generationSpec');
const { sha256Canonical } = require('../../h3/contract');
const { createPromptSemanticVersionRecord } = require('../../assets/generationHistory');
const { createH3TextToVideoWorkflowBundle } = require('../../h3/workflowBundle');
const { createH3ExecutionBinding } = require('../../h3/executionBinding');
const { h3HistoryMatchesIntent } = require('../../h3/historyCompletion');
const { createRemoteConnectionRecord } = require('../../remote/connectionProfile');
const { canonicalUid } = require('../../audio/audioContract');
const { createBgmLicense } = require('../../audio/bgmLicense');
const { createBgmTrack } = require('../../audio/bgmTrack');
const {
  parseMediaExportExecutionPlanRecord,
} = require('../../media/mediaExportExecutionPlan');
const { parseMediaExportReceiptRecord } = require('../../media/mediaExportReceipt');
const { validateWorkflowExecutionPlan } = require('../../workflows/executionPlan');

const MAXIMUM_SPEC_BYTES = 1024 * 1024;
const MAXIMUM_SEMANTIC_BYTES = 1024 * 1024;
const MAXIMUM_MANIFEST_JSON_BYTES = 1024 * 1024;
const OFFICIAL_H3_MANIFEST = createH3TextToVideoWorkflowBundle().manifest;

function canonicalJson(value, maximumBytes = MAXIMUM_MANIFEST_JSON_BYTES) {
  if (typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > maximumBytes) return null;
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed) === value ? parsed : null;
  } catch {
    return null;
  }
}

function mediaExportExecutionPlanSha256(value) {
  const parsed = canonicalJson(value, 16 * 1024 * 1024);
  if (parsed === null) return null;
  try {
    return parseMediaExportExecutionPlanRecord(parsed).executionPlanSha256;
  } catch {
    return null;
  }
}

function mediaExportReceiptMatchesPlan(planJson, receiptJson) {
  const planValue = canonicalJson(planJson, 16 * 1024 * 1024);
  const receiptValue = canonicalJson(receiptJson);
  if (planValue === null || receiptValue === null) return 0;
  try {
    const plan = parseMediaExportExecutionPlanRecord(planValue);
    const receipt = parseMediaExportReceiptRecord(receiptValue);
    return receipt.uid === plan.uid
      && receipt.dramaUid === plan.dramaUid
      && receipt.workflowRunUid === plan.workflowRunUid
      && receipt.productionTimelineSnapshotUid === plan.productionTimelineSnapshotUid
      && receipt.productionTimelineSnapshotSha256 === plan.productionTimelineSnapshotSha256
      && receipt.normalizationPlanUid === plan.normalizationPlanUid
      && receipt.normalizationPlanSha256 === plan.normalizationPlanSha256
      && receipt.executionPlanSha256 === plan.executionPlanSha256
      && receipt.profileSha256 === plan.profile.profileSha256
      && receipt.output.relativePath === plan.outputRelativePath
      && Math.abs(receipt.output.durationMs - plan.durationMs) <= 50
      ? 1 : 0;
  } catch {
    return 0;
  }
}

function mediaExportReceiptCompletedIso(receiptJson) {
  const receiptValue = canonicalJson(receiptJson);
  if (receiptValue === null) return null;
  try {
    return new Date(
      parseMediaExportReceiptRecord(receiptValue).completedAtEpochMs,
    ).toISOString();
  } catch {
    return null;
  }
}

function mediaExportIsoTimestampValid(value) {
  if (typeof value !== 'string' || value.length !== 24
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return 0;
  const epochMs = Date.parse(value);
  return Number.isSafeInteger(epochMs) && new Date(epochMs).toISOString() === value ? 1 : 0;
}

function mediaExportEpochIso(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) return null;
  try { return new Date(value).toISOString(); } catch { return null; }
}

function mediaExportSourceGraphValid(
  graphJson,
  workflowUid,
  graphHash,
  graphRevision,
  nodeUid,
) {
  const graphValue = canonicalJson(graphJson, 16 * 1024 * 1024);
  if (graphValue === null) return 0;
  try {
    const graph = validateWorkflowExecutionPlan(graphValue);
    const matches = graph.snapshot.nodes.filter((node) => (
      node.uid === nodeUid && node.nodeType === 'export.final' && node.enabled === true
    ));
    return graph.workflowUid === workflowUid
      && graph.graphHash === graphHash
      && graph.graphRevision === graphRevision
      && matches.length === 1
      ? 1 : 0;
  } catch {
    return 0;
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

function bgmTrackValid(
  uid,
  dramaUid,
  title,
  sourceKind,
  providerId,
  assetVersionUid,
  assetUid,
  storageProvider,
  logicalUri,
  relativePath,
  sha256,
  mimeType,
  width,
  height,
  durationMs,
  parentUid,
  versionStatus,
  versionCreatedAt,
  licenseUid,
  licenseBasis,
  commercialUseAllowed,
  derivativesAllowed,
  attributionRequired,
  attributionText,
  licenseAttestedAtEpochMs,
  createdAtEpochMs,
) {
  try {
    createBgmTrack({
      schemaVersion: 'bgm-track.v1',
      uid,
      dramaUid,
      title,
      sourceKind,
      providerId,
      assetVersion: {
        uid: assetVersionUid,
        assetUid,
        storageProvider,
        logicalUri,
        relativePath,
        sha256,
        mimeType,
        width,
        height,
        durationMs,
        parentUid,
        status: versionStatus,
        createdAt: versionCreatedAt,
      },
      license: {
        schemaVersion: 'bgm-license.v1',
        uid: licenseUid,
        basis: licenseBasis,
        attestationKind: 'user-attestation',
        commercialUseAllowed: commercialUseAllowed === 1,
        derivativesAllowed: derivativesAllowed === 1,
        attributionRequired: attributionRequired === 1,
        attributionText,
        attestedAtEpochMs: licenseAttestedAtEpochMs,
      },
      createdAtEpochMs,
    });
    return 1;
  } catch {
    return 0;
  }
}

function bgmLicenseValid(
  uid,
  trackUid,
  basis,
  attestationKind,
  commercialUseAllowed,
  derivativesAllowed,
  attributionRequired,
  attributionText,
  attestedAtEpochMs,
) {
  try {
    canonicalUid(trackUid, 'BGM_LICENSE_INVALID');
    createBgmLicense({
      schemaVersion: 'bgm-license.v1',
      uid,
      basis,
      attestationKind,
      commercialUseAllowed: commercialUseAllowed === 1,
      derivativesAllowed: derivativesAllowed === 1,
      attributionRequired: attributionRequired === 1,
      attributionText,
      attestedAtEpochMs,
    });
    return 1;
  } catch {
    return 0;
  }
}

function registerV2SqlFunctions(database) {
  database.function(
    'media_export_execution_plan_sha256',
    { deterministic: true },
    mediaExportExecutionPlanSha256,
  );
  database.function(
    'media_export_receipt_matches_plan',
    { deterministic: true },
    mediaExportReceiptMatchesPlan,
  );
  database.function(
    'media_export_receipt_completed_iso',
    { deterministic: true },
    mediaExportReceiptCompletedIso,
  );
  database.function(
    'media_export_iso_timestamp_valid',
    { deterministic: true },
    mediaExportIsoTimestampValid,
  );
  database.function(
    'media_export_epoch_iso',
    { deterministic: true },
    mediaExportEpochIso,
  );
  database.function(
    'media_export_source_graph_valid',
    { deterministic: true },
    mediaExportSourceGraphValid,
  );
  database.function(
    'bgm_license_valid',
    { deterministic: true },
    bgmLicenseValid,
  );
  database.function(
    'bgm_track_valid',
    { deterministic: true },
    bgmTrackValid,
  );
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
  bgmLicenseValid,
  bgmTrackValid,
  h3GenerationSpecSha256,
  h3HistoryMatchesIntent,
  h3OfficialManifestMatches,
  h3PlanEvidenceSha256,
  h3SemanticShotSha256,
  mediaExportExecutionPlanSha256,
  mediaExportEpochIso,
  mediaExportIsoTimestampValid,
  mediaExportReceiptCompletedIso,
  mediaExportReceiptMatchesPlan,
  registerV2SqlFunctions,
});
