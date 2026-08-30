const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ARCHIVE_V20,
  ARCHIVE_V21,
  createArchiveVersionRouter,
} = require('../src/adapters/v2/zip/archiveVersionRouter');
const {
  PROJECT_ARCHIVE_CATALOG,
  validateProjectArchiveCatalog,
} = require('../src/adapters/v2/zip/projectArchiveCatalog');
const { RECORD_SPECS } = require('../src/adapters/v2/zip/manifest');
const { normalizeWorkflowNodeConfig } = require('../src/workflows/nodeConfig');

test('archive version router preserves v1, dispatches exact known versions, and rejects unknown versions', () => {
  const calls = [];
  const router = createArchiveVersionRouter({
    [ARCHIVE_V20]: (value) => {
      calls.push(ARCHIVE_V20);
      return Object.freeze({ ...value, parsedBy: ARCHIVE_V20 });
    },
    [ARCHIVE_V21]: (value) => {
      calls.push(ARCHIVE_V21);
      return Object.freeze({ ...value, parsedBy: ARCHIVE_V21 });
    },
  });

  assert.deepEqual(router.parse(null), {
    kind: 'legacy-v1',
    manifest: null,
    schemaVersion: null,
  });
  assert.equal(router.parse({ schemaVersion: ARCHIVE_V20 }).manifest.parsedBy, ARCHIVE_V20);
  assert.equal(router.parse({ schemaVersion: ARCHIVE_V21 }).manifest.parsedBy, ARCHIVE_V21);
  assert.deepEqual(calls, [ARCHIVE_V20, ARCHIVE_V21]);

  assert.throws(
    () => router.parse({ schemaVersion: '2.2.0' }),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
  assert.throws(
    () => router.parse({ get schemaVersion() { throw new Error('must not execute'); } }),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
});

test('production archive router can reserve 2.1 without accepting an incomplete 2.1 archive', () => {
  const router = createArchiveVersionRouter({
    [ARCHIVE_V20]: (value) => value,
  });

  assert.equal(router.supports(ARCHIVE_V20), true);
  assert.equal(router.supports(ARCHIVE_V21), false);
  assert.throws(
    () => router.parse({ schemaVersion: ARCHIVE_V21 }),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
});

test('archive version routing rejects ordinary and revoked proxies without running traps or leaking native errors', () => {
  const router = createArchiveVersionRouter({ [ARCHIVE_V20]: (value) => value });
  let trapReads = 0;
  const hostile = new Proxy({ schemaVersion: ARCHIVE_V20 }, {
    get() { trapReads += 1; throw new Error('must not execute'); },
    getOwnPropertyDescriptor() { trapReads += 1; throw new Error('must not execute'); },
    getPrototypeOf() { trapReads += 1; throw new Error('must not execute'); },
  });
  assert.throws(
    () => router.parse(hostile),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
  assert.equal(trapReads, 0);

  const revokedManifest = Proxy.revocable({ schemaVersion: ARCHIVE_V20 }, {});
  revokedManifest.revoke();
  assert.throws(
    () => router.parse(revokedManifest.proxy),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );

  const revokedRegistry = Proxy.revocable({ [ARCHIVE_V20]: (value) => value }, {});
  revokedRegistry.revoke();
  assert.throws(
    () => createArchiveVersionRouter(revokedRegistry.proxy),
    (error) => error instanceof TypeError && error.message === 'Project archive parsers are invalid',
  );
});

test('project archive catalog classifies every current record table and keeps local-only state excluded', () => {
  const validated = validateProjectArchiveCatalog(PROJECT_ARCHIVE_CATALOG, RECORD_SPECS);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(validated.currentExportVersion, ARCHIVE_V20);
  assert.equal(validated.targetExportVersion, ARCHIVE_V21);

  const included = new Set(validated.includedTables);
  for (const spec of Object.values(RECORD_SPECS)) assert.equal(included.has(spec.table), true, spec.table);

  for (const table of [
    'ai_service_configs',
    'remote_connections',
    'remote_tasks',
    'h3_api_submissions',
    'h3_generation_intents',
    'schema_migrations',
    '_v2_uid_generation_candidates',
    'global_settings',
    'ai_model_map',
    'prompt_overrides',
    'image_proxy_cache',
  ]) {
    assert.equal(validated.excludedTables.includes(table), true, table);
  }
  for (const table of ['dramas', 'episodes', 'storyboards', 'characters', 'scenes', 'props']) {
    assert.equal(validated.legacyCoreTables.includes(table), true, table);
    assert.equal(validated.requiredV21Tables.includes(table), true, table);
  }
  for (const table of [
    'episode_characters',
    'storyboard_characters',
    'storyboard_props',
    'character_libraries',
    'scene_libraries',
    'prop_libraries',
    'legacy_assets',
    'frame_prompts',
    'image_generations',
    'video_generations',
    'video_merges',
  ]) {
    assert.equal(validated.legacyAddendumTables.includes(table), true, table);
    assert.equal(validated.requiredV21Tables.includes(table), true, table);
  }
  assert.equal(validated.needsRebindTables.includes('voice_profiles'), true);
  assert.equal(validated.requiredV21Tables.includes('narrative_results'), true);
  assert.equal(validated.requiredV21Tables.includes('shot_continuity_snapshots'), true);
  assert.equal(validated.requiredV21Tables.includes('bgm_tracks'), true);
});

test('project archive catalog marks every credential-bearing workflow field for portable rebind', () => {
  const credentialRef = 'credential:v1:00000000-0000-4000-8000-000000009401';
  const audioConfig = normalizeWorkflowNodeConfig('audio.tts', {
    credentialRef,
    profileUid: '00000000-0000-4000-8000-000000009402',
    speed: 1,
  });
  const videoConfig = normalizeWorkflowNodeConfig('shot.video', {
    connectionEvidenceSha256: 'a'.repeat(64),
    connectionUid: '00000000-0000-4000-8000-000000009403',
    credentialRef,
    durationMs: 15000,
    fps: 24,
    height: 1080,
    manifestUid: '00000000-0000-4000-8000-000000009404',
    profileUid: '00000000-0000-4000-8000-000000009405',
    seed: 42,
    width: 1920,
  });
  assert.equal(audioConfig.credentialRef, credentialRef);
  assert.equal(videoConfig.credentialRef, credentialRef);

  const fields = new Set(PROJECT_ARCHIVE_CATALOG.needsRebindFields.map(
    ({ table, column }) => `${table}.${column}`,
  ));
  for (const table of ['voice_profiles', 'canvas_nodes', 'workflow_runs', 'node_runs']) {
    assert.equal(PROJECT_ARCHIVE_CATALOG.needsRebindTables.includes(table), true, table);
  }
  for (const field of [
    'voice_profiles.credential_ref',
    'canvas_nodes.config_json',
    'workflow_runs.graph_snapshot_json',
    'node_runs.input_snapshot_json',
    'node_runs.output_json',
  ]) assert.equal(fields.has(field), true, field);

  assert.equal(validateProjectArchiveCatalog(PROJECT_ARCHIVE_CATALOG, RECORD_SPECS), PROJECT_ARCHIVE_CATALOG);
});
