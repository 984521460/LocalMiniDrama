const { randomUUID } = require('node:crypto');

const {
  LEGACY_DRAFT_DESCRIPTION,
  LEGACY_DRAFT_NAME,
  createLegacyWorkflowDraft,
} = require('../adapters/v2/legacyWorkflowDraft');
const {
  WORKFLOW_REGISTRY_VERSION,
  WorkflowGraphError,
  getNodeTypeDefinition,
  validateWorkflowGraph,
} = require('@local-mini-drama/workflow-engine');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../repositories/v2');
const { createWorkflowError, isWorkflowError } = require('./errors');
const { isValidBoundDomainReference } = require('./domainReferences');
const { WorkflowPlanDataError, createWorkflowExecutionPlan } = require('./executionPlan');
const { isCanonicalUuid, isPortId } = require('./identifiers');
const { assertExactObject, snapshotJson } = require('./jsonSnapshot');
const { WorkflowNodeConfigError, normalizeWorkflowNodeConfig } = require('./nodeConfig');

const NODE_STATUSES = new Set(['draft', 'ready', 'disabled']);
const MAX_NODES = 500;
const MAX_EDGES = 2000;
const MAX_POSITION = 1_000_000;

function workflowErrorFromInput(error) {
  if (error?.code === 'STRUCTURED_INPUT_LIMIT_EXCEEDED') {
    return createWorkflowError('WORKFLOW_LIMIT_EXCEEDED');
  }
  return createWorkflowError('WORKFLOW_INPUT_INVALID');
}

function translateRepositoryError(error, notFoundCode = 'WORKFLOW_NOT_FOUND') {
  if (error instanceof V2RepositoryNotFoundError) return createWorkflowError(notFoundCode);
  if (error instanceof V2RepositoryConflictError) return createWorkflowError('WORKFLOW_CONFLICT');
  if (error instanceof V2RepositoryDataError) return createWorkflowError('WORKFLOW_DATA_INVALID');
  return error;
}

function assertUuid(value) {
  if (!isCanonicalUuid(value)) {
    throw createWorkflowError('WORKFLOW_INPUT_INVALID');
  }
  return value;
}

function assertDramaId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw createWorkflowError('WORKFLOW_INPUT_INVALID');
  }
  return value;
}

function normalizeText(value, { nullable = false, maxBytes = 10_000 } = {}) {
  if (value === undefined || value === null) {
    if (nullable) return null;
    throw createWorkflowError('WORKFLOW_INPUT_INVALID');
  }
  if (typeof value !== 'string') throw createWorkflowError('WORKFLOW_INPUT_INVALID');
  const normalized = value.trim();
  if ((!nullable && normalized.length === 0) || Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw createWorkflowError('WORKFLOW_INPUT_INVALID');
  }
  return normalized || null;
}

function normalizeDomainRef(value) {
  if (value === undefined || value === null) return { domainRefType: null, domainRefUid: null };
  assertExactObject(value, ['type', 'uid']);
  const type = normalizeText(value.type, { maxBytes: 128 });
  return { domainRefType: type, domainRefUid: assertUuid(value.uid) };
}

function normalizeNode(value) {
  assertExactObject(value, ['uid', 'nodeType', 'position', 'config', 'domainRef', 'status']);
  const uid = assertUuid(value.uid);
  if (typeof value.nodeType !== 'string') throw createWorkflowError('WORKFLOW_GRAPH_INVALID');
  try {
    getNodeTypeDefinition(value.nodeType);
  } catch {
    throw createWorkflowError('WORKFLOW_GRAPH_INVALID');
  }
  assertExactObject(value.position, ['x', 'y']);
  const { x, y } = value.position;
  if (![x, y].every((coordinate) => (
    typeof coordinate === 'number' && Number.isFinite(coordinate) && Math.abs(coordinate) <= MAX_POSITION
  ))) {
    throw createWorkflowError('WORKFLOW_GRAPH_INVALID');
  }
  let config;
  try {
    config = normalizeWorkflowNodeConfig(value.nodeType, value.config);
  } catch (error) {
    if (error instanceof WorkflowNodeConfigError) {
      throw createWorkflowError('WORKFLOW_GRAPH_INVALID');
    }
    throw error;
  }
  const status = value.status === undefined ? 'draft' : value.status;
  if (!NODE_STATUSES.has(status)) throw createWorkflowError('WORKFLOW_GRAPH_INVALID');
  return {
    uid,
    nodeType: value.nodeType,
    position: value.position,
    config,
    ...normalizeDomainRef(value.domainRef),
    status,
  };
}

function normalizeEdge(value, nodeUids) {
  assertExactObject(value, ['uid', 'sourceNodeUid', 'sourcePort', 'targetNodeUid', 'targetPort']);
  const uid = assertUuid(value.uid);
  const sourceNodeUid = assertUuid(value.sourceNodeUid);
  const targetNodeUid = assertUuid(value.targetNodeUid);
  if (
    sourceNodeUid === targetNodeUid
    || !nodeUids.has(sourceNodeUid)
    || !nodeUids.has(targetNodeUid)
    || !isPortId(value.sourcePort)
    || !isPortId(value.targetPort)
  ) {
    throw createWorkflowError('WORKFLOW_GRAPH_INVALID');
  }
  return {
    uid,
    sourceNodeUid,
    sourcePort: value.sourcePort,
    targetNodeUid,
    targetPort: value.targetPort,
  };
}

function normalizeGraph(input, workflowUid, repositories, dramaUid) {
  let snapshot;
  try {
    snapshot = snapshotJson(input);
    assertExactObject(snapshot, ['expectedRevision', 'workflowUid', 'nodes', 'edges']);
  } catch (error) {
    throw workflowErrorFromInput(error);
  }
  if (
    !Number.isSafeInteger(snapshot.expectedRevision)
    || snapshot.expectedRevision < 0
    || !Array.isArray(snapshot.nodes)
    || !Array.isArray(snapshot.edges)
  ) {
    throw createWorkflowError('WORKFLOW_INPUT_INVALID');
  }
  if (snapshot.workflowUid !== undefined && snapshot.workflowUid !== workflowUid) {
    throw createWorkflowError('WORKFLOW_GRAPH_INVALID');
  }
  if (snapshot.nodes.length > MAX_NODES || snapshot.edges.length > MAX_EDGES) {
    throw createWorkflowError('WORKFLOW_LIMIT_EXCEEDED');
  }
  try {
    const nodes = snapshot.nodes.map(normalizeNode);
    const nodeUids = new Set(nodes.map((node) => node.uid));
    if (nodeUids.size !== nodes.length) throw createWorkflowError('WORKFLOW_GRAPH_INVALID');
    const edges = snapshot.edges.map((edge) => normalizeEdge(edge, nodeUids));
    if (new Set(edges.map((edge) => edge.uid)).size !== edges.length) {
      throw createWorkflowError('WORKFLOW_GRAPH_INVALID');
    }
    const validationNodes = nodes.map((node) => {
      const bound = node.domainRefType !== null;
      if (bound && !isValidBoundDomainReference(node, repositories, dramaUid)) {
        throw createWorkflowError('WORKFLOW_GRAPH_INVALID');
      }
      return {
        uid: node.uid,
        nodeType: node.nodeType,
        bound,
        disabled: node.status === 'disabled',
      };
    });
    try {
      validateWorkflowGraph({ nodes: validationNodes, edges });
    } catch (error) {
      if (error instanceof WorkflowGraphError) {
        throw createWorkflowError('WORKFLOW_GRAPH_INVALID');
      }
      throw error;
    }
    return { expectedRevision: snapshot.expectedRevision, nodes, edges };
  } catch (error) {
    if (isWorkflowError(error)) throw error;
    throw workflowErrorFromInput(error);
  }
}

function createWorkflowService({ repositories, createUid = randomUUID }) {
  if (!repositories?.sources || !repositories?.workflows || typeof createUid !== 'function') {
    throw new TypeError('Workflow service dependencies are invalid');
  }

  function resolveDrama(dramaId) {
    const drama = repositories.sources.findDramaByLegacyId(assertDramaId(dramaId));
    if (!drama) throw createWorkflowError('WORKFLOW_DRAMA_NOT_FOUND');
    return drama;
  }

  return Object.freeze({
    ensureLegacyDraft(dramaId) {
      const drama = resolveDrama(dramaId);
      try {
        const existing = repositories.workflows.listByDrama(drama.uid);
        if (existing.length > 0) return repositories.workflows.getGraph(existing[0].uid);
        const draft = createLegacyWorkflowDraft({ dramaUid: drama.uid });
        try {
          return repositories.workflows.createGraph(draft);
        } catch (error) {
          if (!(error instanceof V2RepositoryConflictError)) throw error;
          const concurrent = repositories.workflows.listByDrama(drama.uid).find((definition) => (
            definition.uid === draft.definition.uid
            || (
              definition.name === LEGACY_DRAFT_NAME
              && definition.version === 1
              && definition.description === LEGACY_DRAFT_DESCRIPTION
            )
          ));
          if (!concurrent) throw error;
          return repositories.workflows.getGraph(concurrent.uid);
        }
      } catch (error) {
        throw translateRepositoryError(error);
      }
    },

    createWorkflow(input) {
      let snapshot;
      try {
        snapshot = snapshotJson(input);
        assertExactObject(snapshot, ['dramaId', 'name', 'description']);
      } catch (error) {
        throw workflowErrorFromInput(error);
      }
      const drama = resolveDrama(snapshot.dramaId);
      const definition = {
        uid: assertUuid(createUid()),
        dramaUid: drama.uid,
        name: normalizeText(snapshot.name, { maxBytes: 512 }),
        version: 1,
        status: 'draft',
        description: normalizeText(snapshot.description, { nullable: true }),
        registryVersion: WORKFLOW_REGISTRY_VERSION,
        graphRevision: 0,
      };
      try {
        return repositories.workflows.createGraph({ definition, nodes: [], edges: [] });
      } catch (error) {
        throw translateRepositoryError(error);
      }
    },

    createExecutionPlan(workflowUid) {
      assertUuid(workflowUid);
      let graph;
      try {
        graph = repositories.workflows.getGraph(workflowUid);
        return createWorkflowExecutionPlan(graph, repositories);
      } catch (error) {
        if (error instanceof WorkflowPlanDataError) {
          throw createWorkflowError('WORKFLOW_DATA_INVALID');
        }
        throw translateRepositoryError(error);
      }
    },

    getWorkflow(workflowUid) {
      assertUuid(workflowUid);
      try {
        return repositories.workflows.getGraph(workflowUid);
      } catch (error) {
        throw translateRepositoryError(error);
      }
    },

    listWorkflows(dramaId) {
      const drama = resolveDrama(dramaId);
      try {
        return repositories.workflows.listByDrama(drama.uid);
      } catch (error) {
        throw translateRepositoryError(error);
      }
    },

    replaceGraph(workflowUid, input) {
      assertUuid(workflowUid);
      let definition;
      try {
        definition = repositories.workflows.getDefinition(workflowUid);
      } catch (error) {
        throw translateRepositoryError(error);
      }
      const graph = normalizeGraph(input, workflowUid, repositories, definition.dramaUid);
      try {
        return repositories.workflows.replaceGraph({ workflowUid, ...graph });
      } catch (error) {
        throw translateRepositoryError(error);
      }
    },
  });
}

module.exports = { createWorkflowService };
