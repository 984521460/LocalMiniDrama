'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const AdmZip = require('adm-zip');
const Ajv2020 = require('ajv/dist/2020');
const sharp = require('sharp');

const { LocalStorageProvider } = require('../src/adapters/v2/storage/localStorageProvider');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { readProjectArchive } = require('../src/adapters/v2/zip/archiveReader');
const { parseProjectManifestV21 } = require('../src/adapters/v2/zip/manifestV21');
const {
  assertProjectArchiveV21CharacterCandidateExecutionStructured,
} = require('../src/adapters/v2/zip/projectArchiveV21CharacterCandidateExecutionEvidence');
const {
  createConfiguredCharacterCandidateImageProvider,
  createCharacterCandidateExecutionService,
  isCharacterCandidateExecutionError,
} = require('../src/characterCandidates/execution');
const {
  createBoundedImageSourceReader,
} = require('../src/characterCandidates/execution/boundedImageSource');
const {
  parseCharacterCandidateSource,
} = require('../src/characterCandidates/execution/source');
const { createNarrativeExecutionService } = require('../src/narrative/execution');
const { createNarrativeReviewService } = require('../src/narrative/reviews');
const { createV2Repositories } = require('../src/repositories/v2');
const projectZipService = require('../src/services/projectZipService');
const { createMigratedV2Database, insertDrama, uid } = require('./helpers/v2RepositoryDatabase');

const baseManifestSchema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../schemas/v2/project-archive-manifest.schema.json'),
  'utf8',
));
const manifestV21Schema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../schemas/v2/project-archive-manifest-v2.1.schema.json'),
  'utf8',
));

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function seedApprovedCharacterSource(database) {
  const ids = Object.freeze({
    drama: uid(31000),
    character: uid(31001),
    document: uid(31002),
    block: uid(31003),
    selection: uid(31004),
    extractionOperation: uid(31005),
  });
  const text = '阿澜是一名二十岁的黑发剑客，身穿青色短袍。';
  const textHash = sha256(text);
  insertDrama(database, ids.drama, 'Character candidate execution fixture');
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
      VALUES (?,?,'txt','character.txt','utf-8',?,?,1)
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
      factId: 'character-alan',
      name: '阿澜',
      description: '二十岁的黑发剑客，身穿青色短袍。',
      evidence: [{ blockUid: ids.block, startOffset: 0, endOffset: Array.from(text).length, quote: text }],
    }],
    scenes: [], props: [], relationships: [], events: [], dialogue: [],
  });
  const narrative = createNarrativeExecutionService({
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
  });
  return narrative.execute({
    schemaVersion: 'narrative-execution-request.v1',
    operationUid: ids.extractionOperation,
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
  }).then(({ result }) => {
    createNarrativeReviewService({ repositories }).reviewResult({
      resultUid: result.uid,
      decision: 'approve',
      comment: 'synthetic approval',
    });
    return Object.freeze({ ids: { ...ids, extraction: result.uid }, repositories });
  });
}

function executionRequest(ids, operationUid = uid(31010)) {
  return {
    schemaVersion: 'character-candidate-execution-request.v1',
    operationUid,
    dramaUid: ids.drama,
    characterUid: ids.character,
    extractionResultUid: ids.extraction,
    characterFactId: 'character-alan',
    width: 256,
    height: 256,
    seed: 42,
  };
}

test('candidate source rejects unpaired UTF-16 surrogates without rejecting valid emoji', () => {
  const source = {
    schemaVersion: 'character-candidate-source.v1',
    dramaUid: uid(31900),
    characterUid: uid(31901),
    characterName: '阿澜😀',
    characterDescription: null,
    characterPersonality: null,
    characterAppearance: null,
    sourceSelectionUid: uid(31902),
    extractionResultUid: uid(31903),
    extractionResultHash: 'a'.repeat(64),
    extractionEnvelopeHash: 'b'.repeat(64),
    extractionApprovalRef: `review:v1:${uid(31904)}`,
    characterFactId: 'character-alan',
    characterFactName: '阿澜',
    characterFactDescription: '合法😀文本',
  };

  assert.equal(parseCharacterCandidateSource(source).characterName, '阿澜😀');
  assert.throws(
    () => parseCharacterCandidateSource({ ...source, characterFactDescription: '\ud800' }),
    /Character candidate source is invalid/u,
  );
  assert.throws(
    () => parseCharacterCandidateSource({ ...source, characterFactDescription: '\udc00' }),
    /Character candidate source is invalid/u,
  );
});

async function png(ordinal) {
  return sharp({
    create: {
      width: 256,
      height: 256,
      channels: 3,
      background: { r: 40 + ordinal * 30, g: 80, b: 120 },
    },
  }).png().toBuffer();
}

function syntheticProvider(calls, failureOrdinal = null) {
  return Object.freeze({
    scope: 'configured-image',
    isAvailable: () => true,
    async generate(command) {
      calls.push(command);
      if (command.ordinal === failureOrdinal) throw new Error('synthetic provider failure');
      return Object.freeze({
        provider: 'synthetic',
        model: 'fixture-image-model',
        parameters: Object.freeze({
          adapter: 'configured-image.v1',
          size: `${command.width}x${command.height}`,
          requestedSeed: command.seed,
          ordinal: command.ordinal,
        }),
        bytes: await png(command.ordinal),
      });
    },
  });
}

function tempStorage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'character-candidate-execution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, storage: new LocalStorageProvider({ projectRoot: root }) };
}

test('production candidate execution makes four independent calls and seals one durable batch', async (t) => {
  const database = createMigratedV2Database(t);
  const { ids, repositories } = await seedApprovedCharacterSource(database);
  const { root, storage } = tempStorage(t);
  const calls = [];
  const service = createCharacterCandidateExecutionService({
    repositories,
    provider: syntheticProvider(calls),
    storage,
  });
  const request = executionRequest(ids);
  const first = await service.execute(request);
  const second = await service.execute(request);

  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((item) => item.ordinal), [0, 1, 2, 3]);
  assert.equal(new Set(calls.map((item) => item.seed)).size, 4);
  for (let index = 0; index < calls.length; index += 1) {
    assert.match(calls[index].prompt, new RegExp(`Variation seed request: ${calls[index].seed}\\.`));
  }
  assert.equal(first.execution.state, 'succeeded');
  assert.equal(first.execution.items.length, 4);
  assert.equal(first.batch.candidates.length, 4);
  assert.equal(second.execution.operationUid, first.execution.operationUid);
  assert.equal(database.prepare('SELECT count(*) FROM character_candidate_executions').pluck().get(), 1);
  assert.equal(database.prepare('SELECT count(*) FROM character_candidate_execution_items').pluck().get(), 4);
  assert.equal(database.prepare('SELECT count(*) FROM assets WHERE asset_type=?').pluck().get('character_candidate'), 4);
  database.pragma('recursive_triggers = OFF');
  assert.throws(
    () => database.prepare(`
      INSERT OR REPLACE INTO character_candidate_executions
      SELECT * FROM character_candidate_executions WHERE operation_uid=?
    `).run(request.operationUid),
    /cannot be replaced/u,
  );
  assert.equal(database.prepare('SELECT count(*) FROM character_candidate_executions').pluck().get(), 1);
  database.pragma('recursive_triggers = ON');
  runMigrationsAndEnsure(database);
  const exported = projectZipService.exportDrama(
    database,
    { storage: { local_path: root } },
    Object.freeze({ info() {}, error() {} }),
    1,
  );
  const archive = readProjectArchive(exported.buffer);
  assert.equal(archive.manifestData.structuredRecords.characterCandidateExecutions.length, 1);
  assert.equal(archive.manifestData.structuredRecords.characterCandidateExecutionItems.length, 4);
  assert.equal(archive.files.size, 4);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(baseManifestSchema);
  const validateManifest = ajv.compile(manifestV21Schema);
  assert.equal(validateManifest(archive.manifestData), true, JSON.stringify(validateManifest.errors));
  const schemaExtra = structuredClone(archive.manifestData);
  schemaExtra.structuredRecords.characterCandidateExecutionItems[0].unexpected = true;
  assert.equal(validateManifest(schemaExtra), false);
  const schemaPartial = structuredClone(archive.manifestData);
  delete schemaPartial.structuredRecords.characterCandidateExecutionItems;
  assert.equal(validateManifest(schemaPartial), false);
  const schemaStateDrift = structuredClone(archive.manifestData);
  schemaStateDrift.structuredRecords.characterCandidateExecutions[0].state = 'failed';
  assert.equal(validateManifest(schemaStateDrift), false);
  const missingItem = structuredClone(archive.manifestData);
  missingItem.structuredRecords.characterCandidateExecutionItems.pop();
  assert.throws(
    () => parseProjectManifestV21(missingItem),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
  const reorderedItems = structuredClone(archive.manifestData);
  [
    reorderedItems.structuredRecords.characterCandidateExecutionItems[0],
    reorderedItems.structuredRecords.characterCandidateExecutionItems[1],
  ] = [
    reorderedItems.structuredRecords.characterCandidateExecutionItems[1],
    reorderedItems.structuredRecords.characterCandidateExecutionItems[0],
  ];
  assert.throws(
    () => parseProjectManifestV21(reorderedItems),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
  const resignedSource = structuredClone(archive.manifestData);
  const resignedExecution = resignedSource.structuredRecords.characterCandidateExecutions[0];
  const sourceEvidence = JSON.parse(resignedExecution.source_json);
  sourceEvidence.characterDescription = 'coordinated synthetic source drift';
  resignedExecution.source_json = JSON.stringify(sourceEvidence);
  resignedExecution.source_sha256 = sha256(resignedExecution.source_json);
  assert.throws(
    () => parseProjectManifestV21(resignedSource),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );

  const rejectedDatabase = createMigratedV2Database(t);
  runMigrationsAndEnsure(rejectedDatabase);
  const rejectedStorage = tempStorage(t).root;
  const tamperedZip = new AdmZip(exported.buffer);
  const tamperedManifest = JSON.parse(tamperedZip.readAsText('v2/manifest.json'));
  tamperedManifest.structuredRecords.characterCandidateExecutionItems[0].byte_length += 1;
  tamperedZip.updateFile(
    'v2/manifest.json',
    Buffer.from(JSON.stringify(tamperedManifest, null, 2), 'utf8'),
  );
  assert.throws(
    () => projectZipService.importDrama(
      rejectedDatabase,
      { storage: { local_path: rejectedStorage } },
      Object.freeze({ info() {}, error() {} }),
      tamperedZip.toBuffer(),
    ),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
  assert.equal(rejectedDatabase.prepare('SELECT count(*) FROM dramas').pluck().get(), 0);
  assert.equal(rejectedDatabase.prepare(
    'SELECT count(*) FROM character_candidate_executions',
  ).pluck().get(), 0);
  assert.deepEqual(fs.readdirSync(rejectedStorage), []);

  database.exec('DROP TRIGGER v2_character_candidate_executions_validate_update');
  database.prepare(`
    UPDATE character_candidate_executions SET profile_sha256=? WHERE operation_uid=?
  `).run('f'.repeat(64), request.operationUid);
  assert.throws(
    () => projectZipService.exportDrama(
      database,
      { storage: { local_path: root } },
      Object.freeze({ info() {}, error() {} }),
      1,
    ),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );

  const restoredDatabase = createMigratedV2Database(t);
  runMigrationsAndEnsure(restoredDatabase);
  const restoredStorage = tempStorage(t).root;
  const imported = projectZipService.importDrama(
    restoredDatabase,
    { storage: { local_path: restoredStorage } },
    Object.freeze({ info() {}, error() {} }),
    exported.buffer,
  );
  assert.equal(imported.title, 'Character candidate execution fixture');
  const restored = createV2Repositories(restoredDatabase)
    .characterCandidateExecutions.get(request.operationUid);
  assert.equal(restored.state, 'succeeded');
  assert.equal(restored.items.length, 4);
  for (let index = 0; index < restored.items.length; index += 1) {
    const item = restored.items[index];
    const bytes = fs.readFileSync(path.join(restoredStorage, ...item.relativePath.split('/')));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.contentSha256);
    assert.equal(bytes.length, item.byteLength);
  }
  const reexported = projectZipService.exportDrama(
    restoredDatabase,
    { storage: { local_path: restoredStorage } },
    Object.freeze({ info() {}, error() {} }),
    imported.drama_id,
  );
  const rearchive = readProjectArchive(reexported.buffer);
  assert.deepEqual(
    rearchive.manifestData.structuredRecords.characterCandidateExecutions,
    archive.manifestData.structuredRecords.characterCandidateExecutions,
  );
  assert.deepEqual(
    rearchive.manifestData.structuredRecords.characterCandidateExecutionItems,
    archive.manifestData.structuredRecords.characterCandidateExecutionItems,
  );
  for (let ordinal = 0; ordinal < 4; ordinal += 1) {
    assert.equal(fs.existsSync(path.join(
      root, 'characters', ids.character, 'candidate-batches', request.operationUid, `${ordinal}.png`,
    )), true);
  }
});

test('structured execution evidence indexes high-cardinality narrative sources once', async (t) => {
  const database = createMigratedV2Database(t);
  const { ids, repositories } = await seedApprovedCharacterSource(database);
  const request = executionRequest(ids, uid(31990));
  const {
    characterCandidateExecutionRequestSha256,
    canonicalCharacterCandidateExecutionRequest,
  } = require('../src/characterCandidates/execution/request');
  const {
    canonicalCharacterCandidateSource,
    characterCandidateSourceSha256,
  } = require('../src/characterCandidates/execution/source');
  const { createCharacterCandidateSourceResolver } = require(
    '../src/characterCandidates/execution/sourceResolver'
  );
  const profile = require('../src/characterCandidates/execution/profile');
  const resolved = createCharacterCandidateSourceResolver({ repositories }).resolve(request);
  repositories.characterCandidateExecutions.reserve({
    request,
    requestSha256: characterCandidateExecutionRequestSha256(request),
    source: resolved.source,
    sourceSha256: resolved.sourceSha256,
    profileJson: profile.PROFILE_JSON,
    profileSha256: profile.PROFILE_SHA256,
    manifestJson: profile.MANIFEST_JSON,
    manifestSha256: profile.MANIFEST_SHA256,
  });
  runMigrationsAndEnsure(database);
  const { root } = tempStorage(t);
  const archive = readProjectArchive(projectZipService.exportDrama(
    database,
    { storage: { local_path: root } },
    Object.freeze({ info() {}, error() {} }),
    1,
  ).buffer);
  const records = structuredClone(archive.manifestData.structuredRecords);
  const baseExecution = records.characterCandidateExecutions[0];
  const baseResult = records.narrativeResults.find(
    (row) => row.uid === baseExecution.extraction_result_uid,
  );
  const baseReview = records.narrativeReviewEvents.find(
    (row) => row.uid === baseExecution.extraction_review_uid,
  );
  const count = 256;
  const targetResultUid = 'f0000000-0000-4000-8000-000000000000';
  const targetReviewUid = 'e0000000-0000-4000-8000-000000000000';
  const orderedUid = (prefix, index) => (
    `${prefix}0000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  );
  const narrativeResults = [];
  const narrativeReviews = [];
  for (let index = 0; index < count - 1; index += 1) {
    const resultUid = orderedUid('1', index);
    const reviewUid = orderedUid('2', index);
    const result = structuredClone(baseResult);
    result.uid = resultUid;
    result.current_review_uid = reviewUid;
    const review = structuredClone(baseReview);
    review.uid = reviewUid;
    review.result_uid = resultUid;
    narrativeResults.push(result);
    narrativeReviews.push(review);
  }
  const targetResult = structuredClone(baseResult);
  targetResult.uid = targetResultUid;
  targetResult.current_review_uid = targetReviewUid;
  const targetResultJson = targetResult.result_json;
  let targetResultJsonReads = 0;
  Object.defineProperty(targetResult, 'result_json', {
    enumerable: true,
    configurable: true,
    get() {
      targetResultJsonReads += 1;
      return targetResultJson;
    },
  });
  narrativeResults.push(targetResult);
  const targetReview = structuredClone(baseReview);
  targetReview.uid = targetReviewUid;
  targetReview.result_uid = targetResultUid;
  narrativeReviews.push(targetReview);
  narrativeResults.sort((left, right) => left.uid.localeCompare(right.uid));
  narrativeReviews.sort((left, right) => left.uid.localeCompare(right.uid));

  const source = JSON.parse(baseExecution.source_json);
  source.extractionResultUid = targetResultUid;
  source.extractionApprovalRef = `review:v1:${targetReviewUid}`;
  const sourceJson = canonicalCharacterCandidateSource(source);
  const sourceSha256 = characterCandidateSourceSha256(source);
  const executions = [];
  for (let index = 0; index < count; index += 1) {
    const operationUid = orderedUid('3', index);
    const executionRequestValue = JSON.parse(baseExecution.request_json);
    executionRequestValue.operationUid = operationUid;
    executionRequestValue.extractionResultUid = targetResultUid;
    executions.push({
      ...baseExecution,
      operation_uid: operationUid,
      extraction_result_uid: targetResultUid,
      extraction_review_uid: targetReviewUid,
      request_json: canonicalCharacterCandidateExecutionRequest(executionRequestValue),
      request_sha256: characterCandidateExecutionRequestSha256(executionRequestValue),
      source_json: sourceJson,
      source_sha256: sourceSha256,
      state: 'reserved',
      batch_uid: null,
      error_code: null,
    });
  }
  const reads = { results: 0, reviews: 0 };
  const countedRows = (rows, key) => new Proxy(rows, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(property)) {
        reads[key] += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  records.characterCandidateExecutions = executions;
  records.characterCandidateExecutionItems = [];
  records.narrativeResults = countedRows(narrativeResults, 'results');
  records.narrativeReviewEvents = countedRows(narrativeReviews, 'reviews');
  assert.doesNotThrow(() => assertProjectArchiveV21CharacterCandidateExecutionStructured(
    records,
    () => { throw new TypeError('synthetic archive invalid'); },
  ));
  assert.ok(reads.results <= count * 2 + 1, `narrative result reads: ${reads.results}`);
  assert.ok(reads.reviews <= count * 2 + 1, `narrative review reads: ${reads.reviews}`);
  assert.equal(targetResultJsonReads, 1);
});

test('provider uncertainty is persisted and installed partial media is removed', async (t) => {
  const database = createMigratedV2Database(t);
  const { ids, repositories } = await seedApprovedCharacterSource(database);
  const { root, storage } = tempStorage(t);
  const calls = [];
  const operationUid = uid(31011);
  const service = createCharacterCandidateExecutionService({
    repositories,
    provider: syntheticProvider(calls, 1),
    storage,
  });
  await assert.rejects(service.execute(executionRequest(ids, operationUid)), (error) => (
    isCharacterCandidateExecutionError(error)
      && error.code === 'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN'
  ));
  assert.equal(calls.length, 2);
  assert.equal(database.prepare('SELECT state FROM character_candidate_executions').pluck().get(), 'submission_unknown');
  assert.equal(database.prepare('SELECT count(*) FROM character_candidate_execution_items').pluck().get(), 0);
  assert.equal(database.prepare('SELECT count(*) FROM assets WHERE asset_type=?').pluck().get('character_candidate'), 0);
  assert.equal(fs.readdirSync(root, { recursive: true }).filter((entry) => entry.endsWith('.png')).length, 0);

  runMigrationsAndEnsure(database);
  const exported = projectZipService.exportDrama(
    database,
    { storage: { local_path: root } },
    Object.freeze({ info() {}, error() {} }),
    1,
  );
  const archive = readProjectArchive(exported.buffer);
  assert.equal(archive.files.size, 0);
  assert.equal(archive.manifestData.structuredRecords.characterCandidateExecutions.length, 1);
  assert.equal(
    archive.manifestData.structuredRecords.characterCandidateExecutions[0].state,
    'submission_unknown',
  );
  assert.deepEqual(
    archive.manifestData.structuredRecords.characterCandidateExecutionItems,
    [],
  );
  const target = createMigratedV2Database(t);
  runMigrationsAndEnsure(target);
  const targetRoot = tempStorage(t).root;
  projectZipService.importDrama(
    target,
    { storage: { local_path: targetRoot } },
    Object.freeze({ info() {}, error() {} }),
    exported.buffer,
  );
  assert.equal(
    createV2Repositories(target).characterCandidateExecutions.get(operationUid).state,
    'submission_unknown',
  );
  assert.deepEqual(fs.readdirSync(targetRoot), []);
});

test('unexpected source read failure after a Provider call becomes submission_unknown', async (t) => {
  const database = createMigratedV2Database(t);
  const seeded = await seedApprovedCharacterSource(database);
  const { root, storage } = tempStorage(t);
  let sourceReads = 0;
  const executionRepository = seeded.repositories.characterCandidateExecutions;
  const injectedRepository = Object.freeze({
    ...executionRepository,
    getCharacterSource(characterUid) {
      sourceReads += 1;
      if (sourceReads === 3) throw new Error('synthetic storage outage');
      return executionRepository.getCharacterSource(characterUid);
    },
  });
  const repositories = Object.create(seeded.repositories);
  Object.defineProperty(repositories, 'characterCandidateExecutions', {
    enumerable: true,
    value: injectedRepository,
  });
  const calls = [];
  const service = createCharacterCandidateExecutionService({
    repositories,
    provider: syntheticProvider(calls),
    storage,
  });
  await assert.rejects(service.execute(executionRequest(seeded.ids, uid(31014))), (error) => (
    isCharacterCandidateExecutionError(error)
      && error.code === 'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN'
  ));
  assert.equal(calls.length, 1);
  assert.equal(database.prepare('SELECT state FROM character_candidate_executions').pluck().get(), 'submission_unknown');
  assert.equal(fs.readdirSync(root, { recursive: true }).filter((entry) => entry.endsWith('.png')).length, 0);
});

test('configured-image adapter stays local until generate and binds the requested seed', async (t) => {
  const database = createMigratedV2Database(t);
  const now = '2026-09-01T00:00:00.000Z';
  database.prepare(`
    INSERT INTO ai_service_configs
      (service_type,provider,name,base_url,api_key,model,priority,is_default,is_active,created_at,updated_at)
    VALUES ('image','synthetic-image','fixture','https://image.example.invalid',
      'synthetic-image-key','["fixture-image-model"]',100,1,1,?,?)
  `).run(now, now);
  const calls = [];
  const imageBytes = await png(0);
  const provider = createConfiguredCharacterCandidateImageProvider({
    database,
    dependencies: {
      getDefaultImageConfig() {
        return Object.freeze({
          provider: 'synthetic-image',
          model: Object.freeze(['fixture-image-model']),
          default_model: 'fixture-image-model',
          is_active: 1,
        });
      },
      async callImageApi(_database, _log, options) {
        calls[calls.length] = options;
        return Object.freeze({ image_url: 'data:image/png;base64,synthetic' });
      },
      async readImageSource(value) {
        assert.equal(value, 'data:image/png;base64,synthetic');
        return Object.freeze({ bytes: imageBytes });
      },
    },
  });
  assert.equal(provider.isAvailable(), true);
  assert.equal(calls.length, 0);
  const output = await provider.generate({
    schemaVersion: 'character-candidate-generation-command.v1',
    operationUid: uid(31015),
    ordinal: 2,
    prompt: 'synthetic approved portrait prompt',
    promptSha256: sha256('synthetic approved portrait prompt'),
    width: 256,
    height: 256,
    seed: 123456,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].seed, 123456);
  assert.equal(calls[0].size, '256x256');
  assert.equal(output.parameters.requestedSeed, 123456);
  assert.equal(output.parameters.ordinal, 2);
  assert.deepEqual(output.bytes, imageBytes);
});

test('bounded image source enforces bytes and rejects response Proxy without traps', async () => {
  const boundedData = createBoundedImageSourceReader({ maximumBytes: 4 });
  const data = await boundedData('data:image/png;base64,AQIDBA==');
  assert.deepEqual(data.bytes, Buffer.from([1, 2, 3, 4]));
  await assert.rejects(boundedData('data:image/png;base64,AQIDBAU='), /local bound/u);

  let responseTrapReads = 0;
  const requestImpl = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.setTimeout = () => {};
    request.end = () => {
      const response = new Proxy(new EventEmitter(), {
        get(target, key, receiver) {
          responseTrapReads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      callback(response);
    };
    return request;
  };
  const hostile = createBoundedImageSourceReader({ maximumBytes: 4, requestImpl });
  await assert.rejects(hostile('https://image.example.invalid/candidate.png'), /invalid/u);
  assert.equal(responseTrapReads, 0);
});

test('completed execution fails closed after current character source drift', async (t) => {
  const database = createMigratedV2Database(t);
  const { ids, repositories } = await seedApprovedCharacterSource(database);
  const { storage } = tempStorage(t);
  const service = createCharacterCandidateExecutionService({
    repositories,
    provider: syntheticProvider([]),
    storage,
  });
  const request = executionRequest(ids, uid(31012));
  await service.execute(request);
  database.prepare('UPDATE characters SET appearance=? WHERE uid=?').run('漂移外观', ids.character);
  await assert.rejects(service.get(request.operationUid), (error) => (
    isCharacterCandidateExecutionError(error)
      && error.code === 'CHARACTER_CANDIDATE_EXECUTION_DATA_INVALID'
  ));
});

test('completed execution revalidates installed media bytes on every read', async (t) => {
  const database = createMigratedV2Database(t);
  const { ids, repositories } = await seedApprovedCharacterSource(database);
  const { root, storage } = tempStorage(t);
  const service = createCharacterCandidateExecutionService({
    repositories,
    provider: syntheticProvider([]),
    storage,
  });
  const request = executionRequest(ids, uid(31016));
  await service.execute(request);
  const filename = path.join(
    root, 'characters', ids.character, 'candidate-batches', request.operationUid, '0.png',
  );
  const original = fs.readFileSync(filename);
  const changed = Buffer.from(original);
  changed[changed.length - 1] ^= 1;
  fs.writeFileSync(filename, changed);
  await assert.rejects(service.get(request.operationUid), (error) => (
    isCharacterCandidateExecutionError(error)
      && error.code === 'CHARACTER_CANDIDATE_EXECUTION_DATA_INVALID'
  ));
});

test('completed execution fails closed after persisted prompt hash drift', async (t) => {
  const database = createMigratedV2Database(t);
  const { ids, repositories } = await seedApprovedCharacterSource(database);
  const { storage } = tempStorage(t);
  const service = createCharacterCandidateExecutionService({
    repositories,
    provider: syntheticProvider([]),
    storage,
  });
  const request = executionRequest(ids, uid(31017));
  await service.execute(request);
  database.exec('DROP TRIGGER v2_character_candidate_execution_items_immutable_update');
  database.prepare(`
    UPDATE character_candidate_execution_items SET prompt_sha256=?
    WHERE operation_uid=? AND ordinal=0
  `).run('f'.repeat(64), request.operationUid);
  await assert.rejects(service.get(request.operationUid), (error) => (
    isCharacterCandidateExecutionError(error)
      && error.code === 'CHARACTER_CANDIDATE_EXECUTION_DATA_INVALID'
  ));
});

test('startup recovery converts reserved candidate operations to submission_unknown', async (t) => {
  const database = createMigratedV2Database(t);
  const { ids, repositories } = await seedApprovedCharacterSource(database);
  const request = executionRequest(ids, uid(31013));
  const source = require('../src/characterCandidates/execution/sourceResolver')
    .createCharacterCandidateSourceResolver({ repositories }).resolve(request);
  const profile = require('../src/characterCandidates/execution/profile');
  repositories.characterCandidateExecutions.reserve({
    request,
    requestSha256: require('../src/characterCandidates/execution/request')
      .characterCandidateExecutionRequestSha256(request),
    source: source.source,
    sourceSha256: source.sourceSha256,
    profileJson: profile.PROFILE_JSON,
    profileSha256: profile.PROFILE_SHA256,
    manifestJson: profile.MANIFEST_JSON,
    manifestSha256: profile.MANIFEST_SHA256,
  });
  const { root } = tempStorage(t);
  runMigrationsAndEnsure(database);
  const reservedArchive = readProjectArchive(projectZipService.exportDrama(
    database,
    { storage: { local_path: root } },
    Object.freeze({ info() {}, error() {} }),
    1,
  ).buffer);
  assert.equal(
    reservedArchive.manifestData.structuredRecords.characterCandidateExecutions[0].state,
    'reserved',
  );
  assert.deepEqual(
    reservedArchive.manifestData.structuredRecords.characterCandidateExecutionItems,
    [],
  );
  assert.deepEqual(
    repositories.characterCandidateExecutions.recoverInterrupted(),
    { recoveredCount: 1 },
  );
  assert.equal(repositories.characterCandidateExecutions.get(request.operationUid).state, 'submission_unknown');

  const failedRequest = executionRequest(ids, uid(31018));
  const failedSource = require('../src/characterCandidates/execution/sourceResolver')
    .createCharacterCandidateSourceResolver({ repositories }).resolve(failedRequest);
  repositories.characterCandidateExecutions.reserve({
    request: failedRequest,
    requestSha256: require('../src/characterCandidates/execution/request')
      .characterCandidateExecutionRequestSha256(failedRequest),
    source: failedSource.source,
    sourceSha256: failedSource.sourceSha256,
    profileJson: profile.PROFILE_JSON,
    profileSha256: profile.PROFILE_SHA256,
    manifestJson: profile.MANIFEST_JSON,
    manifestSha256: profile.MANIFEST_SHA256,
  });
  repositories.characterCandidateExecutions.fail(
    failedRequest.operationUid,
    'CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID',
  );
  const terminalArchive = readProjectArchive(projectZipService.exportDrama(
    database,
    { storage: { local_path: root } },
    Object.freeze({ info() {}, error() {} }),
    1,
  ).buffer);
  assert.deepEqual(
    terminalArchive.manifestData.structuredRecords.characterCandidateExecutions
      .map((row) => row.state).sort(),
    ['failed', 'submission_unknown'],
  );
  assert.deepEqual(
    terminalArchive.manifestData.structuredRecords.characterCandidateExecutionItems,
    [],
  );
});
