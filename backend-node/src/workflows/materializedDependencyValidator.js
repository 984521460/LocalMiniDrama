'use strict';

const { isDeepStrictEqual } = require('node:util');

const { createNodeExecutionError } = require('./nodeExecutionError');

const { isArray: IS_ARRAY } = Array;
const { hasOwn: HAS_OWN, keys: OBJECT_KEYS } = Object;

const PROVENANCE = Object.freeze({
  'story.facts': Object.freeze({
    sourceNodeType: 'source.selection',
    sourcePort: 'selection',
    targetPort: 'selection',
    refType: 'source_selection',
    recordField: 'sourceSelectionUid',
  }),
  'episode.adaptation': Object.freeze({
    sourceNodeType: 'story.facts',
    sourcePort: 'facts',
    targetPort: 'facts',
    refType: 'narrative_result',
    recordField: 'upstreamResultUid',
  }),
  'script.structured': Object.freeze({
    sourceNodeType: 'episode.adaptation',
    sourcePort: 'beats',
    targetPort: 'beats',
    refType: 'narrative_result',
    recordField: 'upstreamResultUid',
  }),
  'shot.plan': Object.freeze({
    sourceNodeType: 'script.structured',
    sourcePort: 'script',
    targetPort: 'script',
    refType: 'narrative_result',
    recordField: 'upstreamResultUid',
  }),
});

function invalid() {
  throw createNodeExecutionError('ERR_NODE_EXECUTION_DATA_INVALID', { retryable: false });
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || IS_ARRAY(value)) invalid();
  const actual = OBJECT_KEYS(value);
  if (actual.length !== keys.length) invalid();
  for (let index = 0; index < keys.length; index += 1) {
    if (!HAS_OWN(value, keys[index])) invalid();
  }
  return value;
}

function findNode(values, field, uid) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index]?.[field] === uid) return values[index];
  }
  return null;
}

function referenceFromOutput(output, port) {
  const value = exactObject(output, [port]);
  const reference = exactObject(value[port], ['type', 'uid']);
  if (typeof reference.type !== 'string' || typeof reference.uid !== 'string') invalid();
  return reference;
}

function incomingEdges(aggregate, nodeUid) {
  const edges = aggregate.run.graphSnapshot.snapshot.edges;
  const result = [];
  for (let index = 0; index < edges.length; index += 1) {
    if (edges[index].targetNodeUid === nodeUid) result.push(edges[index]);
  }
  return result;
}

function matchingEdge(edges, dependency, matched) {
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    if (!matched[index]
      && edge.sourceNodeUid === dependency.sourceNodeUid
      && edge.sourcePort === dependency.sourcePort
      && edge.targetPort === dependency.targetPort) {
      matched[index] = true;
      return edge;
    }
  }
  return null;
}

function assertRuntimeDependencies(aggregate, planNode, dependencies) {
  const edges = incomingEdges(aggregate, planNode.uid);
  if (edges.length !== dependencies.length) invalid();
  const matched = new Array(edges.length);
  for (let index = 0; index < matched.length; index += 1) matched[index] = false;
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = exactObject(dependencies[index], [
      'sourceNodeUid', 'sourcePort', 'targetPort', 'selected', 'status', 'output',
    ]);
    if (typeof dependency.selected !== 'boolean' || !matchingEdge(edges, dependency, matched)) {
      invalid();
    }
    const sourceRun = findNode(aggregate.nodes, 'nodeUid', dependency.sourceNodeUid);
    const sourceNode = findNode(
      aggregate.run.graphSnapshot.snapshot.nodes,
      'uid',
      dependency.sourceNodeUid,
    );
    if (!sourceRun || !sourceNode
      || sourceRun.status !== 'succeeded'
      || dependency.status !== sourceRun.status
      || !isDeepStrictEqual(dependency.output, sourceRun.output)) invalid();
  }
}

function assertProvenanceDependency(aggregate, planNode, dependency, repositories) {
  const contract = PROVENANCE[planNode.nodeType];
  if (!contract || dependency.targetPort !== contract.targetPort
    || dependency.sourcePort !== contract.sourcePort) invalid();
  const sourceNode = findNode(
    aggregate.run.graphSnapshot.snapshot.nodes,
    'uid',
    dependency.sourceNodeUid,
  );
  if (!sourceNode || sourceNode.nodeType !== contract.sourceNodeType
    || sourceNode.domainRef === null) invalid();
  let record;
  try {
    record = repositories.narrativeReviews.getResult(planNode.domainRef.uid);
  } catch {
    return invalid();
  }
  const expectedUid = record[contract.recordField];
  const reference = referenceFromOutput(dependency.output, contract.sourcePort);
  if (typeof expectedUid !== 'string'
    || sourceNode.domainRef.type !== contract.refType
    || sourceNode.domainRef.uid !== expectedUid
    || reference.type !== contract.refType
    || reference.uid !== expectedUid) invalid();
}

function assertMaterializedDependencies({ aggregate, planNode, inputSnapshot, repositories }) {
  if (!inputSnapshot || typeof inputSnapshot !== 'object' || IS_ARRAY(inputSnapshot)) invalid();
  const input = exactObject(inputSnapshot, OBJECT_KEYS(inputSnapshot).length === 0
    ? []
    : ['dependencies']);
  const dependencies = HAS_OWN(input, 'dependencies') ? input.dependencies : [];
  if (!IS_ARRAY(dependencies)) invalid();
  assertRuntimeDependencies(aggregate, planNode, dependencies);
  if (dependencies.length === 0) return;
  if (dependencies.length !== 1) invalid();
  assertProvenanceDependency(
    aggregate,
    planNode,
    dependencies[0],
    repositories,
  );
}

module.exports = Object.freeze({ assertMaterializedDependencies });
