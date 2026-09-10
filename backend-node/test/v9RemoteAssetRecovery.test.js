'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const recoveryRequestSchema = require('../../schemas/v9/remote-asset-recovery-request.schema.json');
const recoverySchema = require('../../schemas/v9/remote-asset-recovery.schema.json');

const {
  canonicalRemoteAssetRecoveryRequest,
  parseRemoteAssetRecoveryRequest,
  remoteAssetRecoveryRequestSha256,
} = require('../src/remoteAssets/recoveryRequest');
const {
  canonicalRemoteAssetRecoveryManifest,
  parseRemoteAssetRecoveryManifest,
} = require('../src/remoteAssets/recoveryManifest');
const { createMigratedV2Database } = require('./helpers/v2RepositoryDatabase');
const { createV2Repositories } = require('../src/repositories/v2');
const { LocalStorageProvider } = require('../src/adapters/v2/storage/localStorageProvider');
const { createNarrativeExecutionService } = require('../src/narrative/execution');
const { createNarrativeReviewService } = require('../src/narrative/reviews');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const { createRemoteAssetRecoveryService } = require('../src/remoteAssets');
const { runV2Migrations } = require('../src/db/v2');

const uid = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const sha = (character) => character.repeat(64);

function request() {
  return {
    schemaVersion: 'remote-asset-recovery-request.v1',
    operationUid: uid(1),
    dramaUid: uid(2),
    characterUid: uid(3),
    extractionResultUid: uid(4),
    characterFactId: 'character-alan',
    connectionUid: uid(5),
    connectionEvidenceSha256: sha('a'),
    remoteTaskUid: uid(6),
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function seedApprovedSource(database) {
  const ids = {
    drama: uid(100), character: uid(101), document: uid(102), block: uid(103),
    selection: uid(104), extraction: uid(105),
  };
  const text = '阿澜是一名二十岁的黑发剑客，身穿青色短袍。';
  const textHash = sha256(Buffer.from(text, 'utf8'));
  database.prepare('INSERT INTO dramas (title,uid) VALUES (?,?)').run('Recovery fixture', ids.drama);
  const dramaId = database.prepare('SELECT id FROM dramas WHERE uid=?').pluck().get(ids.drama);
  database.prepare(`
    INSERT INTO characters
      (drama_id,name,description,personality,appearance,created_at,updated_at,uid)
    VALUES (?, '阿澜', '年轻剑客', '沉着坚定', '黑发，青色短袍',
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z', ?)
  `).run(dramaId, ids.character);
  database.transaction(() => {
    database.prepare(`
      INSERT INTO source_documents
        (uid,drama_uid,source_type,original_name,encoding,content_sha256,full_text,block_count)
      VALUES (?,?,'txt','recovery.txt','utf-8',?,?,1)
    `).run(ids.document, ids.drama, textHash, text);
    database.prepare(`
      INSERT INTO source_blocks
        (uid,document_uid,ordinal,heading_path_json,char_start,char_end,text,text_sha256)
      VALUES (?,?,0,'[]',0,?,?,?)
    `).run(ids.block, ids.document, Array.from(text).length, text, textHash);
    database.prepare(`
      INSERT INTO source_selections
        (uid,document_uid,start_block_uid,end_block_uid,start_offset,end_offset,selected_text_sha256)
      VALUES (?,?,?,?,0,?,?)
    `).run(ids.selection, ids.document, ids.block, ids.block, Array.from(text).length, textHash);
  })();
  const repositories = createV2Repositories(database);
  const rawResponse = JSON.stringify({
    schemaVersion: 'novel-extraction.v1',
    characters: [{
      factId: 'character-alan', name: '阿澜',
      description: '二十岁的黑发剑客，身穿青色短袍。',
      evidence: [{ blockUid: ids.block, startOffset: 0, endOffset: Array.from(text).length, quote: text }],
    }],
    scenes: [], props: [], relationships: [], events: [], dialogue: [],
  });
  const result = await createNarrativeExecutionService({
    repositories,
    provider: Object.freeze({
      scope: 'configured-text',
      isAvailable: () => true,
      generate: () => ({
        model: { provider: 'synthetic', name: 'fixture-model' },
        parameters: { temperature: 0 },
        promptVersion: 'narrative-extraction.v1',
        rawResponse,
      }),
    }),
    assetOwnership: Object.freeze({ accepts() { return true; } }),
  }).execute({
    schemaVersion: 'narrative-execution-request.v1',
    operationUid: ids.extraction,
    dramaUid: ids.drama,
    sourceSelectionUid: ids.selection,
    resultType: 'extraction',
    upstreamResultUid: null,
    upstreamResultHash: null,
    upstreamEnvelopeHash: null,
    upstreamApprovalRef: null,
    durationBudget: null,
    style: null,
    assetVersions: [],
  });
  ids.extraction = result.result.uid;
  createNarrativeReviewService({ repositories }).reviewResult({
    resultUid: result.result.uid,
    decision: 'approve',
    comment: 'recovery fixture approval',
  });
  return { ids, repositories };
}

async function localPackageFixture(characterName = '阿澜') {
  const AdmZip = require('adm-zip');
  const pngs = await Promise.all([0, 1].map((ordinal) => sharp({
    create: {
      width: 256, height: 256, channels: 3,
      background: { r: 90 + ordinal * 20, g: 110, b: 130 },
    },
  }).png().toBuffer()));
  const operationUid = uid(760);
  const items = pngs.map((bytes, ordinal) => ({
    slug: 'alan', name: characterName, operationUid, ordinal, seed: ordinal,
    promptSha256: sha('a'), promptId: uid(770 + ordinal), state: 'succeeded',
    filename: `${ordinal}.png`, subfolder: `character-candidates/${operationUid}`,
    type: 'output', bytes: bytes.length, sha256: sha256(bytes),
    localPackageName: `alan-${ordinal + 1}.png`, verifiedWidth: 256, verifiedHeight: 256,
  }));
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    schemaVersion: 'project-character-candidate-emergency-run.v1', runUid: uid(780),
    checkpoint: 'model.safetensors', width: 256, height: 256, sampler: 'euler',
    scheduler: 'normal', steps: 20, cfg: 6, items,
  })));
  for (const item of items) zip.addFile(item.localPackageName, pngs[item.ordinal]);
  return zip.toBuffer();
}

test('remote asset recovery request is exact, canonical, and evidence bound', () => {
  const parsed = parseRemoteAssetRecoveryRequest(request());
  const ajv = new Ajv2020({ allErrors: true, strict: true })
    .addSchema(recoveryRequestSchema);
  assert.equal(ajv.validate(recoveryRequestSchema.$id, parsed), true, JSON.stringify(ajv.errors));
  assert.doesNotThrow(() => ajv.compile(recoverySchema));
  assert.deepEqual(parsed, request());
  assert.equal(Object.isFrozen(parsed), true);
  const canonical = canonicalRemoteAssetRecoveryRequest(parsed);
  assert.equal(
    remoteAssetRecoveryRequestSha256(parsed),
    createHash('sha256').update(canonical, 'utf8').digest('hex'),
  );
  assert.throws(() => parseRemoteAssetRecoveryRequest({ ...request(), extra: true }));
  assert.throws(() => parseRemoteAssetRecoveryRequest({
    ...request(), connectionEvidenceSha256: sha('A'),
  }));
  assert.throws(() => parseRemoteAssetRecoveryRequest({
    ...request(), remoteTaskUid: '../escape',
  }));
});

test('remote asset recovery manifest normalizes standard and legacy character jobs', () => {
  const sourceManifestSha256 = sha('b');
  const standard = parseRemoteAssetRecoveryManifest({
    schemaVersion: 'remote-asset-recovery-manifest.v1',
    remoteTaskUid: uid(6),
    characterName: '阿澜',
    assets: [
      { ordinal: 0, relativePath: 'outputs/lin-che-1.png', sha256: sha('c'), width: 1024, height: 1024 },
      { ordinal: 1, relativePath: 'outputs/lin-che-2.png', sha256: sha('d'), width: 1024, height: 1024 },
    ],
  }, { remoteTaskUid: uid(6), sourceManifestSha256, characterName: '阿澜' });
  assert.equal(standard.sourceFormat, 'standard.v1');
  assert.equal(standard.items.length, 2);
  assert.equal(standard.items[0].remoteRelativePath, 'outputs/lin-che-1.png');
  assert.throws(() => parseRemoteAssetRecoveryManifest({
    schemaVersion: 'remote-asset-recovery-manifest.v1',
    remoteTaskUid: uid(6),
    characterName: '夏弦',
    assets: [
      { ordinal: 0, relativePath: 'outputs/xia-xian-1.png', sha256: sha('c'), width: 1024, height: 1024 },
    ],
  }, { remoteTaskUid: uid(6), sourceManifestSha256, characterName: '阿澜' }));

  const legacy = parseRemoteAssetRecoveryManifest({
    runUid: uid(6),
    checkpoint: 'animagine-xl-4.0-opt.safetensors',
    size: '1024x1024',
    steps: 28,
    cfg: 6,
    sampler: 'euler_ancestral',
    scheduler: 'normal',
    items: [
      {
        name: '林澈', slug: 'lin-che', ordinal: 0, seed: 1,
        promptSha256: sha('e'), promptId: uid(20),
        file: 'lin-che-1.png', subfolder: 'outputs', sha256: sha('f'),
      },
    ],
  }, { remoteTaskUid: uid(6), sourceManifestSha256, characterName: '林澈' });
  assert.equal(legacy.sourceFormat, 'legacy.character-candidates.v1');
  assert.equal(legacy.characterName, '林澈');
  assert.equal(legacy.items[0].remoteRelativePath, 'outputs/lin-che-1.png');
  assert.equal(
    JSON.parse(canonicalRemoteAssetRecoveryManifest(legacy)).sourceManifestSha256,
    sourceManifestSha256,
  );

  assert.throws(() => parseRemoteAssetRecoveryManifest({
    schemaVersion: 'remote-asset-recovery-manifest.v1',
    remoteTaskUid: uid(6),
    assets: [{ ordinal: 0, relativePath: '../secret', sha256: sha('c'), width: 1024, height: 1024 }],
  }, { remoteTaskUid: uid(6), sourceManifestSha256, characterName: '阿澜' }));
  assert.throws(() => parseRemoteAssetRecoveryManifest({
    schemaVersion: 'remote-asset-recovery-manifest.v1',
    remoteTaskUid: uid(999),
    assets: [{ ordinal: 0, relativePath: 'safe.png', sha256: sha('c'), width: 1024, height: 1024 }],
  }, { remoteTaskUid: uid(6), sourceManifestSha256, characterName: '阿澜' }));
});

test('legacy recovery selects only the approved character from a multi-character task', () => {
  const sourceManifestSha256 = sha('9');
  const shared = {
    seed: 1,
    promptSha256: sha('8'),
    promptId: uid(21),
    subfolder: 'outputs',
    sha256: sha('7'),
  };
  const manifest = {
    runUid: uid(6),
    checkpoint: 'animagine-xl-4.0-opt.safetensors',
    size: '1024x1024',
    steps: 28,
    cfg: 6,
    sampler: 'euler_ancestral',
    scheduler: 'normal',
    items: [
      { ...shared, name: '林澈', slug: 'lin-che', ordinal: 0, file: 'lin-che-1.png' },
      { ...shared, name: '林澈', slug: 'lin-che', ordinal: 1, file: 'lin-che-2.png' },
      { ...shared, name: '夏弦', slug: 'xia-xian', ordinal: 0, file: 'xia-xian-1.png' },
      { ...shared, name: '夏弦', slug: 'xia-xian', ordinal: 1, file: 'xia-xian-2.png' },
    ],
  };
  const selected = parseRemoteAssetRecoveryManifest(manifest, {
    remoteTaskUid: uid(6), sourceManifestSha256, characterName: '夏弦',
  });
  assert.equal(selected.characterName, '夏弦');
  assert.deepEqual(selected.items.map((item) => ({
    ordinal: item.ordinal, path: item.remoteRelativePath,
  })), [
    { ordinal: 0, path: 'outputs/xia-xian-1.png' },
    { ordinal: 1, path: 'outputs/xia-xian-2.png' },
  ]);
  assert.throws(() => parseRemoteAssetRecoveryManifest(manifest, {
    remoteTaskUid: uid(6), sourceManifestSha256, characterName: '不存在',
  }));
  const invalidUnselected = structuredClone(manifest);
  invalidUnselected.items[0].sha256 = 'Z'.repeat(64);
  assert.throws(() => parseRemoteAssetRecoveryManifest(invalidUnselected, {
    remoteTaskUid: uid(6), sourceManifestSha256, characterName: '夏弦',
  }));
});

test('migrations 34 and 35 create append-only character-bound recovery evidence', (t) => {
  const database = createMigratedV2Database(t);
  assert.equal(database.prepare('SELECT max(version) FROM schema_migrations').pluck().get(), 40);
  assert.equal(database.prepare(`
    SELECT count(*) FROM sqlite_master
    WHERE type='table' AND name IN ('remote_asset_recoveries','remote_asset_recovery_items')
  `).pluck().get(), 2);
  assert.equal(database.prepare(`
    SELECT count(*) FROM sqlite_master
    WHERE type='trigger' AND name='v2_remote_asset_recoveries_character_binding_update'
  `).pluck().get(), 1);
  const repository = createV2Repositories(database).remoteAssetRecoveries;
  assert.equal(typeof repository.reserve, 'function');
  assert.equal(typeof repository.complete, 'function');
  assert.equal(typeof repository.listByCharacter, 'function');
  assert.deepEqual(repository.recoverInterrupted(), { recoveredCount: 0 });
});

test('migrations 37 through 40 preserve genuine v36 local items, media reads and replay', async (t) => {
  const migrationRoot = path.resolve(__dirname, '../migrations/v2');
  const v36Root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-recovery-v36-'));
  t.after(() => fs.rmSync(v36Root, { recursive: true, force: true }));
  for (const name of fs.readdirSync(migrationRoot)) {
    if (!/^\d{4}_.+\.sql$/u.test(name) || Number(name.slice(0, 4)) > 36) continue;
    fs.copyFileSync(path.join(migrationRoot, name), path.join(v36Root, name));
  }
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.pragma('foreign_keys = ON');
  database.exec(fs.readFileSync(path.resolve(__dirname, '../migrations/01_init.sql'), 'utf8'));
  assert.equal(runV2Migrations(database, { migrationsDir: v36Root }).currentVersion, 36);
  const { ids, repositories } = await seedApprovedSource(database);
  const input = {
    dramaUid: ids.drama,
    characterUid: ids.character,
    extractionResultUid: ids.extraction,
    characterFactId: 'character-alan',
  };
  const { createCharacterCandidateSourceResolver } = require('../src/characterCandidates/execution/sourceResolver');
  const {
    canonicalCharacterCandidateSource,
  } = require('../src/characterCandidates/execution/source');
  const source = createCharacterCandidateSourceResolver({ repositories }).resolve(input);
  const packageUid = uid(198);
  const { readLocalRecoveryPackage } = require('../src/remoteAssets/localRecoveryPackage');
  const { createLocalPackageImportService } = require('../src/remoteAssets/localPackageImportService');
  const packageBytes = await localPackageFixture();
  const pkg = await readLocalRecoveryPackage(packageBytes);
  const storageRoot = path.join(v36Root, 'storage');
  fs.mkdirSync(storageRoot);
  const storage = new LocalStorageProvider({ projectRoot: storageRoot });
  const oldItems = [];
  for (const [ordinal, image] of pkg.items.entries()) {
  const normalize = require('../src/characterCandidates/execution/imageNormalizer').createCharacterCandidateImageNormalizer();
  const normalized = await normalize(image.bytes, 256, 256);
  const assetUid = uid(199 + ordinal);
  const versionUid = uid(2000 + ordinal);
  const relativePath = `characters/${ids.character}/local-recoveries/${packageUid}/${ordinal}.png`;
  repositories.assets.create({
    uid: assetUid,
    ownerType: 'character',
    ownerUid: ids.character,
    assetType: 'local_recovery',
    status: 'draft',
  });
  repositories.assets.addVersion({
    uid: versionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri: `asset://${relativePath}`,
    relativePath,
    sha256: sha256(normalized.bytes),
    mimeType: 'image/png',
    width: 256,
    height: 256,
    durationMs: null,
    parentUid: null,
    status: 'ready',
  });
  await storage.write({ storageProvider: 'local', logicalUri: `asset://${relativePath}`, relativePath }, normalized.bytes);
  oldItems.push({ ordinal, assetUid, assetVersionUid: versionUid, relativePath,
    sha256: sha256(normalized.bytes), byteLength: normalized.bytes.length, width: 256, height: 256,
    originalName: image.localPackageName, originalSha256: image.sha256 });
  }
  database.prepare(`
    INSERT INTO local_recovery_packages
      (uid,drama_uid,character_uid,package_sha256,manifest_sha256,remote_task_uid,
       source_json,source_sha256,items_json)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    packageUid,
    ids.drama,
    ids.character,
    pkg.packageSha256,
    pkg.sourceManifestSha256,
    pkg.remoteTaskUid,
    canonicalCharacterCandidateSource(source.source),
    source.sourceSha256,
    JSON.stringify(oldItems),
  );
  assert.equal(runV2Migrations(database, { migrationsDir: migrationRoot }).currentVersion, 40);
  assert.deepEqual(database.prepare(`
    SELECT operation_uid,state,attempt_count FROM local_recovery_import_attempts
  `).get(), { operation_uid: packageUid, state: 'succeeded', attempt_count: 1 });
  assert.equal(database.prepare('SELECT count(*) FROM local_recovery_packages').pluck().get(), 1);
  const upgraded = createLocalPackageImportService({ repositories: createV2Repositories(database), storage });
  const listed = await upgraded.list(ids.drama, ids.character);
  assert.equal(listed[0].items.length, 2);
  for (const item of listed[0].items) {
    assert.equal(item.logicalUri, `asset://${item.relativePath}`);
    assert.equal(sha256(await storage.readBounded({ storageProvider: 'local',
      relativePath: item.relativePath, logicalUri: item.logicalUri }, 16 * 1024 * 1024)), item.sha256);
  }
  assert.equal((await upgraded.execute(input, packageBytes)).uid, packageUid);
  assert.equal(database.prepare('SELECT items_json FROM local_recovery_packages').pluck().get(), JSON.stringify(oldItems));
});

test('recovery downloads a remote manifest and seals normalized PNGs as local quarantine assets', async (t) => {
  const database = createMigratedV2Database(t);
  const { ids, repositories } = await seedApprovedSource(database);
  const connection = repositories.remote.createConnection({
    uid: uid(200),
    name: 'Recovery GPU',
    host: 'gpu.example.test',
    port: 22,
    username: 'worker',
    hostFingerprint: `SHA256:${'A'.repeat(43)}`,
    credentialRef: `credential:v1:${uid(201)}`,
    status: 'ready',
    authMethod: 'password',
    sshPublicKey: null,
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
  });
  const remoteTaskUid = uid(202);
  const operationUid = uid(203);
  const pngs = await Promise.all([0, 1].map((ordinal) => sharp({
    create: {
      width: 256, height: 256, channels: 3,
      background: { r: 60 + ordinal * 40, g: 80, b: 120 },
    },
  }).png().toBuffer()));
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 'remote-asset-recovery-manifest.v1',
    remoteTaskUid,
    characterName: '阿澜',
    assets: pngs.map((bytes, ordinal) => ({
      ordinal,
      relativePath: `outputs/candidate-${ordinal}.png`,
      sha256: sha256(bytes),
      width: 256,
      height: 256,
    })),
  }), 'utf8');
  const remote = new Map([
    ['manifest.json', manifestBytes],
    ['outputs/candidate-0.png', pngs[0]],
    ['outputs/candidate-1.png', pngs[1]],
  ]);
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-asset-recovery-'));
  t.after(() => fs.rmSync(localRoot, { recursive: true, force: true }));
  const storage = new LocalStorageProvider({ projectRoot: localRoot });
  const calls = [];
  let releaseTransfer;
  let announceTransfer;
  const transferStarted = new Promise((resolve) => { announceTransfer = resolve; });
  const transferGate = new Promise((resolve) => { releaseTransfer = resolve; });
  const session = { async close() { calls.push('close'); } };
  const service = createRemoteAssetRecoveryService({
    repositories,
    storage,
    sessionService: {
      async openSession(connectionUid, evidenceSha256) {
        assert.equal(connectionUid, connection.uid);
        assert.equal(evidenceSha256, remoteConnectionEvidenceSha256(connection));
        return { connection, session };
      },
    },
    transfer: {
      async inspectScopedRemoteFile(input) {
        assert.equal(input.taskScope, 'character-candidates');
        const bytes = remote.get(input.relativePath);
        return {
          remoteRelativePath: `ai-drama-studio/jobs/character-candidates/${remoteTaskUid}/${input.relativePath}`,
          sha256: sha256(bytes),
          bytes: bytes.length,
        };
      },
      async downloadScopedFile(input) {
        calls.push(input.relativePath);
        const bytes = remote.get(input.relativePath);
        assert.ok(bytes);
        assert.equal(
          input.expectedSha256,
          input.relativePath === 'manifest.json' ? null : sha256(bytes),
        );
        const target = path.join(localRoot, ...input.localRelativePath.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
        if (input.relativePath === 'manifest.json') {
          announceTransfer(target);
          await transferGate;
        }
        return { localRelativePath: input.localRelativePath, sha256: sha256(bytes), bytes: bytes.length };
      },
    },
    createUid: (() => {
      let next = 300;
      return () => uid(next++);
    })(),
  });
  const recoveryRequest = {
    schemaVersion: 'remote-asset-recovery-request.v1',
    operationUid,
    dramaUid: ids.drama,
    characterUid: ids.character,
    extractionResultUid: ids.extraction,
    characterFactId: 'character-alan',
    connectionUid: connection.uid,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(connection),
    remoteTaskUid,
  };
  const running = service.execute(recoveryRequest);
  const activeFile = await transferStarted;
  const startupInstance = createRemoteAssetRecoveryService({ repositories: createV2Repositories(database), storage,
    sessionService: { async openSession() { throw new Error('Must not connect'); } },
    transfer: { async downloadScopedFile() { throw new Error('Must not download'); } },
  });
  const startupResult = await startupInstance.recoverInterrupted();
  const fileSurvived = fs.existsSync(activeFile);
  releaseTransfer();
  const first = await running;
  assert.deepEqual(startupResult, { recoveredCount: 0, failedCount: 0 });
  assert.equal(fileSurvived, true);
  const second = await service.execute(recoveryRequest);
  await assert.rejects(
    service.execute({ ...recoveryRequest, remoteTaskUid: uid(299) }),
    (error) => error?.code === 'REMOTE_ASSET_RECOVERY_CONFLICT',
  );
  await assert.rejects(
    service.execute({ ...recoveryRequest, operationUid: uid(204) }),
    (error) => error?.code === 'REMOTE_ASSET_RECOVERY_CONFLICT',
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true })
    .addSchema(recoveryRequestSchema);
  const validateRecovery = ajv.compile(recoverySchema);
  assert.equal(validateRecovery(first.recovery), true, JSON.stringify(validateRecovery.errors));
  assert.equal(first.recovery.state, 'succeeded');
  assert.equal(first.recovery.quarantineStatus, 'unapproved');
  assert.equal(first.recovery.items.length, 2);
  assert.deepEqual(second, first);
  assert.deepEqual(calls, ['manifest.json', 'outputs/candidate-0.png', 'outputs/candidate-1.png', 'close']);
  assert.equal(database.prepare("SELECT count(*) FROM assets WHERE asset_type='remote_recovery'").pluck().get(), 2);
  assert.deepEqual(database.prepare(`
    SELECT status,current_version_uid FROM assets WHERE asset_type='remote_recovery' ORDER BY uid
  `).all(), [
    { status: 'draft', current_version_uid: null },
    { status: 'draft', current_version_uid: null },
  ]);
  assert.equal((await service.list({ dramaUid: ids.drama, characterUid: ids.character }))
    .recoveries.length, 1);
  for (const item of first.recovery.items) {
    assert.equal(fs.existsSync(path.join(localRoot, ...item.relativePath.split('/'))), true);
  }
  assert.throws(() => database.prepare(`
    UPDATE remote_asset_recovery_items SET width=width WHERE operation_uid=?
  `).run(operationUid), /immutable/u);
  assert.throws(() => database.prepare(`
    DELETE FROM remote_asset_recoveries WHERE operation_uid=?
  `).run(operationUid), /append-only/u);

  const retryRemoteTaskUid = uid(650);
  const retryOperationUid = uid(651);
  const retryManifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 'remote-asset-recovery-manifest.v1',
    remoteTaskUid: retryRemoteTaskUid,
    characterName: '阿澜',
    assets: pngs.map((bytes, ordinal) => ({
      ordinal,
      relativePath: `outputs/candidate-${ordinal}.png`,
      sha256: sha256(bytes),
      width: 256,
      height: 256,
    })),
  }), 'utf8');
  remote.set('manifest.json', retryManifestBytes);
  const retryRequest = {
    ...recoveryRequest,
    operationUid: retryOperationUid,
    remoteTaskUid: retryRemoteTaskUid,
  };
  const { createCharacterCandidateSourceResolver } = require('../src/characterCandidates/execution/sourceResolver');
  const retrySource = createCharacterCandidateSourceResolver({ repositories }).resolve(retryRequest);
  repositories.remoteAssetRecoveries.reserve({
    request: retryRequest,
    requestSha256: remoteAssetRecoveryRequestSha256(retryRequest),
    source: retrySource.source,
    sourceSha256: retrySource.sourceSha256,
  });
  const orphanPaths = [
    `remote-recovery-staging/${retryOperationUid}/manifest.json`,
    `characters/${ids.character}/remote-recoveries/${retryOperationUid}/0.png`,
  ];
  for (const orphan of orphanPaths) {
    const absolute = path.join(localRoot, ...orphan.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, 'partial');
  }
  assert.deepEqual(await service.recoverInterrupted(), { recoveredCount: 1, failedCount: 0 });
  assert.equal(orphanPaths.every((orphan) => (
    !fs.existsSync(path.join(localRoot, ...orphan.split('/')))
  )), true);
  assert.equal(
    repositories.remoteAssetRecoveries.get(retryOperationUid).errorCode,
    'REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE',
  );
  const retried = await service.execute(retryRequest);
  assert.equal(retried.recovery.state, 'succeeded');
  assert.equal(retried.recovery.operationUid, retryOperationUid);

  const wrongManifestJson = canonicalRemoteAssetRecoveryManifest({
    ...first.recovery.manifest,
    characterName: '夏弦',
  });
  database.exec('DROP TRIGGER v2_remote_asset_recoveries_validate_update');
  assert.throws(() => database.prepare(`
    UPDATE remote_asset_recoveries
    SET manifest_json=?, manifest_sha256=?, updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=?
  `).run(wrongManifestJson, sha256(Buffer.from(wrongManifestJson, 'utf8')), operationUid),
  /character binding invalid/u);

  const damaged = first.recovery.items[0];
  const { createLocalPackageImportService } = require('../src/remoteAssets/localPackageImportService');
  const AdmZip = require('adm-zip');
  const localZip = new AdmZip();
  const packageItems = pngs.map((bytes, ordinal) => ({
    slug: 'alan', name: '阿澜', operationUid: uid(600), ordinal, seed: ordinal,
    promptSha256: sha('a'), promptId: uid(610 + ordinal), state: 'succeeded',
    filename: `${ordinal}.png`, subfolder: `character-candidates/${uid(600)}`,
    type: 'output', bytes: bytes.length, sha256: sha256(bytes),
    localPackageName: `alan-${ordinal + 1}.png`, verifiedWidth: 256, verifiedHeight: 256,
  }));
  localZip.addFile('manifest.json', Buffer.from(JSON.stringify({
    schemaVersion: 'project-character-candidate-emergency-run.v1', runUid: uid(620),
    checkpoint: 'model.safetensors', width: 256, height: 256, sampler: 'euler',
    scheduler: 'normal', steps: 20, cfg: 6, items: packageItems,
  })));
  for (const item of packageItems) localZip.addFile(item.localPackageName, pngs[item.ordinal]);
  const localService = createLocalPackageImportService({ database, repositories, storage });
  const localInput = { dramaUid: ids.drama, characterUid: ids.character,
    extractionResultUid: ids.extraction, characterFactId: 'character-alan' };
  const imported = await localService.execute(localInput, localZip.toBuffer());
  assert.equal(imported.items.length, 2);
  assert.equal(imported.quarantineStatus, 'unapproved');
  assert.equal(imported.sourceCurrent, true);
  assert.deepEqual(await localService.execute(localInput, localZip.toBuffer()), imported);
  assert.equal((await localService.list(ids.drama, ids.character)).length, 1);
  assert.equal(database.prepare('SELECT count(*) FROM local_recovery_packages').pluck().get(), 1);
  database.prepare('UPDATE characters SET name=? WHERE uid=?').run('已变更角色', ids.character);
  const staleRemote = await service.list({ dramaUid: ids.drama, characterUid: ids.character });
  const staleLocal = await localService.list(ids.drama, ids.character);
  assert.equal(staleRemote.recoveries.every((record) => record.sourceCurrent === false), true);
  assert.equal(staleLocal[0].sourceCurrent, false);
  assert.equal(staleLocal[0].items.length, 2);
  database.prepare('UPDATE characters SET name=? WHERE uid=?').run('阿澜', ids.character);
  assert.equal((await localService.list(ids.drama, ids.character))[0].sourceCurrent, true);
  fs.writeFileSync(path.join(localRoot, ...imported.items[0].relativePath.split('/')), 'damaged');
  await assert.rejects(localService.list(ids.drama, ids.character));
  fs.writeFileSync(path.join(localRoot, ...damaged.relativePath.split('/')), Buffer.from('tampered'));
  await assert.rejects(
    service.get(operationUid),
    (error) => error?.code === 'REMOTE_ASSET_RECOVERY_DATA_INVALID',
  );
});

test('local package import records failure before retry and leaves no files after DB rollback', async (t) => {
  const { createLocalPackageImportService } = require('../src/remoteAssets/localPackageImportService');
  const database = createMigratedV2Database(t);
  const { ids, repositories } = await seedApprovedSource(database);
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-package-rollback-'));
  t.after(() => fs.rmSync(localRoot, { recursive: true, force: true }));
  const storage = new LocalStorageProvider({ projectRoot: localRoot });
  const bytes = await localPackageFixture();
  const input = {
    dramaUid: ids.drama,
    characterUid: ids.character,
    extractionResultUid: ids.extraction,
    characterFactId: 'character-alan',
  };
  database.exec(`
    CREATE TRIGGER synthetic_local_package_failure
    BEFORE INSERT ON local_recovery_packages
    BEGIN SELECT RAISE(ABORT,'synthetic local package failure'); END
  `);
  const service = createLocalPackageImportService({ repositories, storage });
  await assert.rejects(
    service.execute(input, bytes),
    (error) => error?.code === 'LOCAL_PACKAGE_IMPORT_FAILED',
  );
  assert.equal(database.prepare("SELECT state FROM local_recovery_import_attempts").pluck().get(), 'failed');
  assert.equal(database.prepare("SELECT count(*) FROM assets WHERE asset_type='local_recovery'").pluck().get(), 0);
  assert.equal(database.prepare('SELECT count(*) FROM local_recovery_packages').pluck().get(), 0);
  assert.equal(fs.readdirSync(localRoot, { recursive: true }).filter((name) => name.endsWith('.png')).length, 0);

  database.exec('DROP TRIGGER synthetic_local_package_failure');
  const imported = await service.execute(input, bytes);
  assert.equal(imported.items.length, 2);
  assert.deepEqual(database.prepare(`
    SELECT state,attempt_count FROM local_recovery_import_attempts
  `).get(), { state: 'succeeded', attempt_count: 2 });
  assert.equal(database.prepare('SELECT count(*) FROM local_recovery_packages').pluck().get(), 1);
});

test('startup recovery removes partial local imports before the same package is retried', async (t) => {
  const { createLocalPackageImportService } = require('../src/remoteAssets/localPackageImportService');
  const { readLocalRecoveryPackage } = require('../src/remoteAssets/localRecoveryPackage');
  const { createCharacterCandidateSourceResolver } = require('../src/characterCandidates/execution/sourceResolver');
  const database = createMigratedV2Database(t);
  const { ids, repositories } = await seedApprovedSource(database);
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-package-interrupted-'));
  t.after(() => fs.rmSync(localRoot, { recursive: true, force: true }));
  const storage = new LocalStorageProvider({ projectRoot: localRoot });
  const bytes = await localPackageFixture();
  const parsed = await readLocalRecoveryPackage(bytes);
  const input = {
    dramaUid: ids.drama,
    characterUid: ids.character,
    extractionResultUid: ids.extraction,
    characterFactId: 'character-alan',
  };
  const source = createCharacterCandidateSourceResolver({ repositories }).resolve(input);
  const operationUid = uid(790);
  repositories.localRecoveryPackages.reserve({
    operationUid,
    dramaUid: ids.drama,
    characterUid: ids.character,
    packageSha256: parsed.packageSha256,
    manifestSha256: parsed.sourceManifestSha256,
    remoteTaskUid: parsed.remoteTaskUid,
    source: source.source,
    sourceSha256: source.sourceSha256,
  });
  const partial = {
    storageProvider: 'local',
    logicalUri: `asset://characters/${ids.character}/local-recoveries/${operationUid}/0.png`,
    relativePath: `characters/${ids.character}/local-recoveries/${operationUid}/0.png`,
  };
  await storage.write(partial, Buffer.from('partial'));
  const service = createLocalPackageImportService({ repositories, storage });
  assert.deepEqual(await service.recoverInterrupted(), { recoveredCount: 1, failedCount: 0 });
  assert.equal(await storage.exists(partial), false);
  assert.equal(repositories.localRecoveryPackages.getAttempt(operationUid).state, 'failed');

  const imported = await service.execute(input, bytes);
  assert.equal(imported.uid, operationUid);
  assert.equal(repositories.localRecoveryPackages.getAttempt(operationUid).attemptCount, 2);
  assert.equal(imported.items.length, 2);
});

test('concurrent local package service instances create one character-bound record', async (t) => {
  const { createLocalPackageImportService } = require('../src/remoteAssets/localPackageImportService');
  const database = createMigratedV2Database(t);
  const { ids, repositories } = await seedApprovedSource(database);
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-package-concurrent-'));
  t.after(() => fs.rmSync(localRoot, { recursive: true, force: true }));
  const storage = new LocalStorageProvider({ projectRoot: localRoot });
  const bytes = await localPackageFixture();
  const input = {
    dramaUid: ids.drama,
    characterUid: ids.character,
    extractionResultUid: ids.extraction,
    characterFactId: 'character-alan',
  };
  const firstService = createLocalPackageImportService({ repositories, storage });
  const secondService = createLocalPackageImportService({ repositories, storage });
  const outcomes = await Promise.allSettled([
    firstService.execute(input, bytes),
    secondService.execute(input, bytes),
  ]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.ok(fulfilled.length >= 1);
  assert.equal(rejected.every((outcome) => (
    outcome.reason?.code === 'LOCAL_PACKAGE_IMPORT_IN_PROGRESS'
  )), true);
  assert.equal(database.prepare('SELECT count(*) FROM local_recovery_import_attempts').pluck().get(), 1);
  assert.equal(database.prepare('SELECT count(*) FROM local_recovery_packages').pluck().get(), 1);
  assert.equal(database.prepare("SELECT count(*) FROM assets WHERE asset_type='local_recovery'").pluck().get(), 2);
  const replayed = await secondService.execute(input, bytes);
  assert.equal(replayed.uid, fulfilled[0].value.uid);
});

test('startup local recovery cannot delete an active import from another service instance', async (t) => {
  const { createLocalPackageImportService } = require('../src/remoteAssets/localPackageImportService');
  const database = createMigratedV2Database(t);
  const { ids, repositories } = await seedApprovedSource(database);
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-package-active-startup-'));
  t.after(() => fs.rmSync(localRoot, { recursive: true, force: true }));
  const storage = new LocalStorageProvider({ projectRoot: localRoot });
  let announce;
  let release;
  const ready = new Promise((resolve) => { announce = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const blockedStorage = { readBounded: storage.readBounded.bind(storage), remove: storage.remove.bind(storage),
    async write(locator, bytes) { const result = await storage.write(locator, bytes); announce(locator); await gate; return result; },
  };
  const first = createLocalPackageImportService({ repositories, storage: blockedStorage });
  const other = createLocalPackageImportService({ repositories: createV2Repositories(database), storage });
  const pending = first.execute({ dramaUid: ids.drama, characterUid: ids.character,
    extractionResultUid: ids.extraction, characterFactId: 'character-alan' }, await localPackageFixture());
  const locator = await ready;
  const result = await other.recoverInterrupted();
  const survived = await storage.exists(locator);
  release();
  const imported = await pending;
  assert.deepEqual(result, { recoveredCount: 0, failedCount: 0 });
  assert.equal(survived, true);
  assert.equal(imported.items.length, 2);
});
