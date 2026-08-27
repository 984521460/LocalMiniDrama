# v2 database migrations

The v2 runner owns migration ordering, the `schema_migrations` ledger, checksums,
and the outer SQLite transaction. Migration files only contain schema or data
changes.

## File contract

- Use contiguous `NNNN_lowercase_name.sql` versions, starting at `0001`.
- Never edit a migration after it has shipped; add a new version instead.
- Do not use transaction control, `PRAGMA`, `ATTACH`, `DETACH`, `VACUUM`, or
  access the `schema_migrations` table from migration SQL.
- Migrations are persistent `main`-database changes. Temporary objects and
  SQLite schema internals are outside the contract.
- Files must be regular UTF-8 files. Their exact bytes are recorded as SHA-256.
- The migrations directory and SQL files must be physical paths, not symbolic
  links or junctions.
- The directory must remain unchanged for the complete migration call. Deploy
  migration sets as immutable releases or by an atomic directory replacement;
  the runner revalidates its snapshot after locking and immediately before
  commit.

The caller must provide an isolated connection with no attached or temporary
schemas, `foreign_keys=ON`, `ignore_check_constraints=OFF`, and
`writable_schema=OFF`. The runner verifies those conditions before and after it
holds the write reservation.

Before an application migrates an existing project, its integration layer must
create the recoverable database/project-manifest copy required by the Phase 2
plan. The runner deliberately accepts an already opened SQLite connection and
does not guess project or backup paths.

If the runner reports `MIGRATION_ROLLBACK_FAILED`, the caller must immediately
close and discard that connection. It may still expose an uncommitted partial
transaction and must never be reused or committed.

## Narrative review evidence

Migration `0004_narrative_reviews.sql` stores the four reviewable narrative
task results and append-only review decisions. Result payloads and hashes never
change; only their bounded review state can change. Approved references bind
both the output hash and the complete task-envelope hash.

Migration `0005_narrative_staleness.sql` adds one terminal stale-state record
and one immutable audit event per invalidated narrative result. Document,
selection and result replacement use fixed machine reason codes; a changed
review reference uses the review UID as its operation identity. The database
validates root ancestry and stores time only as bounded integer epoch
milliseconds. The service derives canonical UTC ISO text at its public
boundary, so SQLite and JavaScript never compete as timestamp parsers. Every
event sharing an operation identity must bind the same root/reason/time, and
the complete propagation rolls back if any audit event cannot be written.

Migration `0006_workflow_graph_registry.sql` binds workflow definitions to the
stable Phase 4 node registry and adds a monotonic graph revision. Whole-graph
updates advance the revision exactly once so optimistic saves can fail without
persisting partial nodes or edges.

Migration `0007_workflow_run_state_integrity.sql` binds workflow and node runs
to an immutable canonical graph snapshot, enforces legal state transitions,
caps retry evidence at 100, and preserves node-run identity independently of
mutable canvas rows. Project-archive restore does not bypass these guards: it
replays validated history from the queued state inside the import transaction.
The
provisional pre-v4 run format cannot be converted into a verifiable canonical
snapshot in SQL, so this migration fails atomically when legacy workflow-run
rows exist instead of silently accepting unverifiable history.
