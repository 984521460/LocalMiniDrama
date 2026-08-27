-- Phase 2 persistence foundations. Later phases own narrative, prompt, and
-- character-version tables; this migration only creates the shared Source,
-- Asset, Workflow, Run, and Remote boundaries.

-- The v1 API owns an integer-keyed table named assets. Preserve that table and
-- its rows under an explicit compatibility name before claiming `assets` for
-- the v2 UID/version contract. The v1 service resolves this name at runtime.
ALTER TABLE assets RENAME TO legacy_assets;

CREATE TABLE source_documents (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('txt', 'markdown')),
  original_name TEXT NOT NULL CHECK (typeof(original_name) = 'text' AND length(trim(original_name)) > 0),
  encoding TEXT NOT NULL CHECK (typeof(encoding) = 'text' AND length(trim(encoding)) > 0),
  content_sha256 TEXT NOT NULL
    CHECK (
      typeof(content_sha256) = 'text' AND length(CAST(content_sha256 AS BLOB)) = 64 AND
      content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  full_text TEXT NOT NULL CHECK (typeof(full_text) = 'text'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE INDEX idx_v2_source_documents_drama ON source_documents(drama_uid);

CREATE TABLE source_blocks (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  document_uid TEXT NOT NULL REFERENCES source_documents(uid) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  heading_path_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      typeof(heading_path_json) = 'text' AND
      CASE WHEN json_valid(heading_path_json) THEN json_type(heading_path_json) = 'array' ELSE 0 END
    ),
  char_start INTEGER NOT NULL CHECK (typeof(char_start) = 'integer' AND char_start >= 0),
  char_end INTEGER NOT NULL CHECK (typeof(char_end) = 'integer' AND char_end >= char_start),
  text TEXT NOT NULL CHECK (typeof(text) = 'text'),
  text_sha256 TEXT NOT NULL
    CHECK (
      typeof(text_sha256) = 'text' AND length(CAST(text_sha256 AS BLOB)) = 64 AND
      text_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (document_uid, ordinal)
) WITHOUT ROWID;

CREATE INDEX idx_v2_source_blocks_document_range
  ON source_blocks(document_uid, char_start, char_end);

CREATE TABLE source_selections (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  document_uid TEXT NOT NULL REFERENCES source_documents(uid) ON DELETE CASCADE,
  start_block_uid TEXT NOT NULL REFERENCES source_blocks(uid) ON DELETE RESTRICT,
  end_block_uid TEXT NOT NULL REFERENCES source_blocks(uid) ON DELETE RESTRICT,
  start_offset INTEGER NOT NULL CHECK (typeof(start_offset) = 'integer' AND start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (typeof(end_offset) = 'integer' AND end_offset >= 0),
  selected_text_sha256 TEXT NOT NULL
    CHECK (
      typeof(selected_text_sha256) = 'text' AND length(CAST(selected_text_sha256 AS BLOB)) = 64 AND
      selected_text_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE INDEX idx_v2_source_selections_document ON source_selections(document_uid, created_at);

CREATE TRIGGER v2_source_selections_validate_insert
BEFORE INSERT ON source_selections
WHEN NOT EXISTS (
  SELECT 1
  FROM source_blocks AS start_block
  JOIN source_blocks AS end_block ON end_block.uid = NEW.end_block_uid
  WHERE start_block.uid = NEW.start_block_uid
    AND start_block.document_uid = NEW.document_uid
    AND end_block.document_uid = NEW.document_uid
    AND NEW.start_offset <= length(start_block.text)
    AND NEW.end_offset <= length(end_block.text)
    AND (
      start_block.ordinal < end_block.ordinal OR
      (start_block.ordinal = end_block.ordinal AND NEW.start_offset <= NEW.end_offset)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'selection blocks must belong to the selected document and form a valid range');
END;

CREATE TRIGGER v2_source_selections_validate_update
BEFORE UPDATE OF document_uid, start_block_uid, end_block_uid, start_offset, end_offset ON source_selections
WHEN NOT EXISTS (
  SELECT 1
  FROM source_blocks AS start_block
  JOIN source_blocks AS end_block ON end_block.uid = NEW.end_block_uid
  WHERE start_block.uid = NEW.start_block_uid
    AND start_block.document_uid = NEW.document_uid
    AND end_block.document_uid = NEW.document_uid
    AND NEW.start_offset <= length(start_block.text)
    AND NEW.end_offset <= length(end_block.text)
    AND (
      start_block.ordinal < end_block.ordinal OR
      (start_block.ordinal = end_block.ordinal AND NEW.start_offset <= NEW.end_offset)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'selection blocks must belong to the selected document and form a valid range');
END;

CREATE TRIGGER v2_source_blocks_immutable_content
BEFORE UPDATE OF document_uid, ordinal, heading_path_json, char_start, char_end, text, text_sha256 ON source_blocks
WHEN NEW.document_uid IS NOT OLD.document_uid
  OR NEW.ordinal IS NOT OLD.ordinal
  OR NEW.heading_path_json IS NOT OLD.heading_path_json
  OR NEW.char_start IS NOT OLD.char_start
  OR NEW.char_end IS NOT OLD.char_end
  OR NEW.text IS NOT OLD.text
  OR NEW.text_sha256 IS NOT OLD.text_sha256
BEGIN
  SELECT RAISE(ABORT, 'source block identity and content are immutable');
END;

CREATE TABLE assets (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  owner_type TEXT NOT NULL CHECK (typeof(owner_type) = 'text' AND length(trim(owner_type)) > 0),
  owner_uid TEXT NOT NULL
    CHECK (
      typeof(owner_uid) = 'text' AND length(CAST(owner_uid AS BLOB)) = 36 AND
      owner_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  asset_type TEXT NOT NULL CHECK (typeof(asset_type) = 'text' AND length(trim(asset_type)) > 0),
  current_version_uid TEXT REFERENCES asset_versions(uid) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'archived', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE INDEX idx_v2_assets_owner ON assets(owner_type, owner_uid, asset_type);
CREATE INDEX idx_v2_assets_status ON assets(status, updated_at);

CREATE TABLE asset_versions (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  asset_uid TEXT NOT NULL REFERENCES assets(uid) ON DELETE CASCADE,
  storage_provider TEXT NOT NULL CHECK (storage_provider IN ('local', 'nas', 'object')),
  logical_uri TEXT NOT NULL
    CHECK (typeof(logical_uri) = 'text' AND length(trim(logical_uri)) > 8 AND logical_uri LIKE 'asset://%'),
  relative_path TEXT NOT NULL
    CHECK (
      typeof(relative_path) = 'text' AND length(trim(relative_path)) > 0 AND
      length(CAST(relative_path AS BLOB)) <= 1024 AND instr(relative_path, char(0)) = 0 AND
      substr(replace(relative_path, '\', '/'), 1, 1) <> '/' AND
      replace(relative_path, '\', '/') NOT GLOB '[A-Za-z]:*' AND
      replace(relative_path, '\', '/') NOT GLOB '*:*' AND
      replace(relative_path, '\', '/') NOT GLOB '*//*' AND
      replace(relative_path, '\', '/') NOT IN ('.', '..') AND
      replace(relative_path, '\', '/') NOT GLOB './*' AND
      replace(relative_path, '\', '/') NOT GLOB '../*' AND
      replace(relative_path, '\', '/') NOT GLOB '*/./*' AND
      replace(relative_path, '\', '/') NOT GLOB '*/../*' AND
      replace(relative_path, '\', '/') NOT GLOB '*/.' AND
      replace(relative_path, '\', '/') NOT GLOB '*/..' AND
      replace(relative_path, '\', '/') NOT GLOB '*/'
    ),
  sha256 TEXT
    CHECK (
      sha256 IS NULL OR (
        typeof(sha256) = 'text' AND length(CAST(sha256 AS BLOB)) = 64 AND
        sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  mime_type TEXT CHECK (mime_type IS NULL OR (typeof(mime_type) = 'text' AND length(trim(mime_type)) > 0)),
  width INTEGER CHECK (width IS NULL OR (typeof(width) = 'integer' AND width > 0)),
  height INTEGER CHECK (height IS NULL OR (typeof(height) = 'integer' AND height > 0)),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR (typeof(duration_ms) = 'integer' AND duration_ms >= 0)),
  parent_uid TEXT REFERENCES asset_versions(uid) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (parent_uid IS NULL OR parent_uid <> uid),
  UNIQUE (logical_uri),
  UNIQUE (storage_provider, relative_path)
) WITHOUT ROWID;

CREATE INDEX idx_v2_asset_versions_asset ON asset_versions(asset_uid, created_at);
CREATE INDEX idx_v2_asset_versions_status ON asset_versions(status, created_at);

CREATE TRIGGER v2_assets_validate_current_version_insert
BEFORE INSERT ON assets
WHEN NEW.current_version_uid IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM asset_versions
  WHERE uid = NEW.current_version_uid AND asset_uid = NEW.uid
)
BEGIN
  SELECT RAISE(ABORT, 'current asset version must belong to the asset');
END;

CREATE TRIGGER v2_assets_validate_current_version_update
BEFORE UPDATE OF current_version_uid ON assets
WHEN NEW.current_version_uid IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM asset_versions
  WHERE uid = NEW.current_version_uid AND asset_uid = NEW.uid
)
BEGIN
  SELECT RAISE(ABORT, 'current asset version must belong to the asset');
END;

CREATE TRIGGER v2_asset_versions_validate_parent_insert
BEFORE INSERT ON asset_versions
WHEN NEW.parent_uid IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM asset_versions
  WHERE uid = NEW.parent_uid AND asset_uid = NEW.asset_uid
)
BEGIN
  SELECT RAISE(ABORT, 'parent asset version must belong to the same asset');
END;

CREATE TRIGGER v2_asset_versions_validate_parent_update
BEFORE UPDATE OF asset_uid, parent_uid ON asset_versions
WHEN NEW.parent_uid IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM asset_versions
  WHERE uid = NEW.parent_uid AND asset_uid = NEW.asset_uid
)
BEGIN
  SELECT RAISE(ABORT, 'parent asset version must belong to the same asset');
END;

CREATE TRIGGER v2_asset_versions_acyclic_parent_insert
BEFORE INSERT ON asset_versions
WHEN NEW.parent_uid IS NOT NULL AND EXISTS (
  WITH RECURSIVE ancestors(uid, path, cyclic) AS (
    VALUES (NEW.parent_uid, ',' || NEW.parent_uid || ',', 0)
    UNION ALL
    SELECT
      version.parent_uid,
      ancestors.path || version.parent_uid || ',',
      instr(ancestors.path, ',' || version.parent_uid || ',') > 0
    FROM asset_versions AS version
    JOIN ancestors ON version.uid = ancestors.uid
    WHERE version.parent_uid IS NOT NULL AND ancestors.cyclic = 0
  )
  SELECT 1 FROM ancestors WHERE uid = NEW.uid OR cyclic = 1
)
BEGIN
  SELECT RAISE(ABORT, 'asset version ancestry must be acyclic');
END;

CREATE TRIGGER v2_asset_versions_acyclic_parent_update
BEFORE UPDATE OF parent_uid ON asset_versions
WHEN NEW.parent_uid IS NOT NULL AND EXISTS (
  WITH RECURSIVE ancestors(uid, path, cyclic) AS (
    VALUES (NEW.parent_uid, ',' || NEW.parent_uid || ',', 0)
    UNION ALL
    SELECT
      version.parent_uid,
      ancestors.path || version.parent_uid || ',',
      instr(ancestors.path, ',' || version.parent_uid || ',') > 0
    FROM asset_versions AS version
    JOIN ancestors ON version.uid = ancestors.uid
    WHERE version.parent_uid IS NOT NULL AND ancestors.cyclic = 0
  )
  SELECT 1 FROM ancestors WHERE uid = NEW.uid OR cyclic = 1
)
BEGIN
  SELECT RAISE(ABORT, 'asset version ancestry must be acyclic');
END;

CREATE TRIGGER v2_asset_versions_immutable_owner
BEFORE UPDATE OF asset_uid ON asset_versions
WHEN NEW.asset_uid IS NOT OLD.asset_uid
BEGIN
  SELECT RAISE(ABORT, 'asset version ownership is immutable');
END;

CREATE TABLE workflow_definitions (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (typeof(name) = 'text' AND length(trim(name)) > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  description TEXT CHECK (description IS NULL OR typeof(description) = 'text'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (drama_uid, name, version)
) WITHOUT ROWID;

CREATE INDEX idx_v2_workflow_definitions_drama ON workflow_definitions(drama_uid, status);

CREATE TRIGGER v2_workflow_definitions_immutable_drama
BEFORE UPDATE OF drama_uid ON workflow_definitions
WHEN NEW.drama_uid IS NOT OLD.drama_uid
BEGIN
  SELECT RAISE(ABORT, 'workflow drama ownership is immutable');
END;

CREATE TABLE canvas_nodes (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  workflow_uid TEXT NOT NULL REFERENCES workflow_definitions(uid) ON DELETE CASCADE,
  node_type TEXT NOT NULL CHECK (typeof(node_type) = 'text' AND length(trim(node_type)) > 0),
  position_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      typeof(position_json) = 'text' AND
      CASE WHEN json_valid(position_json) THEN json_type(position_json) = 'object' ELSE 0 END
    ),
  config_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      typeof(config_json) = 'text' AND
      CASE WHEN json_valid(config_json) THEN json_type(config_json) = 'object' ELSE 0 END
    ),
  domain_ref_type TEXT,
  domain_ref_uid TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready', 'running', 'succeeded', 'failed', 'stale', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (domain_ref_type IS NULL AND domain_ref_uid IS NULL) OR
    (
      typeof(domain_ref_type) = 'text' AND length(trim(domain_ref_type)) > 0 AND
      typeof(domain_ref_uid) = 'text' AND length(CAST(domain_ref_uid AS BLOB)) = 36 AND
      domain_ref_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    )
  )
) WITHOUT ROWID;

CREATE INDEX idx_v2_canvas_nodes_workflow ON canvas_nodes(workflow_uid, status);

CREATE TABLE canvas_edges (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  workflow_uid TEXT NOT NULL REFERENCES workflow_definitions(uid) ON DELETE CASCADE,
  source_node_uid TEXT NOT NULL REFERENCES canvas_nodes(uid) ON DELETE CASCADE,
  source_port TEXT NOT NULL CHECK (typeof(source_port) = 'text' AND length(trim(source_port)) > 0),
  target_node_uid TEXT NOT NULL REFERENCES canvas_nodes(uid) ON DELETE CASCADE,
  target_port TEXT NOT NULL CHECK (typeof(target_port) = 'text' AND length(trim(target_port)) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (source_node_uid <> target_node_uid),
  UNIQUE (workflow_uid, source_node_uid, source_port, target_node_uid, target_port)
) WITHOUT ROWID;

CREATE INDEX idx_v2_canvas_edges_workflow ON canvas_edges(workflow_uid);
CREATE INDEX idx_v2_canvas_edges_target ON canvas_edges(target_node_uid, target_port);

CREATE TRIGGER v2_canvas_edges_validate_insert
BEFORE INSERT ON canvas_edges
WHEN NOT EXISTS (
  SELECT 1
  FROM canvas_nodes AS source_node
  JOIN canvas_nodes AS target_node ON target_node.uid = NEW.target_node_uid
  WHERE source_node.uid = NEW.source_node_uid
    AND source_node.workflow_uid = NEW.workflow_uid
    AND target_node.workflow_uid = NEW.workflow_uid
)
BEGIN
  SELECT RAISE(ABORT, 'edge nodes must belong to the edge workflow');
END;

CREATE TRIGGER v2_canvas_edges_validate_update
BEFORE UPDATE OF workflow_uid, source_node_uid, target_node_uid ON canvas_edges
WHEN NOT EXISTS (
  SELECT 1
  FROM canvas_nodes AS source_node
  JOIN canvas_nodes AS target_node ON target_node.uid = NEW.target_node_uid
  WHERE source_node.uid = NEW.source_node_uid
    AND source_node.workflow_uid = NEW.workflow_uid
    AND target_node.workflow_uid = NEW.workflow_uid
)
BEGIN
  SELECT RAISE(ABORT, 'edge nodes must belong to the edge workflow');
END;

CREATE TRIGGER v2_canvas_nodes_immutable_workflow
BEFORE UPDATE OF workflow_uid ON canvas_nodes
WHEN NEW.workflow_uid IS NOT OLD.workflow_uid
BEGIN
  SELECT RAISE(ABORT, 'canvas node workflow ownership is immutable');
END;

CREATE TABLE workflow_manifests (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  manifest_id TEXT NOT NULL CHECK (typeof(manifest_id) = 'text' AND length(trim(manifest_id)) > 0),
  version TEXT NOT NULL CHECK (typeof(version) = 'text' AND length(trim(version)) > 0),
  engine TEXT NOT NULL CHECK (engine IN ('comfyui', 'local', 'external')),
  workflow_file TEXT NOT NULL
    CHECK (
      typeof(workflow_file) = 'text' AND length(trim(workflow_file)) > 0 AND
      length(CAST(workflow_file AS BLOB)) <= 1024 AND instr(workflow_file, char(0)) = 0 AND
      substr(replace(workflow_file, '\', '/'), 1, 1) <> '/' AND
      replace(workflow_file, '\', '/') NOT GLOB '[A-Za-z]:*' AND
      replace(workflow_file, '\', '/') NOT GLOB '*:*' AND
      replace(workflow_file, '\', '/') NOT GLOB '*//*' AND
      replace(workflow_file, '\', '/') NOT IN ('.', '..') AND
      replace(workflow_file, '\', '/') NOT GLOB './*' AND
      replace(workflow_file, '\', '/') NOT GLOB '../*' AND
      replace(workflow_file, '\', '/') NOT GLOB '*/./*' AND
      replace(workflow_file, '\', '/') NOT GLOB '*/../*' AND
      replace(workflow_file, '\', '/') NOT GLOB '*/.' AND
      replace(workflow_file, '\', '/') NOT GLOB '*/..' AND
      replace(workflow_file, '\', '/') NOT GLOB '*/'
    ),
  workflow_sha256 TEXT NOT NULL
    CHECK (
      typeof(workflow_sha256) = 'text' AND length(CAST(workflow_sha256 AS BLOB)) = 64 AND
      workflow_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  model_family TEXT CHECK (model_family IS NULL OR (typeof(model_family) = 'text' AND length(trim(model_family)) > 0)),
  requirements_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      typeof(requirements_json) = 'text' AND
      CASE WHEN json_valid(requirements_json) THEN json_type(requirements_json) = 'array' ELSE 0 END
    ),
  inputs_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      typeof(inputs_json) = 'text' AND
      CASE WHEN json_valid(inputs_json) THEN json_type(inputs_json) = 'object' ELSE 0 END
    ),
  outputs_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      typeof(outputs_json) = 'text' AND
      CASE WHEN json_valid(outputs_json) THEN json_type(outputs_json) = 'object' ELSE 0 END
    ),
  validation_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      typeof(validation_json) = 'text' AND
      CASE WHEN json_valid(validation_json) THEN json_type(validation_json) = 'object' ELSE 0 END
    ),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated', 'invalid', 'archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (manifest_id, version)
) WITHOUT ROWID;

CREATE INDEX idx_v2_workflow_manifests_status ON workflow_manifests(status, manifest_id);

CREATE TABLE generation_runs (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  owner_type TEXT NOT NULL CHECK (typeof(owner_type) = 'text' AND length(trim(owner_type)) > 0),
  owner_uid TEXT NOT NULL
    CHECK (
      typeof(owner_uid) = 'text' AND length(CAST(owner_uid AS BLOB)) = 36 AND
      owner_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  provider TEXT NOT NULL CHECK (typeof(provider) = 'text' AND length(trim(provider)) > 0),
  model TEXT NOT NULL CHECK (typeof(model) = 'text' AND length(trim(model)) > 0),
  seed INTEGER CHECK (seed IS NULL OR typeof(seed) = 'integer'),
  parameters_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      typeof(parameters_json) = 'text' AND
      CASE WHEN json_valid(parameters_json) THEN json_type(parameters_json) = 'object' ELSE 0 END
    ),
  input_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      typeof(input_json) = 'text' AND
      CASE WHEN json_valid(input_json) THEN json_type(input_json) = 'object' ELSE 0 END
    ),
  prompt_version_uid TEXT
    CHECK (
      prompt_version_uid IS NULL OR (
        typeof(prompt_version_uid) = 'text' AND length(CAST(prompt_version_uid AS BLOB)) = 36 AND
        prompt_version_uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      )
    ),
  output_asset_version_uid TEXT REFERENCES asset_versions(uid) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(retry_count) = 'integer' AND retry_count >= 0),
  error_code TEXT
    CHECK (
      error_code IS NULL OR (
        typeof(error_code) = 'text' AND length(CAST(error_code AS BLOB)) BETWEEN 5 AND 64 AND
        instr(error_code, char(0)) = 0 AND
        substr(error_code, 1, 4) = 'ERR_' AND error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  error_detail_ref TEXT
    CHECK (
      error_detail_ref IS NULL OR (
        typeof(error_detail_ref) = 'text' AND length(CAST(error_detail_ref AS BLOB)) = 52 AND
        substr(error_detail_ref, 1, 16) = 'error-detail:v1:' AND
        substr(error_detail_ref, 17) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      )
    ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE INDEX idx_v2_generation_runs_owner ON generation_runs(owner_type, owner_uid, created_at);
CREATE INDEX idx_v2_generation_runs_status ON generation_runs(status, updated_at);

CREATE TRIGGER v2_generation_runs_reject_replacement
BEFORE INSERT ON generation_runs
WHEN EXISTS (SELECT 1 FROM generation_runs WHERE uid = NEW.uid)
BEGIN
  SELECT RAISE(ABORT, 'generation run identity cannot be replaced');
END;

CREATE TRIGGER v2_generation_runs_immutable_owner
BEFORE UPDATE OF uid, owner_type, owner_uid ON generation_runs
WHEN NEW.uid IS NOT OLD.uid
  OR NEW.owner_type IS NOT OLD.owner_type
  OR NEW.owner_uid IS NOT OLD.owner_uid
BEGIN
  SELECT RAISE(ABORT, 'generation run ownership is immutable');
END;

CREATE TABLE workflow_runs (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  workflow_uid TEXT NOT NULL REFERENCES workflow_definitions(uid) ON DELETE RESTRICT,
  graph_snapshot_json TEXT NOT NULL
    CHECK (
      typeof(graph_snapshot_json) = 'text' AND
      CASE WHEN json_valid(graph_snapshot_json) THEN json_type(graph_snapshot_json) = 'object' ELSE 0 END
    ),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual', 'node', 'downstream', 'selection', 'full', 'system')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(retry_count) = 'integer' AND retry_count >= 0),
  error_code TEXT
    CHECK (
      error_code IS NULL OR (
        typeof(error_code) = 'text' AND length(CAST(error_code AS BLOB)) BETWEEN 5 AND 64 AND
        instr(error_code, char(0)) = 0 AND
        substr(error_code, 1, 4) = 'ERR_' AND error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  error_detail_ref TEXT
    CHECK (
      error_detail_ref IS NULL OR (
        typeof(error_detail_ref) = 'text' AND length(CAST(error_detail_ref AS BLOB)) = 52 AND
        substr(error_detail_ref, 1, 16) = 'error-detail:v1:' AND
        substr(error_detail_ref, 17) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      )
    ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE INDEX idx_v2_workflow_runs_workflow ON workflow_runs(workflow_uid, created_at);
CREATE INDEX idx_v2_workflow_runs_status ON workflow_runs(status, updated_at);

CREATE TRIGGER v2_workflow_runs_reject_replacement
BEFORE INSERT ON workflow_runs
WHEN EXISTS (SELECT 1 FROM workflow_runs WHERE uid = NEW.uid)
BEGIN
  SELECT RAISE(ABORT, 'workflow run identity cannot be replaced');
END;

CREATE TABLE node_runs (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  workflow_run_uid TEXT NOT NULL REFERENCES workflow_runs(uid) ON DELETE CASCADE,
  node_uid TEXT NOT NULL REFERENCES canvas_nodes(uid) ON DELETE RESTRICT,
  input_snapshot_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      typeof(input_snapshot_json) = 'text' AND
      CASE WHEN json_valid(input_snapshot_json) THEN json_type(input_snapshot_json) = 'object' ELSE 0 END
    ),
  output_json TEXT
    CHECK (
      output_json IS NULL OR (
        typeof(output_json) = 'text' AND
        CASE WHEN json_valid(output_json) THEN json_type(output_json) = 'object' ELSE 0 END
      )
    ),
  cache_key TEXT CHECK (cache_key IS NULL OR (typeof(cache_key) = 'text' AND length(trim(cache_key)) > 0)),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked', 'skipped')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(retry_count) = 'integer' AND retry_count >= 0),
  error_code TEXT
    CHECK (
      error_code IS NULL OR (
        typeof(error_code) = 'text' AND length(CAST(error_code AS BLOB)) BETWEEN 5 AND 64 AND
        instr(error_code, char(0)) = 0 AND
        substr(error_code, 1, 4) = 'ERR_' AND error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  error_detail_ref TEXT
    CHECK (
      error_detail_ref IS NULL OR (
        typeof(error_detail_ref) = 'text' AND length(CAST(error_detail_ref AS BLOB)) = 52 AND
        substr(error_detail_ref, 1, 16) = 'error-detail:v1:' AND
        substr(error_detail_ref, 17) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      )
    ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (workflow_run_uid, node_uid)
) WITHOUT ROWID;

CREATE INDEX idx_v2_node_runs_status ON node_runs(status, updated_at);

CREATE TRIGGER v2_node_runs_reject_replacement
BEFORE INSERT ON node_runs
WHEN EXISTS (
  SELECT 1
  FROM node_runs
  WHERE uid = NEW.uid
    OR (workflow_run_uid = NEW.workflow_run_uid AND node_uid = NEW.node_uid)
)
BEGIN
  SELECT RAISE(ABORT, 'node run identity cannot be replaced');
END;

CREATE TRIGGER v2_node_runs_validate_insert
BEFORE INSERT ON node_runs
WHEN NOT EXISTS (
  SELECT 1
  FROM workflow_runs AS workflow_run
  JOIN canvas_nodes AS node ON node.uid = NEW.node_uid
  WHERE workflow_run.uid = NEW.workflow_run_uid
    AND node.workflow_uid = workflow_run.workflow_uid
)
BEGIN
  SELECT RAISE(ABORT, 'node run must reference a node from its workflow');
END;

CREATE TRIGGER v2_node_runs_validate_update
BEFORE UPDATE OF workflow_run_uid, node_uid ON node_runs
WHEN NOT EXISTS (
  SELECT 1
  FROM workflow_runs AS workflow_run
  JOIN canvas_nodes AS node ON node.uid = NEW.node_uid
  WHERE workflow_run.uid = NEW.workflow_run_uid
    AND node.workflow_uid = workflow_run.workflow_uid
)
BEGIN
  SELECT RAISE(ABORT, 'node run must reference a node from its workflow');
END;

CREATE TRIGGER v2_node_runs_immutable_owner
BEFORE UPDATE OF uid, workflow_run_uid, node_uid ON node_runs
WHEN NEW.uid IS NOT OLD.uid
  OR NEW.workflow_run_uid IS NOT OLD.workflow_run_uid
  OR NEW.node_uid IS NOT OLD.node_uid
BEGIN
  SELECT RAISE(ABORT, 'node run ownership is immutable');
END;

CREATE TRIGGER v2_workflow_runs_immutable_workflow
BEFORE UPDATE OF uid, workflow_uid ON workflow_runs
WHEN NEW.uid IS NOT OLD.uid OR NEW.workflow_uid IS NOT OLD.workflow_uid
BEGIN
  SELECT RAISE(ABORT, 'workflow run ownership is immutable');
END;

CREATE TABLE remote_connections (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  name TEXT NOT NULL CHECK (typeof(name) = 'text' AND length(trim(name)) > 0),
  host TEXT NOT NULL CHECK (typeof(host) = 'text' AND length(trim(host)) > 0),
  port INTEGER NOT NULL CHECK (typeof(port) = 'integer' AND port BETWEEN 1 AND 65535),
  username TEXT NOT NULL CHECK (typeof(username) = 'text' AND length(trim(username)) > 0),
  host_fingerprint TEXT CHECK (host_fingerprint IS NULL OR (typeof(host_fingerprint) = 'text' AND length(trim(host_fingerprint)) > 0)),
  credential_ref TEXT NOT NULL
    CHECK (
      typeof(credential_ref) = 'text' AND length(CAST(credential_ref AS BLOB)) = 50 AND
      substr(credential_ref, 1, 14) = 'credential:v1:' AND
      substr(credential_ref, 15) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'ready', 'changed', 'disabled', 'error')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE INDEX idx_v2_remote_connections_status ON remote_connections(status, updated_at);

CREATE TABLE remote_tasks (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  connection_uid TEXT NOT NULL REFERENCES remote_connections(uid) ON DELETE RESTRICT,
  workflow_run_uid TEXT REFERENCES workflow_runs(uid) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (typeof(provider) = 'text' AND length(trim(provider)) > 0),
  prompt_id TEXT CHECK (prompt_id IS NULL OR (typeof(prompt_id) = 'text' AND length(trim(prompt_id)) > 0)),
  remote_relative_dir TEXT NOT NULL
    CHECK (
      typeof(remote_relative_dir) = 'text' AND length(trim(remote_relative_dir)) > 0 AND
      length(CAST(remote_relative_dir AS BLOB)) <= 1024 AND instr(remote_relative_dir, char(0)) = 0 AND
      substr(replace(remote_relative_dir, '\', '/'), 1, 1) <> '/' AND
      replace(remote_relative_dir, '\', '/') NOT GLOB '[A-Za-z]:*' AND
      replace(remote_relative_dir, '\', '/') NOT GLOB '*:*' AND
      replace(remote_relative_dir, '\', '/') NOT GLOB '*//*' AND
      replace(remote_relative_dir, '\', '/') NOT IN ('.', '..') AND
      replace(remote_relative_dir, '\', '/') NOT GLOB './*' AND
      replace(remote_relative_dir, '\', '/') NOT GLOB '../*' AND
      replace(remote_relative_dir, '\', '/') NOT GLOB '*/./*' AND
      replace(remote_relative_dir, '\', '/') NOT GLOB '*/../*' AND
      replace(remote_relative_dir, '\', '/') NOT GLOB '*/.' AND
      replace(remote_relative_dir, '\', '/') NOT GLOB '*/..' AND
      replace(remote_relative_dir, '\', '/') NOT GLOB '*/'
    ),
  stage TEXT NOT NULL DEFAULT 'prepared'
    CHECK (stage IN ('prepared', 'uploading', 'submitted', 'executing', 'downloading', 'verifying', 'completed', 'failed', 'cancelled')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  heartbeat_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(retry_count) = 'integer' AND retry_count >= 0),
  output_asset_version_uid TEXT REFERENCES asset_versions(uid) ON DELETE SET NULL,
  error_code TEXT
    CHECK (
      error_code IS NULL OR (
        typeof(error_code) = 'text' AND length(CAST(error_code AS BLOB)) BETWEEN 5 AND 64 AND
        instr(error_code, char(0)) = 0 AND
        substr(error_code, 1, 4) = 'ERR_' AND error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  error_detail_ref TEXT
    CHECK (
      error_detail_ref IS NULL OR (
        typeof(error_detail_ref) = 'text' AND length(CAST(error_detail_ref AS BLOB)) = 52 AND
        substr(error_detail_ref, 1, 16) = 'error-detail:v1:' AND
        substr(error_detail_ref, 17) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      )
    ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE INDEX idx_v2_remote_tasks_status ON remote_tasks(connection_uid, status, updated_at);
CREATE UNIQUE INDEX idx_v2_remote_tasks_prompt
  ON remote_tasks(connection_uid, prompt_id)
  WHERE prompt_id IS NOT NULL;

CREATE TRIGGER v2_remote_tasks_reject_replacement
BEFORE INSERT ON remote_tasks
WHEN EXISTS (
  SELECT 1
  FROM remote_tasks
  WHERE uid = NEW.uid
    OR (
      NEW.prompt_id IS NOT NULL
      AND connection_uid = NEW.connection_uid
      AND prompt_id = NEW.prompt_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'remote task identity cannot be replaced');
END;

CREATE TRIGGER v2_remote_tasks_reject_prompt_collision_update
BEFORE UPDATE OF connection_uid, prompt_id ON remote_tasks
WHEN NEW.prompt_id IS NOT NULL AND EXISTS (
  SELECT 1
  FROM remote_tasks
  WHERE uid IS NOT OLD.uid
    AND connection_uid = NEW.connection_uid
    AND prompt_id = NEW.prompt_id
)
BEGIN
  SELECT RAISE(ABORT, 'remote task prompt identity conflicts with existing task');
END;

CREATE TRIGGER v2_remote_tasks_immutable_prompt_identity
BEFORE UPDATE OF prompt_id ON remote_tasks
WHEN OLD.prompt_id IS NOT NULL AND NEW.prompt_id IS NOT OLD.prompt_id
BEGIN
  SELECT RAISE(ABORT, 'remote task prompt identity is immutable');
END;

CREATE TRIGGER v2_remote_tasks_immutable_owner
BEFORE UPDATE OF uid, connection_uid, workflow_run_uid ON remote_tasks
WHEN NEW.uid IS NOT OLD.uid
  OR NEW.connection_uid IS NOT OLD.connection_uid
  OR NEW.workflow_run_uid IS NOT OLD.workflow_run_uid
BEGIN
  SELECT RAISE(ABORT, 'remote task ownership is immutable');
END;

CREATE TABLE export_runs (
  uid TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(uid) = 'text' AND length(CAST(uid AS BLOB)) = 36 AND
      uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  workflow_run_uid TEXT REFERENCES workflow_runs(uid) ON DELETE SET NULL,
  timeline_snapshot_json TEXT NOT NULL
    CHECK (
      typeof(timeline_snapshot_json) = 'text' AND
      CASE WHEN json_valid(timeline_snapshot_json) THEN json_type(timeline_snapshot_json) = 'object' ELSE 0 END
    ),
  encoding_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      typeof(encoding_json) = 'text' AND
      CASE WHEN json_valid(encoding_json) THEN json_type(encoding_json) = 'object' ELSE 0 END
    ),
  audio_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      typeof(audio_json) = 'text' AND
      CASE WHEN json_valid(audio_json) THEN json_type(audio_json) = 'object' ELSE 0 END
    ),
  subtitle_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      typeof(subtitle_json) = 'text' AND
      CASE WHEN json_valid(subtitle_json) THEN json_type(subtitle_json) = 'object' ELSE 0 END
    ),
  output_asset_version_uid TEXT REFERENCES asset_versions(uid) ON DELETE SET NULL,
  validation_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      typeof(validation_json) = 'text' AND
      CASE WHEN json_valid(validation_json) THEN json_type(validation_json) = 'object' ELSE 0 END
    ),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  error_code TEXT
    CHECK (
      error_code IS NULL OR (
        typeof(error_code) = 'text' AND length(CAST(error_code AS BLOB)) BETWEEN 5 AND 64 AND
        instr(error_code, char(0)) = 0 AND
        substr(error_code, 1, 4) = 'ERR_' AND error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  error_detail_ref TEXT
    CHECK (
      error_detail_ref IS NULL OR (
        typeof(error_detail_ref) = 'text' AND length(CAST(error_detail_ref AS BLOB)) = 52 AND
        substr(error_detail_ref, 1, 16) = 'error-detail:v1:' AND
        substr(error_detail_ref, 17) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      )
    ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE INDEX idx_v2_export_runs_drama ON export_runs(drama_uid, created_at);
CREATE INDEX idx_v2_export_runs_status ON export_runs(status, updated_at);

CREATE TRIGGER v2_export_runs_reject_replacement
BEFORE INSERT ON export_runs
WHEN EXISTS (SELECT 1 FROM export_runs WHERE uid = NEW.uid)
BEGIN
  SELECT RAISE(ABORT, 'export run identity cannot be replaced');
END;

CREATE TRIGGER v2_export_runs_validate_workflow_insert
BEFORE INSERT ON export_runs
WHEN NEW.workflow_run_uid IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM workflow_runs AS workflow_run
  JOIN workflow_definitions AS workflow ON workflow.uid = workflow_run.workflow_uid
  WHERE workflow_run.uid = NEW.workflow_run_uid AND workflow.drama_uid = NEW.drama_uid
)
BEGIN
  SELECT RAISE(ABORT, 'export run drama must match its workflow run');
END;

CREATE TRIGGER v2_export_runs_validate_workflow_update
BEFORE UPDATE OF drama_uid, workflow_run_uid ON export_runs
WHEN NEW.workflow_run_uid IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM workflow_runs AS workflow_run
  JOIN workflow_definitions AS workflow ON workflow.uid = workflow_run.workflow_uid
  WHERE workflow_run.uid = NEW.workflow_run_uid AND workflow.drama_uid = NEW.drama_uid
)
BEGIN
  SELECT RAISE(ABORT, 'export run drama must match its workflow run');
END;

CREATE TRIGGER v2_export_runs_immutable_owner
BEFORE UPDATE OF uid, drama_uid, workflow_run_uid ON export_runs
WHEN NEW.uid IS NOT OLD.uid
  OR NEW.drama_uid IS NOT OLD.drama_uid
  OR NEW.workflow_run_uid IS NOT OLD.workflow_run_uid
BEGIN
  SELECT RAISE(ABORT, 'export run ownership is immutable');
END;
