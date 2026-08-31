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

Migration `0008_character_asset_versions.sql` separates stable Character,
Scene, and Prop identities from append-only Identity, Appearance, Costume,
Voice, Scene-visual, and Prop-visual versions. Character child
layers must bind an Identity belonging to the same Character; parent versions
must stay within the same owner and layer. Scene and Prop versions additionally
carry a bounded draft/ready/retired state, and only owner-matched ready records
can be used as references. All version rows reject update, delete, and
replacement so later lock and selection state can reference immutable content.
Database writes also enforce the exact bounded metadata shape, and repositories
preserve an explicit caller-provided epoch so archive replay cannot rewrite time
evidence. The same migration stores Character candidate media as complete
four-result batches: all four deferred candidate rows and the sealing batch row
must commit together. Their candidate Asset and ready AssetVersion rows are
fully frozen afterward, including media location, lineage, and timestamp fields.
Identity lock and unlock changes are append-only, monotonically versioned events;
stale writers, cross-Character references, replacement, update, and delete fail
without changing the current state or removing earlier candidates.
The migration also stores complete Character reference packages against one
currently locked Identity event. A package contains the ten required view and
expression slots in canonical order, one immutable ready AssetVersion per slot,
one owner-matched Appearance version, and one owner-matched default Costume
version. Package and item rows are append-only; their media Assets and complete
AssetVersion storage, lineage, dimensions, hashes, and canonical UTC-millisecond
time evidence are frozen and revalidated on every repository read. A later
unlock or a newer package does not rewrite an earlier package.
The same migration stores one append-only continuity snapshot per approved
planned-shot revision. A sealing transaction requires exact coverage of the
shot's Character and Prop fact references, a same-project ready Scene version,
currently locked Character reference packages, selected same-Identity Costume
versions, and same-project ready Prop versions. Snapshot rows retain the exact
approval hashes and review event. Later review staleness or identity unlock does
not erase historical snapshots, while owner re-hanging, replacement, update,
delete, and persisted version drift fail closed.

The same migration also separates mutable generation-run state from immutable
terminal generation history. Each history row binds one validated workflow
manifest, one Provider-neutral Prompt Semantic version, exact model/seed/input/
parameter/error evidence, and complete immutable snapshots of the ready output
AssetVersion plus its explicit parent when present. The seal transaction compares
every storage, URI/path, content hash, MIME, dimension, duration, lineage, status,
and canonical creation-time field; repository reads and project ZIP validation
repeat that comparison so missing protection triggers cannot hide later drift.
Evidence JSON is stored in one canonical serialization; duplicate keys, reordered
keys, alternate escapes, and surrounding whitespace fail closed on every read.
Regeneration appends a child AssetVersion and another history row; it
never overwrites an earlier result. Current-version changes are applied only by
monotonic append-only selection events with optimistic state versions. Once a
history or selection exists, its run, asset ownership, output version evidence,
and selection chain are frozen. Project ZIP export/import validates the whole
reference closure and replays selection events from their recorded initial
pointer inside the project import transaction. Failed or cancelled regeneration
may retain the same-asset ready parent version even though it has no output, so
the attempted lineage is not lost. History start/end epochs must exactly match
the terminal generation run timestamps, and generation payloads, Prompt text,
and exported history reject raw credential-shaped values before persistence.

Migration `0009_remote_execution_productization.sql` begins Phase 6 by making
remote connection profiles explicit while retaining only opaque Windows
Credential Manager references. Profiles pin password authentication, the
remote ComfyUI loopback endpoint, a safe relative work directory, and a
monotonic state version. The environment report and its checked-at timestamp
are reserved for P6-09 and must both remain `NULL` until that exact,
secret-free report contract is introduced. Endpoint identity
changes clear any previously confirmed host fingerprint and return the profile
to `unverified`; optimistic updates prevent stale UI writes from restoring an
older connection state. The migration also recognizes formal ComfyUI manifests
by their `comfy-workflow-manifest.v1` validation marker, checks their bounded
node/model and marker-binding structure at the database boundary, prevents
replacement, and freezes them after insertion. Runtime validation remains the
authority for binding the manifest to the exact workflow bytes and compiled
graph. Later Phase 6 tasks extend this migration with the recoverable remote-task
evidence defined by the same product contract.

Migration `0010_h3_generation_intents.sql` begins the local H3 T2V production
binding. Before upload or prompt submission, one append-only intent freezes the
prepared formal remote task, current approved Prompt Semantic record, official
validated workflow manifest, target video Asset, selected parent AssetVersion,
normalized H3 generation specification, safe output prefix, compiled prompt
hash, and immutable workflow-plan evidence. Database writes and repository
reads both revalidate the current approval, exact manifest, current connection
evidence, media ownership, parent lineage, plan node parameters, and canonical
specification/prompt hashes. Completion of a bound remote task is rejected at
the database boundary unless the matching immutable generation run and history
bind the full canonical specification, provider/model, parameters, prompt
identity, manifest hash, and output/parent evidence. Output AssetVersion
creation, H3 history append, remote-task completion, node completion, and
workflow completion are committed by one local SQLite transaction; selection
of the new video remains an explicit later user action.

Migration `0011_h3_api_submissions.sql` reserves every chargeable MiniMax H3
API submission before the remote POST. A canonical client operation UID is
bound to the exact request hash and saved-configuration evidence. A returned
provider task ID can be attached once; a timeout or indeterminate response is
persisted as append-only `submission_unknown` and cannot be automatically
retried under the same or a changed request.

Migration `0012_voice_profiles.sql` begins Phase 8 with append-only character
VoiceProfiles. Each profile binds one immutable Character Voice version, its
exact evidence, a provider-neutral model and preset voice key, and only an
opaque canonical CredentialVault reference. Public projections never contain
that reference. Profile revisions and fixed-voice selections are monotonic,
owner-scoped event chains; replacement, update, delete, cross-drama links, and
persisted Character Voice evidence drift fail closed.

Migration `0013_bgm_tracks.sql` stores append-only BGM candidates. Each record
binds one same-drama ready local AssetVersion and its complete portable media
evidence to an immutable, self-identifying user license attestation. User
absolute paths and credentials are not representable in the public license
projection. The local-import provider writes media through the
StorageProvider locator boundary and removes a newly written object if the
database transaction cannot commit. Each license UID is permanently assigned
to one track UID. The authoritative attestation is an independent append-only
`bgm_licenses` row; each track freezes a complete snapshot and every read
cross-checks the assignment and snapshot against that license row.

Migration `0016_project_archive_v21_import.sql` stores only the secret-free
portable-field projection required by Project Archive `2.1.0`. Each binding is
append-only, drama-scoped, exact to one approved carrier field, and records
whether a fresh local binding is required. Direct VoiceProfile credential
bindings never contain a Vault reference or secret in this sidecar; imported
profiles remain non-executable until an explicit local rebind flow replaces
the import placeholder under the later production activation gate.

Migration `0017_audio_mode_intents.sql` stores local prepared independent-TTS
intent records before any credential or Provider side effect. Each row binds
one queued `audio.tts` NodeRun whose frozen execution plan is enabled and bound
to the current approved Shot result, the Shot's directly approved Script
upstream, exact continuity snapshots and speaker-fact Character mappings, and
the currently active VoiceProfile selected by the node's secret-free opaque
credential reference. Canonical request and AudioModePlan JSON plus the plan
hash are revalidated by the SQLite UDF, insert trigger, repository write
readback, and every later read. Public projections omit both the request and
credential reference. These prepared operations are local execution state and
are deliberately excluded from project archives; they create no audio file,
AssetVersion, Vault read, Provider call, or readiness claim.

Migration `0018_audio_tts_submissions.sql` reserves each prepared dialogue
request before a synchronous TTS Provider call. The immutable identity binds
the intent, request ordinal, DialogueDelivery UID, request hash, VoiceProfile,
and Provider. A reservation begins as `submitting`; startup recovery changes
an interrupted reservation to `submission_unknown`, which is never eligible
for automatic replay. The optional `received` transition stores only a bounded
digest, byte count, and MIME summary and is reserved for a later durable media
sink. Credentials and audio bytes are not stored in this table. The table is
local operation state and is excluded from project archives.

Migration `0019_audio_tts_outputs.sql` seals each observed TTS response to a
deterministic local Audio Asset and ready AssetVersion after the stored bytes
have been re-read, SHA-256 verified, probed, and fully decoded. A completed
intent stores one exact output row per request plus a whole-plan AudioExecution
evidence record, then atomically advances the existing `audio.tts` NodeRun and
its WorkflowRun. The insert boundary binds live Asset, AssetVersion, media
probe, prepared plan, workflow/node identity, and every public evidence field;
replacement, update, and delete are rejected. A `submission_unknown` record
can complete only from the deterministic file already present and is never
sent to the Provider again. These two tables are local execution seals and are
excluded from project archives; the resulting portable Audio Asset and
AssetVersion remain part of the ordinary project media closure.

Migration `0020_mvp_benchmark_sessions.sql` freezes one secret-free execution
plan for a single drama and workflow run before any real benchmark side effect.
The plan must cover exactly every enabled `shot.video` node with 4–6 official
prepared H3 tasks and every enabled `audio.tts` node with its current prepared
audio intent. SQLite and runtime bind the graph revision/hash, node runs,
manifest identities, assets, generation-spec hashes and audio-plan hashes. The
session is append-only local operation evidence; it is deliberately excluded
from project archives and is not external execution or human-review evidence.

Migration `0021_mvp_benchmark_external_authorizations.sql` stores at most one
immutable, secret-free external authorization for a frozen benchmark session.
It binds the current ready connection evidence used by every prepared H3 task,
a CNY-fen cost ceiling, a one-attempt-per-item limit, a maximum 24-hour window,
session-only data scope, and mandatory instance return after terminal state or
expiry. The trusted RTX 4090 class and Phase 7 environment digest are recorded
as requirements: the authorization explicitly requires a separate live
environment check before any external execution and does not claim that such a
check, a Provider call, media generation, or human review has happened. This
local authorization is excluded from project archives. Until a later stage
adds and verifies live-environment, atomic cost, and one-attempt reservation,
all H3 tasks and audio intents reserved by a benchmark session remain blocked
at the production remote/H3/TTS execution boundaries before side effects.

Migration `0022_mvp_benchmark_execution_preflights.sql` adds two local-only
pre-execution evidence layers without enabling external work. A short-lived
attestation binds the current authorization and connection evidence to the
reviewed RTX 4090 operational projection (GPU, ComfyUI/runtime, and all seven
model content hashes). An immutable reservation then consumes exactly one
attempt for one frozen H3 task or TTS intent and a CNY-fen estimate from a
captured local cost-policy adapter. SQLite rejects cross-session items,
expired proofs, non-prepared sources, duplicates, and aggregate reservations
above the authorization ceiling. Independent seal tables make coordinated row
rewrites fail closed if a primary-row update guard is missing. All four tables
are excluded from project archives and contain no endpoint, path, credential,
Provider response, or media. Production execution remains blocked until a
later stage wires a real live verifier, trusted estimator, terminal accounting,
and instance return through the same gate.

Both evidence INSERT gates also require the
`mvp_benchmark_execution_ready_sessions` view. The view reconstructs the
current D3A source closure instead of trusting the older authorization alone:
queued workflow/node/task state, full graph identity, current RemoteConnection
evidence, approved H3 prompt semantics, video assets, dialogue continuity, and
the active VoiceProfile must still match the frozen session. A later approval,
profile, connection, asset, or execution-state change therefore prevents any
new attestation or reservation before an append-only row can be written.

Migration `0023_mvp_benchmark_execution_accounting.sql` keeps terminal
accounting separate from execution. Each reservation can receive at most one
immutable settlement after its H3 task or TTS evidence is durably terminal;
the actual CNY-fen amount is bounded by the reserved estimate and the original
authorization ceiling. The first live attestation also creates a durable
resource-release obligation for the original connection evidence. That
obligation survives authorization expiry and source drift and can be closed
only by one secret-free release receipt from a separately trusted verifier.
Settlements, obligations, receipts, and their independent seals remain local
operational evidence and are excluded from project archives. The migration
does not contact, stop, or claim to have stopped a remote instance.

Migration `0024_mvp_benchmark_execution_batches.sql` closes the frozen request
identity at the SQLite boundary. Every H3 reservation must use the session's
exact `planEvidenceSha256`, and every TTS reservation must use the exact frozen
audio `planSha256`; direct SQL and replacement conflict algorithms cannot
substitute another request digest. The application prepares all session items
under one live attestation and one immediate transaction, so an expiry,
budget failure, source drift, duplicate, or later-item insert failure leaves
no partial batch. This local preflight still does not enable or claim any
Provider, Vault, GPU, media, billing, or instance-return operation.
