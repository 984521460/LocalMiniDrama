const express = require('express');
const { types } = require('node:util');
const { getWorkflowRegistry } = require('@local-mini-drama/workflow-engine');

const response = require('../../response');
const { createV2Repositories } = require('../../repositories/v2');
const {
  createWorkflowError,
  createWorkflowRunService,
  createWorkflowScheduler,
  createWorkflowService,
  isWorkflowError,
} = require('../../workflows');
const { assertExactObject, snapshotJson } = require('../../workflows/jsonSnapshot');

function parseDramaId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function requestObject(value, allowedKeys) {
  try {
    const snapshot = snapshotJson(value);
    return assertExactObject(snapshot, allowedKeys);
  } catch {
    throw createWorkflowError('WORKFLOW_INPUT_INVALID');
  }
}

function mapCreateBody(value, dramaId) {
  const body = requestObject(value, ['name', 'description']);
  return {
    dramaId,
    name: body.name,
    ...(body.description !== undefined ? { description: body.description } : {}),
  };
}

function mapNode(value) {
  const node = requestObject(value, ['uid', 'node_type', 'position', 'config', 'domain_ref', 'status']);
  return {
    uid: node.uid,
    nodeType: node.node_type,
    position: node.position,
    config: node.config,
    ...(node.domain_ref !== undefined ? { domainRef: node.domain_ref } : {}),
    ...(node.status !== undefined ? { status: node.status } : {}),
  };
}

function mapEdge(value) {
  const edge = requestObject(value, [
    'uid',
    'source_node_uid',
    'source_port',
    'target_node_uid',
    'target_port',
  ]);
  return {
    uid: edge.uid,
    sourceNodeUid: edge.source_node_uid,
    sourcePort: edge.source_port,
    targetNodeUid: edge.target_node_uid,
    targetPort: edge.target_port,
  };
}

function mapGraphBody(value) {
  const body = requestObject(value, ['expected_revision', 'nodes', 'edges']);
  if (!Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
    throw createWorkflowError('WORKFLOW_INPUT_INVALID');
  }
  return {
    expectedRevision: body.expected_revision,
    nodes: body.nodes.map(mapNode),
    edges: body.edges.map(mapEdge),
  };
}

function mapExecutionScope(value) {
  const scope = requestObject(value, ['mode', 'node_uid', 'node_uids']);
  if (scope.mode === 'full') {
    if (scope.node_uid !== undefined || scope.node_uids !== undefined) {
      throw createWorkflowError('WORKFLOW_INPUT_INVALID');
    }
    return { mode: 'full' };
  }
  if (scope.mode === 'node' || scope.mode === 'downstream') {
    if (scope.node_uid === undefined || scope.node_uids !== undefined) {
      throw createWorkflowError('WORKFLOW_INPUT_INVALID');
    }
    return { mode: scope.mode, nodeUid: scope.node_uid };
  }
  if (scope.mode === 'selection') {
    if (scope.node_uid !== undefined || !Array.isArray(scope.node_uids)) {
      throw createWorkflowError('WORKFLOW_INPUT_INVALID');
    }
    return { mode: 'selection', nodeUids: scope.node_uids };
  }
  throw createWorkflowError('WORKFLOW_INPUT_INVALID');
}

function statusFor(error) {
  if (error.code === 'WORKFLOW_CONFLICT') return 409;
  if (error.code === 'WORKFLOW_RUN_TRANSITION_INVALID') return 409;
  if (
    error.code === 'WORKFLOW_DRAMA_NOT_FOUND'
    || error.code === 'WORKFLOW_NOT_FOUND'
    || error.code === 'WORKFLOW_RUN_NOT_FOUND'
  ) return 404;
  if (error.code === 'WORKFLOW_DATA_INVALID') return 500;
  if (error.code === 'WORKFLOW_EXECUTION_FAILED') return 500;
  if (error.code === 'WORKFLOW_EXECUTION_UNAVAILABLE') return 503;
  if (error.code === 'WORKFLOW_LIMIT_EXCEEDED') return 413;
  return 400;
}

function workflowRoutes(database, log, runtime = {}) {
  const router = express.Router();
  const repositories = createV2Repositories(database);
  const service = createWorkflowService({ repositories });
  const runService = createWorkflowRunService({ repositories });
  const scheduler = runtime.scheduler || (
    typeof runtime.executeNode === 'function'
      ? createWorkflowScheduler({ runService, executeNode: runtime.executeNode })
      : null
  );
  if (scheduler !== null && (
    typeof scheduler.start !== 'function'
    || typeof scheduler.retryNode !== 'function'
    || typeof scheduler.cancelRun !== 'function'
  )) throw new TypeError('Workflow route scheduler is invalid');

  function requireScheduler() {
    if (scheduler === null) throw createWorkflowError('WORKFLOW_EXECUTION_UNAVAILABLE');
    return scheduler;
  }

  function observeCompletion(handle, event) {
    if (!handle || typeof handle.runUid !== 'string' || !types.isPromise(handle.completion)) {
      throw createWorkflowError('WORKFLOW_EXECUTION_FAILED');
    }
    Promise.prototype.then.call(handle.completion, undefined, (error) => {
      log?.error?.(event, {
        code: isWorkflowError(error) ? error.code : 'WORKFLOW_EXECUTION_FAILED',
      });
    });
    return { run_uid: handle.runUid };
  }

  function handleError(res, error, event) {
    if (isWorkflowError(error)) {
      return response.error(res, statusFor(error), error.code, error.message);
    }
    log?.error?.(event, { code: 'WORKFLOW_UNEXPECTED' });
    return response.error(res, 500, 'WORKFLOW_UNEXPECTED', 'Workflow operation failed');
  }

  router.get('/workflow-registry', (_req, res) => (
    response.success(res, getWorkflowRegistry())
  ));

  router.post('/dramas/:dramaId/workflows', (req, res) => {
    try {
      const dramaId = parseDramaId(req.params.dramaId);
      if (dramaId === null) throw createWorkflowError('WORKFLOW_INPUT_INVALID');
      return response.created(res, service.createWorkflow(mapCreateBody(req.body, dramaId)));
    } catch (error) {
      return handleError(res, error, 'workflow-create');
    }
  });

  router.post('/dramas/:dramaId/workflows/legacy-draft', (req, res) => {
    try {
      requestObject(req.body, []);
      const dramaId = parseDramaId(req.params.dramaId);
      if (dramaId === null) throw createWorkflowError('WORKFLOW_INPUT_INVALID');
      return response.success(res, service.ensureLegacyDraft(dramaId));
    } catch (error) {
      return handleError(res, error, 'workflow-legacy-draft');
    }
  });

  router.get('/dramas/:dramaId/workflows', (req, res) => {
    try {
      const dramaId = parseDramaId(req.params.dramaId);
      if (dramaId === null) throw createWorkflowError('WORKFLOW_INPUT_INVALID');
      return response.success(res, service.listWorkflows(dramaId));
    } catch (error) {
      return handleError(res, error, 'workflow-list');
    }
  });

  router.get('/workflows/:workflowUid', (req, res) => {
    try {
      return response.success(res, service.getWorkflow(req.params.workflowUid));
    } catch (error) {
      return handleError(res, error, 'workflow-get');
    }
  });

  router.get('/workflows/:workflowUid/plan', (req, res) => {
    try {
      return response.success(res, service.createExecutionPlan(req.params.workflowUid));
    } catch (error) {
      return handleError(res, error, 'workflow-plan-get');
    }
  });

  router.post('/workflows/:workflowUid/runs', (req, res) => {
    try {
      const body = requestObject(req.body, ['trigger_type', 'scope', 'max_retries']);
      if (body.scope !== undefined) {
        if (body.trigger_type !== undefined) throw createWorkflowError('WORKFLOW_INPUT_INVALID');
        const handle = requireScheduler().start({
          workflowUid: req.params.workflowUid,
          scope: mapExecutionScope(body.scope),
          ...(body.max_retries === undefined ? {} : { maxRetries: body.max_retries }),
        });
        return response.accepted(res, observeCompletion(handle, 'workflow-run-execute'));
      }
      if (body.max_retries !== undefined) throw createWorkflowError('WORKFLOW_INPUT_INVALID');
      return response.created(res, runService.createRun({
        workflowUid: req.params.workflowUid,
        triggerType: body.trigger_type,
      }));
    } catch (error) {
      return handleError(res, error, 'workflow-run-create');
    }
  });

  router.get('/workflows/:workflowUid/runs', (req, res) => {
    try {
      return response.success(res, runService.listRuns(req.params.workflowUid));
    } catch (error) {
      return handleError(res, error, 'workflow-run-list');
    }
  });

  router.get('/workflow-runs/:runUid', (req, res) => {
    try {
      return response.success(res, runService.getRun(req.params.runUid));
    } catch (error) {
      return handleError(res, error, 'workflow-run-get');
    }
  });

  router.post('/node-runs/:nodeRunUid/retry', (req, res) => {
    try {
      const body = requestObject(req.body, ['max_retries']);
      const handle = requireScheduler().retryNode({
        nodeRunUid: req.params.nodeRunUid,
        ...(body.max_retries === undefined ? {} : { maxRetries: body.max_retries }),
      });
      return response.accepted(res, observeCompletion(handle, 'workflow-node-retry'));
    } catch (error) {
      return handleError(res, error, 'workflow-node-retry');
    }
  });

  router.post('/workflow-runs/:runUid/cancel', (req, res) => {
    try {
      requestObject(req.body, []);
      return response.success(res, requireScheduler().cancelRun(req.params.runUid));
    } catch (error) {
      return handleError(res, error, 'workflow-run-cancel');
    }
  });

  router.put('/workflows/:workflowUid/graph', (req, res) => {
    try {
      return response.success(res, service.replaceGraph(
        req.params.workflowUid,
        mapGraphBody(req.body),
      ));
    } catch (error) {
      return handleError(res, error, 'workflow-graph-replace');
    }
  });

  return router;
}

module.exports = workflowRoutes;
