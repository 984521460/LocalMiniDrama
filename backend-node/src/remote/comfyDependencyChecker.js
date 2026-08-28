'use strict';

const { types: { isProxy } } = require('node:util');

const { snapshotJson } = require('../workflows/jsonSnapshot');
const { raceNativePromise } = require('../integrations/comfyui/asyncControl');
const { createComfyManifestError } = require('./comfyManifestErrors');
const { validateStoredComfyWorkflowManifest } = require('./workflowManifest');

const DEFAULT_TIMEOUT_MS = 30_000;

function fail(code) {
  throw createComfyManifestError(code);
}

function dependencySnapshot(value) {
  try {
    return snapshotJson(value, {
      maxArrayLength: 10_000,
      maxDepth: 16,
      maxEntries: 50_000,
      maxStringBytes: 4096,
      maxTotalBytes: 4 * 1024 * 1024,
    });
  } catch {
    fail('COMFY_DEPENDENCY_RESPONSE_INVALID');
  }
}

function capabilityRecord(objectInfo, nodeType) {
  if (!Object.hasOwn(objectInfo, nodeType)) return null;
  const node = objectInfo[nodeType];
  if (!node || Array.isArray(node) || typeof node !== 'object'
    || !node.input || Array.isArray(node.input) || typeof node.input !== 'object'
    || !node.input.required || Array.isArray(node.input.required)
    || typeof node.input.required !== 'object') {
    fail('COMFY_DEPENDENCY_RESPONSE_INVALID');
  }
  return node;
}

function modelOptions(node, requirement) {
  if (!Object.hasOwn(node.input.required, requirement.inputName)) return null;
  const definition = node.input.required[requirement.inputName];
  if (!Array.isArray(definition) || definition.length < 1 || !Array.isArray(definition[0])
    || !definition[0].every((value) => typeof value === 'string')) {
    fail('COMFY_DEPENDENCY_RESPONSE_INVALID');
  }
  return definition[0];
}

function readConfiguration(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || isProxy(options)) {
    throw new TypeError('ComfyUI dependency checker configuration is invalid');
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(options); } catch {
    throw new TypeError('ComfyUI dependency checker configuration is invalid');
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !['client', 'timeoutMs'].includes(key))) {
    throw new TypeError('ComfyUI dependency checker configuration is invalid');
  }
  if (!descriptors.client || !Object.hasOwn(descriptors.client, 'value')) {
    throw new TypeError('ComfyUI dependency checker configuration is invalid');
  }
  const client = descriptors.client.value;
  const timeoutMs = descriptors.timeoutMs === undefined
    ? DEFAULT_TIMEOUT_MS : descriptors.timeoutMs.value;
  if (!client || typeof client !== 'object' || isProxy(client)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new TypeError('ComfyUI dependency checker configuration is invalid');
  }
  let clientDescriptors;
  try { clientDescriptors = Object.getOwnPropertyDescriptors(client); } catch {
    throw new TypeError('ComfyUI dependency checker configuration is invalid');
  }
  const objectInfo = clientDescriptors.objectInfo;
  if (!objectInfo || !Object.hasOwn(objectInfo, 'value')
    || typeof objectInfo.value !== 'function' || isProxy(objectInfo.value)) {
    throw new TypeError('ComfyUI dependency checker configuration is invalid');
  }
  return Object.freeze({ client, objectInfo: objectInfo.value, timeoutMs });
}

function createComfyDependencyChecker(options) {
  const { client, objectInfo: objectInfoMethod, timeoutMs } = readConfiguration(options);

  async function check(manifest) {
    let validatedManifest;
    try { validatedManifest = validateStoredComfyWorkflowManifest(manifest); } catch {
      fail('COMFY_MANIFEST_INVALID');
    }
    let pending;
    try { pending = Reflect.apply(objectInfoMethod, client, []); } catch {
      fail('COMFY_DEPENDENCY_RESPONSE_INVALID');
    }
    let response;
    try { response = await raceNativePromise(pending, { timeoutMs }); } catch {
      fail('COMFY_DEPENDENCY_RESPONSE_INVALID');
    }
    const capabilities = dependencySnapshot(response);
    if (!capabilities || Array.isArray(capabilities) || typeof capabilities !== 'object') {
      fail('COMFY_DEPENDENCY_RESPONSE_INVALID');
    }

    const nodeCapabilities = new Map();
    const missingNodes = [];
    for (const requirement of validatedManifest.requirements) {
      if (requirement.kind !== 'node') continue;
      const node = capabilityRecord(capabilities, requirement.nodeType);
      if (node === null) missingNodes.push(requirement.nodeType);
      else nodeCapabilities.set(requirement.nodeType, node);
    }
    const missingNodeSet = new Set(missingNodes);
    const missingModels = validatedManifest.requirements
      .filter((requirement) => requirement.kind === 'model'
        && !missingNodeSet.has(requirement.nodeType)
        && !modelOptions(nodeCapabilities.get(requirement.nodeType), requirement)?.includes(requirement.fileName))
      .map((requirement) => Object.freeze({
        nodeType: requirement.nodeType,
        inputName: requirement.inputName,
        fileName: requirement.fileName,
      }));
    return Object.freeze({
      ready: missingNodes.length === 0 && missingModels.length === 0,
      missingNodes: Object.freeze(missingNodes),
      missingModels: Object.freeze(missingModels),
    });
  }

  async function requireReady(manifest) {
    const report = await check(manifest);
    if (!report.ready) fail('COMFY_DEPENDENCIES_MISSING');
    return report;
  }

  return Object.freeze({ check, requireReady });
}

module.exports = Object.freeze({ createComfyDependencyChecker });
