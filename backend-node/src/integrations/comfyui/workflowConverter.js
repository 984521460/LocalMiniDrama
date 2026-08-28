'use strict';

const { snapshotJson } = require('../../workflows/jsonSnapshot');
const { createComfyWorkflowError } = require('./workflowErrors');

const NODE_ID = /^(?:0|[1-9][0-9]{0,9})$/u;
const MARKER = /^APP_[A-Z0-9]+(?:_[A-Z0-9]+)*$/u;
const MAX_NODES = 5000;

function workflowError(code = 'COMFY_WORKFLOW_INVALID') {
  return createComfyWorkflowError(code);
}

function exactKeys(value, required, optional = []) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw workflowError();
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.length < required.length || keys.some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(value, key))) throw workflowError();
}

function boundedText(value, maximumBytes) {
  return typeof value === 'string' && value === value.trim() && value.length > 0
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= maximumBytes;
}

function validateLinks(value, nodeIds) {
  if (Array.isArray(value)) {
    const first = value[0];
    const linkLike = (typeof first === 'string' && /^[0-9]+$/u.test(first))
      || (Number.isSafeInteger(first) && first >= 0);
    if (linkLike) {
      if (value.length !== 2 || typeof first !== 'string' || !NODE_ID.test(first)
        || !Number.isSafeInteger(value[1]) || value[1] < 0 || !nodeIds.has(first)) {
        throw workflowError();
      }
      return;
    }
    for (const item of value) validateLinks(item, nodeIds);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) validateLinks(item, nodeIds);
  }
}

function convertComfyApiWorkflow(value) {
  let graph;
  try {
    graph = snapshotJson(value, {
      maxArrayLength: 5000,
      maxDepth: 32,
      maxEntries: 50000,
      maxStringBytes: 512 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    });
  } catch (error) {
    if (error?.code === 'STRUCTURED_INPUT_LIMIT_EXCEEDED') {
      throw workflowError('COMFY_WORKFLOW_LIMIT_EXCEEDED');
    }
    throw workflowError();
  }
  if (!graph || Array.isArray(graph)) throw workflowError();
  const nodeIds = Object.keys(graph);
  if (nodeIds.length < 1 || nodeIds.length > MAX_NODES || nodeIds.some((id) => !NODE_ID.test(id))) {
    throw workflowError();
  }
  const nodeIdSet = new Set(nodeIds);

  const markers = Object.create(null);
  for (const nodeId of nodeIds) {
    const node = graph[nodeId];
    exactKeys(node, ['class_type', 'inputs'], ['_meta']);
    if (!boundedText(node.class_type, 256) || !node.inputs
      || Array.isArray(node.inputs) || typeof node.inputs !== 'object') throw workflowError();
    if (node._meta === undefined) continue;
    exactKeys(node._meta, ['title']);
    if (!boundedText(node._meta.title, 256)) throw workflowError();
    if (!node._meta.title.startsWith('APP_')) continue;
    if (!MARKER.test(node._meta.title) || Object.hasOwn(markers, node._meta.title)) {
      throw workflowError('COMFY_WORKFLOW_MARKER_INVALID');
    }
    markers[node._meta.title] = nodeId;
  }
  for (const nodeId of nodeIds) validateLinks(graph[nodeId].inputs, nodeIdSet);

  return Object.freeze({
    graph,
    markers: snapshotJson(markers, { maxEntries: MAX_NODES, maxTotalBytes: 512 * 1024 }),
  });
}

module.exports = Object.freeze({ MARKER, NODE_ID, convertComfyApiWorkflow });
