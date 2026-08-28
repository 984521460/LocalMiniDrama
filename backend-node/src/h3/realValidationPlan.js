'use strict';

const {
  exactKeys,
  sha256,
  sha256Canonical,
  snapshot,
  uid,
} = require('./contract');
const { fail } = require('./errors');
const { RTX_4090_GPU_CLASS } = require('./gpuClasses');
const { validateH3GenerationSpec } = require('./generationSpec');
const { H3_PROFILE } = require('./profile');
const {
  compileH3GenerationWorkflow,
  createH3TextToVideoWorkflowBundle,
} = require('./workflowBundle');
const {
  compileH3WorkflowCandidate,
  createH3WorkflowCandidateBundle,
} = require('./workflowCandidates');

const CODE = 'H3_REAL_VALIDATION_INVALID';
const H3_PHASE_7_VALIDATION_MODES = Object.freeze([
  't2v', 'fl2va-first', 'fl2va-first-last', 'ref2va',
]);
const PLAN_FIELDS = Object.freeze([
  'schemaVersion', 'planUid', 'profileUid', 'gpuClass', 'status', 'cases', 'planSha256',
]);
const CASE_FIELDS = Object.freeze([
  'mode', 'supportStatus', 'source', 'manifest', 'generationSpec', 'filenamePrefix',
  'mediaBindings', 'prompt', 'promptSha256', 'outputNodeIds', 'nativeAudioOutput',
  'expectedOutput',
]);
const LIMITS = Object.freeze({
  maxArrayLength: 5000,
  maxDepth: 48,
  maxEntries: 250_000,
  maxStringBytes: 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
});

function invalid() {
  fail(CODE);
}

function validationVariant(spec) {
  return {
    mode: spec.mode,
    referenceImageCount: spec.referenceImages.length,
    referenceAudio: spec.referenceAudio !== null,
  };
}

function assertCoverageCase(spec, expectedMode) {
  if (spec.mode !== expectedMode) invalid();
  if (expectedMode === 'ref2va'
    && (spec.referenceImages.length !== 4 || spec.referenceAudio === null)) invalid();
}

function compileCase(input, expectedMode) {
  exactKeys(input, ['generationSpec', 'filenamePrefix', 'mediaBindings'], CODE);
  const spec = validateH3GenerationSpec(input.generationSpec);
  assertCoverageCase(spec, expectedMode);

  let compiled;
  let bundle;
  let supportStatus;
  let source;
  if (spec.mode === 't2v') {
    if (input.mediaBindings !== null) invalid();
    try {
      compiled = compileH3GenerationWorkflow({
        generationSpec: spec,
        filenamePrefix: input.filenamePrefix,
      });
    } catch {
      return invalid();
    }
    bundle = createH3TextToVideoWorkflowBundle();
    supportStatus = 'trusted-workflow';
    source = null;
  } else {
    if (input.mediaBindings === null) invalid();
    try {
      compiled = compileH3WorkflowCandidate({
        generationSpec: spec,
        filenamePrefix: input.filenamePrefix,
        mediaBindings: input.mediaBindings,
      });
      bundle = createH3WorkflowCandidateBundle(validationVariant(spec));
    } catch {
      return invalid();
    }
    supportStatus = compiled.supportStatus;
    source = bundle.source;
  }

  if (compiled.manifestUid !== bundle.manifest.uid
    || compiled.workflowSha256 !== bundle.manifest.workflowSha256
    || H3_PROFILE.modes[spec.mode]?.nativeAudioOutput !== true) invalid();

  return snapshot({
    mode: spec.mode,
    supportStatus,
    source,
    manifest: bundle.manifest,
    generationSpec: spec,
    filenamePrefix: input.filenamePrefix,
    mediaBindings: input.mediaBindings,
    prompt: compiled.prompt,
    promptSha256: sha256Canonical(compiled.prompt),
    outputNodeIds: compiled.outputNodeIds,
    nativeAudioOutput: true,
    expectedOutput: {
      width: spec.width,
      height: spec.height,
      frames: spec.frames,
      fps: spec.fps,
      durationMs: Math.round((spec.frames / spec.fps) * 1000),
    },
  }, CODE, LIMITS);
}

function planPayload(plan) {
  return Object.fromEntries(PLAN_FIELDS
    .filter((field) => field !== 'planSha256')
    .map((field) => [field, plan[field]]));
}

function createH3Phase7ValidationPlan(value) {
  const input = snapshot(value, CODE, LIMITS);
  exactKeys(input, ['planUid', 'gpuClass', 'cases'], CODE);
  uid(input.planUid, CODE);
  if (input.gpuClass !== RTX_4090_GPU_CLASS
    || !Array.isArray(input.cases)
    || input.cases.length !== H3_PHASE_7_VALIDATION_MODES.length) invalid();

  const cases = input.cases.map((entry, index) => (
    compileCase(entry, H3_PHASE_7_VALIDATION_MODES[index])
  ));
  if (new Set(cases.map(({ promptSha256 }) => promptSha256)).size !== cases.length
    || new Set(cases.map(({ filenamePrefix }) => filenamePrefix)).size !== cases.length) invalid();

  const payload = snapshot({
    schemaVersion: 'h3-phase7-validation-plan.v1',
    planUid: input.planUid,
    profileUid: H3_PROFILE.uid,
    gpuClass: input.gpuClass,
    status: 'prepared-unverified',
    cases,
  }, CODE, LIMITS);
  return snapshot({
    ...payload,
    planSha256: sha256Canonical(payload),
  }, CODE, LIMITS);
}

function validateH3Phase7ValidationPlan(value) {
  const stored = snapshot(value, CODE, LIMITS);
  exactKeys(stored, PLAN_FIELDS, CODE);
  uid(stored.planUid, CODE);
  sha256(stored.planSha256, CODE);
  if (stored.schemaVersion !== 'h3-phase7-validation-plan.v1'
    || stored.profileUid !== H3_PROFILE.uid
    || stored.gpuClass !== RTX_4090_GPU_CLASS
    || stored.status !== 'prepared-unverified'
    || !Array.isArray(stored.cases)
    || stored.cases.length !== H3_PHASE_7_VALIDATION_MODES.length
    || sha256Canonical(planPayload(stored)) !== stored.planSha256) invalid();
  stored.cases.forEach((entry) => exactKeys(entry, CASE_FIELDS, CODE));
  const rebuilt = createH3Phase7ValidationPlan({
    planUid: stored.planUid,
    gpuClass: stored.gpuClass,
    cases: stored.cases.map((entry) => ({
      generationSpec: entry.generationSpec,
      filenamePrefix: entry.filenamePrefix,
      mediaBindings: entry.mediaBindings,
    })),
  });
  if (sha256Canonical(stored) !== sha256Canonical(rebuilt)) invalid();
  return stored;
}

module.exports = Object.freeze({
  H3_PHASE_7_VALIDATION_MODES,
  createH3Phase7ValidationPlan,
  validateH3Phase7ValidationPlan,
});
