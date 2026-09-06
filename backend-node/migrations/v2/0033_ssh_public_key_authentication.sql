-- Adds native Ed25519 public-key authentication while preserving every legacy
-- password connection and the original auth_method column name used by sealed evidence.

ALTER TABLE remote_connections ADD COLUMN auth_method_v2 TEXT NOT NULL DEFAULT 'password'
  CHECK (auth_method_v2 IN ('password', 'publickey'));

UPDATE remote_connections SET auth_method_v2 = auth_method;

ALTER TABLE remote_connections ADD COLUMN ssh_public_key TEXT
  CHECK (
    (auth_method_v2 = 'password' AND ssh_public_key IS NULL)
    OR (
      auth_method_v2 = 'publickey'
      AND typeof(ssh_public_key) = 'text'
      AND length(CAST(ssh_public_key AS BLOB)) = 97
      AND substr(ssh_public_key, 1, 12) = 'ssh-ed25519 '
      AND substr(ssh_public_key, 13, 25) = 'AAAAC3NzaC1lZDI1NTE5AAAAI'
      AND substr(ssh_public_key, 13, 68) NOT GLOB '*[^A-Za-z0-9+/]*'
      AND substr(ssh_public_key, 81) = ' local-mini-drama'
    )
  );

DROP TRIGGER v2_h3_generation_intents_validate_insert;
DROP TRIGGER v2_h3_generation_intents_reject_replacement;
DROP TRIGGER v2_mvp_benchmark_external_authorizations_validate_insert;
DROP TRIGGER v2_mvp_benchmark_external_authorizations_reject_replacement;
DROP TRIGGER v2_mvp_benchmark_external_authorizations_operator_attestation_insert;
DROP TRIGGER v2_mvp_benchmark_live_environment_attestations_validate_insert;
DROP TRIGGER v2_mvp_benchmark_live_environment_attestations_reject_replacement;
DROP TRIGGER v2_mvp_benchmark_execution_reservations_validate_insert;
DROP TRIGGER v2_mvp_benchmark_execution_reservations_reject_replacement;
DROP VIEW mvp_benchmark_execution_ready_sessions;

CREATE VIEW mvp_benchmark_execution_ready_sessions AS
SELECT session.uid
FROM mvp_benchmark_sessions AS session
JOIN workflow_runs AS run ON run.uid=session.workflow_run_uid
JOIN workflow_definitions AS definition ON definition.uid=run.workflow_uid
WHERE definition.drama_uid=session.drama_uid
  AND run.status='queued'
  AND run.workflow_uid=json_extract(session.plan_json,'$.workflowUid')
  AND run.graph_hash=json_extract(session.plan_json,'$.graphHash')
  AND run.graph_revision=json_extract(session.plan_json,'$.graphRevision')
  AND mvp_benchmark_session_record_valid(
    session.uid,session.drama_uid,session.workflow_run_uid,
    session.request_json,session.plan_json,session.plan_sha256,
    session.created_at_epoch_ms
  )=1
  AND mvp_benchmark_session_source_graph_valid(
    run.graph_snapshot_json,session.plan_json
  )=1
  AND json_array_length(session.plan_json,'$.h3Tasks') BETWEEN 4 AND 6
  AND json_array_length(session.plan_json,'$.audioIntents') BETWEEN 1 AND 32
  AND (
    SELECT count(*)
    FROM h3_generation_intents AS intent
    JOIN remote_tasks AS task ON task.uid=intent.task_uid
    WHERE task.workflow_run_uid=session.workflow_run_uid
  )=json_array_length(session.plan_json,'$.h3Tasks')
  AND (
    SELECT count(*) FROM audio_mode_intents AS intent
    WHERE intent.workflow_run_uid=session.workflow_run_uid
  )=json_array_length(session.plan_json,'$.audioIntents')
  AND NOT EXISTS (
    SELECT 1 FROM json_each(session.plan_json,'$.h3Tasks') AS planned
    WHERE NOT EXISTS (
      SELECT 1
      FROM h3_generation_intents AS intent
      JOIN remote_tasks AS task ON task.uid=intent.task_uid
      JOIN node_runs AS node
        ON node.uid=json_extract(planned.value,'$.nodeRunUid')
       AND node.uid=substr(task.idempotency_key,16)
      JOIN json_each(run.graph_snapshot_json,'$.snapshot.nodes') AS graph_node
        ON json_extract(graph_node.value,'$.uid')=node.node_uid
      JOIN workflow_manifests AS manifest ON manifest.uid=intent.manifest_uid
      JOIN remote_connections AS connection ON connection.uid=task.connection_uid
      JOIN assets AS asset ON asset.uid=intent.asset_uid
      JOIN prompt_semantic_versions AS semantic ON semantic.uid=intent.prompt_semantic_uid
      JOIN narrative_results AS shot ON shot.uid=semantic.shot_result_uid
      JOIN narrative_review_events AS review ON review.uid=shot.current_review_uid
      WHERE task.uid=json_extract(planned.value,'$.taskUid')
        AND intent.uid=json_extract(planned.value,'$.intentUid')
        AND intent.asset_uid=json_extract(planned.value,'$.assetUid')
        AND intent.manifest_uid=json_extract(planned.value,'$.manifestUid')
        AND intent.generation_spec_sha256=json_extract(
          planned.value,'$.generationSpecSha256'
        )
        AND intent.plan_evidence_sha256=json_extract(planned.value,'$.planEvidenceSha256')
        AND task.workflow_run_uid=session.workflow_run_uid
        AND task.workflow_manifest_uid=intent.manifest_uid
        AND task.prompt_sha256=intent.task_prompt_sha256
        AND task.contract_version='remote-task.v1'
        AND task.stage='prepared' AND task.status='queued'
        AND task.prompt_id IS NULL AND task.output_asset_version_uid IS NULL
        AND node.workflow_run_uid=session.workflow_run_uid AND node.status='queued'
        AND node.node_uid=json_extract(planned.value,'$.nodeUid')
        AND json_extract(graph_node.value,'$.nodeType')='shot.video'
        AND json_extract(graph_node.value,'$.enabled')=1
        AND json_extract(graph_node.value,'$.domainRef.type')='asset'
        AND json_extract(graph_node.value,'$.domainRef.uid')=intent.asset_uid
        AND asset.owner_type='drama' AND asset.owner_uid=session.drama_uid
        AND asset.asset_type='video' AND asset.status<>'deleted'
        AND semantic.drama_uid=session.drama_uid
        AND shot.result_type='shot' AND shot.status='approved'
        AND shot.result_hash=semantic.shot_result_hash
        AND shot.envelope_hash=semantic.shot_envelope_hash
        AND review.result_uid=shot.uid AND review.decision='approve'
        AND review.result_hash=shot.result_hash
        AND review.envelope_hash=shot.envelope_hash
        AND semantic.shot_approval_ref='review:v1:' || review.uid
        AND (
          (intent.parent_version_uid IS NULL AND asset.current_version_uid IS NULL)
          OR EXISTS (
            SELECT 1 FROM asset_versions AS parent
            WHERE parent.uid=intent.parent_version_uid
              AND parent.asset_uid=intent.asset_uid AND parent.status='ready'
              AND asset.current_version_uid=parent.uid
          )
        )
        AND h3_generation_spec_sha256(intent.generation_spec_json)
          =intent.generation_spec_sha256
        AND h3_official_manifest_matches(
          manifest.uid,manifest.manifest_id,manifest.version,manifest.engine,
          manifest.workflow_file,manifest.workflow_sha256,manifest.model_family,
          manifest.requirements_json,manifest.inputs_json,manifest.outputs_json,
          manifest.validation_json,manifest.status
        )=1
        AND h3_semantic_shot_sha256(
          semantic.semantic_json,semantic.uid,semantic.created_at_epoch_ms,
          semantic.drama_uid,semantic.shot_result_uid,semantic.shot_result_hash,
          semantic.shot_envelope_hash,semantic.shot_approval_ref,semantic.semantic_sha256,
          json_extract(intent.generation_spec_json,'$.prompt.shotId'),
          json_extract(intent.generation_spec_json,'$.prompt.continuitySnapshotUid')
        )=json_extract(intent.generation_spec_json,'$.prompt.semanticSha256')
        AND intent.plan_evidence_sha256=h3_plan_evidence_sha256(
          run.graph_snapshot_json,node.node_uid,
          json_object(
            'uid',task.uid,'connectionUid',task.connection_uid,
            'connectionEvidenceSha256',task.connection_evidence_sha256,
            'workflowRunUid',task.workflow_run_uid,
            'workflowManifestUid',task.workflow_manifest_uid,
            'promptSha256',task.prompt_sha256
          ),
          json_object(
            'uid',connection.uid,'name',connection.name,'host',connection.host,
            'port',connection.port,'username',connection.username,
            'hostFingerprint',connection.host_fingerprint,
            'credentialRef',connection.credential_ref,'status',connection.status,
            'createdAt',connection.created_at,'updatedAt',connection.updated_at,
            'authMethod',connection.auth_method_v2,'comfyHost',connection.comfy_host,
            'comfyPort',connection.comfy_port,'remoteWorkDir',connection.remote_work_dir,
            'environmentReport',CASE WHEN connection.environment_report_json IS NULL
              THEN NULL ELSE json(connection.environment_report_json) END,
            'environmentCheckedAtEpochMs',connection.environment_checked_at_epoch_ms,
            'stateVersion',connection.state_version
          ),
          json_object(
            'uid',asset.uid,'ownerType',asset.owner_type,'ownerUid',asset.owner_uid,
            'assetType',asset.asset_type,'status',asset.status,
            'currentVersionUid',asset.current_version_uid
          ),
          intent.generation_spec_json,intent.manifest_uid,intent.filename_prefix
        )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(session.plan_json,'$.audioIntents') AS planned
    WHERE NOT EXISTS (
      SELECT 1
      FROM audio_mode_intents AS intent
      JOIN node_runs AS node ON node.uid=intent.node_run_uid
      JOIN json_each(run.graph_snapshot_json,'$.snapshot.nodes') AS graph_node
        ON json_extract(graph_node.value,'$.uid')=node.node_uid
      JOIN narrative_results AS shot ON shot.uid=intent.shot_result_uid
      JOIN narrative_review_events AS shot_review ON shot_review.uid=shot.current_review_uid
      JOIN narrative_results AS script ON script.uid=intent.script_result_uid
      JOIN narrative_review_events AS script_review
        ON script_review.uid=script.current_review_uid
      WHERE intent.uid=json_extract(planned.value,'$.intentUid')
        AND intent.workflow_run_uid=session.workflow_run_uid
        AND intent.node_run_uid=json_extract(planned.value,'$.nodeRunUid')
        AND intent.plan_sha256=json_extract(planned.value,'$.planSha256')
        AND audio_mode_intent_record_valid(
          intent.uid,intent.drama_uid,intent.workflow_run_uid,intent.node_run_uid,
          intent.shot_result_uid,intent.script_result_uid,intent.request_json,
          intent.plan_json,intent.plan_sha256,intent.created_at_epoch_ms
        )=1
        AND node.workflow_run_uid=session.workflow_run_uid AND node.status='queued'
        AND node.node_uid=json_extract(planned.value,'$.nodeUid')
        AND json_extract(graph_node.value,'$.nodeType')='audio.tts'
        AND json_extract(graph_node.value,'$.enabled')=1
        AND json_extract(graph_node.value,'$.domainRef.type')='narrative_result'
        AND json_extract(graph_node.value,'$.domainRef.uid')=intent.shot_result_uid
        AND shot.drama_uid=session.drama_uid
        AND shot.result_type='shot' AND shot.status='approved'
        AND shot_review.result_uid=shot.uid AND shot_review.decision='approve'
        AND shot_review.result_hash=shot.result_hash
        AND shot_review.envelope_hash=shot.envelope_hash
        AND shot.upstream_result_uid=script.uid
        AND script.drama_uid=session.drama_uid
        AND script.result_type='script' AND script.status='approved'
        AND script_review.result_uid=script.uid AND script_review.decision='approve'
        AND script_review.result_hash=script.result_hash
        AND script_review.envelope_hash=script.envelope_hash
        AND NOT EXISTS (
          SELECT 1 FROM json_each(intent.request_json,'$.deliveries') AS delivery
          WHERE NOT EXISTS (
            SELECT 1
            FROM shot_continuity_snapshots AS snapshot
            JOIN json_each(shot.result_json,'$.output.shots') AS planned_shot
            JOIN json_each(script.result_json,'$.output.scenes') AS script_scene
            JOIN json_each(script_scene.value,'$.entries') AS script_entry
            JOIN shot_continuity_character_refs AS character_ref
              ON character_ref.snapshot_uid=snapshot.uid
             AND character_ref.fact_ref=json_extract(
               script_entry.value,'$.speakerCharacterFactId'
             )
            JOIN voice_profiles AS profile
              ON profile.uid=json_extract(delivery.value,'$.voiceProfileUid')
             AND profile.character_uid=character_ref.character_uid
             AND profile.drama_uid=session.drama_uid
            WHERE snapshot.uid=json_extract(delivery.value,'$.continuitySnapshotUid')
              AND snapshot.drama_uid=session.drama_uid
              AND snapshot.shot_result_uid=shot.uid
              AND snapshot.shot_result_hash=shot.result_hash
              AND snapshot.shot_envelope_hash=shot.envelope_hash
              AND snapshot.shot_review_uid=shot.current_review_uid
              AND snapshot.shot_id=json_extract(delivery.value,'$.shotId')
              AND json_extract(planned_shot.value,'$.shotId')=snapshot.shot_id
              AND EXISTS (
                SELECT 1 FROM json_each(
                  planned_shot.value,'$.dialogueEntryRefs'
                ) AS dialogue_ref
                WHERE dialogue_ref.value=json_extract(delivery.value,'$.dialogueEntryId')
              )
              AND json_extract(script_entry.value,'$.entryId')
                =json_extract(delivery.value,'$.dialogueEntryId')
              AND json_extract(script_entry.value,'$.type')='dialogue'
              AND json_type(script_entry.value,'$.speakerCharacterFactId')='text'
              AND audio_mode_narrative_emotion(
                json_extract(script_entry.value,'$.emotion')
              )=json_extract(delivery.value,'$.emotion')
              AND json_extract(graph_node.value,'$.config.profileUid')=profile.uid
              AND json_extract(graph_node.value,'$.config.credentialRef')
                =profile.credential_ref
              AND CAST(json_extract(graph_node.value,'$.config.speed') * 1000 AS INTEGER)
                =json_extract(delivery.value,'$.speedPermille')
              AND EXISTS (
                SELECT 1 FROM voice_profile_selection_events AS selection
                WHERE selection.character_uid=profile.character_uid
                  AND selection.voice_profile_uid=profile.uid
                  AND selection.state_version=(
                    SELECT max(latest.state_version)
                    FROM voice_profile_selection_events AS latest
                    WHERE latest.character_uid=profile.character_uid
                  )
              )
          )
        )
    )
  );

CREATE TRIGGER v2_mvp_benchmark_external_authorizations_validate_insert
BEFORE INSERT ON mvp_benchmark_external_authorizations
BEGIN
  SELECT CASE WHEN
    mvp_benchmark_external_authorization_record_valid(
      NEW.uid, NEW.session_uid, NEW.drama_uid, NEW.request_json,
      NEW.authorization_json, NEW.authorization_sha256,
      NEW.authorized_at_epoch_ms, NEW.expires_at_epoch_ms
    ) IS NOT 1
    OR NOT EXISTS (
      SELECT 1
      FROM mvp_benchmark_sessions AS session
      JOIN workflow_runs AS run ON run.uid=session.workflow_run_uid
      WHERE session.uid=NEW.session_uid
        AND session.drama_uid=NEW.drama_uid
        AND session.plan_sha256=json_extract(NEW.authorization_json,'$.sessionPlanSha256')
        AND run.status='queued'
        AND mvp_benchmark_session_record_valid(
          session.uid, session.drama_uid, session.workflow_run_uid,
          session.request_json, session.plan_json, session.plan_sha256,
          session.created_at_epoch_ms
        )=1
        AND mvp_benchmark_session_source_graph_valid(
          run.graph_snapshot_json, session.plan_json
        )=1
        AND json_array_length(session.plan_json,'$.h3Tasks')
          =json_extract(NEW.authorization_json,'$.h3SubmissionLimit')
        AND json_array_length(session.plan_json,'$.audioIntents')
          =json_extract(NEW.authorization_json,'$.ttsSubmissionLimit')
    )
    OR NOT EXISTS (
      SELECT 1 FROM remote_connections AS connection
      WHERE connection.uid=json_extract(NEW.authorization_json,'$.connectionUid')
        AND connection.status='ready'
        AND mvp_benchmark_connection_evidence_sha256(
          connection.uid, connection.name, connection.host, connection.port,
          connection.username, connection.host_fingerprint, connection.credential_ref,
          connection.status, connection.created_at, connection.updated_at,
          connection.auth_method_v2, connection.comfy_host, connection.comfy_port,
          connection.remote_work_dir, connection.environment_report_json,
          connection.environment_checked_at_epoch_ms, connection.state_version
        )=json_extract(NEW.authorization_json,'$.connectionEvidenceSha256')
    )
    OR EXISTS (
      SELECT 1
      FROM mvp_benchmark_sessions AS session,
           json_each(session.plan_json,'$.h3Tasks') AS planned
      WHERE session.uid=NEW.session_uid
        AND NOT EXISTS (
          SELECT 1 FROM remote_tasks AS task
          JOIN node_runs AS node ON node.uid=json_extract(planned.value,'$.nodeRunUid')
          WHERE task.uid=json_extract(planned.value,'$.taskUid')
            AND task.connection_uid=json_extract(NEW.authorization_json,'$.connectionUid')
            AND task.connection_evidence_sha256=json_extract(
              NEW.authorization_json,'$.connectionEvidenceSha256'
            )
            AND task.workflow_run_uid=session.workflow_run_uid
            AND task.stage='prepared' AND task.status='queued'
            AND task.prompt_id IS NULL AND task.output_asset_version_uid IS NULL
            AND node.workflow_run_uid=session.workflow_run_uid
            AND node.node_uid=json_extract(planned.value,'$.nodeUid')
            AND node.status='queued'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM mvp_benchmark_sessions AS session,
           json_each(session.plan_json,'$.audioIntents') AS planned
      WHERE session.uid=NEW.session_uid
        AND NOT EXISTS (
          SELECT 1 FROM audio_mode_intents AS intent
          JOIN node_runs AS node ON node.uid=intent.node_run_uid
          WHERE intent.uid=json_extract(planned.value,'$.intentUid')
            AND intent.workflow_run_uid=session.workflow_run_uid
            AND intent.node_run_uid=json_extract(planned.value,'$.nodeRunUid')
            AND intent.plan_sha256=json_extract(planned.value,'$.planSha256')
            AND node.workflow_run_uid=session.workflow_run_uid
            AND node.node_uid=json_extract(planned.value,'$.nodeUid')
            AND node.status='queued'
        )
    )
  THEN RAISE(ABORT, 'MVP benchmark external authorization invalid') END;
END;

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
        'authMethod', connection.auth_method_v2, 'comfyHost', connection.comfy_host,
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

CREATE TRIGGER v2_mvp_benchmark_live_environment_attestations_validate_insert
BEFORE INSERT ON mvp_benchmark_live_environment_attestations
BEGIN
  SELECT CASE WHEN
    mvp_benchmark_live_environment_attestation_record_valid(
      NEW.uid,NEW.authorization_uid,NEW.session_uid,NEW.drama_uid,
      NEW.connection_uid,NEW.connection_evidence_sha256,
      NEW.observation_json,NEW.observation_sha256,
      NEW.attestation_json,NEW.attestation_sha256,
      NEW.attested_at_epoch_ms,NEW.expires_at_epoch_ms
    ) IS NOT 1
    OR NOT EXISTS (
      SELECT 1
      FROM mvp_benchmark_external_authorizations AS authorization
      JOIN mvp_benchmark_sessions AS session ON session.uid=authorization.session_uid
      JOIN workflow_runs AS run ON run.uid=session.workflow_run_uid
      JOIN remote_connections AS connection
        ON connection.uid=json_extract(authorization.authorization_json,'$.connectionUid')
      WHERE authorization.uid=NEW.authorization_uid
        AND authorization.session_uid=NEW.session_uid
        AND authorization.drama_uid=NEW.drama_uid
        AND run.status='queued'
        AND EXISTS (
          SELECT 1 FROM mvp_benchmark_execution_ready_sessions AS ready
          WHERE ready.uid=NEW.session_uid
        )
        AND connection.uid=NEW.connection_uid
        AND connection.status='ready'
        AND json_extract(authorization.authorization_json,'$.connectionEvidenceSha256')
          =NEW.connection_evidence_sha256
        AND json_extract(authorization.authorization_json,'$.requiredEnvironmentSha256')
          =json_extract(NEW.observation_json,'$.approvedEnvironmentSha256')
        AND NEW.attested_at_epoch_ms>=authorization.authorized_at_epoch_ms
        AND NEW.expires_at_epoch_ms=min(
          authorization.expires_at_epoch_ms,
          json_extract(NEW.observation_json,'$.observedAtEpochMs')+300000
        )
        AND mvp_benchmark_connection_evidence_sha256(
          connection.uid,connection.name,connection.host,connection.port,
          connection.username,connection.host_fingerprint,connection.credential_ref,
          connection.status,connection.created_at,connection.updated_at,
          connection.auth_method_v2,connection.comfy_host,connection.comfy_port,
          connection.remote_work_dir,connection.environment_report_json,
          connection.environment_checked_at_epoch_ms,connection.state_version
        )=NEW.connection_evidence_sha256
    )
  THEN RAISE(ABORT,'MVP benchmark live environment attestation invalid') END;
END;

CREATE TRIGGER v2_mvp_benchmark_execution_reservations_validate_insert
BEFORE INSERT ON mvp_benchmark_execution_reservations
BEGIN
  SELECT CASE WHEN
    mvp_benchmark_execution_reservation_record_valid(
      NEW.uid,NEW.authorization_uid,NEW.attestation_uid,NEW.session_uid,NEW.drama_uid,
      NEW.item_kind,NEW.item_uid,NEW.request_sha256,
      NEW.estimate_json,NEW.estimate_sha256,NEW.estimated_cost_cny_fen,
      NEW.reservation_json,NEW.reservation_sha256,NEW.reserved_at_epoch_ms
    ) IS NOT 1
    OR NOT EXISTS (
      SELECT 1
      FROM mvp_benchmark_external_authorizations AS authorization
      JOIN mvp_benchmark_sessions AS session ON session.uid=authorization.session_uid
      JOIN workflow_runs AS run ON run.uid=session.workflow_run_uid
      JOIN mvp_benchmark_live_environment_attestations AS attestation
        ON attestation.uid=NEW.attestation_uid
      JOIN remote_connections AS connection ON connection.uid=attestation.connection_uid
      WHERE authorization.uid=NEW.authorization_uid
        AND authorization.session_uid=NEW.session_uid
        AND authorization.drama_uid=NEW.drama_uid
        AND session.uid=NEW.session_uid
        AND run.status='queued'
        AND EXISTS (
          SELECT 1 FROM mvp_benchmark_execution_ready_sessions AS ready
          WHERE ready.uid=NEW.session_uid
        )
        AND attestation.authorization_uid=NEW.authorization_uid
        AND attestation.session_uid=NEW.session_uid
        AND attestation.drama_uid=NEW.drama_uid
        AND attestation.connection_uid=json_extract(
          authorization.authorization_json,'$.connectionUid'
        )
        AND attestation.connection_evidence_sha256=json_extract(
          authorization.authorization_json,'$.connectionEvidenceSha256'
        )
        AND connection.status='ready'
        AND mvp_benchmark_connection_evidence_sha256(
          connection.uid,connection.name,connection.host,connection.port,
          connection.username,connection.host_fingerprint,connection.credential_ref,
          connection.status,connection.created_at,connection.updated_at,
          connection.auth_method_v2,connection.comfy_host,connection.comfy_port,
          connection.remote_work_dir,connection.environment_report_json,
          connection.environment_checked_at_epoch_ms,connection.state_version
        )=attestation.connection_evidence_sha256
        AND NEW.reserved_at_epoch_ms>=authorization.authorized_at_epoch_ms
        AND NEW.reserved_at_epoch_ms<authorization.expires_at_epoch_ms
        AND NEW.reserved_at_epoch_ms>=attestation.attested_at_epoch_ms
        AND NEW.reserved_at_epoch_ms<attestation.expires_at_epoch_ms
        AND COALESCE((
          SELECT sum(existing.estimated_cost_cny_fen)
          FROM mvp_benchmark_execution_reservations AS existing
          WHERE existing.authorization_uid=NEW.authorization_uid
        ),0)+NEW.estimated_cost_cny_fen
          <=json_extract(authorization.authorization_json,'$.maximumCostCnyFen')
    )
    OR (
      NEW.item_kind='h3' AND NOT EXISTS (
        SELECT 1
        FROM mvp_benchmark_sessions AS session,
             json_each(session.plan_json,'$.h3Tasks') AS planned
        JOIN remote_tasks AS task ON task.uid=NEW.item_uid
        JOIN node_runs AS node ON node.uid=json_extract(planned.value,'$.nodeRunUid')
        WHERE session.uid=NEW.session_uid
          AND json_extract(planned.value,'$.taskUid')=NEW.item_uid
          AND task.connection_uid=(
            SELECT connection_uid
            FROM mvp_benchmark_live_environment_attestations
            WHERE uid=NEW.attestation_uid
          )
          AND task.connection_evidence_sha256=(
            SELECT connection_evidence_sha256
            FROM mvp_benchmark_live_environment_attestations
            WHERE uid=NEW.attestation_uid
          )
          AND task.workflow_run_uid=session.workflow_run_uid
          AND task.stage='prepared' AND task.status='queued'
          AND task.prompt_id IS NULL AND task.output_asset_version_uid IS NULL
          AND node.workflow_run_uid=session.workflow_run_uid
          AND node.node_uid=json_extract(planned.value,'$.nodeUid')
          AND node.status='queued'
      )
    )
    OR (
      NEW.item_kind='tts' AND NOT EXISTS (
        SELECT 1
        FROM mvp_benchmark_sessions AS session,
             json_each(session.plan_json,'$.audioIntents') AS planned
        JOIN audio_mode_intents AS intent ON intent.uid=NEW.item_uid
        JOIN node_runs AS node ON node.uid=intent.node_run_uid
        WHERE session.uid=NEW.session_uid
          AND json_extract(planned.value,'$.intentUid')=NEW.item_uid
          AND intent.workflow_run_uid=session.workflow_run_uid
          AND node.workflow_run_uid=session.workflow_run_uid
          AND node.node_uid=json_extract(planned.value,'$.nodeUid')
          AND node.status='queued'
      )
    )
  THEN RAISE(ABORT,'MVP benchmark execution reservation invalid') END;
END;

-- Recreate conflict and attestation guards after the dependent validation triggers.
-- SQLite runs same-timing triggers newest first; this preserves the established
-- immutable/operator-specific fail-closed errors for INSERT OR REPLACE requests.
CREATE TRIGGER v2_h3_generation_intents_reject_replacement
BEFORE INSERT ON h3_generation_intents
WHEN EXISTS (
  SELECT 1 FROM h3_generation_intents AS intent
  WHERE intent.uid=NEW.uid OR intent.task_uid=NEW.task_uid
    OR intent.generation_run_uid=NEW.generation_run_uid
    OR intent.history_uid=NEW.history_uid
)
BEGIN SELECT RAISE(ABORT, 'H3 generation intent replacement is forbidden'); END;

CREATE TRIGGER v2_mvp_benchmark_live_environment_attestations_reject_replacement
BEFORE INSERT ON mvp_benchmark_live_environment_attestations
WHEN EXISTS (SELECT 1 FROM mvp_benchmark_live_environment_attestations WHERE uid=NEW.uid)
BEGIN SELECT RAISE(ABORT,'MVP benchmark live environment attestations are immutable'); END;

CREATE TRIGGER v2_mvp_benchmark_execution_reservations_reject_replacement
BEFORE INSERT ON mvp_benchmark_execution_reservations
WHEN EXISTS (
  SELECT 1 FROM mvp_benchmark_execution_reservations
  WHERE uid=NEW.uid OR (item_kind=NEW.item_kind AND item_uid=NEW.item_uid)
)
BEGIN SELECT RAISE(ABORT,'MVP benchmark execution reservations are immutable'); END;

CREATE TRIGGER v2_mvp_benchmark_external_authorizations_reject_replacement
BEFORE INSERT ON mvp_benchmark_external_authorizations
WHEN EXISTS (
  SELECT 1 FROM mvp_benchmark_external_authorizations
  WHERE uid=NEW.uid OR session_uid=NEW.session_uid
)
BEGIN
  SELECT RAISE(ABORT, 'MVP benchmark external authorizations are immutable');
END;

CREATE TRIGGER v2_mvp_benchmark_external_authorizations_operator_attestation_insert
BEFORE INSERT ON mvp_benchmark_external_authorizations
BEGIN
  SELECT CASE WHEN
    NEW.request_sha256 IS NULL
    OR json_valid(NEW.request_json) IS NOT 1
    OR json_extract(NEW.request_json,'$.schemaVersion')
      IS NOT 'mvp-benchmark-external-authorization-request.v2'
    OR json_type(NEW.request_json,'$.operatorAttestation') IS NOT 'object'
    OR json_extract(NEW.request_json,'$.operatorAttestation.schemaVersion')
      IS NOT 'mvp-benchmark-operator-attestation.v1'
    OR json_extract(NEW.request_json,'$.operatorAttestation.licenseId')
      IS NOT 'MiniMax-H3-Community-License-Agreement'
    OR json_extract(NEW.request_json,'$.operatorAttestation.licenseSourceRevision')
      IS NOT '42ed227ee7df40d41602854ae760620d6eb651fe'
    OR json_extract(NEW.request_json,'$.operatorAttestation.requiredEnvironmentSha256')
      IS NOT '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43'
    OR json_extract(NEW.request_json,'$.operatorAttestation.territoryEligibilityConfirmed') IS NOT 1
    OR COALESCE(
      json_extract(NEW.request_json,'$.operatorAttestation.commercialEligibilityBasis') NOT IN (
        'annual-revenue-not-over-usd-20000000', 'written-minimax-authorization'
      ),
      1
    )
    OR json_extract(NEW.request_json,'$.operatorAttestation.commercialUiAttributionAccepted') IS NOT 1
    OR json_extract(NEW.request_json,'$.operatorAttestation.acceptableUseAndSafeguardsAccepted') IS NOT 1
    OR json_extract(NEW.request_json,'$.operatorAttestation.downstreamUseRestrictionsAccepted') IS NOT 1
    OR json_extract(NEW.request_json,'$.operatorAttestation.publicAiContentDisclosureAccepted') IS NOT 1
    OR json_extract(NEW.request_json,'$.operatorAttestation.benchmarkInputRightsConfirmed') IS NOT 1
    OR mvp_benchmark_external_authorization_request_sha256(NEW.request_json)
      IS NOT NEW.request_sha256
  THEN RAISE(ABORT, 'MVP benchmark operator attestation invalid') END;
END;
