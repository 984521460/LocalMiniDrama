'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
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
  assert.equal(database.prepare('SELECT max(version) FROM schema_migrations').pluck().get(), 35);
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
        assert.equal(input.expectedSha256, sha256(bytes));
        const target = path.join(localRoot, ...input.localRelativePath.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
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
  const first = await service.execute(recoveryRequest);
  const second = await service.execute(recoveryRequest);
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
  fs.writeFileSync(path.join(localRoot, ...damaged.relativePath.split('/')), Buffer.from('tampered'));
  await assert.rejects(
    service.get(operationUid),
    (error) => error?.code === 'REMOTE_ASSET_RECOVERY_DATA_INVALID',
  );
});
