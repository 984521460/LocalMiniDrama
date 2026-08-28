-- Phase 7: persist immutable local H3 execution intent before remote side effects.

CREATE TABLE h3_generation_intents (
  uid TEXT PRIMARY KEY NOT NULL CHECK (
    typeof(uid)='text' AND length(CAST(uid AS BLOB))=36 AND
    uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  task_uid TEXT NOT NULL UNIQUE REFERENCES remote_tasks(uid) ON DELETE RESTRICT CHECK (
    typeof(task_uid)='text' AND length(CAST(task_uid AS BLOB))=36
  ),
  generation_run_uid TEXT NOT NULL UNIQUE CHECK (
    typeof(generation_run_uid)='text' AND length(CAST(generation_run_uid AS BLOB))=36 AND
    generation_run_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  history_uid TEXT NOT NULL UNIQUE CHECK (
    typeof(history_uid)='text' AND length(CAST(history_uid AS BLOB))=36 AND
    history_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  asset_uid TEXT NOT NULL REFERENCES assets(uid) ON DELETE RESTRICT,
  prompt_semantic_uid TEXT NOT NULL REFERENCES prompt_semantic_versions(uid) ON DELETE RESTRICT,
  manifest_uid TEXT NOT NULL REFERENCES workflow_manifests(uid) ON DELETE RESTRICT,
  parent_version_uid TEXT REFERENCES asset_versions(uid) ON DELETE RESTRICT,
  generation_spec_json TEXT NOT NULL CHECK (
    typeof(generation_spec_json)='text' AND
    length(CAST(generation_spec_json AS BLOB)) BETWEEN 2 AND 1048576 AND
    CASE WHEN json_valid(generation_spec_json)
      THEN json_type(generation_spec_json)='object' ELSE 0 END
  ),
  generation_spec_sha256 TEXT NOT NULL CHECK (
    typeof(generation_spec_sha256)='text' AND
    length(CAST(generation_spec_sha256 AS BLOB))=64 AND
    generation_spec_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  filename_prefix TEXT NOT NULL CHECK (
    typeof(filename_prefix)='text' AND
    length(CAST(filename_prefix AS BLOB)) BETWEEN 1 AND 512 AND
    instr(filename_prefix, char(0))=0
  ),
  task_prompt_sha256 TEXT NOT NULL CHECK (
    typeof(task_prompt_sha256)='text' AND length(CAST(task_prompt_sha256 AS BLOB))=64 AND
    task_prompt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  plan_evidence_sha256 TEXT NOT NULL CHECK (
    typeof(plan_evidence_sha256)='text' AND length(CAST(plan_evidence_sha256 AS BLOB))=64 AND
    plan_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_epoch_ms INTEGER NOT NULL CHECK (
    typeof(created_at_epoch_ms)='integer' AND
    created_at_epoch_ms BETWEEN 0 AND 253402300799999
  )
) WITHOUT ROWID;

CREATE TRIGGER v2_h3_generation_intents_validate_insert
BEFORE INSERT ON h3_generation_intents
WHEN NOT (
  EXISTS (
    SELECT 1 FROM remote_tasks AS task
    WHERE task.uid=NEW.task_uid
      AND task.contract_version='remote-task.v1'
      AND task.workflow_run_uid IS NOT NULL
      AND task.workflow_manifest_uid=NEW.manifest_uid
      AND task.prompt_sha256=NEW.task_prompt_sha256
      AND task.stage='prepared' AND task.status='queued'
      AND task.prompt_id IS NULL AND task.output_asset_version_uid IS NULL
  )
  AND 1=(
    SELECT h3_official_manifest_matches(
      manifest.uid, manifest.manifest_id, manifest.version, manifest.engine,
      manifest.workflow_file, manifest.workflow_sha256, manifest.model_family,
      manifest.requirements_json, manifest.inputs_json, manifest.outputs_json,
      manifest.validation_json, manifest.status
    )
    FROM workflow_manifests AS manifest WHERE manifest.uid=NEW.manifest_uid
  )
  AND EXISTS (
    SELECT 1 FROM prompt_semantic_versions AS semantic
    JOIN assets AS asset ON asset.uid=NEW.asset_uid
    WHERE semantic.uid=NEW.prompt_semantic_uid
      AND asset.owner_type='drama' AND asset.owner_uid=semantic.drama_uid
      AND asset.asset_type='video' AND asset.status<>'deleted'
  )
  AND EXISTS (
    SELECT 1
    FROM prompt_semantic_versions AS semantic
    JOIN narrative_results AS result ON result.uid=semantic.shot_result_uid
    JOIN narrative_review_events AS review ON review.uid=result.current_review_uid
    WHERE semantic.uid=NEW.prompt_semantic_uid
      AND result.result_type='shot' AND result.status='approved'
      AND result.result_hash=semantic.shot_result_hash
      AND result.envelope_hash=semantic.shot_envelope_hash
      AND review.result_uid=result.uid AND review.decision='approve'
      AND review.result_hash=result.result_hash
      AND review.envelope_hash=result.envelope_hash
      AND semantic.shot_approval_ref='review:v1:' || review.uid
  )
  AND (
    (NEW.parent_version_uid IS NULL AND EXISTS (
      SELECT 1 FROM assets AS asset
      WHERE asset.uid=NEW.asset_uid AND asset.current_version_uid IS NULL
    ))
    OR EXISTS (
      SELECT 1 FROM asset_versions AS version
      JOIN assets AS asset ON asset.uid=version.asset_uid
      WHERE version.uid=NEW.parent_version_uid
        AND version.asset_uid=NEW.asset_uid AND version.status='ready'
        AND asset.current_version_uid=version.uid
    )
  )
  AND json_extract(NEW.generation_spec_json,'$.schemaVersion')='h3-generation-spec.v1'
  AND json_extract(NEW.generation_spec_json,'$.mode')='t2v'
  AND json_extract(NEW.generation_spec_json,'$.referenceAudio') IS NULL
  AND json_array_length(NEW.generation_spec_json,'$.referenceImages')=0
  AND json_extract(NEW.generation_spec_json,'$.prompt.dramaUid')=(
    SELECT drama_uid FROM prompt_semantic_versions WHERE uid=NEW.prompt_semantic_uid
  )
  AND h3_generation_spec_sha256(NEW.generation_spec_json) IS NEW.generation_spec_sha256
  AND h3_semantic_shot_sha256(
    (SELECT semantic_json FROM prompt_semantic_versions WHERE uid=NEW.prompt_semantic_uid),
    NEW.prompt_semantic_uid,
    (SELECT created_at_epoch_ms FROM prompt_semantic_versions WHERE uid=NEW.prompt_semantic_uid),
    (SELECT drama_uid FROM prompt_semantic_versions WHERE uid=NEW.prompt_semantic_uid),
    (SELECT shot_result_uid FROM prompt_semantic_versions WHERE uid=NEW.prompt_semantic_uid),
    (SELECT shot_result_hash FROM prompt_semantic_versions WHERE uid=NEW.prompt_semantic_uid),
    (SELECT shot_envelope_hash FROM prompt_semantic_versions WHERE uid=NEW.prompt_semantic_uid),
    (SELECT shot_approval_ref FROM prompt_semantic_versions WHERE uid=NEW.prompt_semantic_uid),
    (SELECT semantic_sha256 FROM prompt_semantic_versions WHERE uid=NEW.prompt_semantic_uid),
    json_extract(NEW.generation_spec_json,'$.prompt.shotId'),
    json_extract(NEW.generation_spec_json,'$.prompt.continuitySnapshotUid')
  ) IS json_extract(NEW.generation_spec_json,'$.prompt.semanticSha256')
  AND NEW.plan_evidence_sha256 IS (
    SELECT h3_plan_evidence_sha256(
      run.graph_snapshot_json,
      node.node_uid,
      json_object(
        'uid', task.uid,
        'connectionUid', task.connection_uid,
        'connectionEvidenceSha256', task.connection_evidence_sha256,
        'workflowRunUid', task.workflow_run_uid,
        'workflowManifestUid', task.workflow_manifest_uid,
        'promptSha256', task.prompt_sha256
      ),
      json_object(
        'uid', connection.uid, 'name', connection.name, 'host', connection.host,
        'port', connection.port, 'username', connection.username,
        'hostFingerprint', connection.host_fingerprint,
        'credentialRef', connection.credential_ref, 'status', connection.status,
        'createdAt', connection.created_at, 'updatedAt', connection.updated_at,
        'authMethod', connection.auth_method, 'comfyHost', connection.comfy_host,
        'comfyPort', connection.comfy_port, 'remoteWorkDir', connection.remote_work_dir,
        'environmentReport', CASE WHEN connection.environment_report_json IS NULL
          THEN NULL ELSE json(connection.environment_report_json) END,
        'environmentCheckedAtEpochMs', connection.environment_checked_at_epoch_ms,
        'stateVersion', connection.state_version
      ),
      json_object(
        'uid', asset.uid, 'ownerType', asset.owner_type, 'ownerUid', asset.owner_uid,
        'assetType', asset.asset_type, 'status', asset.status,
        'currentVersionUid', asset.current_version_uid
      ),
      NEW.generation_spec_json,
      NEW.manifest_uid,
      NEW.filename_prefix
    )
    FROM remote_tasks AS task
    JOIN node_runs AS node ON node.uid=substr(task.idempotency_key, 16)
      AND node.workflow_run_uid=task.workflow_run_uid
    JOIN workflow_runs AS run ON run.uid=task.workflow_run_uid
    JOIN remote_connections AS connection ON connection.uid=task.connection_uid
    JOIN assets AS asset ON asset.uid=NEW.asset_uid
    WHERE task.uid=NEW.task_uid AND task.contract_version='remote-task.v1'
  )
)
BEGIN SELECT RAISE(ABORT, 'H3 generation intent is invalid'); END;

CREATE TRIGGER v2_h3_generation_intents_reject_replacement
BEFORE INSERT ON h3_generation_intents
WHEN EXISTS (
  SELECT 1 FROM h3_generation_intents AS intent
  WHERE intent.uid=NEW.uid OR intent.task_uid=NEW.task_uid
    OR intent.generation_run_uid=NEW.generation_run_uid
    OR intent.history_uid=NEW.history_uid
)
BEGIN SELECT RAISE(ABORT, 'H3 generation intent replacement is forbidden'); END;

CREATE TRIGGER v2_h3_generation_intents_immutable_update
BEFORE UPDATE ON h3_generation_intents
BEGIN SELECT RAISE(ABORT, 'H3 generation intents are immutable'); END;

CREATE TRIGGER v2_h3_generation_intents_immutable_delete
BEFORE DELETE ON h3_generation_intents
BEGIN SELECT RAISE(ABORT, 'H3 generation intents are append-only'); END;

CREATE TRIGGER v2_h3_remote_task_completion_requires_history
BEFORE UPDATE OF stage, status, prompt_id, output_asset_version_uid ON remote_tasks
WHEN NEW.stage='completed' AND EXISTS (
  SELECT 1 FROM h3_generation_intents AS intent WHERE intent.task_uid=NEW.uid
) AND NOT EXISTS (
  SELECT 1
  FROM h3_generation_intents AS intent
  JOIN asset_generation_history AS history
    ON history.uid=intent.history_uid
   AND history.run_uid=intent.generation_run_uid
   AND history.asset_uid=intent.asset_uid
   AND history.prompt_semantic_uid=intent.prompt_semantic_uid
   AND history.manifest_uid=intent.manifest_uid
   AND history.output_version_uid=NEW.output_asset_version_uid
   AND history.parent_version_uid IS intent.parent_version_uid
  WHERE intent.task_uid=NEW.uid
    AND NEW.prompt_id IS NOT NULL
    AND json_extract(history.input_json,'$.remotePromptId')=NEW.prompt_id
    AND 1=h3_history_matches_intent(
      intent.generation_spec_json,
      intent.generation_spec_sha256,
      json_object(
        'historyUid', intent.history_uid,
        'generationRunUid', intent.generation_run_uid,
        'assetUid', intent.asset_uid,
        'promptSemanticUid', intent.prompt_semantic_uid,
        'manifestUid', intent.manifest_uid,
        'parentVersionUid', intent.parent_version_uid,
        'remotePromptId', NEW.prompt_id,
        'outputVersionUid', NEW.output_asset_version_uid,
        'outputVersionEvidence', (
          SELECT json_object(
            'uid', version.uid,
            'assetUid', version.asset_uid,
            'storageProvider', version.storage_provider,
            'logicalUri', version.logical_uri,
            'relativePath', version.relative_path,
            'sha256', version.sha256,
            'mimeType', version.mime_type,
            'width', version.width,
            'height', version.height,
            'durationMs', version.duration_ms,
            'parentUid', version.parent_uid,
            'status', version.status,
            'createdAt', version.created_at
          ) FROM asset_versions AS version WHERE version.uid=NEW.output_asset_version_uid
        ),
        'parentVersionEvidence', CASE WHEN intent.parent_version_uid IS NULL
          THEN NULL ELSE (
            SELECT json_object(
              'uid', version.uid,
              'assetUid', version.asset_uid,
              'storageProvider', version.storage_provider,
              'logicalUri', version.logical_uri,
              'relativePath', version.relative_path,
              'sha256', version.sha256,
              'mimeType', version.mime_type,
              'width', version.width,
              'height', version.height,
              'durationMs', version.duration_ms,
              'parentUid', version.parent_uid,
              'status', version.status,
              'createdAt', version.created_at
            ) FROM asset_versions AS version WHERE version.uid=intent.parent_version_uid
          ) END
      ),
      json_object(
        'uid', history.uid,
        'runUid', history.run_uid,
        'dramaUid', history.drama_uid,
        'assetUid', history.asset_uid,
        'promptSemanticUid', history.prompt_semantic_uid,
        'manifestUid', history.manifest_uid,
        'manifestSha256', history.manifest_sha256,
        'provider', history.provider,
        'model', history.model,
        'seed', history.seed,
        'parametersJson', history.parameters_json,
        'parametersSha256', history.parameters_sha256,
        'inputJson', history.input_json,
        'inputSha256', history.input_sha256,
        'status', history.status,
        'outputVersionUid', history.output_version_uid,
        'outputVersionEvidenceJson', history.output_version_evidence_json,
        'parentVersionUid', history.parent_version_uid,
        'parentVersionEvidenceJson', history.parent_version_evidence_json,
        'errorCode', history.error_code,
        'errorDetailRef', history.error_detail_ref,
        'createdAtEpochMs', history.created_at_epoch_ms,
        'completedAtEpochMs', history.completed_at_epoch_ms
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'H3 remote task completion requires generation history'); END;
