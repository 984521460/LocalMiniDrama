const ARCHIVE_REPLAY_ERROR = 'ERR_ARCHIVE_REPLAY';

function requireSingleChange(result) {
  if (!result || result.changes !== 1) {
    throw new TypeError('Workflow run archive replay did not change exactly one row');
  }
}

function createWorkflowRunArchiveReplay(database) {
  const insertWorkflowRun = database.prepare(`
    INSERT INTO workflow_runs
      (uid, workflow_uid, graph_snapshot_json, graph_hash, graph_revision, trigger_type,
       status, retry_count, error_code, error_detail_ref, created_at, started_at,
       completed_at, updated_at)
    VALUES
      (@uid, @workflow_uid, @graph_snapshot_json, @graph_hash, @graph_revision, @trigger_type,
       'queued', 0, NULL, NULL, @created_at, NULL, NULL, @updated_at)
  `);
  const updateWorkflowRun = database.prepare(`
    UPDATE workflow_runs
    SET status = @status,
        retry_count = @retry_count,
        error_code = @error_code,
        error_detail_ref = @error_detail_ref,
        started_at = @started_at,
        completed_at = @completed_at,
        updated_at = @updated_at
    WHERE uid = @uid AND status = @expected_status
  `);
  const insertNodeRun = database.prepare(`
    INSERT INTO node_runs
      (uid, workflow_run_uid, node_uid, ordinal, input_snapshot_json, output_json,
       cache_key, status, retry_count, error_code, error_detail_ref, created_at,
       started_at, completed_at, updated_at)
    VALUES
      (@uid, @workflow_run_uid, @node_uid, @ordinal, '{}', NULL,
       NULL, 'queued', 0, NULL, NULL, @created_at, NULL, NULL, @updated_at)
  `);
  const updateNodeRun = database.prepare(`
    UPDATE node_runs
    SET status = @status,
        retry_count = @retry_count,
        input_snapshot_json = @input_snapshot_json,
        output_json = @output_json,
        cache_key = @cache_key,
        error_code = @error_code,
        error_detail_ref = @error_detail_ref,
        started_at = @started_at,
        completed_at = @completed_at,
        updated_at = @updated_at
    WHERE uid = @uid
      AND status = @expected_status
      AND retry_count = @expected_retry_count
  `);

  function workflowStep(row, expectedStatus, state) {
    requireSingleChange(updateWorkflowRun.run({
      uid: row.uid,
      expected_status: expectedStatus,
      updated_at: row.updated_at,
      ...state,
    }));
  }

  function finishWorkflowRun(row) {
    const finalState = {
      status: row.status,
      retry_count: row.retry_count,
      error_code: row.error_code,
      error_detail_ref: row.error_detail_ref,
      started_at: row.started_at,
      completed_at: row.completed_at,
    };
    if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(row.status)) {
      throw new TypeError('Workflow run archive status is not replayable');
    }
    if (row.status === 'queued') return;
    let currentStatus = 'queued';
    let retryCount = 0;
    while (retryCount < row.retry_count) {
      if (currentStatus === 'running') {
        workflowStep(row, 'running', {
          status: 'failed',
          retry_count: retryCount,
          error_code: ARCHIVE_REPLAY_ERROR,
          error_detail_ref: null,
          started_at: row.created_at,
          completed_at: row.created_at,
        });
      } else if (currentStatus === 'queued') {
        workflowStep(row, 'queued', {
          status: 'failed',
          retry_count: retryCount,
          error_code: ARCHIVE_REPLAY_ERROR,
          error_detail_ref: null,
          started_at: null,
          completed_at: row.created_at,
        });
      }
      workflowStep(row, 'failed', {
        status: 'running',
        retry_count: retryCount + 1,
        error_code: null,
        error_detail_ref: null,
        started_at: row.created_at,
        completed_at: null,
      });
      retryCount += 1;
      currentStatus = 'running';
    }
    if (row.status === 'failed' && currentStatus === 'running') {
      workflowStep(row, 'running', {
        ...finalState,
        status: 'failed',
      });
      return;
    }
    if (row.status === 'succeeded' && currentStatus === 'queued') {
      workflowStep(row, 'queued', {
        status: 'running',
        retry_count: 0,
        error_code: null,
        error_detail_ref: null,
        started_at: row.started_at,
        completed_at: null,
      });
      currentStatus = 'running';
    }
    if (currentStatus === row.status) {
      workflowStep(row, currentStatus, finalState);
      return;
    }
    if (currentStatus === 'queued' || currentStatus === 'running') {
      workflowStep(row, currentStatus, finalState);
      return;
    }
    throw new TypeError('Workflow run archive retry state is not replayable');
  }

  function nodeStep(row, expectedStatus, expectedRetryCount, state) {
    requireSingleChange(updateNodeRun.run({
      uid: row.uid,
      expected_status: expectedStatus,
      expected_retry_count: expectedRetryCount,
      updated_at: row.updated_at,
      ...state,
    }));
  }

  function replayNodeRetries(row) {
    for (let retry = 0; retry < row.retry_count; retry++) {
      nodeStep(row, 'queued', retry, {
        status: 'blocked',
        retry_count: retry,
        input_snapshot_json: '{}',
        output_json: null,
        cache_key: null,
        error_code: ARCHIVE_REPLAY_ERROR,
        error_detail_ref: null,
        started_at: null,
        completed_at: row.created_at,
      });
      nodeStep(row, 'blocked', retry, {
        status: 'queued',
        retry_count: retry + 1,
        input_snapshot_json: '{}',
        output_json: null,
        cache_key: null,
        error_code: null,
        error_detail_ref: null,
        started_at: null,
        completed_at: null,
      });
    }
  }

  function finishNodeRun(row) {
    replayNodeRetries(row);
    if (row.status === 'queued') return;
    const finalState = {
      status: row.status,
      retry_count: row.retry_count,
      input_snapshot_json: row.input_snapshot_json,
      output_json: row.output_json,
      cache_key: row.cache_key,
      error_code: row.error_code,
      error_detail_ref: row.error_detail_ref,
      started_at: row.started_at,
      completed_at: row.completed_at,
    };
    if (row.status === 'succeeded' || row.status === 'failed') {
      nodeStep(row, 'queued', row.retry_count, {
        status: 'running',
        retry_count: row.retry_count,
        input_snapshot_json: row.input_snapshot_json,
        output_json: null,
        cache_key: row.cache_key,
        error_code: null,
        error_detail_ref: null,
        started_at: row.started_at || row.created_at,
        completed_at: null,
      });
      nodeStep(row, 'running', row.retry_count, finalState);
      return;
    }
    if (!['running', 'cancelled', 'blocked', 'skipped'].includes(row.status)) {
      throw new TypeError('Node run archive status is not replayable');
    }
    nodeStep(row, 'queued', row.retry_count, finalState);
  }

  return Object.freeze({
    importHistory(workflowRuns, nodeRuns) {
      for (const row of workflowRuns) insertWorkflowRun.run(row);
      for (const row of nodeRuns) insertNodeRun.run(row);
      for (const row of nodeRuns) finishNodeRun(row);
      for (const row of workflowRuns) finishWorkflowRun(row);
    },
  });
}

module.exports = { createWorkflowRunArchiveReplay };
