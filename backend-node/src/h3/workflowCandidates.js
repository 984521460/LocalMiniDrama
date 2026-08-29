'use strict';

const { createHash } = require('node:crypto');

const {
  buildH3FirstLastFrameCandidateGraph,
  buildH3ReferenceToVideoCandidateGraph,
} = require('../integrations/comfyui/h3WorkflowCandidates');
const { compileComfyWorkflow } = require('../integrations/comfyui/workflowCompiler');
const { convertComfyApiWorkflow } = require('../integrations/comfyui/workflowConverter');
const { createComfyWorkflowManifest } = require('../remote/workflowManifest');
const { exactKeys, snapshot } = require('./contract');
const { fail } = require('./errors');
const { validateH3GenerationSpec } = require('./generationSpec');
const { H3_PROFILE } = require('./profile');
const { H3_OFFICIAL_WORKFLOW_SOURCES, H3_REF2VA_MODEL_FILES } = require('./workflowSources');
const { isH3Phase7WorkflowVariantTrusted } = require('./workflowTrust');

const CODE = 'H3_GENERATION_INPUT_INVALID';
const UNVERIFIED_SUPPORT_STATUS = 'implementation-candidate-unverified';
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const BUNDLES = new Map();
const PUBLIC_BUNDLES = new Map();
const VARIANT_UIDS = Object.freeze({
  'fl2va-first:1:0': '7f100000-0000-4000-8000-000000000001',
  'fl2va-first-last:2:0': '7f100000-0000-4000-8000-000000000002',
  'ref2va:1:0': '7f100000-0000-4000-8000-000000000101',
  'ref2va:1:1': '7f100000-0000-4000-8000-000000000111',
  'ref2va:2:0': '7f100000-0000-4000-8000-000000000201',
  'ref2va:2:1': '7f100000-0000-4000-8000-000000000211',
  'ref2va:3:0': '7f100000-0000-4000-8000-000000000301',
  'ref2va:3:1': '7f100000-0000-4000-8000-000000000311',
  'ref2va:4:0': '7f100000-0000-4000-8000-000000000401',
  'ref2va:4:1': '7f100000-0000-4000-8000-000000000411',
});

function safeRelativeInputFile(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > 512 || value.includes('\\') || value.includes(':')
    || value.startsWith('/') || value.endsWith('/')) fail(CODE);
  const segments = value.split('/');
  if (segments.length > 16 || segments.some((segment) => (
    segment === '.' || segment === '..' || !SAFE_SEGMENT.test(segment)
  ))) fail(CODE);
  return value;
}

function variant(input) {
  const value = snapshot(input, CODE, { maxDepth: 4, maxEntries: 16, maxTotalBytes: 4096 });
  exactKeys(value, ['mode', 'referenceImageCount', 'referenceAudio'], CODE);
  if (!['fl2va-first', 'fl2va-first-last', 'ref2va'].includes(value.mode)
    || !Number.isSafeInteger(value.referenceImageCount)
    || typeof value.referenceAudio !== 'boolean') fail(CODE);
  if ((value.mode === 'fl2va-first'
      && (value.referenceImageCount !== 1 || value.referenceAudio))
    || (value.mode === 'fl2va-first-last'
      && (value.referenceImageCount !== 2 || value.referenceAudio))
    || (value.mode === 'ref2va'
      && (value.referenceImageCount < 1 || value.referenceImageCount > 4))) fail(CODE);
  const key = `${value.mode}:${value.referenceImageCount}:${value.referenceAudio ? 1 : 0}`;
  if (!Object.hasOwn(VARIANT_UIDS, key)) fail(CODE);
  return Object.freeze({ ...value, key });
}

function modelRequirements(mode) {
  const entries = mode === 'ref2va'
    ? [
      ['UNETLoader', 'unet_name', H3_REF2VA_MODEL_FILES.diffusionModel],
      ['CLIPLoader', 'clip_name', H3_PROFILE.models.textEncoder.fileName],
      ['VAELoader', 'vae_name', H3_PROFILE.models.videoVae.fileName],
      ['VAELoader', 'vae_name', H3_PROFILE.models.audioVae.fileName],
      ['LoraLoaderModelOnly', 'lora_name', H3_REF2VA_MODEL_FILES.turboLora4Step],
    ]
    : Object.values(H3_PROFILE.models).map((entry) => (
      [entry.nodeType, entry.inputName, entry.fileName]
    ));
  return entries.map(([nodeType, inputName, fileName]) => ({
    kind: 'model', nodeType, inputName, fileName,
  }));
}

function manifestId(value) {
  if (value.mode === 'fl2va-first') return 'minimax-h3-fl2va-first-local-v1';
  if (value.mode === 'fl2va-first-last') return 'minimax-h3-fl2va-first-last-local-v1';
  return `minimax-h3-ref2va-${value.referenceImageCount}-image${
    value.referenceAudio ? '-audio' : ''}-local-v1`;
}

function workflowFile(value) {
  return `workflows/v7/${manifestId(value)}-api.json`;
}

function inputBindings(value) {
  const inputs = {
    prompt: { marker: 'APP_H3_GENERATION', inputName: 'prompt', valueType: 'string', required: true },
    width: { marker: 'APP_H3_GENERATION', inputName: 'width', valueType: 'integer', required: true },
    height: { marker: 'APP_H3_GENERATION', inputName: 'height', valueType: 'integer', required: true },
    frames: { marker: 'APP_H3_GENERATION', inputName: 'length', valueType: 'integer', required: true },
    seed: { marker: 'APP_H3_SEED', inputName: 'noise_seed', valueType: 'integer', required: true },
    filenamePrefix: {
      marker: 'APP_H3_OUTPUT_VIDEO', inputName: 'filename_prefix', valueType: 'string', required: true,
    },
  };
  for (let index = 0; index < value.referenceImageCount; index += 1) {
    inputs[`referenceImage${index + 1}`] = {
      marker: `APP_H3_REFERENCE_IMAGE_${index + 1}`,
      inputName: 'image',
      valueType: 'string',
      required: true,
    };
  }
  if (value.referenceAudio) {
    inputs.referenceAudio = {
      marker: 'APP_H3_REFERENCE_AUDIO',
      inputName: 'audio',
      valueType: 'string',
      required: true,
    };
  }
  return inputs;
}

function buildBundle(value) {
  const graph = value.mode === 'ref2va'
    ? buildH3ReferenceToVideoCandidateGraph(value)
    : buildH3FirstLastFrameCandidateGraph(value.mode);
  const workflowJson = JSON.stringify(graph);
  const workflowBytes = Buffer.from(workflowJson, 'utf8');
  const nodeRequirements = [...new Set(Object.values(graph).map(({ class_type: nodeType }) => nodeType))]
    .sort()
    .map((nodeType) => ({ kind: 'node', nodeType }));
  const manifest = createComfyWorkflowManifest({
    schemaVersion: 'comfy-workflow-manifest.v1',
    uid: VARIANT_UIDS[value.key],
    manifestId: manifestId(value),
    version: '1.0.0',
    engine: 'comfyui',
    workflowFile: workflowFile(value),
    workflowSha256: createHash('sha256').update(workflowBytes).digest('hex'),
    modelFamily: H3_PROFILE.modelFamily,
    requirements: [...nodeRequirements, ...modelRequirements(value.mode)],
    inputs: inputBindings(value),
    outputs: { video: { marker: 'APP_H3_OUTPUT_VIDEO' } },
    validation: {
      schemaVersion: 'comfy-workflow-manifest.v1',
      workflowFormat: 'api',
      markersValidated: true,
    },
    status: 'validated',
  }, workflowBytes);
  return Object.freeze({
    supportStatus: isH3Phase7WorkflowVariantTrusted(value)
      ? 'trusted-workflow'
      : UNVERIFIED_SUPPORT_STATUS,
    workflowJson,
    manifest,
    source: value.mode === 'ref2va'
      ? H3_OFFICIAL_WORKFLOW_SOURCES.ref2v
      : H3_OFFICIAL_WORKFLOW_SOURCES.i2v,
    convertedWorkflow: convertComfyApiWorkflow(graph),
  });
}

function internalBundle(input) {
  const value = variant(input);
  if (!BUNDLES.has(value.key)) BUNDLES.set(value.key, buildBundle(value));
  return BUNDLES.get(value.key);
}

function createH3WorkflowCandidateBundle(input) {
  const value = variant(input);
  if (!BUNDLES.has(value.key)) BUNDLES.set(value.key, buildBundle(value));
  const bundle = BUNDLES.get(value.key);
  if (!PUBLIC_BUNDLES.has(value.key)) {
    PUBLIC_BUNDLES.set(value.key, Object.freeze({
      supportStatus: bundle.supportStatus,
      workflowJson: bundle.workflowJson,
      manifest: bundle.manifest,
      source: bundle.source,
    }));
  }
  return PUBLIC_BUNDLES.get(value.key);
}

function mediaExtension(evidence) {
  const extensions = {
    'image/jpeg': ['.jpeg', '.jpg'],
    'image/png': ['.png'],
    'image/webp': ['.webp'],
    'audio/flac': ['.flac'],
    'audio/mpeg': ['.mp3'],
    'audio/wav': ['.wav'],
    'audio/x-wav': ['.wav'],
  }[evidence.mimeType];
  if (!extensions) fail(CODE);
  return extensions;
}

function mediaBinding(value, evidence) {
  exactKeys(value, ['assetVersionUid', 'sha256', 'fileName'], CODE);
  if (value.assetVersionUid !== evidence.assetVersionUid || value.sha256 !== evidence.sha256) fail(CODE);
  const fileName = safeRelativeInputFile(value.fileName);
  if (!mediaExtension(evidence).some((extension) => fileName.endsWith(extension))) fail(CODE);
  return fileName;
}

function compileH3WorkflowCandidate(input) {
  const root = snapshot(input, CODE, {
    maxArrayLength: 64,
    maxDepth: 40,
    maxEntries: 60_000,
    maxStringBytes: 512 * 1024,
    maxTotalBytes: 8 * 1024 * 1024,
  });
  exactKeys(root, ['generationSpec', 'filenamePrefix', 'mediaBindings'], CODE);
  const spec = validateH3GenerationSpec(root.generationSpec);
  if (spec.mode === 't2v') fail(CODE);
  if (spec.referenceAudio !== null && spec.mode !== 'ref2va') fail('H3_WORKFLOW_UNVERIFIED');
  exactKeys(root.mediaBindings, ['referenceImages', 'referenceAudio'], CODE);
  if (!Array.isArray(root.mediaBindings.referenceImages)
    || root.mediaBindings.referenceImages.length !== spec.referenceImages.length) fail(CODE);
  const imageFiles = root.mediaBindings.referenceImages.map((entry, index) => (
    mediaBinding(entry, spec.referenceImages[index])
  ));
  let audioFile = null;
  if (spec.referenceAudio === null) {
    if (root.mediaBindings.referenceAudio !== null) fail(CODE);
  } else {
    if (root.mediaBindings.referenceAudio === null) fail(CODE);
    audioFile = mediaBinding(root.mediaBindings.referenceAudio, spec.referenceAudio);
  }
  const allFiles = audioFile === null ? imageFiles : [...imageFiles, audioFile];
  if (new Set(allFiles).size !== allFiles.length) fail(CODE);
  const bundle = internalBundle({
    mode: spec.mode,
    referenceImageCount: spec.referenceImages.length,
    referenceAudio: spec.referenceAudio !== null,
  });
  const values = {
    prompt: spec.prompt.text,
    width: spec.width,
    height: spec.height,
    frames: spec.frames,
    seed: spec.seed,
    filenamePrefix: safeRelativeInputFile(root.filenamePrefix),
  };
  imageFiles.forEach((fileName, index) => { values[`referenceImage${index + 1}`] = fileName; });
  if (audioFile !== null) values.referenceAudio = audioFile;
  let compiled;
  try {
    compiled = compileComfyWorkflow({
      convertedWorkflow: bundle.convertedWorkflow,
      inputBindings: bundle.manifest.inputs,
      outputBindings: bundle.manifest.outputs,
      values,
    });
  } catch {
    return fail(CODE);
  }
  return snapshot({
    supportStatus: bundle.supportStatus,
    manifestUid: bundle.manifest.uid,
    workflowSha256: bundle.manifest.workflowSha256,
    prompt: compiled.prompt,
    outputNodeIds: compiled.outputNodeIds,
    nativeAudioOutput: true,
  }, CODE, {
    maxArrayLength: 5000,
    maxDepth: 40,
    maxEntries: 60_000,
    maxStringBytes: 512 * 1024,
    maxTotalBytes: 8 * 1024 * 1024,
  });
}

module.exports = Object.freeze({
  H3_OFFICIAL_WORKFLOW_SOURCES,
  compileH3WorkflowCandidate,
  createH3WorkflowCandidateBundle,
});
