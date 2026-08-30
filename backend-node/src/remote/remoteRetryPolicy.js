'use strict';

const { createRemoteTaskRecord } = require('./remoteTask');

const SAFE_REPLAY_PHASES = new Set(['dependency', 'upload', 'recovery']);

function classification(task, disposition, allowed, reasonCode) {
  return Object.freeze({
    taskUid: task.uid,
    stateVersion: task.stateVersion,
    disposition,
    allowed,
    retryCount: task.retryCount,
    maxRetries: task.maxRetries,
    reasonCode,
  });
}

function createRemoteTaskRetryClassification(value) {
  const task = createRemoteTaskRecord(value);
  if (task.status === 'queued' || task.status === 'running') {
    return classification(task, 'in_progress', false, 'REMOTE_RETRY_TASK_IN_PROGRESS');
  }
  if (task.status === 'succeeded' || task.status === 'cancelled') {
    return classification(task, 'terminal', false, 'REMOTE_RETRY_TASK_TERMINAL');
  }
  if (task.recoveryState === 'orphaned' || task.promptId !== null) {
    return classification(task, 'manual_reconcile', false, 'REMOTE_RETRY_MANUAL_RECONCILIATION_REQUIRED');
  }
  if (task.retryCount >= task.maxRetries) {
    return classification(task, 'exhausted', false, 'REMOTE_RETRY_LIMIT_EXHAUSTED');
  }
  if (task.recoveryState === 'retryable' && SAFE_REPLAY_PHASES.has(task.errorPhase)) {
    return classification(task, 'safe_replay', true, 'REMOTE_RETRY_SAFE_BEFORE_SUBMISSION');
  }
  return classification(task, 'manual_reconcile', false, 'REMOTE_RETRY_MANUAL_RECONCILIATION_REQUIRED');
}

module.exports = Object.freeze({ createRemoteTaskRetryClassification });
