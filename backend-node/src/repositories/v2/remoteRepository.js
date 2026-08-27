const {
  assertAllowedKeys,
  executeWrite,
  optimisticResult,
  requiredRow,
} = require('./repositorySupport');
const { mapRow, mapRows } = require('./rowMapping');

const CONNECTION_MAP = Object.freeze({ entity: 'remote connection' });
const TASK_MAP = Object.freeze({ entity: 'remote task' });

function createRemoteRepository(database) {
  const insertConnection = database.prepare(`
    INSERT INTO remote_connections
      (uid, name, host, port, username, host_fingerprint, credential_ref, status)
    VALUES
      (@uid, @name, @host, @port, @username, @hostFingerprint, @credentialRef, @status)
  `);
  const insertTask = database.prepare(`
    INSERT INTO remote_tasks
      (uid, connection_uid, workflow_run_uid, provider, prompt_id, remote_relative_dir, stage, status)
    VALUES
      (@uid, @connectionUid, @workflowRunUid, @provider, @promptId, @remoteRelativeDir, @stage, @status)
  `);
  const getConnectionRow = database.prepare('SELECT * FROM remote_connections WHERE uid = ?');
  const getTaskRow = database.prepare('SELECT * FROM remote_tasks WHERE uid = ?');
  const listConnectionRows = database.prepare(`
    SELECT * FROM remote_connections ORDER BY name, uid
  `);
  const listTaskRows = database.prepare(`
    SELECT * FROM remote_tasks WHERE connection_uid = ? ORDER BY created_at, uid
  `);
  const assignPrompt = database.prepare(`
    UPDATE remote_tasks
    SET prompt_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = ? AND prompt_id IS NULL
  `);
  const transitionTask = database.prepare(`
    UPDATE remote_tasks
    SET stage = @nextStage,
        status = @nextStatus,
        started_at = CASE WHEN @nextStatus = 'running' AND started_at IS NULL
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE started_at END,
        completed_at = CASE WHEN @nextStatus IN ('succeeded', 'failed', 'cancelled')
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE completed_at END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND status = @expectedStatus
  `);
  const touchHeartbeat = database.prepare(`
    UPDATE remote_tasks
    SET heartbeat_at = @heartbeatAt,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND status = 'running'
  `);

  function getConnection(uid) {
    return mapRow(requiredRow(getConnectionRow.get(uid), 'remote connection', uid), CONNECTION_MAP);
  }

  function getTask(uid) {
    return mapRow(requiredRow(getTaskRow.get(uid), 'remote task', uid), TASK_MAP);
  }

  return Object.freeze({
    assignPrompt(uid, promptId) {
      const result = executeWrite('remote task', 'assigned a prompt identity', () => assignPrompt.run(promptId, uid));
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getTaskRow.get(uid)),
        entity: 'remote task',
        uid,
        operation: 'assigned a prompt identity',
      });
      return getTask(uid);
    },

    createConnection(connection) {
      assertAllowedKeys(connection, [
        'uid',
        'name',
        'host',
        'port',
        'username',
        'hostFingerprint',
        'credentialRef',
        'status',
      ], 'remote connection');
      executeWrite('remote connection', 'created', () => insertConnection.run(connection));
      return getConnection(connection.uid);
    },

    createTask(task) {
      assertAllowedKeys(task, [
        'uid',
        'connectionUid',
        'workflowRunUid',
        'provider',
        'promptId',
        'remoteRelativeDir',
        'stage',
        'status',
      ], 'remote task');
      const persisted = {
        ...task,
        workflowRunUid: task.workflowRunUid ?? null,
        promptId: task.promptId ?? null,
      };
      executeWrite('remote task', 'created', () => insertTask.run(persisted));
      return getTask(task.uid);
    },

    getConnection,
    getTask,

    listConnections() {
      return mapRows(listConnectionRows.all(), CONNECTION_MAP);
    },

    listTasks(connectionUid) {
      return mapRows(listTaskRows.all(connectionUid), TASK_MAP);
    },

    touchHeartbeat(uid, heartbeatAt) {
      const result = executeWrite('remote task', 'updated', () => touchHeartbeat.run({ uid, heartbeatAt }));
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getTaskRow.get(uid)),
        entity: 'remote task',
        uid,
        operation: 'updated',
      });
      return getTask(uid);
    },

    transitionTask({ uid, expectedStatus, nextStatus, nextStage }) {
      const result = executeWrite('remote task', 'transitioned', () => transitionTask.run({
        uid,
        expectedStatus,
        nextStatus,
        nextStage,
      }));
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getTaskRow.get(uid)),
        entity: 'remote task',
        uid,
        operation: 'transitioned',
      });
      return getTask(uid);
    },
  });
}

module.exports = { createRemoteRepository };
