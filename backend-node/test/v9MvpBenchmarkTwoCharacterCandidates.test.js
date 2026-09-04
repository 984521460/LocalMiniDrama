'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const express = require('express');
const sharp = require('sharp');

const {
  createProductionCharacterCandidateExecutionRuntime,
} = require('../src/characterCandidates/execution/productionRuntime');
const {
  createProductionNarrativeExecutionRuntime,
} = require('../src/narrative/execution/productionRuntime');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { createV2Repositories } = require('../src/repositories/v2');
const characterCandidateExecutionRoutes = require('../src/routes/v2/characterCandidateExecutions');
const characterReferencePackageRoutes = require('../src/routes/v2/characterReferencePackages');
const narrativeExecutionRoutes = require('../src/routes/v2/narrativeExecutions');
const narrativeReviewRoutes = require('../src/routes/v2/narrativeReviews');
const projectZipService = require('../src/services/projectZipService');
const {
  createRainExtractionOutput,
  insertRainMainCharacters,
  setupRainBeforeClearSource,
  uidFactory,
} = require('./fixtures/narrative/rainBeforeClearSource');
const { createMigratedV2Database, uid } = require('./helpers/v2RepositoryDatabase');

const QUIET_LOG = Object.freeze({ info() {}, warn() {}, error() {} });

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function extractionRequest(current, operationUid) {
  return Object.freeze({
    schemaVersion: 'narrative-execution-request.v1',
    operationUid,
    dramaUid: current.dramaUid,
    sourceSelectionUid: current.selection.selection.uid,
    resultType: 'extraction',
    upstreamResultUid: null,
    upstreamResultHash: null,
    upstreamEnvelopeHash: null,
    upstreamApprovalRef: null,
    durationBudget: null,
    style: null,
    assetVersions: [],
  });
}

function candidateRequest(current, character, extractionResultUid, operationUid, seed) {
  return Object.freeze({
    schemaVersion: 'character-candidate-execution-request.v1',
    operationUid,
    dramaUid: current.dramaUid,
    characterUid: character.uid,
    extractionResultUid,
    characterFactId: character.factId,
    width: 256,
    height: 256,
    seed,
  });
}

async function requestJson(url, method, value) {
  const response = await fetch(url, {
    method,
    ...(value === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    }),
  });
  return Object.freeze({ response, body: await response.json() });
}

async function portraitPng(identity, ordinal) {
  const palettes = [
    ['#17324d', '#e8b88f', '#355d7a'],
    ['#3a2449', '#edc19d', '#6d4778'],
    ['#203b32', '#d9a77f', '#477563'],
    ['#4b2e26', '#f0c7a2', '#835a48'],
    ['#24354f', '#e1b28b', '#526b91'],
    ['#4a2638', '#e9bd98', '#85506a'],
    ['#23423c', '#ddb086', '#4d7e72'],
    ['#51352c', '#ecc39d', '#906552'],
    ['#2f3152', '#e4b790', '#5d6290'],
    ['#433044', '#e8b993', '#78577b'],
  ];
  const [background, skin, clothes] = palettes[ordinal];
  const hair = identity === 'character-lin-che' ? '#151a20' : '#3b241f';
  const accent = identity === 'character-lin-che' ? '#b9c8d6' : '#d7b86e';
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
    <rect width="256" height="256" fill="${background}"/>
    <circle cx="128" cy="104" r="58" fill="${skin}"/>
    <path d="M70 102Q72 36 128 35Q188 40 187 105Q162 72 83 77Z" fill="${hair}"/>
    <circle cx="107" cy="107" r="5" fill="#222"/><circle cx="149" cy="107" r="5" fill="#222"/>
    <path d="M111 136Q128 148 145 136" fill="none" stroke="#7d4137" stroke-width="4"/>
    <path d="M55 256Q61 169 128 166Q198 170 204 256Z" fill="${clothes}"/>
    <path d="M128 166L128 256" stroke="${accent}" stroke-width="8"/>
    <circle cx="218" cy="31" r="18" fill="${accent}"/>
    <text x="218" y="38" text-anchor="middle" font-size="20" font-family="sans-serif">${ordinal + 1}</text>
  </svg>`, 'utf8');
  return sharp(svg).png().toBuffer();
}

function imageProvider(calls, {
  duplicate = false,
  duplicateReference = false,
  rejectReference = false,
} = {}) {
  let duplicateBytes = null;
  let duplicateReferenceBytes = null;
  return Object.freeze({
    scope: 'configured-image',
    isAvailable() { return true; },
    async generate(command) {
      const identity = command.prompt.includes('夏弦')
        ? 'character-xia-xian' : 'character-lin-che';
      if (duplicate && duplicateBytes === null) duplicateBytes = await portraitPng(identity, 0);
      const reference = command.schemaVersion
        === 'character-reference-package-generation-command.v1';
      if (reference) {
        assert.equal(command.referenceImage.mimeType, 'image/png');
        assert.equal(
          sha256(command.referenceImage.bytes),
          command.referenceImage.contentSha256,
        );
      }
      calls[calls.length] = reference
        ? Object.freeze({
          ...command,
          referenceImage: Object.freeze({
            mimeType: command.referenceImage.mimeType,
            contentSha256: command.referenceImage.contentSha256,
            observedSha256: sha256(command.referenceImage.bytes),
          }),
        })
        : command;
      if (rejectReference && reference) throw new Error('synthetic reference provider failure');
      if (duplicateReference && reference && duplicateReferenceBytes === null) {
        duplicateReferenceBytes = await portraitPng(identity, 4);
      }
      return Object.freeze({
        provider: 'synthetic-local',
        model: 'fixture-portrait-v1',
        parameters: Object.freeze({
          adapter: 'configured-image.v1',
          size: `${command.width}x${command.height}`,
          requestedSeed: command.seed,
          ordinal: command.ordinal,
          ...(reference
            ? { referenceImageSha256: command.referenceImage.contentSha256 }
            : {}),
        }),
        bytes: duplicate
          ? Buffer.from(duplicateBytes)
          : duplicateReference && reference
            ? Buffer.from(duplicateReferenceBytes)
            : await portraitPng(identity, command.ordinal),
      });
    },
  });
}

async function fixture(t, start, providerOptions = {}) {
  const current = setupRainBeforeClearSource(t, start);
  const characters = insertRainMainCharacters(current, start + 100);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-two-character-candidates-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const imageCalls = [];
  const log = Object.freeze({ info() {}, warn() {}, error() {} });
  const narrative = createProductionNarrativeExecutionRuntime({
    database: current.database,
    log,
    dependencies: {
      createUid: uidFactory(start + 200),
      provider: Object.freeze({
        getConfigFromModelMap() { return { config: { id: 1 } }; },
        getDefaultConfig() { throw new Error('mapped fixture config must win'); },
        generateText(_database, _log, _type, _userPrompt, _systemPrompt, options) {
          assert.equal(options.scene_key, 'narrative_extraction');
          return Promise.resolve(Object.freeze({
            model: Object.freeze({ provider: 'synthetic-local', name: 'fixture-text-v1' }),
            parameters: Object.freeze({ temperature: 0, maxTokens: 8192, jsonMode: true }),
            promptVersion: options.prompt_version,
            rawResponse: JSON.stringify(createRainExtractionOutput(current.imported.blocks)),
          }));
        },
      }),
    },
  });
  const candidates = createProductionCharacterCandidateExecutionRuntime({
    database: current.database,
    localRoot: storageRoot,
    dependencies: {
      createUid: uidFactory(start + 300),
      provider: imageProvider(imageCalls, providerOptions),
      timeoutMs: 5_000,
    },
  });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/v2', narrativeExecutionRoutes(
    current.database, log, narrative.narrativeTasks,
  ));
  app.use('/api/v1/v2', narrativeReviewRoutes(
    current.database, log, { createUid: uidFactory(start + 250) },
  ));
  app.use('/api/v1/v2', characterCandidateExecutionRoutes(
    current.database, log, candidates.characterCandidates,
  ));
  app.use('/api/v1/v2', characterReferencePackageRoutes(
    log,
    candidates.characterReferencePackages,
    current.database,
  ));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/v2`;
  const extraction = await requestJson(
    `${baseUrl}/dramas/${current.dramaId}/narrative-executions`,
    'POST',
    extractionRequest(current, uid(start + 500)),
  );
  assert.equal(extraction.response.status, 200, JSON.stringify(extraction.body));
  const approved = await requestJson(
    `${baseUrl}/narrative-results/${extraction.body.data.result.uid}/reviews`,
    'POST',
    { decision: 'approve' },
  );
  assert.equal(approved.response.status, 201, JSON.stringify(approved.body));
  return Object.freeze({
    baseUrl,
    characters,
    current,
    extractionResultUid: extraction.body.data.result.uid,
    imageCalls,
    storageRoot,
  });
}

async function executeCandidates(current, character, operationUid, seed) {
  const value = candidateRequest(
    current.current, character, current.extractionResultUid, operationUid, seed,
  );
  const result = await requestJson(
    `${current.baseUrl}/dramas/${current.current.dramaId}/characters/${character.uid}/candidate-executions`,
    'POST',
    value,
  );
  return Object.freeze({ result, value });
}

async function executeReferencePackage(current, character, candidateExecution, candidateUid, operationUid) {
  const request = {
    schemaVersion: 'character-reference-package-execution-request.v1',
    operationUid,
    dramaUid: current.current.dramaUid,
    characterUid: character.uid,
    candidateExecutionUid: candidateExecution.operationUid,
    candidateUid,
    width: 256,
    height: 256,
    seed: 126,
  };
  return requestJson(
    `${current.baseUrl}/dramas/${current.current.dramaId}/characters/${character.uid}/reference-package-executions`,
    'POST',
    request,
  );
}

test('two benchmark protagonists each persist four independent portrait candidates', async (t) => {
  const current = await fixture(t, 230000);
  const first = await executeCandidates(
    current, current.characters[0], uid(230501), 42,
  );
  const second = await executeCandidates(
    current, current.characters[1], uid(230502), 84,
  );
  assert.equal(first.result.response.status, 200, JSON.stringify(first.result.body));
  assert.equal(second.result.response.status, 200, JSON.stringify(second.result.body));

  const executions = [first.result.body.data.execution, second.result.body.data.execution];
  const allItems = executions.flatMap((execution) => execution.items);
  assert.deepEqual(executions.map((execution) => execution.items.length), [4, 4]);
  assert.equal(new Set(allItems.map((item) => item.contentSha256)).size, 8);
  assert.equal(new Set(allItems.map((item) => item.assetVersionUid)).size, 8);
  assert.deepEqual(current.imageCalls.map((call) => call.ordinal), [0, 1, 2, 3, 0, 1, 2, 3]);
  assert.equal(new Set(current.imageCalls.map((call) => call.operationUid)).size, 2);

  const ownerCounts = current.current.database.prepare(`
    SELECT owner_uid AS ownerUid,count(*) AS count FROM assets
    WHERE asset_type='character_candidate' GROUP BY owner_uid ORDER BY owner_uid
  `).all();
  assert.deepEqual(ownerCounts, current.characters
    .map((character) => ({ ownerUid: character.uid, count: 4 }))
    .sort((left, right) => left.ownerUid.localeCompare(right.ownerUid)));
  assert.equal(current.current.database.prepare(
    'SELECT count(*) FROM character_candidate_batches',
  ).pluck().get(), 2);
  assert.equal(current.current.database.prepare(
    'SELECT count(*) FROM character_candidate_execution_items',
  ).pluck().get(), 8);

  const files = fs.readdirSync(current.storageRoot, { recursive: true })
    .filter((entry) => entry.endsWith('.png'));
  assert.equal(files.length, 8);
  for (let index = 0; index < files.length; index += 1) {
    const metadata = await sharp(path.join(current.storageRoot, files[index])).metadata();
    assert.equal(metadata.width, 256);
    assert.equal(metadata.height, 256);
  }

  const replayed = await executeCandidates(
    current, current.characters[0], first.value.operationUid, first.value.seed,
  );
  assert.equal(replayed.result.response.status, 200);
  assert.equal(replayed.result.body.data.execution.operationUid, first.value.operationUid);
  assert.equal(current.imageCalls.length, 8);
  const reopened = await requestJson(
    `${current.baseUrl}/character-candidate-executions/${second.value.operationUid}`,
    'GET',
  );
  assert.equal(reopened.response.status, 200);
  assert.deepEqual(reopened.body.data.execution.items, executions[1].items);
});

test('duplicate images fail the batch without candidate assets or files', async (t) => {
  const current = await fixture(t, 233000, { duplicate: true });
  const generated = await executeCandidates(
    current, current.characters[0], uid(233501), 42,
  );
  assert.equal(generated.result.response.status, 422);
  assert.equal(generated.result.body.error.code, 'CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID');
  assert.equal(current.imageCalls.length, 2);
  assert.equal(current.current.database.prepare(
    "SELECT count(*) FROM assets WHERE asset_type='character_candidate'",
  ).pluck().get(), 0);
  assert.equal(current.current.database.prepare(
    'SELECT count(*) FROM character_candidate_batches',
  ).pluck().get(), 0);
  assert.equal(fs.readdirSync(current.storageRoot, { recursive: true })
    .filter((entry) => entry.endsWith('.png')).length, 0);
});

test('second-character source drift cannot be reported as a completed pair', async (t) => {
  const current = await fixture(t, 236000);
  const first = await executeCandidates(
    current, current.characters[0], uid(236501), 42,
  );
  assert.equal(first.result.response.status, 200);
  current.current.database.prepare('UPDATE characters SET name=? WHERE uid=?')
    .run('夏弦（已变更）', current.characters[1].uid);
  const second = await executeCandidates(
    current, current.characters[1], uid(236502), 84,
  );
  assert.equal(second.result.response.status, 409);
  assert.equal(second.result.body.error.code, 'CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE');
  assert.equal(current.imageCalls.length, 4);
  assert.equal(current.current.database.prepare(
    "SELECT count(*) FROM character_candidate_executions WHERE state='succeeded'",
  ).pluck().get(), 1);
  assert.equal(current.current.database.prepare(
    'SELECT count(*) FROM character_candidate_batches',
  ).pluck().get(), 1);
  assert.equal(current.current.database.prepare(
    "SELECT count(*) FROM assets WHERE asset_type='character_candidate'",
  ).pluck().get(), 4);
});

test('a chosen candidate locks one identity and atomically creates a ten-item reference package', async (t) => {
  const current = await fixture(t, 239000);
  const generated = await executeCandidates(
    current, current.characters[0], uid(239501), 42,
  );
  assert.equal(generated.result.response.status, 200, JSON.stringify(generated.result.body));
  const candidate = generated.result.body.data.execution.items[2];
  const packaged = await executeReferencePackage(
    current,
    current.characters[0],
    generated.result.body.data.execution,
    candidate.candidateUid,
    uid(239502),
  );
  assert.equal(packaged.response.status, 200, JSON.stringify(packaged.body));
  const record = packaged.body.data.package;
  assert.equal(record.characterUid, current.characters[0].uid);
  assert.equal(record.candidateUid, candidate.candidateUid);
  assert.equal(record.items.length, 10);
  assert.equal(new Set(record.items.map((item) => item.contentSha256)).size, 10);
  assert.deepEqual(record.items.map((item) => item.ordinal), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(
    current.imageCalls.map((call) => call.schemaVersion),
    [
      ...Array(4).fill('character-candidate-generation-command.v1'),
      ...Array(10).fill('character-reference-package-generation-command.v1'),
    ],
  );
  const referenceCalls = current.imageCalls.slice(4);
  assert.equal(referenceCalls.length, 10);
  for (let index = 0; index < referenceCalls.length; index += 1) {
    assert.equal(referenceCalls[index].referenceImage.contentSha256, candidate.contentSha256);
    assert.equal(referenceCalls[index].referenceImage.observedSha256, candidate.contentSha256);
  }
  const lock = current.current.database.prepare(`
    SELECT operation,candidate_uid AS candidateUid,identity_version_uid AS identityVersionUid
    FROM character_identity_lock_events WHERE character_uid=?
  `).get(current.characters[0].uid);
  assert.deepEqual(lock, {
    operation: 'lock',
    candidateUid: candidate.candidateUid,
    identityVersionUid: record.identityVersionUid,
  });
  assert.equal(current.current.database.prepare(
    "SELECT count(*) FROM assets WHERE owner_uid=? AND asset_type='character_reference'",
  ).pluck().get(current.characters[0].uid), 10);
  assert.equal(current.current.database.prepare(
    'SELECT count(*) FROM character_reference_packages',
  ).pluck().get(), 1);
  assert.equal(current.current.database.prepare(
    'SELECT count(*) FROM character_reference_package_items',
  ).pluck().get(), 10);
  assert.equal(current.current.database.prepare(
    'SELECT state FROM character_reference_package_executions WHERE operation_uid=?',
  ).pluck().get(uid(239502)), 'succeeded');
  const callsBeforeReplay = current.imageCalls.length;
  const replayed = await executeReferencePackage(
    current,
    current.characters[0],
    generated.result.body.data.execution,
    candidate.candidateUid,
    uid(239502),
  );
  assert.equal(replayed.response.status, 200, JSON.stringify(replayed.body));
  assert.deepEqual(replayed.body.data.package, record);
  assert.equal(current.imageCalls.length, callsBeforeReplay);
  const archived = current.current.repositories.projectArchives
    .exportStructuredV21(current.current.dramaUid);
  assert.equal(archived.characterReferencePackageExecutions.length, 1);
  assert.equal(archived.characterReferencePackageExecutions[0].state, 'succeeded');
  runMigrationsAndEnsure(current.current.database);
  const exported = projectZipService.exportDrama(
    current.current.database,
    { storage: { local_path: current.storageRoot } },
    QUIET_LOG,
    current.current.dramaId,
  );
  const target = createMigratedV2Database(t);
  runMigrationsAndEnsure(target);
  const targetStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-package-archive-'));
  t.after(() => fs.rmSync(targetStorageRoot, { recursive: true, force: true }));
  const imported = projectZipService.importDrama(
    target,
    { storage: { local_path: targetStorageRoot } },
    QUIET_LOG,
    exported.buffer,
  );
  assert.equal(
    imported.title,
    current.current.database.prepare('SELECT title FROM dramas WHERE id=?')
      .pluck().get(current.current.dramaId),
  );
  const restored = createV2Repositories(target)
    .characterReferencePackageExecutions.get(uid(239502));
  assert.equal(restored.state, 'succeeded');
  assert.equal(restored.packageUid, uid(239502));
  assert.equal(
    target.prepare('SELECT count(*) FROM character_reference_package_items').pluck().get(),
    10,
  );
  current.current.database.pragma('recursive_triggers = OFF');
  assert.throws(() => current.current.database.prepare(`
    INSERT OR REPLACE INTO character_reference_package_executions
    SELECT * FROM character_reference_package_executions WHERE operation_uid=?
  `).run(uid(239502)));
  assert.equal(current.current.database.prepare(
    'SELECT count(*) FROM character_reference_package_executions',
  ).pluck().get(), 1);
  assert.equal(fs.readdirSync(current.storageRoot, { recursive: true })
    .filter((entry) => entry.endsWith('.png')).length, 14);
});

test('duplicate reference output cleans generated files and leaves the character unlocked', async (t) => {
  const current = await fixture(t, 242000, { duplicateReference: true });
  const generated = await executeCandidates(
    current, current.characters[0], uid(242501), 42,
  );
  assert.equal(generated.result.response.status, 200);
  const candidate = generated.result.body.data.execution.items[0];
  const packaged = await executeReferencePackage(
    current,
    current.characters[0],
    generated.result.body.data.execution,
    candidate.candidateUid,
    uid(242502),
  );
  assert.equal(packaged.response.status, 422, JSON.stringify(packaged.body));
  assert.equal(packaged.body.error.code, 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID');
  assert.equal(current.current.database.prepare(
    'SELECT count(*) FROM character_identity_lock_events',
  ).pluck().get(), 0);
  assert.equal(current.current.database.prepare(
    'SELECT count(*) FROM character_reference_packages',
  ).pluck().get(), 0);
  assert.equal(current.current.database.prepare(
    "SELECT count(*) FROM assets WHERE asset_type='character_reference'",
  ).pluck().get(), 0);
  assert.equal(current.current.database.prepare(
    'SELECT state FROM character_reference_package_executions WHERE operation_uid=?',
  ).pluck().get(uid(242502)), 'failed');
  assert.equal(fs.readdirSync(current.storageRoot, { recursive: true })
    .filter((entry) => entry.endsWith('.png')).length, 4);
});

test('uncertain reference submission is durable and never automatically replayed', async (t) => {
  const current = await fixture(t, 245000, { rejectReference: true });
  const generated = await executeCandidates(
    current, current.characters[0], uid(245501), 42,
  );
  assert.equal(generated.result.response.status, 200);
  const candidate = generated.result.body.data.execution.items[0];
  const first = await executeReferencePackage(
    current,
    current.characters[0],
    generated.result.body.data.execution,
    candidate.candidateUid,
    uid(245502),
  );
  assert.equal(first.response.status, 409, JSON.stringify(first.body));
  assert.equal(
    first.body.error.code,
    'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN',
  );
  assert.equal(current.current.database.prepare(
    'SELECT state FROM character_reference_package_executions WHERE operation_uid=?',
  ).pluck().get(uid(245502)), 'submission_unknown');
  const callsAfterFirst = current.imageCalls.length;
  const replay = await executeReferencePackage(
    current,
    current.characters[0],
    generated.result.body.data.execution,
    candidate.candidateUid,
    uid(245502),
  );
  assert.equal(replay.response.status, 409);
  assert.equal(
    replay.body.error.code,
    'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN',
  );
  assert.equal(current.imageCalls.length, callsAfterFirst);
  assert.equal(current.current.database.prepare(
    'SELECT count(*) FROM character_reference_packages',
  ).pluck().get(), 0);
});

test('startup recovery seals an interrupted reference reservation as unknown without replay', async (t) => {
  const current = await fixture(t, 248000);
  const generated = await executeCandidates(
    current, current.characters[0], uid(248501), 42,
  );
  assert.equal(generated.result.response.status, 200, JSON.stringify(generated.result.body));
  const candidate = generated.result.body.data.execution.items[0];
  const request = {
    schemaVersion: 'character-reference-package-execution-request.v1',
    operationUid: uid(248502),
    dramaUid: current.current.dramaUid,
    characterUid: current.characters[0].uid,
    candidateExecutionUid: generated.result.body.data.execution.operationUid,
    candidateUid: candidate.candidateUid,
    width: 256,
    height: 256,
    seed: 126,
  };
  const repositories = current.current.repositories;
  const reservation = repositories.characterReferencePackageExecutions.reserve({
    request,
    candidateExecution: repositories.characterCandidateExecutions.get(
      generated.result.body.data.execution.operationUid,
    ),
    candidate: repositories.characterCandidates.getBatch(
      generated.result.body.data.execution.operationUid,
    ).candidates[0],
  });
  assert.equal(reservation.created, true);
  assert.equal(reservation.execution.state, 'reserved');
  const callsBeforeRecovery = current.imageCalls.length;
  assert.deepEqual(
    repositories.characterReferencePackageExecutions.recoverInterrupted(),
    { recoveredCount: 1 },
  );
  const recovered = repositories.characterReferencePackageExecutions.get(request.operationUid);
  assert.equal(recovered.state, 'submission_unknown');
  assert.equal(
    recovered.errorCode,
    'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN',
  );
  assert.equal(current.imageCalls.length, callsBeforeRecovery);
  assert.deepEqual(
    repositories.characterReferencePackageExecutions.recoverInterrupted(),
    { recoveredCount: 0 },
  );
});
