'use strict';

const { createMediaExportRunRequest } = require('./mediaExportRun');
const { V2RepositoryConflictError } = require('../repositories/v2/errors');

function createMediaExportService(value) {
  const required = ['repository', 'exporter', 'createUid', 'removeOutput', 'nowEpochMs'];
  if (!value || typeof value !== 'object' || required.some((key) => (
    !Object.hasOwn(value, key)
    || (key === 'repository'
      ? !value.repository || typeof value.repository !== 'object'
      : typeof value[key] !== 'function' && key !== 'exporter')
  )) || !value.exporter || typeof value.exporter.export !== 'function') {
    throw new TypeError('Media export service dependencies are invalid');
  }
  const repositoryMethods = [
    'complete', 'fail', 'get', 'getBySourceNodeRun', 'getExecutionPlan',
    'listByDrama', 'prepareFromNode', 'recoverInterrupted', 'start',
  ];
  if (repositoryMethods.some((name) => typeof value.repository[name] !== 'function')) {
    throw new TypeError('Media export service dependencies are invalid');
  }

  async function start(inputValue, expectedDramaUid = null) {
    const input = createMediaExportRunRequest(inputValue);
    let run = value.repository.getBySourceNodeRun(input.nodeRunUid);
    if (run === null) {
      run = value.repository.prepareFromNode(
        input.nodeRunUid, value.nowEpochMs(), expectedDramaUid,
      );
    }
    if (expectedDramaUid !== null && run.dramaUid !== expectedDramaUid) {
      throw new V2RepositoryConflictError('media export run', 'started');
    }
    if (run.status === 'succeeded' || run.status === 'failed') return run;
    if (run.status !== 'queued') {
      throw new V2RepositoryConflictError('media export run', 'started');
    }
    run = value.repository.start(run.uid);
    const plan = value.repository.getExecutionPlan(run.uid);
    let receipt = null;
    try {
      receipt = await value.exporter.export(Object.freeze({
        schemaVersion: '8.0',
        executionPlan: plan,
        completedAtEpochMs: value.nowEpochMs(),
      }));
      return value.repository.complete({
        uid: run.uid,
        assetUid: value.createUid(),
        assetVersionUid: value.createUid(),
        receipt,
      });
    } catch {
      let errorCode = 'MEDIA_EXPORT_FAILED';
      if (receipt !== null) {
        try {
          await value.removeOutput(receipt.output.relativePath, receipt.output.sha256);
        } catch {
          errorCode = 'MEDIA_EXPORT_CLEANUP_FAILED';
        }
      }
      try {
        return value.repository.fail(run.uid, errorCode, value.nowEpochMs());
      } catch {
        throw new TypeError(errorCode);
      }
    }
  }

  return Object.freeze({
    get(uid, expectedDramaUid = null) {
      const run = value.repository.get(uid);
      if (expectedDramaUid !== null && run.dramaUid !== expectedDramaUid) {
        throw new V2RepositoryConflictError('media export run', 'read');
      }
      return run;
    },
    listByDrama(dramaUid) { return value.repository.listByDrama(dramaUid); },
    recoverInterrupted() {
      return value.repository.recoverInterrupted(value.nowEpochMs());
    },
    start,
  });
}

module.exports = Object.freeze({ createMediaExportService });
