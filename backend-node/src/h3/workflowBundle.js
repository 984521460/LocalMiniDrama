'use strict';

const { createHash } = require('node:crypto');

const { buildMinimaxH3TextToVideoPrompt } = require('../integrations/comfyui/workflows');
const { compileComfyWorkflow } = require('../integrations/comfyui/workflowCompiler');
const { convertComfyApiWorkflow } = require('../integrations/comfyui/workflowConverter');
const { createComfyWorkflowManifest } = require('../remote/workflowManifest');
const { exactKeys, snapshot } = require('./contract');
const { fail } = require('./errors');
const { validateH3GenerationSpec } = require('./generationSpec');
const { H3_PROFILE } = require('./profile');
const { assertH3WorkflowVerified } = require('./workflowSupport');

const CODE = 'H3_GENERATION_INPUT_INVALID';
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function workflowGraph() {
  const graph = buildMinimaxH3TextToVideoPrompt({
    prompt: 'A quiet cinematic scene unfolds with clear motion.',
    width: 608,
    height: 352,
    durationSeconds: 1,
    seed: 0,
    filenamePrefix: 'video/H3_contract',
  });
  graph[131]._meta = { title: 'APP_H3_GENERATION' };
  graph[129]._meta = { title: 'APP_H3_SEED' };
  graph[92]._meta = { title: 'APP_H3_OUTPUT_VIDEO' };
  return graph;
}

function requirements(graph) {
  const nodeTypes = [...new Set(Object.values(graph).map((node) => node.class_type))].sort();
  const nodeRequirements = nodeTypes.map((nodeType) => ({ kind: 'node', nodeType }));
  const modelRequirements = Object.values(H3_PROFILE.models).map((entry) => ({
    kind: 'model',
    nodeType: entry.nodeType,
    inputName: entry.inputName,
    fileName: entry.fileName,
  }));
  return [...nodeRequirements, ...modelRequirements];
}

function createBundle() {
  const graph = workflowGraph();
  const workflowJson = JSON.stringify(graph);
  const workflowBytes = Buffer.from(workflowJson, 'utf8');
  const manifest = createComfyWorkflowManifest({
    schemaVersion: 'comfy-workflow-manifest.v1',
    uid: '77adf73c-acf1-4b6b-9a88-b76b175d2d2c',
    manifestId: 'minimax-h3-t2v-local-v1',
    version: '1.0.0',
    engine: 'comfyui',
    workflowFile: 'workflows/v7/minimax-h3-t2v-api.json',
    workflowSha256: createHash('sha256').update(workflowBytes).digest('hex'),
    modelFamily: H3_PROFILE.modelFamily,
    requirements: requirements(graph),
    inputs: {
      prompt: { marker: 'APP_H3_GENERATION', inputName: 'prompt', valueType: 'string', required: true },
      width: { marker: 'APP_H3_GENERATION', inputName: 'width', valueType: 'integer', required: true },
      height: { marker: 'APP_H3_GENERATION', inputName: 'height', valueType: 'integer', required: true },
      frames: { marker: 'APP_H3_GENERATION', inputName: 'length', valueType: 'integer', required: true },
      seed: { marker: 'APP_H3_SEED', inputName: 'noise_seed', valueType: 'integer', required: true },
      filenamePrefix: { marker: 'APP_H3_OUTPUT_VIDEO', inputName: 'filename_prefix', valueType: 'string', required: true },
    },
    outputs: { video: { marker: 'APP_H3_OUTPUT_VIDEO' } },
    validation: {
      schemaVersion: 'comfy-workflow-manifest.v1',
      workflowFormat: 'api',
      markersValidated: true,
    },
    status: 'validated',
  }, workflowBytes);
  return Object.freeze({
    workflowJson,
    manifest,
    convertedWorkflow: convertComfyApiWorkflow(graph),
  });
}

const INTERNAL_BUNDLE = createBundle();
const PUBLIC_BUNDLE = Object.freeze({
  workflowJson: INTERNAL_BUNDLE.workflowJson,
  manifest: INTERNAL_BUNDLE.manifest,
});

function safePrefix(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > 512 || value.includes('\\') || value.includes(':')
    || value.startsWith('/') || value.endsWith('/')) fail(CODE);
  const segments = value.split('/');
  if (segments.length > 16 || segments.some((segment) => (
    segment === '.' || segment === '..' || !SAFE_SEGMENT.test(segment)
  ))) fail(CODE);
  return value;
}

function createH3TextToVideoWorkflowBundle() {
  return PUBLIC_BUNDLE;
}

function compileH3GenerationWorkflow(input) {
  const root = snapshot(input, CODE, {
    maxStringBytes: 64 * 1024,
    maxTotalBytes: 512 * 1024,
  });
  exactKeys(root, ['generationSpec', 'filenamePrefix'], CODE);
  const spec = validateH3GenerationSpec(root.generationSpec);
  assertH3WorkflowVerified(spec);
  const filenamePrefix = safePrefix(root.filenamePrefix);
  let compiled;
  try {
    compiled = compileComfyWorkflow({
      convertedWorkflow: INTERNAL_BUNDLE.convertedWorkflow,
      inputBindings: INTERNAL_BUNDLE.manifest.inputs,
      outputBindings: INTERNAL_BUNDLE.manifest.outputs,
      values: {
        prompt: spec.prompt.text,
        width: spec.width,
        height: spec.height,
        frames: spec.frames,
        seed: spec.seed,
        filenamePrefix,
      },
    });
  } catch {
    return fail(CODE);
  }
  return snapshot({
    manifestUid: INTERNAL_BUNDLE.manifest.uid,
    workflowSha256: INTERNAL_BUNDLE.manifest.workflowSha256,
    prompt: compiled.prompt,
    outputNodeIds: compiled.outputNodeIds,
  }, CODE, {
    maxArrayLength: 5000,
    maxDepth: 40,
    maxEntries: 60_000,
    maxStringBytes: 512 * 1024,
    maxTotalBytes: 8 * 1024 * 1024,
  });
}

module.exports = Object.freeze({
  compileH3GenerationWorkflow,
  createH3TextToVideoWorkflowBundle,
});
