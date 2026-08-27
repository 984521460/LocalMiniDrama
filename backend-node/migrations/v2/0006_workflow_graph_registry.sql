ALTER TABLE workflow_definitions
ADD COLUMN registry_version TEXT NOT NULL DEFAULT '4.0.0'
  CHECK (typeof(registry_version) = 'text' AND registry_version = '4.0.0');

ALTER TABLE workflow_definitions
ADD COLUMN graph_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(graph_revision) = 'integer' AND graph_revision >= 0);

CREATE TRIGGER v2_workflow_definitions_registry_immutable
BEFORE UPDATE OF registry_version ON workflow_definitions
WHEN NEW.registry_version IS NOT OLD.registry_version
BEGIN
  SELECT RAISE(ABORT, 'workflow registry version is immutable');
END;

CREATE TRIGGER v2_workflow_definitions_revision_monotonic
BEFORE UPDATE OF graph_revision ON workflow_definitions
WHEN NEW.graph_revision IS NOT OLD.graph_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'workflow graph revision must advance by one');
END;
