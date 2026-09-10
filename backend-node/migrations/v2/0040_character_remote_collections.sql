CREATE TABLE character_remote_collections (
 operation_uid TEXT PRIMARY KEY,
 drama_uid TEXT NOT NULL REFERENCES dramas(uid),
 character_uid TEXT NOT NULL REFERENCES characters(uid),
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
 source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
 binding_state TEXT NOT NULL DEFAULT 'bound' CHECK(binding_state IN ('bound','needs_rebind')),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE character_remote_collection_jobs (
 operation_uid TEXT NOT NULL REFERENCES character_remote_collections(operation_uid),
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 3),
 state TEXT NOT NULL CHECK(state IN ('submitting','submitted','output_bound','collected')),
 prompt_sha256 TEXT NOT NULL CHECK(length(prompt_sha256)=64),
 prompt_id TEXT,
 output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),
 item_json TEXT CHECK(item_json IS NULL OR json_valid(item_json)),
 PRIMARY KEY(operation_uid,ordinal),
 CHECK((state='submitting' AND prompt_id IS NULL AND output_json IS NULL AND item_json IS NULL)
 OR(state='submitted' AND prompt_id IS NOT NULL AND output_json IS NULL AND item_json IS NULL)
 OR(state='output_bound' AND prompt_id IS NOT NULL AND output_json IS NOT NULL AND item_json IS NULL)
 OR(state='collected' AND prompt_id IS NOT NULL AND output_json IS NOT NULL AND item_json IS NOT NULL))
) STRICT;
CREATE TRIGGER character_remote_collections_immutable BEFORE UPDATE ON character_remote_collections BEGIN SELECT RAISE(ABORT,'immutable remote collection'); END;
CREATE TRIGGER character_remote_collections_append_only BEFORE DELETE ON character_remote_collections BEGIN SELECT RAISE(ABORT,'append-only remote collection'); END;
CREATE TRIGGER character_remote_jobs_append_only BEFORE DELETE ON character_remote_collection_jobs BEGIN SELECT RAISE(ABORT,'append-only remote job'); END;
CREATE TRIGGER character_remote_jobs_transition BEFORE UPDATE ON character_remote_collection_jobs
WHEN NEW.operation_uid IS NOT OLD.operation_uid OR NEW.ordinal IS NOT OLD.ordinal OR NEW.prompt_sha256 IS NOT OLD.prompt_sha256
 OR (OLD.prompt_id IS NOT NULL AND NEW.prompt_id IS NOT OLD.prompt_id)
 OR (OLD.output_json IS NOT NULL AND NEW.output_json IS NOT OLD.output_json)
 OR (OLD.item_json IS NOT NULL AND NEW.item_json IS NOT OLD.item_json)
 OR NOT((OLD.state='submitting' AND NEW.state='submitted') OR(OLD.state='submitted' AND NEW.state='output_bound') OR(OLD.state='output_bound' AND NEW.state='collected'))
BEGIN SELECT RAISE(ABORT,'invalid remote job transition'); END;
