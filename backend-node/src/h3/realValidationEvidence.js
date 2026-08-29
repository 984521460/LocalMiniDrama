'use strict';

const { types: { isProxy } } = require('node:util');

const { validateStoredComfyWorkflowManifest } = require('../remote/workflowManifest');
const {
  exactKeys,
  sha256,
  sha256Canonical,
  snapshot,
  uid,
} = require('./contract');
const { fail } = require('./errors');
const {
  H3_REAL_VALIDATION_GPU_CLASSES,
  RTX_4090_GPU_CLASS,
} = require('./gpuClasses');
const { validateH3GenerationSpec } = require('./generationSpec');
const { isH3LocalVideoInspector } = require('./localVideoInspector');
const { validateH3VideoEvidence, validateH3VideoOutput } = require('./outputValidation');
const { H3_PROFILE } = require('./profile');
const {
  H3_PHASE_7_ENVIRONMENT_SHA256,
  validateH3RealGpuEnvironment,
} = require('./realValidationEnvironment');
const { createH3TextToVideoWorkflowBundle } = require('./workflowBundle');
const { createH3WorkflowCandidateBundle } = require('./workflowCandidates');
const { assertH3WorkflowVerified } = require('./workflowSupport');
const { isH3Phase7WorkflowVariantTrusted } = require('./workflowTrust');

const CODE = 'H3_REAL_VALIDATION_INVALID';
const PHASE_7_GPU_CLASS = RTX_4090_GPU_CLASS;
const H3_PROFILE_SHA256 = sha256Canonical(H3_PROFILE);
const H3_PHASE_7_REQUIRED_MODES = Object.freeze([
  't2v', 'fl2va-first', 'fl2va-first-last', 'ref2va',
]);
const RECEIPT_FIELDS = Object.freeze([
  'schemaVersion', 'receiptUid', 'profileUid', 'profileRevision', 'profileSha256',
  'environmentSha256', 'gpuClass', 'captureKind', 'mode', 'promptId',
  'capturedAtEpochMs', 'manifest', 'generationSpec', 'output', 'receiptSha256',
]);
const COLLECT_FIELDS = Object.freeze([
  'receiptUid', 'gpuClass', 'promptId', 'manifest', 'generationSpec',
  'assetVersionUid', 'localRelativePath', 'remoteSha256', 'remoteBytes',
]);
const RECEIPT_LIMITS = Object.freeze({
  maxArrayLength: 512,
  maxDepth: 24,
  maxEntries: 16_384,
  maxStringBytes: 64 * 1024,
  maxTotalBytes: 1024 * 1024,
});

const TRUSTED_MANIFESTS = new Map([
  ['t2v', createH3TextToVideoWorkflowBundle().manifest],
  ['fl2va-first', createH3WorkflowCandidateBundle({
    mode: 'fl2va-first', referenceImageCount: 1, referenceAudio: false,
  }).manifest],
  ['fl2va-first-last', createH3WorkflowCandidateBundle({
    mode: 'fl2va-first-last', referenceImageCount: 2, referenceAudio: false,
  }).manifest],
  ['ref2va', createH3WorkflowCandidateBundle({
    mode: 'ref2va', referenceImageCount: 4, referenceAudio: true,
  }).manifest],
]);

function invalid() {
  fail(CODE);
}

function validEpochMilliseconds(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function storedManifest(value) {
  try {
    const manifest = validateStoredComfyWorkflowManifest(value);
    if (manifest.modelFamily !== H3_PROFILE.modelFamily) invalid();
    return manifest;
  } catch {
    return invalid();
  }
}

function generationSpec(value) {
  try {
    return validateH3GenerationSpec(value);
  } catch {
    return invalid();
  }
}

function videoEvidence(spec, value) {
  try {
    return validateH3VideoEvidence({ generationSpec: spec, evidence: value });
  } catch {
    return invalid();
  }
}

function trustedManifestMatches(mode, manifest) {
  const trusted = TRUSTED_MANIFESTS.get(mode);
  return trusted !== undefined
    && sha256Canonical(manifest) === sha256Canonical(trusted);
}

function trustedWorkflowMatches(mode, manifest, spec) {
  if (!trustedManifestMatches(mode, manifest)) return false;
  if (mode === 't2v') {
    try {
      assertH3WorkflowVerified(spec);
      return true;
    } catch {
      return false;
    }
  }
  return isH3Phase7WorkflowVariantTrusted({
    mode: spec.mode,
    referenceImageCount: spec.referenceImages.length,
    referenceAudio: spec.referenceAudio !== null,
  });
}

function candidateWorkflowMatches(manifest, spec) {
  if (spec.mode === 't2v') return false;
  try {
    const candidate = createH3WorkflowCandidateBundle({
      mode: spec.mode,
      referenceImageCount: spec.referenceImages.length,
      referenceAudio: spec.referenceAudio !== null,
    });
    return candidate.supportStatus === 'implementation-candidate-unverified'
      && sha256Canonical(manifest) === sha256Canonical(candidate.manifest);
  } catch {
    return false;
  }
}

function capturableWorkflowMatches(manifest, spec) {
  return trustedWorkflowMatches(spec.mode, manifest, spec)
    || candidateWorkflowMatches(manifest, spec);
}

function receiptPayload(receipt) {
  return Object.fromEntries(RECEIPT_FIELDS
    .filter((field) => field !== 'receiptSha256')
    .map((field) => [field, receipt[field]]));
}

function validateH3RealValidationReceipt(value) {
  const receipt = snapshot(value, CODE, RECEIPT_LIMITS);
  exactKeys(receipt, RECEIPT_FIELDS, CODE);
  if (receipt.schemaVersion !== 'h3-real-validation-receipt.v1'
    || receipt.profileUid !== H3_PROFILE.uid
    || receipt.profileRevision !== H3_PROFILE.revision
    || receipt.profileSha256 !== H3_PROFILE_SHA256
    || receipt.environmentSha256 !== H3_PHASE_7_ENVIRONMENT_SHA256
    || !H3_REAL_VALIDATION_GPU_CLASSES.has(receipt.gpuClass)
    || receipt.captureKind !== 'local-comfyui'
    || !H3_PHASE_7_REQUIRED_MODES.includes(receipt.mode)
    || !validEpochMilliseconds(receipt.capturedAtEpochMs)) invalid();
  uid(receipt.receiptUid, CODE);
  uid(receipt.promptId, CODE);
  sha256(receipt.receiptSha256, CODE);

  const manifest = storedManifest(receipt.manifest);
  const spec = generationSpec(receipt.generationSpec);
  if (spec.mode !== receipt.mode || spec.profileUid !== receipt.profileUid) invalid();

  exactKeys(receipt.output, ['assetVersionUid', 'evidence'], CODE);
  uid(receipt.output.assetVersionUid, CODE);
  videoEvidence(spec, receipt.output.evidence);
  if (sha256Canonical(receiptPayload(receipt)) !== receipt.receiptSha256) invalid();
  return receipt;
}

function ensureIndependentReceipts(receipts) {
  const identities = [new Set(), new Set(), new Set(), new Set(), new Set()];
  for (const receipt of receipts) {
    const values = [
      receipt.receiptUid,
      receipt.mode,
      receipt.promptId,
      receipt.output.assetVersionUid,
      receipt.output.evidence.sha256,
    ];
    values.forEach((value, index) => {
      if (identities[index].has(value)) invalid();
      identities[index].add(value);
    });
  }
}

function evaluateH3Phase7Evidence(value) {
  const gateInput = snapshot(value, CODE, {
    ...RECEIPT_LIMITS,
    maxEntries: 65_536,
    maxTotalBytes: 4 * 1024 * 1024,
  });
  exactKeys(gateInput, ['environment', 'receipts'], CODE);
  const environment = validateH3RealGpuEnvironment(gateInput.environment);
  const input = gateInput.receipts;
  if (!Array.isArray(input) || input.length > H3_PHASE_7_REQUIRED_MODES.length) invalid();
  const receipts = input.map(validateH3RealValidationReceipt);
  if (receipts.some((receipt) => receipt.gpuClass !== PHASE_7_GPU_CLASS)) invalid();
  ensureIndependentReceipts(receipts);
  if (receipts.some((receipt) => !trustedWorkflowMatches(
    receipt.mode,
    receipt.manifest,
    receipt.generationSpec,
  ))) invalid();

  const byMode = new Map(receipts.map((receipt) => [receipt.mode, receipt]));
  const acceptedReceiptModes = H3_PHASE_7_REQUIRED_MODES.filter((mode) => byMode.has(mode));
  const missingModes = H3_PHASE_7_REQUIRED_MODES.filter(
    (mode) => !acceptedReceiptModes.includes(mode),
  );
  const workflowUnavailableModes = H3_PHASE_7_REQUIRED_MODES.filter(
    (mode) => !TRUSTED_MANIFESTS.has(mode),
  );
  const orderedReceipts = H3_PHASE_7_REQUIRED_MODES
    .map((mode) => byMode.get(mode))
    .filter(Boolean);
  return snapshot({
    schemaVersion: 'h3-phase7-evidence-gate.v1',
    profileUid: H3_PROFILE.uid,
    profileRevision: H3_PROFILE.revision,
    profileSha256: H3_PROFILE_SHA256,
    environmentSha256: sha256Canonical(environment),
    gpuClass: PHASE_7_GPU_CLASS,
    evidenceComplete: missingModes.length === 0 && workflowUnavailableModes.length === 0,
    acceptedReceiptModes,
    missingModes,
    workflowUnavailableModes,
    receiptCount: receipts.length,
    receiptsSha256: sha256Canonical(orderedReceipts),
  }, CODE);
}

function collectorConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== 2
    || !descriptors.inspector?.enumerable
    || !Object.hasOwn(descriptors.inspector, 'value')
    || !descriptors.environment?.enumerable
    || !Object.hasOwn(descriptors.environment, 'value')
    || !isH3LocalVideoInspector(descriptors.inspector.value)) invalid();
  const environment = validateH3RealGpuEnvironment(descriptors.environment.value);
  return Object.freeze({
    inspector: descriptors.inspector.value,
    environmentSha256: sha256Canonical(environment),
  });
}

function collectInput(value) {
  const input = snapshot(value, CODE, RECEIPT_LIMITS);
  exactKeys(input, COLLECT_FIELDS, CODE);
  uid(input.receiptUid, CODE);
  uid(input.promptId, CODE);
  uid(input.assetVersionUid, CODE);
  sha256(input.remoteSha256, CODE);
  if (!H3_REAL_VALIDATION_GPU_CLASSES.has(input.gpuClass)
    || !Number.isSafeInteger(input.remoteBytes) || input.remoteBytes < 1
    || input.remoteBytes > 20_000_000_000) invalid();
  const manifest = storedManifest(input.manifest);
  const spec = generationSpec(input.generationSpec);
  if (!capturableWorkflowMatches(manifest, spec)) fail('H3_WORKFLOW_UNVERIFIED');
  return Object.freeze({ input, manifest, spec });
}

async function inspectAndSeal(configured, validated) {
  try {
    const { input, manifest, spec } = validated;
    const measured = await configured.inspector.inspect({
      localRelativePath: input.localRelativePath,
      expected: {
        width: spec.width,
        height: spec.height,
        durationMs: Math.round((spec.frames / spec.fps) * 1000),
        frames: spec.frames,
        fps: spec.fps,
      },
      remoteSha256: input.remoteSha256,
      remoteBytes: input.remoteBytes,
    });
    const evidence = validateH3VideoOutput({ generationSpec: spec, measured });
    const payload = snapshot({
      schemaVersion: 'h3-real-validation-receipt.v1',
      receiptUid: input.receiptUid,
      profileUid: H3_PROFILE.uid,
      profileRevision: H3_PROFILE.revision,
      profileSha256: H3_PROFILE_SHA256,
      environmentSha256: configured.environmentSha256,
      gpuClass: input.gpuClass,
      captureKind: 'local-comfyui',
      mode: spec.mode,
      promptId: input.promptId,
      capturedAtEpochMs: Date.now(),
      manifest,
      generationSpec: spec,
      output: { assetVersionUid: input.assetVersionUid, evidence },
    }, CODE, RECEIPT_LIMITS);
    return validateH3RealValidationReceipt({
      ...payload,
      receiptSha256: sha256Canonical(payload),
    });
  } catch {
    return invalid();
  }
}

function createH3RealValidationCollector(options) {
  const configured = collectorConfiguration(options);
  return Object.freeze({
    collect(value) {
      const validated = collectInput(value);
      return inspectAndSeal(configured, validated);
    },
  });
}

module.exports = Object.freeze({
  H3_PHASE_7_REQUIRED_MODES,
  createH3RealValidationCollector,
  evaluateH3Phase7Evidence,
  validateH3RealValidationReceipt,
});
