const { createHash } = require('node:crypto');

const {
  WORKFLOW_REGISTRY_SCHEMA_VERSION,
  WORKFLOW_REGISTRY_VERSION,
  validateWorkflowGraph,
} = require('@local-mini-drama/workflow-engine');
const { isValidBoundDomainReference } = require('./domainReferences');
const { isCanonicalUuid, isPortId } = require('./identifiers');
const { assertExactObject, snapshotJson } = require('./jsonSnapshot');
const { normalizeWorkflowNodeConfig } = require('./nodeConfig');

const NODE_STATUSES = new Set(['draft', 'ready', 'running', 'succeeded', 'failed', 'stale', 'disabled']);
const DOMAIN_REF_TYPES = Object.freeze({
  'source.selection': 'source_selection',
  'story.facts': 'narrative_result',
  'episode.adaptation': 'narrative_result',
  'script.structured': 'narrative_result',
  'shot.plan': 'narrative_result',
  'shot.image': 'asset',
  'shot.video': 'asset',
});
const MAX_POSITION = 1_000_000;

class WorkflowPlanDataError extends Error {
  constructor() {
    super('Persisted workflow cannot produce an execution plan');
    this.name = 'WorkflowPlanDataError';
  }
}

function invalidData() {
  throw new WorkflowPlanDataError();
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') invalidData();
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function normalizePosition(value) {
  assertExactObject(value, ['x', 'y']);
  if (![value.x, value.y].every((coordinate) => (
    typeof coordinate === 'number' && Number.isFinite(coordinate) && Math.abs(coordinate) <= MAX_POSITION
  ))) invalidData();
  return { x: value.x, y: value.y };
}

function normalizeNode(node, repositories, dramaUid) {
  if (!node || typeof node !== 'object' || !isCanonicalUuid(node.uid) || typeof node.nodeType !== 'string') {
    invalidData();
  }
  if (!NODE_STATUSES.has(node.status)) invalidData();
  const hasReference = node.domainRefType !== null || node.domainRefUid !== null;
  if (hasReference && (
    typeof node.domainRefType !== 'string'
    || !isCanonicalUuid(node.domainRefUid)
    || !isValidBoundDomainReference(node, repositories, dramaUid)
  )) invalidData();
  return {
    uid: node.uid,
    nodeType: node.nodeType,
    position: normalizePosition(node.position),
    config: normalizeWorkflowNodeConfig(node.nodeType, node.config),
    domainRef: hasReference ? { type: node.domainRefType, uid: node.domainRefUid } : null,
    enabled: node.status !== 'disabled',
  };
}

function normalizeEdge(edge) {
  if (!edge || typeof edge !== 'object') invalidData();
  if (
    !isCanonicalUuid(edge.uid)
    || !isCanonicalUuid(edge.sourceNodeUid)
    || !isCanonicalUuid(edge.targetNodeUid)
    || !isPortId(edge.sourcePort)
    || !isPortId(edge.targetPort)
  ) invalidData();
  return {
    uid: edge.uid,
    sourceNodeUid: edge.sourceNodeUid,
    sourcePort: edge.sourcePort,
    targetNodeUid: edge.targetNodeUid,
    targetPort: edge.targetPort,
  };
}

function normalizeStoredNode(node) {
  assertExactObject(node, ['uid', 'nodeType', 'position', 'config', 'domainRef', 'enabled']);
  if (
    !isCanonicalUuid(node.uid)
    || typeof node.nodeType !== 'string'
    || typeof node.enabled !== 'boolean'
  ) invalidData();
  let domainRef = null;
  if (node.domainRef !== null) {
    assertExactObject(node.domainRef, ['type', 'uid']);
    if (
      node.domainRef.type !== DOMAIN_REF_TYPES[node.nodeType]
      || !isCanonicalUuid(node.domainRef.uid)
    ) invalidData();
    domainRef = { type: node.domainRef.type, uid: node.domainRef.uid };
  }
  return {
    uid: node.uid,
    nodeType: node.nodeType,
    position: normalizePosition(node.position),
    config: normalizeWorkflowNodeConfig(node.nodeType, node.config),
    domainRef,
    enabled: node.enabled,
  };
}

function hashSnapshot(snapshot) {
  return createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');
}

function validateWorkflowExecutionPlan(value) {
  try {
    const plan = snapshotJson(value);
    assertExactObject(plan, [
      'schemaVersion',
      'registryVersion',
      'workflowUid',
      'graphRevision',
      'graphHash',
      'snapshot',
      'topologicalOrder',
    ]);
    if (
      plan.schemaVersion !== WORKFLOW_REGISTRY_SCHEMA_VERSION
      || plan.registryVersion !== WORKFLOW_REGISTRY_VERSION
      || !isCanonicalUuid(plan.workflowUid)
      || !Number.isSafeInteger(plan.graphRevision)
      || plan.graphRevision < 0
      || typeof plan.graphHash !== 'string'
      || !/^[0-9a-f]{64}$/u.test(plan.graphHash)
      || !plan.snapshot
      || typeof plan.snapshot !== 'object'
      || Array.isArray(plan.snapshot)
      || !Array.isArray(plan.topologicalOrder)
    ) invalidData();
    assertExactObject(plan.snapshot, ['schemaVersion', 'registryVersion', 'nodes', 'edges']);
    if (
      plan.snapshot.schemaVersion !== WORKFLOW_REGISTRY_SCHEMA_VERSION
      || plan.snapshot.registryVersion !== WORKFLOW_REGISTRY_VERSION
      || !Array.isArray(plan.snapshot.nodes)
      || !Array.isArray(plan.snapshot.edges)
    ) invalidData();
    const nodes = plan.snapshot.nodes.map(normalizeStoredNode);
    const edges = plan.snapshot.edges.map(normalizeEdge);
    const nodeOrder = nodes.map((node) => node.uid);
    const edgeOrder = edges.map((edge) => edge.uid);
    if (
      nodeOrder.join('\u0000') !== [...nodeOrder].sort().join('\u0000')
      || edgeOrder.join('\u0000') !== [...edgeOrder].sort().join('\u0000')
    ) invalidData();
    const validation = validateWorkflowGraph({
      nodes: nodes.map((node) => ({
        uid: node.uid,
        nodeType: node.nodeType,
        bound: node.domainRef !== null,
        disabled: !node.enabled,
      })),
      edges,
    });
    if (
      plan.topologicalOrder.length !== validation.topologicalOrder.length
      || plan.topologicalOrder.some((uid, index) => (
        !isCanonicalUuid(uid) || uid !== validation.topologicalOrder[index]
      ))
    ) invalidData();
    const snapshot = snapshotJson({
      schemaVersion: WORKFLOW_REGISTRY_SCHEMA_VERSION,
      registryVersion: WORKFLOW_REGISTRY_VERSION,
      nodes,
      edges,
    });
    if (hashSnapshot(snapshot) !== plan.graphHash) invalidData();
    return snapshotJson({
      schemaVersion: WORKFLOW_REGISTRY_SCHEMA_VERSION,
      registryVersion: WORKFLOW_REGISTRY_VERSION,
      workflowUid: plan.workflowUid,
      graphRevision: plan.graphRevision,
      graphHash: plan.graphHash,
      snapshot,
      topologicalOrder: validation.topologicalOrder,
    });
  } catch (error) {
    if (error instanceof WorkflowPlanDataError) throw error;
    throw new WorkflowPlanDataError();
  }
}

function createWorkflowExecutionPlan(graph, repositories) {
  try {
    const persisted = snapshotJson(graph);
    if (
      !persisted?.definition
      || persisted.definition.registryVersion !== WORKFLOW_REGISTRY_VERSION
      || !isCanonicalUuid(persisted.definition.uid)
      || !isCanonicalUuid(persisted.definition.dramaUid)
      || !Number.isSafeInteger(persisted.definition.graphRevision)
      || persisted.definition.graphRevision < 0
      || !Array.isArray(persisted.nodes)
      || !Array.isArray(persisted.edges)
    ) invalidData();

    const nodes = persisted.nodes
      .map((node) => normalizeNode(node, repositories, persisted.definition.dramaUid))
      .sort((left, right) => left.uid.localeCompare(right.uid));
    const edges = persisted.edges
      .map(normalizeEdge)
      .sort((left, right) => left.uid.localeCompare(right.uid));
    const validation = validateWorkflowGraph({
      nodes: nodes.map((node) => ({
        uid: node.uid,
        nodeType: node.nodeType,
        bound: node.domainRef !== null,
        disabled: !node.enabled,
      })),
      edges,
    });
    const snapshot = snapshotJson({
      schemaVersion: WORKFLOW_REGISTRY_SCHEMA_VERSION,
      registryVersion: WORKFLOW_REGISTRY_VERSION,
      nodes,
      edges,
    });
    const graphHash = hashSnapshot(snapshot);
    return validateWorkflowExecutionPlan({
      schemaVersion: WORKFLOW_REGISTRY_SCHEMA_VERSION,
      registryVersion: WORKFLOW_REGISTRY_VERSION,
      workflowUid: persisted.definition.uid,
      graphRevision: persisted.definition.graphRevision,
      graphHash,
      snapshot,
      topologicalOrder: validation.topologicalOrder,
    });
  } catch (error) {
    if (error instanceof WorkflowPlanDataError) throw error;
    throw new WorkflowPlanDataError();
  }
}

module.exports = {
  WorkflowPlanDataError,
  createWorkflowExecutionPlan,
  validateWorkflowExecutionPlan,
};
