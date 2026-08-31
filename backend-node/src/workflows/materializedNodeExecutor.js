'use strict';

const { isDeepStrictEqual } = require('node:util');
const { types: { isProxy } } = require('node:util');

const { isValidBoundDomainReference } = require('./domainReferences');
const { isCanonicalUuid } = require('./identifiers');
const {
  createNodeExecutionError,
  isNodeExecutionError,
} = require('./nodeExecutionError');
const { snapshotJson } = require('./jsonSnapshot');

const {
  getOwnPropertyDescriptors: GET_OWN_PROPERTY_DESCRIPTORS,
  getPrototypeOf: GET_PROTOTYPE_OF,
  hasOwn: HAS_OWN,
} = Object;
const { ownKeys: OWN_KEYS } = Reflect;

const SUPPORTED_MATERIALIZED_NODE_TYPES = Object.freeze([
  'source.selection',
  'story.facts',
  'episode.adaptation',
  'script.structured',
  'shot.plan',
  'shot.image',
  'shot.video',
]);

const OUTPUT_PORTS = Object.freeze({
  'source.selection': 'selection',
  'story.facts': 'facts',
  'episode.adaptation': 'beats',
  'script.structured': 'script',
  'shot.plan': 'shots',
  'shot.image': 'image',
  'shot.video': 'video',
});

const SUPPORTED = new Set(SUPPORTED_MATERIALIZED_NODE_TYPES);
const REQUEST_KEYS = Object.freeze([
  'runUid',
  'nodeRunUid',
  'node',
  'inputSnapshot',
  'signal',
]);

function executionError(code) {
  return createNodeExecutionError(code, { retryable: false });
}

function exactRequest(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) {
    throw executionError('ERR_NODE_EXECUTION_DATA_INVALID');
  }
  let prototype;
  let descriptors;
  try {
    prototype = GET_PROTOTYPE_OF(value);
    descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value);
  } catch {
    throw executionError('ERR_NODE_EXECUTION_DATA_INVALID');
  }
  const keys = OWN_KEYS(descriptors);
  if (prototype !== Object.prototype || keys.length !== REQUEST_KEYS.length) {
    throw executionError('ERR_NODE_EXECUTION_DATA_INVALID');
  }
  const request = Object.create(null);
  for (let index = 0; index < REQUEST_KEYS.length; index += 1) {
    const key = REQUEST_KEYS[index];
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !HAS_OWN(descriptor, 'value')) {
      throw executionError('ERR_NODE_EXECUTION_DATA_INVALID');
    }
    request[key] = descriptor.value;
  }
  if (keys.some((key) => typeof key !== 'string' || !REQUEST_KEYS.includes(key))) {
    throw executionError('ERR_NODE_EXECUTION_DATA_INVALID');
  }
  return request;
}

function trustedSnapshot(value) {
  try {
    return snapshotJson(value);
  } catch {
    throw executionError('ERR_NODE_EXECUTION_DATA_INVALID');
  }
}

function createMaterializedNodeExecutor({ repositories, runService }) {
  if (
    !repositories?.workflows
    || typeof repositories.workflows.getDefinition !== 'function'
    || !runService
    || typeof runService.getRun !== 'function'
  ) throw new TypeError('Materialized workflow executor dependencies are invalid');

  return function executeMaterializedNode(input) {
    try {
      const request = exactRequest(input);
      if (!isCanonicalUuid(request.runUid) || !isCanonicalUuid(request.nodeRunUid)) {
        throw executionError('ERR_NODE_EXECUTION_DATA_INVALID');
      }
      const requestedNode = trustedSnapshot(request.node);
      const requestedInput = trustedSnapshot(request.inputSnapshot);
      const aggregate = runService.getRun(request.runUid);
      const definition = repositories.workflows.getDefinition(aggregate.run.workflowUid);
      const nodeRun = aggregate.nodes.find((item) => item.uid === request.nodeRunUid);
      const planNode = aggregate.run.graphSnapshot.snapshot.nodes.find((item) => (
        item.uid === nodeRun?.nodeUid
      ));
      if (
        !nodeRun
        || !planNode
        || nodeRun.workflowRunUid !== aggregate.run.uid
        || nodeRun.status !== 'running'
        || definition.uid !== aggregate.run.workflowUid
        || definition.dramaUid === undefined
        || !isCanonicalUuid(definition.dramaUid)
        || planNode.enabled !== true
        || !isDeepStrictEqual(requestedNode, planNode)
        || !isDeepStrictEqual(requestedInput, nodeRun.inputSnapshot)
      ) throw executionError('ERR_NODE_EXECUTION_DATA_INVALID');

      if (!SUPPORTED.has(planNode.nodeType)) {
        throw executionError('ERR_NODE_EXECUTION_UNAVAILABLE');
      }
      if (!planNode.domainRef || !isValidBoundDomainReference({
        nodeType: planNode.nodeType,
        domainRefType: planNode.domainRef.type,
        domainRefUid: planNode.domainRef.uid,
      }, repositories, definition.dramaUid)) {
        throw executionError('ERR_NODE_EXECUTION_DATA_INVALID');
      }

      return trustedSnapshot({
        [OUTPUT_PORTS[planNode.nodeType]]: {
          type: planNode.domainRef.type,
          uid: planNode.domainRef.uid,
        },
      });
    } catch (error) {
      if (isNodeExecutionError(error)) throw error;
      throw executionError('ERR_NODE_EXECUTION_DATA_INVALID');
    }
  };
}

module.exports = Object.freeze({
  SUPPORTED_MATERIALIZED_NODE_TYPES,
  createMaterializedNodeExecutor,
});
