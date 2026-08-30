const { randomUUID } = require('node:crypto');

const {
  WorkflowExecutionScopeError,
  createExecutionScope,
} = require('@local-mini-drama/workflow-engine');

const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../repositories/v2');
const { createWorkflowError } = require('./errors');
const { WorkflowPlanDataError, createWorkflowExecutionPlan } = require('./executionPlan');
const { isCanonicalUuid } = require('./identifiers');
const { assertExactObject, snapshotJson } = require('./jsonSnapshot');
const {
  ERROR_CODE,
  ERROR_DETAIL_REF,
  HASH,
  MAX_RETRY_COUNT,
  WorkflowRunDataError,
  nodeTransitionAllowed,
  normalizeNodeRunRecord,
  normalizeWorkflowRunRecord,
  safePayload,
  validateRunAggregate,
  workflowTransitionAllowed,
} = require('./runState');

const CREATABLE_TRIGGER_TYPES = new Set(['manual', 'node', 'downstream', 'selection', 'full']);

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

function inputInvalid() {
  throw createWorkflowError('WORKFLOW_INPUT_INVALID');
}

function transitionInvalid() {
  throw createWorkflowError('WORKFLOW_RUN_TRANSITION_INVALID');
}

function inputObject(value, allowedKeys) {
  let snapshot;
  try {
    snapshot = snapshotJson(value);
    assertExactObject(snapshot, allowedKeys);
  } catch {
    inputInvalid();
  }
  return snapshot;
}

function inputUuid(value) {
  if (!isCanonicalUuid(value)) inputInvalid();
  return value;
}

function inputUuidList(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) inputInvalid();
  const values = value.map(inputUuid);
  if (new Set(values).size !== values.length) inputInvalid();
  return values;
}

function generatedUid(createUid) {
  const uid = createUid();
  if (!isCanonicalUuid(uid)) throw createWorkflowError('WORKFLOW_DATA_INVALID');
  return uid;
}

function translateRepositoryError(error, notFoundCode = 'WORKFLOW_RUN_NOT_FOUND') {
  if (error instanceof V2RepositoryNotFoundError) return createWorkflowError(notFoundCode);
  if (error instanceof V2RepositoryConflictError) return createWorkflowError('WORKFLOW_CONFLICT');
  if (
    error instanceof V2RepositoryDataError
    || error instanceof WorkflowPlanDataError
    || error instanceof WorkflowRunDataError
  ) {
    return createWorkflowError('WORKFLOW_DATA_INVALID');
  }
  return error;
}

function normalizeFailure(nextStatus, errorCode, errorDetailRef, node = false) {
  const required = nextStatus === 'failed' || (node && nextStatus === 'blocked');
  if (!required) {
    if (errorCode !== undefined || errorDetailRef !== undefined) inputInvalid();
    return { errorCode: null, errorDetailRef: null };
  }
  if (typeof errorCode !== 'string' || !ERROR_CODE.test(errorCode)) inputInvalid();
  if (errorDetailRef !== undefined && (
    typeof errorDetailRef !== 'string' || !ERROR_DETAIL_REF.test(errorDetailRef)
  )) inputInvalid();
  return { errorCode, errorDetailRef: errorDetailRef ?? null };
}

function createWorkflowRunService({ repositories, createUid = randomUUID }) {
  if (
    !repositories?.runs
    || !repositories?.workflows
    || typeof repositories.withTransaction !== 'function'
    || typeof createUid !== 'function'
  ) throw new TypeError('Workflow run service dependencies are invalid');

  function getRun(runUid) {
    inputUuid(runUid);
    try {
      return validateRunAggregate(repositories.runs.getWorkflowWithNodes(runUid));
    } catch (error) {
      throw translateRepositoryError(error);
    }
  }

  return Object.freeze({
    createRun(input) {
      const request = inputObject(input, ['workflowUid', 'triggerType', 'scope']);
      const workflowUid = inputUuid(request.workflowUid);
      if (!CREATABLE_TRIGGER_TYPES.has(request.triggerType)) inputInvalid();
      try {
        const plan = createWorkflowExecutionPlan(
          repositories.workflows.getGraph(workflowUid),
          repositories,
        );
        if (request.scope !== undefined) {
          try {
            createExecutionScope(scopePlan(plan), request.scope);
          } catch (error) {
            if (error instanceof WorkflowExecutionScopeError) inputInvalid();
            throw error;
          }
        }
        const runUid = generatedUid(createUid);
        const nodes = plan.topologicalOrder.map((nodeUid, ordinal) => ({
          uid: generatedUid(createUid),
          nodeUid,
          ordinal,
          inputSnapshot: {},
          output: null,
          cacheKey: null,
          status: 'queued',
        }));
        const aggregate = repositories.runs.createWorkflowWithNodes({
          run: {
            uid: runUid,
            workflowUid,
            graphSnapshot: plan,
            graphHash: plan.graphHash,
            graphRevision: plan.graphRevision,
            triggerType: request.triggerType,
            status: 'queued',
          },
          nodes,
        });
        return validateRunAggregate(aggregate);
      } catch (error) {
        throw translateRepositoryError(error, 'WORKFLOW_NOT_FOUND');
      }
    },

    getRun,

    getNode(nodeRunUid) {
      inputUuid(nodeRunUid);
      try {
        return normalizeNodeRunRecord(repositories.runs.getNode(nodeRunUid));
      } catch (error) {
        throw translateRepositoryError(error, 'WORKFLOW_RUN_NOT_FOUND');
      }
    },

    listRuns(workflowUid) {
      inputUuid(workflowUid);
      try {
        return repositories.withTransaction((scoped) => snapshotJson(
          scoped.runs.listWorkflowRuns(workflowUid).map((value) => {
            const aggregate = validateRunAggregate(scoped.runs.getWorkflowWithNodes(value.uid));
            const { graphSnapshot, ...summary } = aggregate.run;
            return summary;
          }),
        ));
      } catch (error) {
        throw translateRepositoryError(error);
      }
    },

    recoverInterruptedRuns() {
      try {
        return repositories.withTransaction((scoped) => {
          const runUids = scoped.runs.listRecoverableWorkflowRunUids();
          for (const runUid of runUids) {
            const before = validateRunAggregate(scoped.runs.getWorkflowWithNodes(runUid));
            const statuses = before.nodes.map((node) => node.status);
            if (statuses.every((status) => status === 'succeeded' || status === 'skipped')) {
              scoped.runs.transitionWorkflowStatus({
                uid: runUid,
                expectedStatus: 'running',
                nextStatus: 'succeeded',
              });
              continue;
            }
            if (statuses.some((status) => status === 'cancelled')
              && statuses.every((status) => (
                status === 'succeeded' || status === 'skipped' || status === 'cancelled'
              ))) {
              scoped.runs.transitionWorkflowStatus({
                uid: runUid,
                expectedStatus: 'running',
                nextStatus: 'cancelled',
              });
              continue;
            }
            for (const node of before.nodes) {
              if (node.status !== 'running' && node.status !== 'queued') continue;
              scoped.runs.transitionNodeStatus({
                uid: node.uid,
                expectedStatus: node.status,
                nextStatus: node.status === 'running' ? 'failed' : 'blocked',
                inputSnapshot: {},
                output: null,
                cacheKey: null,
                errorCode: 'ERR_WORKFLOW_RECOVERY_ORPHANED',
                errorDetailRef: null,
              });
            }
            scoped.runs.transitionWorkflowStatus({
              uid: runUid,
              expectedStatus: 'running',
              nextStatus: 'failed',
              errorCode: 'ERR_WORKFLOW_RECOVERY_ORPHANED',
              errorDetailRef: null,
            });
            validateRunAggregate(scoped.runs.getWorkflowWithNodes(runUid));
          }
          return Object.freeze({ recoveredCount: runUids.length });
        });
      } catch (error) {
        throw translateRepositoryError(error);
      }
    },

    restartFailedNodes(input) {
      const request = inputObject(input, ['runUid', 'nodeRunUids']);
      const runUid = inputUuid(request.runUid);
      const nodeRunUids = inputUuidList(request.nodeRunUids);
      try {
        return repositories.withTransaction((scoped) => {
          const before = validateRunAggregate(scoped.runs.getWorkflowWithNodes(runUid));
          const selected = before.nodes.filter((node) => nodeRunUids.includes(node.uid));
          if (
            before.run.status !== 'failed'
            || before.run.retryCount >= MAX_RETRY_COUNT
            || selected.length !== nodeRunUids.length
            || selected.every((node) => node.status !== 'failed')
            || selected.some((node) => (
              (node.status !== 'failed' && node.status !== 'blocked')
              || node.retryCount >= MAX_RETRY_COUNT
            ))
          ) transitionInvalid();
          scoped.runs.transitionWorkflowStatus({
            uid: runUid,
            expectedStatus: 'failed',
            nextStatus: 'running',
          });
          for (const node of selected) {
            scoped.runs.transitionNodeStatus({
              uid: node.uid,
              expectedStatus: node.status,
              nextStatus: 'queued',
              inputSnapshot: {},
              output: null,
              cacheKey: null,
              errorCode: null,
              errorDetailRef: null,
            });
          }
          return validateRunAggregate(scoped.runs.getWorkflowWithNodes(runUid));
        });
      } catch (error) {
        throw translateRepositoryError(error);
      }
    },

    cancelRun(input) {
      const request = inputObject(input, ['runUid']);
      const runUid = inputUuid(request.runUid);
      try {
        return repositories.withTransaction((scoped) => {
          const before = validateRunAggregate(scoped.runs.getWorkflowWithNodes(runUid));
          if (before.run.status !== 'queued' && before.run.status !== 'running') {
            transitionInvalid();
          }
          for (const node of before.nodes) {
            if (node.status !== 'queued' && node.status !== 'running') continue;
            scoped.runs.transitionNodeStatus({
              uid: node.uid,
              expectedStatus: node.status,
              nextStatus: 'cancelled',
              inputSnapshot: {},
              output: null,
              cacheKey: null,
              errorCode: null,
              errorDetailRef: null,
            });
          }
          scoped.runs.transitionWorkflowStatus({
            uid: runUid,
            expectedStatus: before.run.status,
            nextStatus: 'cancelled',
          });
          return validateRunAggregate(scoped.runs.getWorkflowWithNodes(runUid));
        });
      } catch (error) {
        throw translateRepositoryError(error);
      }
    },

    transitionWorkflow(input) {
      const request = inputObject(input, [
        'runUid', 'expectedStatus', 'nextStatus', 'errorCode', 'errorDetailRef',
      ]);
      const runUid = inputUuid(request.runUid);
      if (!workflowTransitionAllowed(request.expectedStatus, request.nextStatus)) transitionInvalid();
      const failure = normalizeFailure(
        request.nextStatus,
        request.errorCode,
        request.errorDetailRef,
      );
      try {
        return repositories.withTransaction((scoped) => {
          const before = validateRunAggregate(scoped.runs.getWorkflowWithNodes(runUid));
          const states = before.nodes.map((node) => node.status);
          if (before.run.status !== request.expectedStatus || (
            request.nextStatus === 'succeeded'
              ? states.some((status) => status !== 'succeeded' && status !== 'skipped')
              : request.nextStatus === 'failed'
                && states.every((status) => status !== 'failed' && status !== 'blocked')
          )) transitionInvalid();
          scoped.runs.transitionWorkflowStatus({
            uid: runUid,
            expectedStatus: request.expectedStatus,
            nextStatus: request.nextStatus,
            ...failure,
          });
          return validateRunAggregate(scoped.runs.getWorkflowWithNodes(runUid)).run;
        });
      } catch (error) {
        throw translateRepositoryError(error);
      }
    },

    transitionNode(input) {
      const request = inputObject(input, [
        'nodeRunUid', 'expectedStatus', 'nextStatus', 'inputSnapshot', 'output', 'cacheKey',
        'errorCode', 'errorDetailRef',
      ]);
      const nodeRunUid = inputUuid(request.nodeRunUid);
      if (!nodeTransitionAllowed(request.expectedStatus, request.nextStatus)) transitionInvalid();
      const failure = normalizeFailure(
        request.nextStatus,
        request.errorCode,
        request.errorDetailRef,
        true,
      );
      let inputSnapshot;
      let output;
      let cacheKey = null;
      try {
        inputSnapshot = request.nextStatus === 'running'
          ? safePayload(request.inputSnapshot)
          : {};
        output = request.nextStatus === 'succeeded'
          ? safePayload(request.output)
          : null;
      } catch {
        inputInvalid();
      }
      if (request.nextStatus === 'running') {
        if (request.cacheKey !== undefined && (
          typeof request.cacheKey !== 'string' || !HASH.test(request.cacheKey)
        )) inputInvalid();
        cacheKey = request.cacheKey ?? null;
      } else if (request.cacheKey !== undefined || request.inputSnapshot !== undefined) {
        inputInvalid();
      }
      if (request.nextStatus !== 'succeeded' && request.output !== undefined) inputInvalid();
      try {
        return repositories.withTransaction((scoped) => {
          const node = normalizeNodeRunRecord(scoped.runs.getNode(nodeRunUid));
          const before = validateRunAggregate(scoped.runs.getWorkflowWithNodes(node.workflowRunUid));
          if (before.run.status !== 'running' || node.status !== request.expectedStatus) {
            transitionInvalid();
          }
          scoped.runs.transitionNodeStatus({
            uid: nodeRunUid,
            expectedStatus: request.expectedStatus,
            nextStatus: request.nextStatus,
            inputSnapshot,
            output,
            cacheKey,
            ...failure,
          });
          const aggregate = validateRunAggregate(scoped.runs.getWorkflowWithNodes(node.workflowRunUid));
          const verified = aggregate.nodes.find((candidate) => candidate.uid === nodeRunUid);
          if (!verified) throw new WorkflowRunDataError();
          return verified;
        });
      } catch (error) {
        throw translateRepositoryError(error);
      }
    },
  });
}

module.exports = { createWorkflowRunService };
