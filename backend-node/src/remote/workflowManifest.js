'use strict';

const { snapshotJson } = require('../workflows/jsonSnapshot');
const { compileComfyWorkflow } = require('../integrations/comfyui/workflowCompiler');
const { convertComfyApiWorkflow, MARKER } = require('../integrations/comfyui/workflowConverter');
const { loadComfyWorkflowJson } = require('../integrations/comfyui/workflowLoader');
const { createComfyManifestError } = require('./comfyManifestErrors');

const MANIFEST_SCHEMA_VERSION = 'comfy-workflow-manifest.v1';
const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MANIFEST_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const VERSION = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/u;
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u;
const MODEL_FAMILY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const VALUE_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'string-array']);
const BRANDED_MANIFESTS = new WeakSet();

function fail(code = 'COMFY_MANIFEST_INVALID') {
  throw createComfyManifestError(code);
}

function exactKeys(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail();
  const actual = Object.keys(value);
  if (actual.length !== keys.length
    || actual.some((key) => !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(value, key))) fail();
}

function boundedText(value, pattern, maxBytes) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && pattern.test(value);
}

function safeRelativePath(value, maxBytes = 1024) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\\')
    || value.includes(':') || value.startsWith('/') || value.endsWith('/')) return false;
  const segments = value.split('/');
  return segments.length <= 32 && segments.every((segment) => (
    segment !== '.' && segment !== '..' && SAFE_SEGMENT.test(segment)
  ));
}

function validateRequirements(requirements) {
  if (!Array.isArray(requirements) || requirements.length < 1 || requirements.length > 256) fail();
  const identities = new Set();
  const nodeTypes = new Set();
  for (const requirement of requirements) {
    if (requirement?.kind === 'node') {
      exactKeys(requirement, ['kind', 'nodeType']);
      if (!boundedText(requirement.nodeType, NAME, 256)) fail();
      const identity = `node\0${requirement.nodeType}`;
      if (identities.has(identity)) fail();
      identities.add(identity);
      nodeTypes.add(requirement.nodeType);
      continue;
    }
    if (requirement?.kind === 'model') {
      exactKeys(requirement, ['kind', 'nodeType', 'inputName', 'fileName']);
      if (!boundedText(requirement.nodeType, NAME, 256)
        || !boundedText(requirement.inputName, NAME, 128)
        || !safeRelativePath(requirement.fileName)) fail();
      const identity = `model\0${requirement.nodeType}\0${requirement.inputName}\0${requirement.fileName}`;
      if (identities.has(identity)) fail();
      identities.add(identity);
      continue;
    }
    fail();
  }
  return nodeTypes;
}

function validateBindings(inputs, outputs) {
  if (!inputs || Array.isArray(inputs) || typeof inputs !== 'object'
    || !outputs || Array.isArray(outputs) || typeof outputs !== 'object') fail();
  const inputNames = Object.keys(inputs);
  const outputNames = Object.keys(outputs);
  if (inputNames.length < 1 || inputNames.length > 64
    || outputNames.length < 1 || outputNames.length > 16
    || [...inputNames, ...outputNames].some((name) => !boundedText(name, NAME, 128))) fail();

  const inputTargets = new Set();
  for (const binding of Object.values(inputs)) {
    exactKeys(binding, ['marker', 'inputName', 'valueType', 'required']);
    if (!boundedText(binding.marker, MARKER, 256) || !boundedText(binding.inputName, NAME, 128)
      || !VALUE_TYPES.has(binding.valueType) || typeof binding.required !== 'boolean') fail();
    const target = `${binding.marker}\0${binding.inputName}`;
    if (inputTargets.has(target)) fail();
    inputTargets.add(target);
  }
  const outputTargets = new Set();
  for (const binding of Object.values(outputs)) {
    exactKeys(binding, ['marker']);
    if (!boundedText(binding.marker, MARKER, 256) || outputTargets.has(binding.marker)) fail();
    outputTargets.add(binding.marker);
  }
}

function snapshotManifest(value) {
  let manifest;
  try {
    manifest = snapshotJson(value, {
      maxArrayLength: 256,
      maxDepth: 8,
      maxEntries: 2048,
      maxStringBytes: 4096,
      maxTotalBytes: 256 * 1024,
    });
  } catch {
    fail();
  }
  exactKeys(manifest, [
    'schemaVersion', 'uid', 'manifestId', 'version', 'engine', 'workflowFile',
    'workflowSha256', 'modelFamily', 'requirements', 'inputs', 'outputs',
    'validation', 'status',
  ]);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || !UID.test(manifest.uid)
    || !boundedText(manifest.manifestId, MANIFEST_ID, 120)
    || !boundedText(manifest.version, VERSION, 64) || manifest.engine !== 'comfyui'
    || !safeRelativePath(manifest.workflowFile) || !SHA256.test(manifest.workflowSha256)
    || !boundedText(manifest.modelFamily, MODEL_FAMILY, 120)
    || manifest.status !== 'validated') fail();
  const nodeTypes = validateRequirements(manifest.requirements);
  validateBindings(manifest.inputs, manifest.outputs);
  exactKeys(manifest.validation, ['schemaVersion', 'workflowFormat', 'markersValidated']);
  if (manifest.validation.schemaVersion !== MANIFEST_SCHEMA_VERSION
    || manifest.validation.workflowFormat !== 'api'
    || manifest.validation.markersValidated !== true) fail();
  return Object.freeze({ manifest, nodeTypes });
}

function placeholderValues(inputs) {
  const values = Object.create(null);
  const placeholders = Object.freeze({
    string: '', integer: 0, number: 0, boolean: false, 'string-array': Object.freeze([]),
  });
  for (const [logicalName, binding] of Object.entries(inputs)) {
    values[logicalName] = placeholders[binding.valueType];
  }
  return values;
}

function assertWorkflowClosure(manifest, nodeTypes, workflow) {
  let converted;
  try { converted = convertComfyApiWorkflow(workflow); } catch { fail(); }
  const actualNodeTypes = new Set(Object.values(converted.graph).map((node) => node.class_type));
  if (actualNodeTypes.size !== nodeTypes.size
    || [...actualNodeTypes].some((nodeType) => !nodeTypes.has(nodeType))) fail();

  for (const requirement of manifest.requirements) {
    if (requirement.kind !== 'model') continue;
    const matches = Object.values(converted.graph).some((node) => (
      node.class_type === requirement.nodeType
      && Object.hasOwn(node.inputs, requirement.inputName)
      && node.inputs[requirement.inputName] === requirement.fileName
    ));
    if (!matches) fail();
  }
  try {
    compileComfyWorkflow({
      convertedWorkflow: converted,
      inputBindings: manifest.inputs,
      outputBindings: manifest.outputs,
      values: placeholderValues(manifest.inputs),
    });
  } catch {
    fail();
  }
}

function createComfyWorkflowManifest(value, workflowBytes) {
  const { manifest, nodeTypes } = snapshotManifest(value);
  let loaded;
  try { loaded = loadComfyWorkflowJson(workflowBytes); } catch { fail(); }
  if (loaded.sha256 !== manifest.workflowSha256) fail('COMFY_MANIFEST_WORKFLOW_MISMATCH');
  assertWorkflowClosure(manifest, nodeTypes, loaded.workflow);
  BRANDED_MANIFESTS.add(manifest);
  return manifest;
}

function validateStoredComfyWorkflowManifest(value) {
  return snapshotManifest(value).manifest;
}

function isComfyWorkflowManifest(value) {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null && BRANDED_MANIFESTS.has(value);
}

module.exports = Object.freeze({
  MANIFEST_SCHEMA_VERSION,
  createComfyWorkflowManifest,
  isComfyWorkflowManifest,
  validateStoredComfyWorkflowManifest,
});
