'use strict';

const { snapshotJson } = require('../../workflows/jsonSnapshot');
const { convertComfyApiWorkflow, MARKER } = require('./workflowConverter');
const { createComfyWorkflowError } = require('./workflowErrors');

const LOGICAL_NAME = /^[a-z][A-Za-z0-9]{0,63}$/u;
const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u;
const VALUE_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'string-array']);

function fail(code) {
  throw createComfyWorkflowError(code);
}

function exactKeys(value, keys, code) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(code);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail(code);
}

function inputValue(value, valueType) {
  if (valueType === 'string') {
    return typeof value === 'string' && !value.includes('\0')
      && Buffer.byteLength(value, 'utf8') <= 512 * 1024;
  }
  if (valueType === 'integer') return Number.isSafeInteger(value);
  if (valueType === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (valueType === 'boolean') return typeof value === 'boolean';
  if (valueType === 'string-array') {
    return Array.isArray(value) && value.length <= 64 && value.every((item) => (
      typeof item === 'string' && !item.includes('\0') && Buffer.byteLength(item, 'utf8') <= 4096
    ));
  }
  return false;
}

function compileComfyWorkflow(value) {
  let request;
  try {
    request = snapshotJson(value, {
      maxArrayLength: 5000,
      maxDepth: 40,
      maxEntries: 60000,
      maxStringBytes: 512 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
    });
  } catch {
    fail('COMFY_WORKFLOW_INPUT_INVALID');
  }
  exactKeys(
    request,
    ['convertedWorkflow', 'inputBindings', 'outputBindings', 'values'],
    'COMFY_WORKFLOW_INPUT_INVALID',
  );
  exactKeys(request.convertedWorkflow, ['graph', 'markers'], 'COMFY_WORKFLOW_INPUT_INVALID');
  const converted = convertComfyApiWorkflow(request.convertedWorkflow.graph);

  const maps = [request.inputBindings, request.outputBindings, request.values];
  if (maps.some((map) => !map || Array.isArray(map) || typeof map !== 'object')) {
    fail('COMFY_WORKFLOW_INPUT_INVALID');
  }
  const inputNames = Object.keys(request.inputBindings);
  const outputNames = Object.keys(request.outputBindings);
  const valueNames = Object.keys(request.values);
  if (inputNames.length < 1 || outputNames.length < 1
    || [...inputNames, ...outputNames].some((name) => !LOGICAL_NAME.test(name))) {
    fail('COMFY_WORKFLOW_BINDING_INVALID');
  }
  if (valueNames.some((name) => !Object.hasOwn(request.inputBindings, name))) {
    fail('COMFY_WORKFLOW_INPUT_INVALID');
  }

  const targets = new Set();
  const normalizedInputs = [];
  for (const logicalName of inputNames) {
    const binding = request.inputBindings[logicalName];
    exactKeys(binding, ['marker', 'inputName', 'valueType', 'required'], 'COMFY_WORKFLOW_BINDING_INVALID');
    if (!MARKER.test(binding.marker) || !INPUT_NAME.test(binding.inputName)
      || !VALUE_TYPES.has(binding.valueType) || typeof binding.required !== 'boolean') {
      fail('COMFY_WORKFLOW_BINDING_INVALID');
    }
    const nodeId = converted.markers[binding.marker];
    if (nodeId === undefined || !Object.hasOwn(converted.graph[nodeId].inputs, binding.inputName)) {
      fail('COMFY_WORKFLOW_BINDING_INVALID');
    }
    const target = `${nodeId}\0${binding.inputName}`;
    if (targets.has(target)) fail('COMFY_WORKFLOW_BINDING_INVALID');
    targets.add(target);
    const hasValue = Object.hasOwn(request.values, logicalName);
    if (!hasValue && binding.required) fail('COMFY_WORKFLOW_INPUT_INVALID');
    if (hasValue && !inputValue(request.values[logicalName], binding.valueType)) {
      fail('COMFY_WORKFLOW_INPUT_INVALID');
    }
    normalizedInputs.push(Object.freeze({ binding, hasValue, logicalName, nodeId }));
  }

  const outputNodeIds = Object.create(null);
  const outputTargets = new Set();
  for (const logicalName of outputNames) {
    const binding = request.outputBindings[logicalName];
    exactKeys(binding, ['marker'], 'COMFY_WORKFLOW_BINDING_INVALID');
    if (!MARKER.test(binding.marker)) fail('COMFY_WORKFLOW_BINDING_INVALID');
    const nodeId = converted.markers[binding.marker];
    if (nodeId === undefined || outputTargets.has(nodeId)) fail('COMFY_WORKFLOW_BINDING_INVALID');
    outputTargets.add(nodeId);
    outputNodeIds[logicalName] = nodeId;
  }

  const promptDraft = Object.create(null);
  for (const [nodeId, node] of Object.entries(converted.graph)) {
    promptDraft[nodeId] = {
      class_type: node.class_type,
      inputs: { ...node.inputs },
      ...(node._meta === undefined ? {} : { _meta: { title: node._meta.title } }),
    };
  }
  for (const entry of normalizedInputs) {
    if (entry.hasValue) {
      promptDraft[entry.nodeId].inputs[entry.binding.inputName] = request.values[entry.logicalName];
    }
  }

  return Object.freeze({
    prompt: snapshotJson(promptDraft, {
      maxArrayLength: 5000,
      maxDepth: 32,
      maxEntries: 50000,
      maxStringBytes: 512 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    }),
    outputNodeIds: snapshotJson(outputNodeIds, { maxEntries: 5000, maxTotalBytes: 512 * 1024 }),
  });
}

module.exports = Object.freeze({ compileComfyWorkflow });
