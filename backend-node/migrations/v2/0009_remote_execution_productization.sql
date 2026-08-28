-- Phase 6 starts by making connection profiles explicit without storing secrets.
-- Later Phase 6 tasks extend this migration with transport and task-state evidence.

ALTER TABLE remote_connections ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'
  CHECK (auth_method IN ('password'));

ALTER TABLE remote_connections ADD COLUMN comfy_host TEXT NOT NULL DEFAULT '127.0.0.1'
  CHECK (comfy_host = '127.0.0.1');

ALTER TABLE remote_connections ADD COLUMN comfy_port INTEGER NOT NULL DEFAULT 8188
  CHECK (typeof(comfy_port) = 'integer' AND comfy_port BETWEEN 1 AND 65535);

ALTER TABLE remote_connections ADD COLUMN remote_work_dir TEXT NOT NULL DEFAULT 'ai-drama-studio'
  CHECK (
    typeof(remote_work_dir) = 'text' AND
    length(CAST(remote_work_dir AS BLOB)) BETWEEN 1 AND 512 AND
    instr(remote_work_dir, char(0)) = 0 AND
    instr(remote_work_dir, '\') = 0 AND
    instr(remote_work_dir, ':') = 0 AND
    substr(remote_work_dir, 1, 1) <> '/' AND
    remote_work_dir NOT IN ('.', '..') AND
    remote_work_dir NOT GLOB './*' AND
    remote_work_dir NOT GLOB '../*' AND
    remote_work_dir NOT GLOB '*/./*' AND
    remote_work_dir NOT GLOB '*/../*' AND
    remote_work_dir NOT GLOB '*/.' AND
    remote_work_dir NOT GLOB '*/..' AND
    remote_work_dir NOT GLOB '*//*' AND
    remote_work_dir NOT GLOB '*/'
  );

ALTER TABLE remote_connections ADD COLUMN environment_report_json TEXT
  CHECK (environment_report_json IS NULL);

ALTER TABLE remote_connections ADD COLUMN environment_checked_at_epoch_ms INTEGER
  CHECK (environment_checked_at_epoch_ms IS NULL);

ALTER TABLE remote_connections ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(state_version) = 'integer' AND state_version BETWEEN 0 AND 2147483647);

CREATE TRIGGER v2_remote_connections_immutable_identity
BEFORE UPDATE OF uid ON remote_connections
WHEN NEW.uid IS NOT OLD.uid
BEGIN
  SELECT RAISE(ABORT, 'remote connection identity is immutable');
END;

CREATE TRIGGER v2_remote_connections_validate_host_fingerprint_insert
BEFORE INSERT ON remote_connections
WHEN NEW.host_fingerprint IS NOT NULL AND NOT (
  typeof(NEW.host_fingerprint) = 'text' AND
  length(CAST(NEW.host_fingerprint AS BLOB)) = 50 AND
  substr(NEW.host_fingerprint, 1, 7) = 'SHA256:' AND
  substr(NEW.host_fingerprint, 8) NOT GLOB '*[^A-Za-z0-9+/]*'
)
BEGIN
  SELECT RAISE(ABORT, 'remote connection host fingerprint is invalid');
END;

CREATE TRIGGER v2_remote_connections_validate_host_fingerprint_update
BEFORE UPDATE OF host_fingerprint ON remote_connections
WHEN NEW.host_fingerprint IS NOT NULL AND NOT (
  typeof(NEW.host_fingerprint) = 'text' AND
  length(CAST(NEW.host_fingerprint AS BLOB)) = 50 AND
  substr(NEW.host_fingerprint, 1, 7) = 'SHA256:' AND
  substr(NEW.host_fingerprint, 8) NOT GLOB '*[^A-Za-z0-9+/]*'
)
BEGIN
  SELECT RAISE(ABORT, 'remote connection host fingerprint is invalid');
END;

-- A formal ComfyUI manifest is identified by the validation schema marker. Legacy
-- workflow manifests remain readable, while formal records receive strict shape
-- checks and append-only evidence semantics.
CREATE TRIGGER v2_comfy_workflow_manifests_validate_insert
BEFORE INSERT ON workflow_manifests
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.validation_json)
  WHERE key = 'schemaVersion' AND value = 'comfy-workflow-manifest.v1'
)
  AND NOT (
    NEW.engine = 'comfyui' AND
    NEW.status = 'validated' AND
    length(CAST(NEW.manifest_id AS BLOB)) BETWEEN 1 AND 120 AND
    NEW.manifest_id = trim(NEW.manifest_id) AND
    NEW.manifest_id NOT GLOB '*[^a-z0-9-]*' AND
    substr(NEW.manifest_id, 1, 1) GLOB '[a-z0-9]' AND
    substr(NEW.manifest_id, -1, 1) GLOB '[a-z0-9]' AND
    NEW.manifest_id NOT GLOB '*--*' AND
    length(CAST(NEW.version AS BLOB)) BETWEEN 5 AND 20 AND
    NEW.version NOT GLOB '*[^0-9.]*' AND
    length(NEW.version) - length(replace(NEW.version, '.', '')) = 2 AND
    NEW.version NOT GLOB '.*' AND NEW.version NOT GLOB '*.' AND
    NEW.version NOT GLOB '*..*' AND
    NEW.version NOT GLOB '0[0-9]*.*' AND
    substr(NEW.version, instr(NEW.version, '.') + 1) NOT GLOB '0[0-9]*.*' AND
    substr(
      substr(NEW.version, instr(NEW.version, '.') + 1),
      instr(substr(NEW.version, instr(NEW.version, '.') + 1), '.') + 1
    ) NOT GLOB '0[0-9]*' AND
    length(substr(NEW.version, 1, instr(NEW.version, '.') - 1)) BETWEEN 1 AND 6 AND
    length(substr(
      substr(NEW.version, instr(NEW.version, '.') + 1), 1,
      instr(substr(NEW.version, instr(NEW.version, '.') + 1), '.') - 1
    )) BETWEEN 1 AND 6 AND
    length(substr(
      substr(NEW.version, instr(NEW.version, '.') + 1),
      instr(substr(NEW.version, instr(NEW.version, '.') + 1), '.') + 1
    )) BETWEEN 1 AND 6 AND
    NEW.workflow_file NOT GLOB '*[^A-Za-z0-9._/-]*' AND
    instr(NEW.workflow_file, '\') = 0 AND
    length(NEW.workflow_file) - length(replace(NEW.workflow_file, '/', '')) <= 31 AND
    typeof(NEW.model_family) = 'text' AND
    length(CAST(NEW.model_family AS BLOB)) BETWEEN 1 AND 120 AND
    NEW.model_family = trim(NEW.model_family) AND
    NEW.model_family NOT GLOB '*[^a-z0-9-]*' AND
    substr(NEW.model_family, 1, 1) GLOB '[a-z0-9]' AND
    substr(NEW.model_family, -1, 1) GLOB '[a-z0-9]' AND
    NEW.model_family NOT GLOB '*--*' AND
    json_type(NEW.validation_json) = 'object' AND
    NEW.validation_json = json(NEW.validation_json) AND
    NEW.requirements_json = json(NEW.requirements_json) AND
    NEW.inputs_json = json(NEW.inputs_json) AND
    NEW.outputs_json = json(NEW.outputs_json) AND
    instr(NEW.validation_json, char(92)) = 0 AND
    instr(NEW.requirements_json, char(92)) = 0 AND
    instr(NEW.inputs_json, char(92)) = 0 AND
    instr(NEW.outputs_json, char(92)) = 0 AND
    (SELECT count(*) FROM json_each(NEW.validation_json)) = 3 AND
    (SELECT count(DISTINCT key) FROM json_each(NEW.validation_json)) = 3 AND
    json_extract(NEW.validation_json, '$.schemaVersion') IS 'comfy-workflow-manifest.v1' AND
    json_extract(NEW.validation_json, '$.workflowFormat') IS 'api' AND
    json_type(NEW.validation_json, '$.markersValidated') IS 'true' AND
    json_array_length(NEW.requirements_json) BETWEEN 1 AND 256 AND
    NOT EXISTS (
      SELECT 1 FROM json_each(NEW.requirements_json) AS requirement
      WHERE requirement.type <> 'object' OR
        CASE json_extract(requirement.value, '$.kind')
          WHEN 'node' THEN NOT (
            (SELECT count(*) FROM json_each(requirement.value)) = 2 AND
            (SELECT count(DISTINCT key) FROM json_each(requirement.value)) = 2 AND
            json_type(requirement.value, '$.nodeType') IS 'text' AND
            length(CAST(json_extract(requirement.value, '$.nodeType') AS BLOB)) BETWEEN 1 AND 128 AND
            substr(json_extract(requirement.value, '$.nodeType'), 1, 1) GLOB '[A-Za-z_]' AND
            json_extract(requirement.value, '$.nodeType') NOT GLOB '*[^A-Za-z0-9_.:-]*'
          )
          WHEN 'model' THEN NOT (
            (SELECT count(*) FROM json_each(requirement.value)) = 4 AND
            (SELECT count(DISTINCT key) FROM json_each(requirement.value)) = 4 AND
            json_type(requirement.value, '$.nodeType') IS 'text' AND
            json_type(requirement.value, '$.inputName') IS 'text' AND
            json_type(requirement.value, '$.fileName') IS 'text' AND
            length(CAST(json_extract(requirement.value, '$.nodeType') AS BLOB)) BETWEEN 1 AND 128 AND
            length(CAST(json_extract(requirement.value, '$.inputName') AS BLOB)) BETWEEN 1 AND 128 AND
            length(CAST(json_extract(requirement.value, '$.fileName') AS BLOB)) BETWEEN 1 AND 1024 AND
            substr(json_extract(requirement.value, '$.nodeType'), 1, 1) GLOB '[A-Za-z_]' AND
            json_extract(requirement.value, '$.nodeType') NOT GLOB '*[^A-Za-z0-9_.:-]*' AND
            substr(json_extract(requirement.value, '$.inputName'), 1, 1) GLOB '[A-Za-z_]' AND
            json_extract(requirement.value, '$.inputName') NOT GLOB '*[^A-Za-z0-9_.:-]*' AND
            json_extract(requirement.value, '$.fileName') = trim(json_extract(requirement.value, '$.fileName')) AND
            json_extract(requirement.value, '$.fileName') NOT GLOB '*[^A-Za-z0-9._/-]*' AND
            instr(json_extract(requirement.value, '$.fileName'), '\') = 0 AND
            instr(json_extract(requirement.value, '$.fileName'), ':') = 0 AND
            substr(json_extract(requirement.value, '$.fileName'), 1, 1) <> '/' AND
            json_extract(requirement.value, '$.fileName') NOT IN ('.', '..') AND
            json_extract(requirement.value, '$.fileName') NOT GLOB './*' AND
            json_extract(requirement.value, '$.fileName') NOT GLOB '../*' AND
            json_extract(requirement.value, '$.fileName') NOT GLOB '*/./*' AND
            json_extract(requirement.value, '$.fileName') NOT GLOB '*/../*' AND
            json_extract(requirement.value, '$.fileName') NOT GLOB '*/.' AND
            json_extract(requirement.value, '$.fileName') NOT GLOB '*/..' AND
            json_extract(requirement.value, '$.fileName') NOT GLOB '*//*' AND
            json_extract(requirement.value, '$.fileName') NOT GLOB '*/' AND
            length(json_extract(requirement.value, '$.fileName')) -
              length(replace(json_extract(requirement.value, '$.fileName'), '/', '')) <= 31
          )
          ELSE 1
        END
    ) AND
    (SELECT count(*) FROM json_each(NEW.requirements_json)) =
      (SELECT count(DISTINCT
        json_extract(value, '$.kind') || char(0) ||
        json_extract(value, '$.nodeType') || char(0) ||
        coalesce(json_extract(value, '$.inputName'), '') || char(0) ||
        coalesce(json_extract(value, '$.fileName'), '')
      ) FROM json_each(NEW.requirements_json)) AND
    (SELECT count(*) FROM json_each(NEW.inputs_json)) BETWEEN 1 AND 64 AND
    NOT EXISTS (
      SELECT 1 FROM json_each(NEW.inputs_json) AS binding
      WHERE binding.key NOT GLOB '[A-Za-z_]*' OR
        binding.key GLOB '*[^A-Za-z0-9_.:-]*' OR
        length(CAST(binding.key AS BLOB)) NOT BETWEEN 1 AND 128 OR
        binding.type <> 'object' OR
        (SELECT count(*) FROM json_each(binding.value)) <> 4 OR
        (SELECT count(DISTINCT key) FROM json_each(binding.value)) <> 4 OR
        json_type(binding.value, '$.marker') IS NOT 'text' OR
        json_type(binding.value, '$.inputName') IS NOT 'text' OR
        length(CAST(json_extract(binding.value, '$.marker') AS BLOB)) NOT BETWEEN 5 AND 256 OR
        json_extract(binding.value, '$.marker') NOT GLOB 'APP_[A-Z0-9]*' OR
        json_extract(binding.value, '$.marker') GLOB '*[^A-Z0-9_]*' OR
        json_extract(binding.value, '$.marker') GLOB '*__*' OR
        substr(json_extract(binding.value, '$.marker'), -1, 1) = '_' OR
        substr(json_extract(binding.value, '$.inputName'), 1, 1) NOT GLOB '[A-Za-z_]' OR
        json_extract(binding.value, '$.inputName') GLOB '*[^A-Za-z0-9_.:-]*' OR
        length(CAST(json_extract(binding.value, '$.inputName') AS BLOB)) NOT BETWEEN 1 AND 128 OR
        coalesce(json_extract(binding.value, '$.valueType') IN
          ('string', 'integer', 'number', 'boolean', 'string-array'), 0) = 0 OR
        coalesce(json_type(binding.value, '$.required') IN ('true', 'false'), 0) = 0
    ) AND
    (SELECT count(*) FROM json_each(NEW.inputs_json)) =
      (SELECT count(DISTINCT key) FROM json_each(NEW.inputs_json)) AND
    (SELECT count(*) FROM json_each(NEW.inputs_json)) =
      (SELECT count(DISTINCT
        json_extract(value, '$.marker') || char(0) || json_extract(value, '$.inputName')
      ) FROM json_each(NEW.inputs_json)) AND
    (SELECT count(*) FROM json_each(NEW.outputs_json)) BETWEEN 1 AND 16 AND
    NOT EXISTS (
      SELECT 1 FROM json_each(NEW.outputs_json) AS binding
      WHERE binding.key NOT GLOB '[A-Za-z_]*' OR
        binding.key GLOB '*[^A-Za-z0-9_.:-]*' OR
        length(CAST(binding.key AS BLOB)) NOT BETWEEN 1 AND 128 OR
        binding.type <> 'object' OR
        (SELECT count(*) FROM json_each(binding.value)) <> 1 OR
        (SELECT count(DISTINCT key) FROM json_each(binding.value)) <> 1 OR
        json_type(binding.value, '$.marker') IS NOT 'text' OR
        length(CAST(json_extract(binding.value, '$.marker') AS BLOB)) NOT BETWEEN 5 AND 256 OR
        json_extract(binding.value, '$.marker') NOT GLOB 'APP_[A-Z0-9]*' OR
        json_extract(binding.value, '$.marker') GLOB '*[^A-Z0-9_]*' OR
        json_extract(binding.value, '$.marker') GLOB '*__*' OR
        substr(json_extract(binding.value, '$.marker'), -1, 1) = '_'
    ) AND
    (SELECT count(*) FROM json_each(NEW.outputs_json)) =
      (SELECT count(DISTINCT key) FROM json_each(NEW.outputs_json)) AND
    (SELECT count(*) FROM json_each(NEW.outputs_json)) =
      (SELECT count(DISTINCT json_extract(value, '$.marker')) FROM json_each(NEW.outputs_json))
  )
BEGIN
  SELECT RAISE(ABORT, 'formal ComfyUI workflow manifest is invalid');
END;

CREATE TRIGGER v2_comfy_workflow_manifests_reject_replacement
BEFORE INSERT ON workflow_manifests
WHEN (
  EXISTS (
    SELECT 1 FROM json_each(NEW.validation_json)
    WHERE key = 'schemaVersion' AND value = 'comfy-workflow-manifest.v1'
  ) AND EXISTS (
    SELECT 1 FROM workflow_manifests
    WHERE uid = NEW.uid OR (manifest_id = NEW.manifest_id AND version = NEW.version)
  )
) OR EXISTS (
  SELECT 1
  FROM workflow_manifests AS existing
  WHERE (existing.uid = NEW.uid OR (
    existing.manifest_id = NEW.manifest_id AND existing.version = NEW.version
  )) AND EXISTS (
    SELECT 1 FROM json_each(existing.validation_json)
    WHERE key = 'schemaVersion' AND value = 'comfy-workflow-manifest.v1'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'formal ComfyUI workflow manifest replacement is forbidden');
END;

CREATE TRIGGER v2_comfy_workflow_manifests_immutable_update
BEFORE UPDATE ON workflow_manifests
WHEN EXISTS (
  SELECT 1 FROM json_each(OLD.validation_json)
  WHERE key = 'schemaVersion' AND value = 'comfy-workflow-manifest.v1'
)
BEGIN
  SELECT RAISE(ABORT, 'formal ComfyUI workflow manifest is immutable');
END;

CREATE TRIGGER v2_comfy_workflow_manifests_immutable_delete
BEFORE DELETE ON workflow_manifests
WHEN EXISTS (
  SELECT 1 FROM json_each(OLD.validation_json)
  WHERE key = 'schemaVersion' AND value = 'comfy-workflow-manifest.v1'
)
BEGIN
  SELECT RAISE(ABORT, 'formal ComfyUI workflow manifest is immutable');
END;

-- Formal remote tasks retain the legacy stage/status columns while adding a
-- versioned, idempotent contract. Legacy task rows remain readable.
ALTER TABLE remote_tasks ADD COLUMN contract_version TEXT
  CHECK (contract_version IS NULL OR contract_version = 'remote-task.v1');

ALTER TABLE remote_tasks ADD COLUMN workflow_manifest_uid TEXT
  REFERENCES workflow_manifests(uid) ON DELETE RESTRICT;

ALTER TABLE remote_tasks ADD COLUMN idempotency_key TEXT
  CHECK (
    idempotency_key IS NULL OR (
      typeof(idempotency_key) = 'text' AND
      length(CAST(idempotency_key AS BLOB)) = 51 AND
      substr(idempotency_key, 1, 15) = 'remote-task:v1:' AND
      substr(idempotency_key, 16) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    )
  );

ALTER TABLE remote_tasks ADD COLUMN request_sha256 TEXT
  CHECK (
    request_sha256 IS NULL OR (
      typeof(request_sha256) = 'text' AND length(CAST(request_sha256 AS BLOB)) = 64 AND
      request_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE remote_tasks ADD COLUMN connection_evidence_sha256 TEXT
  CHECK (
    connection_evidence_sha256 IS NULL OR (
      typeof(connection_evidence_sha256) = 'text' AND
      length(CAST(connection_evidence_sha256 AS BLOB)) = 64 AND
      connection_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE remote_tasks ADD COLUMN prompt_sha256 TEXT
  CHECK (
    prompt_sha256 IS NULL OR (
      typeof(prompt_sha256) = 'text' AND length(CAST(prompt_sha256 AS BLOB)) = 64 AND
      prompt_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE remote_tasks ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(state_version) = 'integer' AND state_version BETWEEN 0 AND 2147483647);

ALTER TABLE remote_tasks ADD COLUMN submission_lease_expires_at_epoch_ms INTEGER
  CHECK (
    submission_lease_expires_at_epoch_ms IS NULL OR (
      typeof(submission_lease_expires_at_epoch_ms) = 'integer' AND
      submission_lease_expires_at_epoch_ms BETWEEN 0 AND 8640000000000000
    )
  );

ALTER TABLE remote_tasks ADD COLUMN error_phase TEXT
  CHECK (
    error_phase IS NULL OR error_phase IN (
      'connection', 'dependency', 'upload', 'submission', 'execution',
      'download', 'verification', 'recovery'
    )
  );

ALTER TABLE remote_tasks ADD COLUMN error_retryable INTEGER
  CHECK (error_retryable IS NULL OR error_retryable IN (0, 1));

ALTER TABLE remote_tasks ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'none'
  CHECK (recovery_state IN ('none', 'completed', 'retryable', 'orphaned'));

CREATE UNIQUE INDEX idx_v2_remote_tasks_idempotency
  ON remote_tasks(connection_uid, idempotency_key)
  WHERE contract_version = 'remote-task.v1';

CREATE TRIGGER v2_remote_tasks_formal_validate_insert
BEFORE INSERT ON remote_tasks
WHEN NEW.contract_version = 'remote-task.v1' AND NOT (
  NEW.provider = 'comfyui' AND
  NEW.workflow_manifest_uid IS NOT NULL AND
  EXISTS (
    SELECT 1 FROM workflow_manifests
    WHERE uid = NEW.workflow_manifest_uid AND engine = 'comfyui' AND status = 'validated'
      AND EXISTS (
        SELECT 1 FROM json_each(validation_json)
        WHERE key = 'schemaVersion' AND value = 'comfy-workflow-manifest.v1'
      )
  ) AND
  NEW.idempotency_key IS NOT NULL AND
  NEW.connection_evidence_sha256 IS NOT NULL AND
  NEW.request_sha256 IS NOT NULL AND
  NEW.prompt_sha256 IS NOT NULL AND
  NEW.prompt_id IS NULL AND
  NEW.stage = 'prepared' AND NEW.status = 'queued' AND
  NEW.heartbeat_at IS NULL AND NEW.retry_count = 0 AND
  NEW.output_asset_version_uid IS NULL AND
  NEW.error_code IS NULL AND NEW.error_detail_ref IS NULL AND
  NEW.error_phase IS NULL AND NEW.error_retryable IS NULL AND
  NEW.recovery_state = 'none' AND NEW.state_version = 0 AND
  NEW.submission_lease_expires_at_epoch_ms IS NULL AND
  NEW.started_at IS NULL AND NEW.completed_at IS NULL AND
  typeof(NEW.created_at) = 'text' AND length(CAST(NEW.created_at AS BLOB)) = 24 AND
  substr(NEW.created_at, 5, 1) = '-' AND substr(NEW.created_at, 8, 1) = '-' AND
  substr(NEW.created_at, 11, 1) = 'T' AND substr(NEW.created_at, 14, 1) = ':' AND
  substr(NEW.created_at, 17, 1) = ':' AND substr(NEW.created_at, 20, 1) = '.' AND
  substr(NEW.created_at, 24, 1) = 'Z' AND
  CAST(substr(NEW.created_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23 AND
  date(substr(NEW.created_at, 1, 10), '+0 days') = substr(NEW.created_at, 1, 10) AND
  strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at) = NEW.created_at AND
  typeof(NEW.updated_at) = 'text' AND length(CAST(NEW.updated_at AS BLOB)) = 24 AND
  date(substr(NEW.updated_at, 1, 10), '+0 days') = substr(NEW.updated_at, 1, 10) AND
  CAST(substr(NEW.updated_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23 AND
  strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at) = NEW.updated_at AND
  NEW.updated_at = NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'formal remote task initial state is invalid');
END;

CREATE TRIGGER v2_remote_tasks_formal_reject_replacement
BEFORE INSERT ON remote_tasks
WHEN NEW.contract_version = 'remote-task.v1' AND EXISTS (
  SELECT 1 FROM remote_tasks
  WHERE uid = NEW.uid OR (
    connection_uid = NEW.connection_uid AND idempotency_key = NEW.idempotency_key
  )
)
BEGIN
  SELECT RAISE(ABORT, 'formal remote task replacement is forbidden');
END;

CREATE TRIGGER v2_remote_tasks_formal_immutable_identity
BEFORE UPDATE ON remote_tasks
WHEN OLD.contract_version = 'remote-task.v1' AND (
  NEW.uid IS NOT OLD.uid OR
  NEW.connection_uid IS NOT OLD.connection_uid OR
  NEW.connection_evidence_sha256 IS NOT OLD.connection_evidence_sha256 OR
  NEW.workflow_run_uid IS NOT OLD.workflow_run_uid OR
  NEW.provider IS NOT OLD.provider OR
  NEW.remote_relative_dir IS NOT OLD.remote_relative_dir OR
  NEW.contract_version IS NOT OLD.contract_version OR
  NEW.workflow_manifest_uid IS NOT OLD.workflow_manifest_uid OR
  NEW.idempotency_key IS NOT OLD.idempotency_key OR
  NEW.request_sha256 IS NOT OLD.request_sha256 OR
  NEW.prompt_sha256 IS NOT OLD.prompt_sha256 OR
  NEW.created_at IS NOT OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'formal remote task identity is immutable');
END;

CREATE TRIGGER v2_remote_tasks_formal_terminal_immutable
BEFORE UPDATE ON remote_tasks
WHEN OLD.contract_version = 'remote-task.v1'
  AND OLD.status IN ('succeeded', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'formal remote task terminal state is immutable');
END;

CREATE TRIGGER v2_remote_tasks_formal_validate_update
BEFORE UPDATE ON remote_tasks
WHEN OLD.contract_version = 'remote-task.v1' AND NOT (
  NEW.state_version = OLD.state_version + 1 AND
  NEW.state_version <= 2147483647 AND
  NEW.retry_count = OLD.retry_count AND
  CASE OLD.stage
    WHEN 'prepared' THEN NEW.stage IN ('uploading', 'submitted', 'failed', 'cancelled')
    WHEN 'uploading' THEN NEW.stage IN ('uploading', 'submitted', 'failed', 'cancelled')
    WHEN 'submitted' THEN NEW.stage IN ('submitted', 'executing', 'downloading', 'failed', 'cancelled')
    WHEN 'executing' THEN NEW.stage IN ('executing', 'downloading', 'failed', 'cancelled')
    WHEN 'downloading' THEN NEW.stage IN ('downloading', 'verifying', 'failed', 'cancelled')
    WHEN 'verifying' THEN NEW.stage IN ('verifying', 'completed', 'failed', 'cancelled')
    ELSE 0
  END AND
  CASE NEW.stage
    WHEN 'prepared' THEN NEW.status = 'queued'
    WHEN 'uploading' THEN NEW.status = 'running'
    WHEN 'submitted' THEN NEW.status = 'running'
    WHEN 'executing' THEN NEW.status = 'running'
    WHEN 'downloading' THEN NEW.status = 'running'
    WHEN 'verifying' THEN NEW.status = 'running'
    WHEN 'completed' THEN NEW.status = 'succeeded'
    WHEN 'failed' THEN NEW.status = 'failed'
    WHEN 'cancelled' THEN NEW.status = 'cancelled'
    ELSE 0
  END AND
  (NEW.prompt_id IS NULL OR (
    typeof(NEW.prompt_id) = 'text' AND
    length(CAST(NEW.prompt_id AS BLOB)) BETWEEN 1 AND 128 AND
    NEW.prompt_id NOT GLOB '*[^A-Za-z0-9._-]*'
  )) AND
  (NEW.stage NOT IN ('prepared', 'uploading') OR NEW.prompt_id IS NULL) AND
  (NEW.stage NOT IN ('executing', 'downloading', 'verifying', 'completed') OR NEW.prompt_id IS NOT NULL) AND
  (
    (NEW.stage = 'submitted' AND NEW.prompt_id IS NULL AND
     NEW.submission_lease_expires_at_epoch_ms IS NOT NULL) OR
    (NOT (NEW.stage = 'submitted' AND NEW.prompt_id IS NULL) AND
     NEW.submission_lease_expires_at_epoch_ms IS NULL)
  ) AND
  (NEW.status = 'running' OR NEW.heartbeat_at IS NULL) AND
  (NEW.heartbeat_at IS NULL OR (
    typeof(NEW.heartbeat_at) = 'text' AND length(CAST(NEW.heartbeat_at AS BLOB)) = 24 AND
    substr(NEW.heartbeat_at, 5, 1) = '-' AND substr(NEW.heartbeat_at, 8, 1) = '-' AND
    substr(NEW.heartbeat_at, 11, 1) = 'T' AND substr(NEW.heartbeat_at, 14, 1) = ':' AND
    substr(NEW.heartbeat_at, 17, 1) = ':' AND substr(NEW.heartbeat_at, 20, 1) = '.' AND
    substr(NEW.heartbeat_at, 24, 1) = 'Z' AND
    CAST(substr(NEW.heartbeat_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23 AND
    strftime('%Y-%m-%dT%H:%M:%fZ', NEW.heartbeat_at) = NEW.heartbeat_at
  )) AND
  typeof(NEW.updated_at) = 'text' AND length(CAST(NEW.updated_at AS BLOB)) = 24 AND
  date(substr(NEW.updated_at, 1, 10), '+0 days') = substr(NEW.updated_at, 1, 10) AND
  CAST(substr(NEW.updated_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23 AND
  strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at) = NEW.updated_at AND
  (NEW.started_at IS NULL OR (
    typeof(NEW.started_at) = 'text' AND length(CAST(NEW.started_at AS BLOB)) = 24 AND
    date(substr(NEW.started_at, 1, 10), '+0 days') = substr(NEW.started_at, 1, 10) AND
    CAST(substr(NEW.started_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23 AND
    strftime('%Y-%m-%dT%H:%M:%fZ', NEW.started_at) = NEW.started_at
  )) AND
  (NEW.completed_at IS NULL OR (
    typeof(NEW.completed_at) = 'text' AND length(CAST(NEW.completed_at AS BLOB)) = 24 AND
    date(substr(NEW.completed_at, 1, 10), '+0 days') = substr(NEW.completed_at, 1, 10) AND
    CAST(substr(NEW.completed_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23 AND
    strftime('%Y-%m-%dT%H:%M:%fZ', NEW.completed_at) = NEW.completed_at
  )) AND
  (NEW.status <> 'running' OR NEW.started_at IS NOT NULL) AND
  (NEW.status NOT IN ('succeeded', 'failed', 'cancelled') OR NEW.completed_at IS NOT NULL) AND
  (NEW.status IN ('succeeded', 'failed', 'cancelled') OR NEW.completed_at IS NULL) AND
  (NEW.output_asset_version_uid IS NULL OR NEW.stage = 'completed') AND
  CASE NEW.stage
    WHEN 'failed' THEN
      NEW.error_code IS NOT NULL AND NEW.error_phase IS NOT NULL AND
      NEW.error_retryable IS NOT NULL AND NEW.recovery_state IN ('retryable', 'orphaned') AND
      ((NEW.recovery_state = 'retryable' AND NEW.error_retryable = 1) OR
       (NEW.recovery_state = 'orphaned' AND NEW.error_retryable = 0))
    ELSE
      NEW.error_code IS NULL AND NEW.error_detail_ref IS NULL AND
      NEW.error_phase IS NULL AND NEW.error_retryable IS NULL AND
      (
        NEW.recovery_state = 'none' OR
        (NEW.recovery_state = 'completed' AND NEW.stage IN ('downloading', 'verifying', 'completed'))
      )
  END
)
BEGIN
  SELECT RAISE(ABORT, 'formal remote task state transition is invalid');
END;

CREATE TRIGGER v2_remote_tasks_formal_immutable_delete
BEFORE DELETE ON remote_tasks
WHEN OLD.contract_version = 'remote-task.v1'
BEGIN
  SELECT RAISE(ABORT, 'formal remote task is immutable');
END;
