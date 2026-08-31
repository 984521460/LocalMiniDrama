'use strict';

const { validateH3GenerationSpec } = require('../../h3/generationSpec');
const { sha256Canonical } = require('../../h3/contract');
const { createPromptSemanticVersionRecord } = require('../../assets/generationHistory');
const { createH3TextToVideoWorkflowBundle } = require('../../h3/workflowBundle');
const { createH3ExecutionBinding } = require('../../h3/executionBinding');
const { h3HistoryMatchesIntent } = require('../../h3/historyCompletion');
const {
  createRemoteConnectionRecord,
  remoteConnectionEvidenceSha256,
} = require('../../remote/connectionProfile');
const { canonicalUid } = require('../../audio/audioContract');
const { createBgmLicense } = require('../../audio/bgmLicense');
const { createBgmTrack } = require('../../audio/bgmTrack');
const {
  audioModeIntentRecordValid,
  audioModeNarrativeEmotion,
} = require('../../audio/audioModeIntent');
const {
  audioTtsExecutionRecordValid,
  audioTtsProbeRecordValid,
  deterministicUid,
  executionUid,
} = require('../../repositories/v2/audioTtsOutputRepository');
const {
  parseMediaExportExecutionPlanRecord,
} = require('../../media/mediaExportExecutionPlan');
const { parseMediaExportReceiptRecord } = require('../../media/mediaExportReceipt');
const { validateWorkflowExecutionPlan } = require('../../workflows/executionPlan');
const {
  parseMvpBenchmarkSessionPlan,
  parseMvpBenchmarkSessionRequest,
  serializeMvpBenchmarkSessionJson,
} = require('../../benchmark/mvpBenchmarkSession');
const {
  parseMvpBenchmarkExternalAuthorization,
  parseMvpBenchmarkExternalAuthorizationRequest,
  serializeMvpBenchmarkExternalAuthorizationJson,
} = require('../../benchmark/mvpBenchmarkExternalAuthorization');

const MAXIMUM_SPEC_BYTES = 1024 * 1024;
const MAXIMUM_SEMANTIC_BYTES = 1024 * 1024;
const MAXIMUM_MANIFEST_JSON_BYTES = 1024 * 1024;
const OFFICIAL_H3_MANIFEST = createH3TextToVideoWorkflowBundle().manifest;
const ARRAY_IS_ARRAY = Array.isArray;
const JSON_STRINGIFY = JSON.stringify;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;

function serializeParsedJson(value, depth = 0) {
  if (depth > 128) throw new TypeError('JSON depth is invalid');
  if (value === null) return 'null';
  if (typeof value === 'string') return REFLECT_APPLY(JSON_STRINGIFY, JSON, [value]);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return REFLECT_APPLY(JSON_STRINGIFY, JSON, [value]);
  }
  if (ARRAY_IS_ARRAY(value)) {
    if (OBJECT_GET_PROTOTYPE_OF(value) !== Array.prototype) throw new TypeError('JSON array is invalid');
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0
      || REFLECT_OWN_KEYS(descriptors).length !== length + 1) {
      throw new TypeError('JSON array is invalid');
    }
    let output = '[';
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
        throw new TypeError('JSON array is invalid');
      }
      if (index > 0) output += ',';
      output += serializeParsedJson(descriptor.value, depth + 1);
    }
    return `${output}]`;
  }
  if (!value || typeof value !== 'object') throw new TypeError('JSON value is invalid');
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('JSON object is invalid');
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
  const keys = REFLECT_OWN_KEYS(descriptors);
  let output = '{';
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor?.enumerable
      || !OBJECT_HAS_OWN(descriptor, 'value')) {
      throw new TypeError('JSON object is invalid');
    }
    if (index > 0) output += ',';
    output += `${REFLECT_APPLY(JSON_STRINGIFY, JSON, [key])}:${serializeParsedJson(
      descriptor.value,
      depth + 1,
    )}`;
  }
  return `${output}}`;
}

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

function mvpBenchmarkSessionRecordValid(
  uid,
  dramaUid,
  workflowRunUid,
  requestJson,
  planJson,
  planSha256,
  createdAtEpochMs,
) {
  try {
    if (typeof requestJson !== 'string' || Buffer.byteLength(requestJson, 'utf8') > 64 * 1024
      || typeof planJson !== 'string' || Buffer.byteLength(planJson, 'utf8') > 1024 * 1024) {
      return 0;
    }
    const requestValue = JSON.parse(requestJson);
    const planValue = JSON.parse(planJson);
    const request = parseMvpBenchmarkSessionRequest(
      requestValue,
      'MVP_BENCHMARK_SESSION_DATA_INVALID',
    );
    const plan = parseMvpBenchmarkSessionPlan(planValue);
    if (serializeMvpBenchmarkSessionJson(request) !== requestJson
      || serializeMvpBenchmarkSessionJson(plan) !== planJson
      || request.uid !== uid || plan.uid !== uid
      || request.dramaUid !== dramaUid || plan.dramaUid !== dramaUid
      || request.workflowRunUid !== workflowRunUid || plan.workflowRunUid !== workflowRunUid
      || request.createdAtEpochMs !== createdAtEpochMs
      || plan.createdAtEpochMs !== createdAtEpochMs || plan.planSha256 !== planSha256
      || request.h3TaskUids.length !== plan.h3Tasks.length
      || request.audioIntentUids.length !== plan.audioIntents.length) return 0;
    const h3 = [];
    const audio = [];
    for (let index = 0; index < plan.h3Tasks.length; index += 1) h3[index] = plan.h3Tasks[index].taskUid;
    for (let index = 0; index < plan.audioIntents.length; index += 1) {
      audio[index] = plan.audioIntents[index].intentUid;
    }
    for (let index = 1; index < h3.length; index += 1) {
      const current = h3[index];
      let position = index;
      while (position > 0 && h3[position - 1] > current) {
        h3[position] = h3[position - 1];
        position -= 1;
      }
      h3[position] = current;
    }
    for (let index = 1; index < audio.length; index += 1) {
      const current = audio[index];
      let position = index;
      while (position > 0 && audio[position - 1] > current) {
        audio[position] = audio[position - 1];
        position -= 1;
      }
      audio[position] = current;
    }
    for (let index = 0; index < h3.length; index += 1) {
      if (h3[index] !== request.h3TaskUids[index]) return 0;
    }
    for (let index = 0; index < audio.length; index += 1) {
      if (audio[index] !== request.audioIntentUids[index]) return 0;
    }
    return 1;
  } catch {
    return 0;
  }
}

function mvpBenchmarkSessionSourceGraphValid(graphJson, planJson) {
  try {
    if (typeof graphJson !== 'string' || Buffer.byteLength(graphJson, 'utf8') > 16 * 1024 * 1024
      || typeof planJson !== 'string' || Buffer.byteLength(planJson, 'utf8') > 1024 * 1024) return 0;
    const graphValue = JSON.parse(graphJson);
    const planValue = JSON.parse(planJson);
    const graph = validateWorkflowExecutionPlan(graphValue);
    const plan = parseMvpBenchmarkSessionPlan(planValue);
    if (serializeParsedJson(graphValue) !== graphJson
      || serializeMvpBenchmarkSessionJson(plan) !== planJson
      || graph.workflowUid !== plan.workflowUid || graph.graphHash !== plan.graphHash
      || graph.graphRevision !== plan.graphRevision) return 0;
    const videoNodeUids = [];
    const audioNodeUids = [];
    for (let order = 0; order < graph.topologicalOrder.length; order += 1) {
      const nodeUid = graph.topologicalOrder[order];
      let node = null;
      for (let index = 0; index < graph.snapshot.nodes.length; index += 1) {
        if (graph.snapshot.nodes[index].uid !== nodeUid) continue;
        if (node !== null) return 0;
        node = graph.snapshot.nodes[index];
      }
      if (node?.enabled !== true) continue;
      if (node.nodeType === 'shot.video') videoNodeUids[videoNodeUids.length] = node.uid;
      if (node.nodeType === 'audio.tts') audioNodeUids[audioNodeUids.length] = node.uid;
    }
    if (videoNodeUids.length !== plan.h3Tasks.length
      || audioNodeUids.length !== plan.audioIntents.length) return 0;
    for (let index = 0; index < videoNodeUids.length; index += 1) {
      if (videoNodeUids[index] !== plan.h3Tasks[index].nodeUid) return 0;
    }
    for (let index = 0; index < audioNodeUids.length; index += 1) {
      if (audioNodeUids[index] !== plan.audioIntents[index].nodeUid) return 0;
    }
    return 1;
  } catch {
    return 0;
  }
}

function mvpBenchmarkExternalAuthorizationRecordValid(
  uid,
  sessionUid,
  dramaUid,
  requestJson,
  authorizationJson,
  authorizationSha256,
  authorizedAtEpochMs,
  expiresAtEpochMs,
) {
  try {
    if (typeof requestJson !== 'string' || Buffer.byteLength(requestJson, 'utf8') > 64 * 1024
      || typeof authorizationJson !== 'string'
      || Buffer.byteLength(authorizationJson, 'utf8') > 64 * 1024) return 0;
    const request = parseMvpBenchmarkExternalAuthorizationRequest(
      JSON.parse(requestJson),
      'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_DATA_INVALID',
    );
    const authorization = parseMvpBenchmarkExternalAuthorization(JSON.parse(authorizationJson));
    return serializeMvpBenchmarkExternalAuthorizationJson(request) === requestJson
      && serializeMvpBenchmarkExternalAuthorizationJson(authorization) === authorizationJson
      && request.uid === uid && authorization.uid === uid
      && request.sessionUid === sessionUid && authorization.sessionUid === sessionUid
      && request.dramaUid === dramaUid && authorization.dramaUid === dramaUid
      && request.sessionPlanSha256 === authorization.sessionPlanSha256
      && request.connectionUid === authorization.connectionUid
      && request.connectionEvidenceSha256 === authorization.connectionEvidenceSha256
      && request.maximumCostCnyFen === authorization.maximumCostCnyFen
      && authorization.authorizationSha256 === authorizationSha256
      && authorization.authorizedAtEpochMs === authorizedAtEpochMs
      && authorization.expiresAtEpochMs === expiresAtEpochMs
      && authorization.expiresAtEpochMs - authorization.authorizedAtEpochMs
        === request.validityDurationMs
      ? 1 : 0;
  } catch {
    return 0;
  }
}

function mvpBenchmarkConnectionEvidenceSha256(
  uid,
  name,
  host,
  port,
  username,
  hostFingerprint,
  credentialRef,
  status,
  createdAt,
  updatedAt,
  authMethod,
  comfyHost,
  comfyPort,
  remoteWorkDir,
  environmentReportJson,
  environmentCheckedAtEpochMs,
  stateVersion,
) {
  try {
    if (environmentReportJson !== null || environmentCheckedAtEpochMs !== null) return null;
    return remoteConnectionEvidenceSha256(createRemoteConnectionRecord({
      uid,
      name,
      host,
      port,
      username,
      hostFingerprint,
      credentialRef,
      status,
      createdAt,
      updatedAt,
      authMethod,
      comfyHost,
      comfyPort,
      remoteWorkDir,
      environmentReport: null,
      environmentCheckedAtEpochMs: null,
      stateVersion,
    }));
  } catch {
    return null;
  }
}

function registerV2SqlFunctions(database) {
  database.function(
    'audio_mode_narrative_emotion',
    { deterministic: true },
    audioModeNarrativeEmotion,
  );
  database.function(
    'audio_mode_intent_record_valid',
    { deterministic: true },
    audioModeIntentRecordValid,
  );
  database.function(
    'audio_tts_asset_uid',
    { deterministic: true },
    (intentUid, dialogueDeliveryUid) => {
      try { return deterministicUid('audio-tts-asset.v1', intentUid, dialogueDeliveryUid); } catch { return null; }
    },
  );
  database.function(
    'audio_tts_asset_version_uid',
    { deterministic: true },
    (intentUid, dialogueDeliveryUid) => {
      try {
        return deterministicUid('audio-tts-asset-version.v1', intentUid, dialogueDeliveryUid);
      } catch { return null; }
    },
  );
  database.function(
    'audio_tts_execution_uid',
    { deterministic: true },
    (intentUid) => {
      try { return executionUid(intentUid); } catch { return null; }
    },
  );
  database.function(
    'audio_tts_probe_record_valid',
    { deterministic: true },
    audioTtsProbeRecordValid,
  );
  database.function(
    'audio_tts_execution_record_valid',
    { deterministic: true },
    audioTtsExecutionRecordValid,
  );
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
  database.function(
    'mvp_benchmark_session_record_valid',
    { deterministic: true },
    mvpBenchmarkSessionRecordValid,
  );
  database.function(
    'mvp_benchmark_session_source_graph_valid',
    { deterministic: true },
    mvpBenchmarkSessionSourceGraphValid,
  );
  database.function(
    'mvp_benchmark_external_authorization_record_valid',
    { deterministic: true },
    mvpBenchmarkExternalAuthorizationRecordValid,
  );
  database.function(
    'mvp_benchmark_connection_evidence_sha256',
    { deterministic: true },
    mvpBenchmarkConnectionEvidenceSha256,
  );
}

module.exports = Object.freeze({
  audioModeIntentRecordValid,
  audioModeNarrativeEmotion,
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
  mvpBenchmarkConnectionEvidenceSha256,
  mvpBenchmarkExternalAuthorizationRecordValid,
  mvpBenchmarkSessionRecordValid,
  mvpBenchmarkSessionSourceGraphValid,
  registerV2SqlFunctions,
});
