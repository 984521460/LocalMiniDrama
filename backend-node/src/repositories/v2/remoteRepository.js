const { types: { isProxy } } = require('node:util');

const {
  assertAllowedKeys,
  executeWrite,
  optimisticResult,
  requiredRow,
} = require('./repositorySupport');
const { V2RepositoryConflictError, V2RepositoryDataError } = require('./errors');
const { mapRow } = require('./rowMapping');
const { createRemoteConnectionRecord } = require('../../remote/connectionProfile');
const {
  createRemoteTaskRecord,
  createRemoteTaskRequest,
  hashRemoteTaskRequest,
} = require('../../remote/remoteTask');

const CONNECTION_MAP = Object.freeze({
  entity: 'remote connection',
  jsonFields: { environment_report_json: 'environmentReport' },
  jsonKinds: { environment_report_json: 'object?' },
});
const TASK_MAP = Object.freeze({ entity: 'remote task' });
const RECOVERY_PAGE_LIMIT = 100;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function recoverableTaskPageRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('remote task recovery page input is invalid');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError('remote task recovery page input is invalid');
  }
  const expected = ['afterCreatedAt', 'afterUid', 'limit'];
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== expected.length
    || keys.some((key) => typeof key !== 'string' || !expected.includes(key))
    || expected.some((key) => !descriptors[key]?.enumerable
      || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new TypeError('remote task recovery page input is invalid');
  }
  const afterCreatedAt = descriptors.afterCreatedAt.value;
  const afterUid = descriptors.afterUid.value;
  const limit = descriptors.limit.value;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECOVERY_PAGE_LIMIT
    || ((afterCreatedAt === null) !== (afterUid === null))) {
    throw new TypeError('remote task recovery page input is invalid');
  }
  if (afterCreatedAt !== null) {
    let canonical = false;
    try { canonical = new Date(afterCreatedAt).toISOString() === afterCreatedAt; } catch { /* invalid */ }
    if (!canonical || typeof afterUid !== 'string' || !UUID_V4.test(afterUid)) {
      throw new TypeError('remote task recovery page input is invalid');
    }
  }
  return Object.freeze({ afterCreatedAt, afterUid, limit });
}

function createRemoteRepository(database) {
  const connectionColumns = new Set(
    database.prepare('PRAGMA table_info(remote_connections)').all().map((column) => column.name),
  );
  const hasProductizedConnections = connectionColumns.has('auth_method');
  const taskColumns = new Set(
    database.prepare('PRAGMA table_info(remote_tasks)').all().map((column) => column.name),
  );
  const hasFormalTasks = taskColumns.has('contract_version');
  const insertConnection = database.prepare(hasProductizedConnections ? `
      INSERT INTO remote_connections
        (uid, name, host, port, username, host_fingerprint, credential_ref, status,
         auth_method, comfy_host, comfy_port, remote_work_dir)
      VALUES
        (@uid, @name, @host, @port, @username, @hostFingerprint, @credentialRef, @status,
         @authMethod, @comfyHost, @comfyPort, @remoteWorkDir)
    ` : `
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
  const insertFormalTask = hasFormalTasks ? database.prepare(`
    INSERT INTO remote_tasks
      (uid, connection_uid, connection_evidence_sha256, workflow_run_uid, workflow_manifest_uid, contract_version,
       idempotency_key, request_sha256, prompt_sha256, provider, prompt_id, remote_relative_dir,
       stage, status, recovery_state, state_version)
    VALUES
      (@uid, @connectionUid, @connectionEvidenceSha256, @workflowRunUid, @workflowManifestUid, 'remote-task.v1',
       @idempotencyKey, @requestSha256, @promptSha256, 'comfyui', NULL, @remoteRelativeDir,
       'prepared', 'queued', 'none', 0)
  `) : null;
  const getConnectionRow = database.prepare('SELECT * FROM remote_connections WHERE uid = ?');
  const getTaskRow = database.prepare('SELECT * FROM remote_tasks WHERE uid = ?');
  const getFormalTaskRow = hasFormalTasks ? database.prepare(`
    SELECT * FROM remote_tasks WHERE uid = ? AND contract_version = 'remote-task.v1'
  `) : null;
  const findFormalTaskByIdempotencyRow = hasFormalTasks ? database.prepare(`
    SELECT * FROM remote_tasks
    WHERE connection_uid = ? AND idempotency_key = ? AND contract_version = 'remote-task.v1'
  `) : null;
  const listConnectionRows = database.prepare(`
    SELECT * FROM remote_connections ORDER BY name, uid
  `);
  const listTaskRows = database.prepare(`
    SELECT * FROM remote_tasks WHERE connection_uid = ? ORDER BY created_at, uid
  `);
  const updateConnection = hasProductizedConnections ? database.prepare(`
    UPDATE remote_connections
    SET name = @name,
        host = @host,
        port = @port,
        username = @username,
        comfy_host = @comfyHost,
        comfy_port = @comfyPort,
        remote_work_dir = @remoteWorkDir,
        host_fingerprint = CASE
          WHEN host IS NOT @host OR port IS NOT @port OR username IS NOT @username
          THEN NULL ELSE host_fingerprint END,
        status = CASE
          WHEN host IS NOT @host OR port IS NOT @port OR username IS NOT @username
          THEN 'unverified' ELSE status END,
        state_version = state_version + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND state_version = @expectedStateVersion
  `) : null;
  const replaceCredential = hasProductizedConnections ? database.prepare(`
    UPDATE remote_connections
    SET credential_ref = @credentialRef,
        state_version = state_version + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND state_version = @expectedStateVersion
  `) : null;
  const confirmHostFingerprint = hasProductizedConnections ? database.prepare(`
    UPDATE remote_connections
    SET host_fingerprint = @fingerprint,
        status = 'ready',
        state_version = state_version + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid
      AND state_version = @expectedStateVersion
      AND (
        (host_fingerprint IS NULL AND status = 'unverified') OR
        (host_fingerprint = @fingerprint AND status = 'changed')
      )
  `) : null;
  const markHostFingerprintChanged = hasProductizedConnections ? database.prepare(`
    UPDATE remote_connections
    SET status = 'changed',
        state_version = state_version + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid
      AND state_version = @expectedStateVersion
      AND host_fingerprint = @expectedFingerprint
      AND status NOT IN ('disabled', 'changed')
  `) : null;
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
  const transitionFormalTask = hasFormalTasks ? database.prepare(`
    UPDATE remote_tasks
    SET stage = @nextStage,
        status = @nextStatus,
        heartbeat_at = CASE WHEN @nextStatus = 'running' THEN heartbeat_at ELSE NULL END,
        output_asset_version_uid = @outputAssetVersionUid,
        error_code = @errorCode,
        error_detail_ref = @errorDetailRef,
        error_phase = @errorPhase,
        error_retryable = @errorRetryable,
        recovery_state = @recoveryState,
        submission_lease_expires_at_epoch_ms = @submissionLeaseExpiresAtEpochMs,
        state_version = state_version + 1,
        started_at = CASE
          WHEN @nextStatus = 'running' AND started_at IS NULL
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE started_at END,
        completed_at = CASE
          WHEN @nextStatus IN ('succeeded', 'failed', 'cancelled')
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND contract_version = 'remote-task.v1'
      AND state_version = @expectedStateVersion
  `) : null;
  const assignFormalPrompt = hasFormalTasks ? database.prepare(`
    UPDATE remote_tasks
    SET prompt_id = @promptId,
        submission_lease_expires_at_epoch_ms = NULL,
        state_version = state_version + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND contract_version = 'remote-task.v1'
      AND state_version = @expectedStateVersion AND stage = 'submitted' AND prompt_id IS NULL
  `) : null;
  const renewFormalSubmissionLease = hasFormalTasks ? database.prepare(`
    UPDATE remote_tasks
    SET submission_lease_expires_at_epoch_ms = @submissionLeaseExpiresAtEpochMs,
        state_version = state_version + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND contract_version = 'remote-task.v1'
      AND state_version = @expectedStateVersion
      AND stage = 'submitted' AND status = 'running' AND prompt_id IS NULL
      AND submission_lease_expires_at_epoch_ms IS NOT NULL
  `) : null;
  const heartbeatFormalTask = hasFormalTasks ? database.prepare(`
    UPDATE remote_tasks
    SET heartbeat_at = @heartbeatAt,
        state_version = state_version + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND contract_version = 'remote-task.v1'
      AND state_version = @expectedStateVersion AND status = 'running'
      AND NOT (stage = 'submitted' AND prompt_id IS NULL)
  `) : null;
  const listRecoverableFormalTaskRows = hasFormalTasks ? database.prepare(`
    SELECT * FROM remote_tasks
    WHERE contract_version = 'remote-task.v1' AND status IN ('queued', 'running')
      AND (
        @afterCreatedAt IS NULL
        OR created_at > @afterCreatedAt
        OR (created_at = @afterCreatedAt AND uid > @afterUid)
      )
    ORDER BY created_at, uid
    LIMIT @limit
  `) : null;

  function mapConnection(row) {
    try {
      const mapped = mapRow(row, CONNECTION_MAP);
      return createRemoteConnectionRecord(hasProductizedConnections ? mapped : {
        ...mapped,
        authMethod: 'password',
        comfyHost: '127.0.0.1',
        comfyPort: 8188,
        remoteWorkDir: 'ai-drama-studio',
        environmentReport: null,
        environmentCheckedAtEpochMs: null,
        stateVersion: 0,
      });
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      throw new V2RepositoryDataError('remote connection', 'record');
    }
  }

  function getConnection(uid) {
    return mapConnection(requiredRow(getConnectionRow.get(uid), 'remote connection', uid));
  }

  function getTask(uid) {
    return mapTask(requiredRow(getTaskRow.get(uid), 'remote task', uid));
  }

  function mapTask(row) {
    const mapped = mapRow(row, TASK_MAP);
    if (!hasFormalTasks || mapped.contractVersion !== 'remote-task.v1') return mapped;
    try {
      return createRemoteTaskRecord(mapped);
    } catch {
      throw new V2RepositoryDataError('remote task', 'record');
    }
  }

  function requireFormalTaskSupport() {
    if (!hasFormalTasks) throw new V2RepositoryDataError('remote task', 'productized schema');
  }

  function getFormalTask(uid) {
    requireFormalTaskSupport();
    return mapTask(requiredRow(getFormalTaskRow.get(uid), 'remote task', uid));
  }

  return Object.freeze({
    assignFormalPrompt({ uid, expectedStateVersion, promptId }) {
      requireFormalTaskSupport();
      const result = executeWrite(
        'remote task',
        'assigned its remote prompt',
        () => assignFormalPrompt.run({ uid, expectedStateVersion, promptId }),
      );
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getFormalTaskRow.get(uid)),
        entity: 'remote task',
        uid,
        operation: 'assigned its remote prompt',
      });
      return getFormalTask(uid);
    },

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

    renewFormalSubmissionLease({
      uid, expectedStateVersion, submissionLeaseExpiresAtEpochMs,
    }) {
      requireFormalTaskSupport();
      const result = executeWrite(
        'remote task',
        'renewed its submission lease',
        () => renewFormalSubmissionLease.run({
          uid,
          expectedStateVersion,
          submissionLeaseExpiresAtEpochMs,
        }),
      );
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getFormalTaskRow.get(uid)),
        entity: 'remote task',
        uid,
        operation: 'renewed its submission lease',
      });
      return getFormalTask(uid);
    },

    createConnection(connection) {
      const allowedKeys = [
        'uid',
        'name',
        'host',
        'port',
        'username',
        'hostFingerprint',
        'credentialRef',
        'status',
        'authMethod',
        'comfyHost',
        'comfyPort',
        'remoteWorkDir',
      ];
      assertAllowedKeys(connection, hasProductizedConnections
        ? allowedKeys
        : allowedKeys.filter((key) => ![
          'authMethod', 'comfyHost', 'comfyPort', 'remoteWorkDir',
        ].includes(key)), 'remote connection');
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

    createFormalTaskIdempotent(task) {
      requireFormalTaskSupport();
      assertAllowedKeys(task, [
        'uid', 'connectionUid', 'connectionEvidenceSha256', 'workflowRunUid',
        'workflowManifestUid', 'idempotencyKey', 'promptSha256', 'remoteRelativeDir',
        'requestSha256',
      ], 'formal remote task');
      const request = createRemoteTaskRequest({
        connectionUid: task.connectionUid,
        connectionEvidenceSha256: task.connectionEvidenceSha256,
        workflowRunUid: task.workflowRunUid,
        workflowManifestUid: task.workflowManifestUid,
        idempotencyKey: task.idempotencyKey,
        promptSha256: task.promptSha256,
        remoteRelativeDir: task.remoteRelativeDir,
      });
      if (typeof task.requestSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(task.requestSha256)
        || task.requestSha256 !== hashRemoteTaskRequest(request)) {
        throw new TypeError('formal remote task request hash is invalid');
      }
      const existing = findFormalTaskByIdempotencyRow.get(
        request.connectionUid,
        request.idempotencyKey,
      );
      if (existing) {
        const persisted = mapTask(existing);
        if (persisted.requestSha256 !== task.requestSha256) {
          throw new V2RepositoryConflictError('remote task', 'created idempotently');
        }
        return Object.freeze({ created: false, task: persisted });
      }
      try {
        executeWrite('remote task', 'created idempotently', () => insertFormalTask.run({
          uid: task.uid,
          ...request,
          requestSha256: task.requestSha256,
        }));
      } catch (error) {
        if (!(error instanceof V2RepositoryConflictError)) throw error;
        const raced = findFormalTaskByIdempotencyRow.get(
          request.connectionUid,
          request.idempotencyKey,
        );
        if (!raced) throw error;
        const persisted = mapTask(raced);
        if (persisted.requestSha256 !== task.requestSha256) throw error;
        return Object.freeze({ created: false, task: persisted });
      }
      return Object.freeze({ created: true, task: getFormalTask(task.uid) });
    },

    confirmHostFingerprint({ uid, expectedStateVersion, fingerprint }) {
      if (!confirmHostFingerprint) {
        throw new V2RepositoryDataError('remote connection', 'productized schema');
      }
      const confirmation = { uid, expectedStateVersion, fingerprint };
      assertAllowedKeys(confirmation, [
        'uid', 'expectedStateVersion', 'fingerprint',
      ], 'remote connection host fingerprint confirmation');
      const result = executeWrite(
        'remote connection',
        'confirmed its host fingerprint',
        () => confirmHostFingerprint.run(confirmation),
      );
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getConnectionRow.get(uid)),
        entity: 'remote connection',
        uid,
        operation: 'confirmed its host fingerprint',
      });
      return getConnection(uid);
    },

    getConnection,
    getFormalTask,
    getTask,

    findFormalTaskByIdempotency(connectionUid, idempotencyKey) {
      requireFormalTaskSupport();
      const row = findFormalTaskByIdempotencyRow.get(connectionUid, idempotencyKey);
      return row ? mapTask(row) : null;
    },

    listConnections() {
      return Object.freeze(listConnectionRows.all().map(mapConnection));
    },

    listTasks(connectionUid) {
      return Object.freeze(listTaskRows.all(connectionUid).map(mapTask));
    },

    listRecoverableFormalTasks(value) {
      requireFormalTaskSupport();
      const request = recoverableTaskPageRequest(value);
      return Object.freeze(listRecoverableFormalTaskRows.all(request).map(mapTask));
    },

    markHostFingerprintChanged({ uid, expectedStateVersion, expectedFingerprint }) {
      if (!markHostFingerprintChanged) {
        throw new V2RepositoryDataError('remote connection', 'productized schema');
      }
      const change = { uid, expectedStateVersion, expectedFingerprint };
      assertAllowedKeys(change, [
        'uid', 'expectedStateVersion', 'expectedFingerprint',
      ], 'remote connection host fingerprint change');
      const result = executeWrite(
        'remote connection',
        'marked its host fingerprint as changed',
        () => markHostFingerprintChanged.run(change),
      );
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getConnectionRow.get(uid)),
        entity: 'remote connection',
        uid,
        operation: 'marked its host fingerprint as changed',
      });
      return getConnection(uid);
    },

    replaceCredential({ uid, expectedStateVersion, credentialRef }) {
      if (!replaceCredential) {
        throw new V2RepositoryDataError('remote connection', 'productized schema');
      }
      const replacement = { uid, expectedStateVersion, credentialRef };
      assertAllowedKeys(replacement, [
        'uid', 'expectedStateVersion', 'credentialRef',
      ], 'remote connection credential replacement');
      const result = executeWrite(
        'remote connection',
        'replaced its credential reference',
        () => replaceCredential.run(replacement),
      );
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getConnectionRow.get(uid)),
        entity: 'remote connection',
        uid,
        operation: 'replaced its credential reference',
      });
      return getConnection(uid);
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

    heartbeatFormalTask({ uid, expectedStateVersion, heartbeatAt }) {
      requireFormalTaskSupport();
      const result = executeWrite(
        'remote task',
        'recorded its heartbeat',
        () => heartbeatFormalTask.run({ uid, expectedStateVersion, heartbeatAt }),
      );
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getFormalTaskRow.get(uid)),
        entity: 'remote task',
        uid,
        operation: 'recorded its heartbeat',
      });
      return getFormalTask(uid);
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

    transitionFormalTask(transition) {
      requireFormalTaskSupport();
      assertAllowedKeys(transition, [
        'uid', 'expectedStateVersion', 'nextStage', 'nextStatus', 'recoveryState',
        'outputAssetVersionUid', 'errorCode', 'errorDetailRef', 'errorPhase', 'errorRetryable',
        'submissionLeaseExpiresAtEpochMs',
      ], 'formal remote task transition');
      const values = {
        uid: transition.uid,
        expectedStateVersion: transition.expectedStateVersion,
        nextStage: transition.nextStage,
        nextStatus: transition.nextStatus,
        recoveryState: transition.recoveryState,
        outputAssetVersionUid: transition.outputAssetVersionUid ?? null,
        errorCode: transition.errorCode ?? null,
        errorDetailRef: transition.errorDetailRef ?? null,
        errorPhase: transition.errorPhase ?? null,
        errorRetryable: transition.errorRetryable === undefined || transition.errorRetryable === null
          ? null : Number(Boolean(transition.errorRetryable)),
        submissionLeaseExpiresAtEpochMs: transition.submissionLeaseExpiresAtEpochMs ?? null,
      };
      const result = executeWrite(
        'remote task',
        'transitioned formally',
        () => transitionFormalTask.run(values),
      );
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getFormalTaskRow.get(transition.uid)),
        entity: 'remote task',
        uid: transition.uid,
        operation: 'transitioned formally',
      });
      return getFormalTask(transition.uid);
    },

    updateConnection(connection) {
      if (!updateConnection) {
        throw new V2RepositoryDataError('remote connection', 'productized schema');
      }
      assertAllowedKeys(connection, [
        'uid',
        'expectedStateVersion',
        'name',
        'host',
        'port',
        'username',
        'comfyHost',
        'comfyPort',
        'remoteWorkDir',
      ], 'remote connection update');
      const result = executeWrite('remote connection', 'updated', () => updateConnection.run(connection));
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getConnectionRow.get(connection.uid)),
        entity: 'remote connection',
        uid: connection.uid,
        operation: 'updated',
      });
      return getConnection(connection.uid);
    },
  });
}

module.exports = { createRemoteRepository };
