'use strict';

const assert = require('node:assert/strict');
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
const characterCandidateExecutionRoutes = require('../src/routes/v2/characterCandidateExecutions');
const narrativeExecutionRoutes = require('../src/routes/v2/narrativeExecutions');
const narrativeReviewRoutes = require('../src/routes/v2/narrativeReviews');
const {
  createRainExtractionOutput,
  insertRainMainCharacters,
  setupRainBeforeClearSource,
  uidFactory,
} = require('./fixtures/narrative/rainBeforeClearSource');
const { uid } = require('./helpers/v2RepositoryDatabase');

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

function imageProvider(calls, { duplicate = false } = {}) {
  let duplicateBytes = null;
  return Object.freeze({
    scope: 'configured-image',
    isAvailable() { return true; },
    async generate(command) {
      calls[calls.length] = command;
      const identity = command.prompt.includes('夏弦')
        ? 'character-xia-xian' : 'character-lin-che';
      if (duplicate && duplicateBytes === null) duplicateBytes = await portraitPng(identity, 0);
      return Object.freeze({
        provider: 'synthetic-local',
        model: 'fixture-portrait-v1',
        parameters: Object.freeze({
          adapter: 'configured-image.v1',
          size: `${command.width}x${command.height}`,
          requestedSeed: command.seed,
          ordinal: command.ordinal,
        }),
        bytes: duplicate ? Buffer.from(duplicateBytes) : await portraitPng(identity, command.ordinal),
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
