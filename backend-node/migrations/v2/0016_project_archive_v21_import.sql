-- Project Archive 2.1 import bindings are secret-free, append-only evidence.
-- Runtime rows keep their existing schema; this sidecar makes imported fields
-- explicitly non-executable until a local user supplies a fresh binding.

ALTER TABLE voice_profiles ADD COLUMN archive_binding_state TEXT CHECK (
  archive_binding_state IS NULL OR archive_binding_state='needs_rebind'
);

CREATE TABLE project_archive_v21_portable_bindings (
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT CHECK (
    typeof(drama_uid)='text' AND length(CAST(drama_uid AS BLOB))=36 AND
    drama_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  table_name TEXT NOT NULL CHECK (
    table_name IN ('canvas_nodes','workflow_runs','node_runs','voice_profiles')
  ),
  row_uid TEXT NOT NULL CHECK (
    typeof(row_uid)='text' AND length(CAST(row_uid AS BLOB))=36 AND
    row_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  column_name TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK (schema_version='project-archive-portable-field.v1'),
  binding_state TEXT NOT NULL CHECK (binding_state IN ('needs_rebind','not_required')),
  marker_count INTEGER NOT NULL CHECK (
    typeof(marker_count)='integer' AND marker_count BETWEEN 0 AND 10000
  ),
  portable_value_json TEXT CHECK (
    portable_value_json IS NULL OR (
      typeof(portable_value_json)='text' AND
      length(CAST(portable_value_json AS BLOB)) BETWEEN 2 AND 1048576 AND
      json_valid(portable_value_json) AND
      json_type(portable_value_json)='object' AND
      json(portable_value_json)=portable_value_json
    )
  ),
  PRIMARY KEY (table_name,row_uid,column_name),
  CHECK (
    (table_name='canvas_nodes' AND column_name='config_json') OR
    (table_name='workflow_runs' AND column_name='graph_snapshot_json') OR
    (table_name='node_runs' AND column_name IN ('input_snapshot_json','output_json')) OR
    (table_name='voice_profiles' AND column_name='credential_ref')
  ),
  CHECK (
    (table_name='voice_profiles' AND binding_state='needs_rebind' AND marker_count=1
      AND portable_value_json IS NULL)
    OR
    (table_name<>'voice_profiles' AND portable_value_json IS NOT NULL AND (
      (binding_state='not_required' AND marker_count=0) OR
      (binding_state='needs_rebind' AND marker_count BETWEEN 1 AND 10000)
    ))
  )
) WITHOUT ROWID;

CREATE INDEX idx_v2_project_archive_portable_bindings_drama
  ON project_archive_v21_portable_bindings(drama_uid,table_name,row_uid,column_name);

CREATE TRIGGER v2_project_archive_portable_bindings_validate_insert
BEFORE INSERT ON project_archive_v21_portable_bindings
WHEN NOT (
  (NEW.table_name='canvas_nodes' AND EXISTS (
    SELECT 1 FROM canvas_nodes AS node
    JOIN workflow_definitions AS workflow ON workflow.uid=node.workflow_uid
    WHERE node.uid=NEW.row_uid AND workflow.drama_uid=NEW.drama_uid
      AND node.config_json=NEW.portable_value_json
  ))
  OR
  (NEW.table_name='workflow_runs' AND EXISTS (
    SELECT 1 FROM workflow_runs AS run
    JOIN workflow_definitions AS workflow ON workflow.uid=run.workflow_uid
    WHERE run.uid=NEW.row_uid AND workflow.drama_uid=NEW.drama_uid
      AND run.graph_snapshot_json=NEW.portable_value_json
  ))
  OR
  (NEW.table_name='node_runs' AND NEW.column_name='input_snapshot_json' AND EXISTS (
    SELECT 1 FROM node_runs AS node_run
    JOIN workflow_runs AS run ON run.uid=node_run.workflow_run_uid
    JOIN workflow_definitions AS workflow ON workflow.uid=run.workflow_uid
    WHERE node_run.uid=NEW.row_uid AND workflow.drama_uid=NEW.drama_uid
      AND node_run.input_snapshot_json=NEW.portable_value_json
  ))
  OR
  (NEW.table_name='node_runs' AND NEW.column_name='output_json' AND EXISTS (
    SELECT 1 FROM node_runs AS node_run
    JOIN workflow_runs AS run ON run.uid=node_run.workflow_run_uid
    JOIN workflow_definitions AS workflow ON workflow.uid=run.workflow_uid
    WHERE node_run.uid=NEW.row_uid AND workflow.drama_uid=NEW.drama_uid
      AND node_run.output_json=NEW.portable_value_json
  ))
  OR
  (NEW.table_name='voice_profiles' AND EXISTS (
    SELECT 1 FROM voice_profiles AS profile
    WHERE profile.uid=NEW.row_uid AND profile.drama_uid=NEW.drama_uid
      AND profile.archive_binding_state='needs_rebind'
  ))
)
BEGIN SELECT RAISE(ABORT,'project archive binding carrier mismatch'); END;

CREATE TRIGGER v2_project_archive_portable_bindings_reject_replacement
BEFORE INSERT ON project_archive_v21_portable_bindings
WHEN EXISTS (
  SELECT 1 FROM project_archive_v21_portable_bindings
  WHERE table_name=NEW.table_name AND row_uid=NEW.row_uid AND column_name=NEW.column_name
)
BEGIN SELECT RAISE(ABORT,'project archive binding replacement is forbidden'); END;

CREATE TRIGGER v2_project_archive_portable_bindings_immutable_update
BEFORE UPDATE ON project_archive_v21_portable_bindings
BEGIN SELECT RAISE(ABORT,'project archive bindings are immutable'); END;

CREATE TRIGGER v2_project_archive_portable_bindings_immutable_delete
BEFORE DELETE ON project_archive_v21_portable_bindings
BEGIN SELECT RAISE(ABORT,'project archive bindings are append-only'); END;
