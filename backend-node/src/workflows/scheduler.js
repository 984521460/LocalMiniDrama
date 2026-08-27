const { createHash } = require('node:crypto');

const {
  WorkflowExecutionScopeError,
  createExecutionScope,
} = require('@local-mini-drama/workflow-engine');
const { createWorkflowError, isWorkflowError } = require('./errors');
const { isNodeExecutionError } = require('./nodeExecutionError');
const { MAX_RETRY_COUNT } = require('./runState');
const { assertExactObject, snapshotJson } = require('./jsonSnapshot');

const MAX_AUTOMATIC_RETRIES = 3;
const DEPENDENCY_FAILURES = new Set(['failed', 'blocked', 'cancelled']);
const EXECUTION_CANCELLED = Symbol('workflow execution cancelled');

function inputInvalid() {
  throw createWorkflowError('WORKFLOW_INPUT_INVALID');
}

function transitionInvalid() {
  throw createWorkflowError('WORKFLOW_RUN_TRANSITION_INVALID');
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') inputInvalid();
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function cacheKey(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function requestObject(value, allowedKeys) {
  try {
    const snapshot = snapshotJson(value);
    return assertExactObject(snapshot, allowedKeys);
  } catch {
    inputInvalid();
  }
}

function retryLimit(value) {
  const normalized = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > MAX_AUTOMATIC_RETRIES) {
    inputInvalid();
  }
  return normalized;
}

function scopePlan(plan) {
  return {
    nodes: plan.snapshot.nodes.map((node) => ({ uid: node.uid, enabled: node.enabled })),
    edges: plan.snapshot.edges.map((edge) => ({
      sourceNodeUid: edge.sourceNodeUid,
      targetNodeUid: edge.targetNodeUid,
    })),
    topologicalOrder: plan.topologicalOrder,
  };
}

function executionScope(plan, input) {
  try {
    return createExecutionScope(scopePlan(plan), input);
  } catch (error) {
    if (error instanceof WorkflowExecutionScopeError) inputInvalid();
    throw error;
  }
}

function createController() {
  return {
    abortController: new AbortController(),
    cancelled: false,
  };
}

function waitForNodeExecution(result, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      callback(value);
    };
    const cancel = () => finish(resolve, EXECUTION_CANCELLED);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(result).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) cancel();
  });
}

function createWorkflowScheduler({ runService, executeNode }) {
  if (
    !runService
    || typeof runService.createRun !== 'function'
    || typeof runService.getNode !== 'function'
    || typeof runService.getRun !== 'function'
    || typeof runService.cancelRun !== 'function'
    || typeof runService.restartFailedNodes !== 'function'
    || typeof runService.transitionNode !== 'function'
    || typeof runService.transitionWorkflow !== 'function'
    || typeof executeNode !== 'function'
  ) throw new TypeError('Workflow scheduler dependencies are invalid');

  const active = new Map();

  function nodeByUid(aggregate) {
    return new Map(aggregate.nodes.map((node) => [node.nodeUid, node]));
  }

  function incomingEdges(plan, nodeUid) {
    return plan.snapshot.edges
      .filter((edge) => edge.targetNodeUid === nodeUid)
      .sort((left, right) => (
        left.sourceNodeUid.localeCompare(right.sourceNodeUid)
        || left.sourcePort.localeCompare(right.sourcePort)
        || left.targetPort.localeCompare(right.targetPort)
      ));
  }

  function nodeInput(aggregate, selected, nodeUid) {
    const byUid = nodeByUid(aggregate);
    const dependencies = incomingEdges(aggregate.run.graphSnapshot, nodeUid).map((edge) => {
      const source = byUid.get(edge.sourceNodeUid);
      if (!source) throw createWorkflowError('WORKFLOW_DATA_INVALID');
      return {
        sourceNodeUid: edge.sourceNodeUid,
        sourcePort: edge.sourcePort,
        targetPort: edge.targetPort,
        selected: selected.has(edge.sourceNodeUid),
        status: source.status,
        output: source.output,
      };
    });
    return snapshotJson({ dependencies });
  }

  function executionFailure(error) {
    if (isNodeExecutionError(error)) {
      return {
        code: error.code,
        errorDetailRef: error.errorDetailRef,
        retryable: error.retryable,
      };
    }
    return { code: 'ERR_NODE_EXECUTION', errorDetailRef: null, retryable: false };
  }

  async function executeNodeRun(runUid, nodeUid, selected, controller, maxRetries) {
    let automaticRetries = 0;
    while (!controller.cancelled) {
      const aggregate = runService.getRun(runUid);
      const current = nodeByUid(aggregate).get(nodeUid);
      const node = aggregate.run.graphSnapshot.snapshot.nodes.find((item) => item.uid === nodeUid);
      if (!current || !node) throw createWorkflowError('WORKFLOW_DATA_INVALID');
      if (current.status !== 'queued') return;
      const inputSnapshot = nodeInput(aggregate, selected, nodeUid);
      const key = cacheKey({
        graphHash: aggregate.run.graphHash,
        nodeUid,
        config: node.config,
        domainRef: node.domainRef,
        inputSnapshot,
      });
      const running = runService.transitionNode({
        nodeRunUid: current.uid,
        expectedStatus: 'queued',
        nextStatus: 'running',
        inputSnapshot,
        cacheKey: key,
      });
      try {
        const output = await waitForNodeExecution(executeNode(Object.freeze({
          runUid,
          nodeRunUid: current.uid,
          node,
          inputSnapshot,
          signal: controller.abortController.signal,
        })), controller.abortController.signal);
        if (controller.cancelled || output === EXECUTION_CANCELLED) return;
        runService.transitionNode({
          nodeRunUid: running.uid,
          expectedStatus: 'running',
          nextStatus: 'succeeded',
          output,
        });
        return;
      } catch (error) {
        if (controller.cancelled) return;
        const failure = executionFailure(error);
        const failed = runService.transitionNode({
          nodeRunUid: running.uid,
          expectedStatus: 'running',
          nextStatus: 'failed',
          errorCode: failure.code,
          ...(failure.errorDetailRef === null ? {} : { errorDetailRef: failure.errorDetailRef }),
        });
        if (
          !failure.retryable
          || automaticRetries >= maxRetries
          || failed.retryCount >= MAX_RETRY_COUNT
        ) return;
        runService.transitionNode({
          nodeRunUid: failed.uid,
          expectedStatus: 'failed',
          nextStatus: 'queued',
        });
        automaticRetries += 1;
      }
    }
  }

  async function process(runUid, scope, controller, maxRetries, initialize) {
    if (initialize) {
      runService.transitionWorkflow({
        runUid,
        expectedStatus: 'queued',
        nextStatus: 'running',
      });
      for (const nodeUid of scope.skippedNodeUids) {
        const aggregate = runService.getRun(runUid);
        const node = nodeByUid(aggregate).get(nodeUid);
        if (node?.status === 'queued') {
          runService.transitionNode({
            nodeRunUid: node.uid,
            expectedStatus: 'queued',
            nextStatus: 'skipped',
          });
        }
      }
    }
    const selected = new Set(scope.executionOrder);
    for (const nodeUid of scope.executionOrder) {
      if (controller.cancelled) break;
      const aggregate = runService.getRun(runUid);
      const node = nodeByUid(aggregate).get(nodeUid);
      if (!node || node.status !== 'queued') continue;
      const blocked = incomingEdges(aggregate.run.graphSnapshot, nodeUid).some((edge) => {
        const source = nodeByUid(aggregate).get(edge.sourceNodeUid);
        return selected.has(edge.sourceNodeUid) && source && DEPENDENCY_FAILURES.has(source.status);
      });
      if (blocked) {
        runService.transitionNode({
          nodeRunUid: node.uid,
          expectedStatus: 'queued',
          nextStatus: 'blocked',
          errorCode: 'ERR_DEPENDENCY_FAILED',
        });
        continue;
      }
      await executeNodeRun(runUid, nodeUid, selected, controller, maxRetries);
    }
    if (controller.cancelled) return runService.getRun(runUid);
    const aggregate = runService.getRun(runUid);
    if (aggregate.nodes.some((node) => node.status === 'failed' || node.status === 'blocked')) {
      if (aggregate.run.status === 'running') {
        runService.transitionWorkflow({
          runUid,
          expectedStatus: 'running',
          nextStatus: 'failed',
          errorCode: 'ERR_WORKFLOW_NODE_FAILED',
        });
      }
    } else if (aggregate.run.status === 'running') {
      runService.transitionWorkflow({
        runUid,
        expectedStatus: 'running',
        nextStatus: 'succeeded',
      });
    }
    return runService.getRun(runUid);
  }

  function handle(runUid, scope, controller, maxRetries, initialize) {
    if (active.has(runUid)) throw createWorkflowError('WORKFLOW_CONFLICT');
    active.set(runUid, controller);
    const completion = process(runUid, scope, controller, maxRetries, initialize)
      .catch((error) => {
        if (isWorkflowError(error)) throw error;
        throw createWorkflowError('WORKFLOW_EXECUTION_FAILED');
      })
      .finally(() => {
        if (active.get(runUid) === controller) active.delete(runUid);
      });
    return Object.freeze({ runUid, completion });
  }

  return Object.freeze({
    start(input) {
      const request = requestObject(input, ['workflowUid', 'scope', 'maxRetries']);
      const maxRetries = retryLimit(request.maxRetries);
      let created;
      let scope;
      try {
        const triggerType = request.scope?.mode === 'full' ? 'full' : request.scope?.mode;
        created = runService.createRun({
          workflowUid: request.workflowUid,
          triggerType,
          scope: request.scope,
        });
        scope = executionScope(created.run.graphSnapshot, request.scope);
      } catch (error) {
        if (error instanceof WorkflowExecutionScopeError) inputInvalid();
        throw error;
      }
      return handle(created.run.uid, scope, createController(), maxRetries, true);
    },

    retryNode(input) {
      const request = requestObject(input, ['nodeRunUid', 'maxRetries']);
      const maxRetries = retryLimit(request.maxRetries);
      const target = runService.getNode(request.nodeRunUid);
      const aggregate = runService.getRun(target.workflowRunUid);
      if (active.has(aggregate.run.uid)) throw createWorkflowError('WORKFLOW_CONFLICT');
      if (
        aggregate.run.status !== 'failed'
        || target.status !== 'failed'
        || target.retryCount >= MAX_RETRY_COUNT
      ) transitionInvalid();
      const downstream = executionScope(aggregate.run.graphSnapshot, {
        mode: 'downstream',
        nodeUid: target.nodeUid,
      });
      const blocked = new Set(
        aggregate.nodes.filter((node) => node.status === 'blocked').map((node) => node.nodeUid),
      );
      const executionOrder = downstream.executionOrder.filter((uid) => (
        uid === target.nodeUid || blocked.has(uid)
      ));
      const reset = executionOrder.map((nodeUid) => nodeByUid(aggregate).get(nodeUid)?.uid);
      if (reset.some((nodeRunUid) => nodeRunUid === undefined)) {
        throw createWorkflowError('WORKFLOW_DATA_INVALID');
      }
      runService.restartFailedNodes({
        runUid: aggregate.run.uid,
        nodeRunUids: reset,
      });
      return handle(
        aggregate.run.uid,
        Object.freeze({
          mode: 'downstream',
          executionOrder: Object.freeze(executionOrder),
          skippedNodeUids: Object.freeze([]),
        }),
        createController(),
        maxRetries,
        false,
      );
    },

    cancelRun(runUid) {
      const controller = active.get(runUid);
      const cancelled = runService.cancelRun({ runUid });
      if (controller) {
        controller.cancelled = true;
        controller.abortController.abort();
      }
      return cancelled;
    },
  });
}

module.exports = { createWorkflowScheduler };
