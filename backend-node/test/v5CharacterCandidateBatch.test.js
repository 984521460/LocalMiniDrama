const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const requestSchemaPath = path.join(
  __dirname, '..', '..', 'schemas', 'v5', 'character-candidate-request.schema.json',
);
const batchSchemaPath = path.join(
  __dirname, '..', '..', 'schemas', 'v5', 'character-candidate-batch.schema.json',
);

function uid(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function request(batchUid = uid(12000)) {
  return {
    schemaVersion: '5.0',
    batchUid,
    characterUid: uid(12001),
    promptSemanticUid: uid(12002),
    profileUid: uid(12003),
    manifestUid: uid(12004),
    width: 1024,
    height: 1024,
    seed: 42,
    candidateCount: 4,
  };
}

function candidates(input = request()) {
  return Array.from({ length: 4 }, (_, ordinal) => ({
    uid: uid(12010 + ordinal),
    ordinal,
    assetVersionUid: uid(12020 + ordinal),
    logicalUri: `asset://characters/${input.characterUid}/candidate-batches/${input.batchUid}/${ordinal}`,
    mediaType: 'image/png',
    width: input.width,
    height: input.height,
    contentSha256: ordinal.toString(16).repeat(64),
    presentation: 'single_portrait',
  }));
}

test('candidate request is exact, bounded, four-only, and accessor safe', () => {
  const { createCharacterCandidateRequest } = require('../src/assets/characterCandidateBatch');
  const created = createCharacterCandidateRequest(request());
  assert.deepEqual(created, request());
  assert.ok(Object.isFrozen(created));
  for (const candidateCount of [0, 1, 3, 5, 16]) {
    assert.throws(() => createCharacterCandidateRequest({ ...request(), candidateCount }));
  }
  assert.throws(() => createCharacterCandidateRequest({ ...request(), unexpected: true }));

  let reads = 0;
  const hostile = { ...request() };
  Object.defineProperty(hostile, 'seed', {
    enumerable: true,
    get() {
      reads += 1;
      return 42;
    },
  });
  assert.throws(() => createCharacterCandidateRequest(hostile));
  assert.equal(reads, 0);
  const proxy = new Proxy(request(), {
    getPrototypeOf() {
      reads += 1;
      return Object.prototype;
    },
  });
  assert.throws(() => createCharacterCandidateRequest(proxy));
  assert.equal(reads, 0);
});

test('one batch contains exactly four independent single-image candidate records', () => {
  const { createCharacterCandidateBatch } = require('../src/assets/characterCandidateBatch');
  const input = request();
  const records = candidates(input);
  const batch = createCharacterCandidateBatch(input, { candidates: records });
  assert.equal(batch.candidates.length, 4);
  assert.equal(new Set(batch.candidates.map((item) => item.uid)).size, 4);
  assert.equal(new Set(batch.candidates.map((item) => item.assetVersionUid)).size, 4);
  assert.equal(new Set(batch.candidates.map((item) => item.logicalUri)).size, 4);
  assert.equal(new Set(batch.candidates.map((item) => item.contentSha256)).size, 4);
  assert.ok(Object.isFrozen(batch));
  assert.ok(Object.isFrozen(batch.candidates));
  assert.ok(batch.candidates.every(Object.isFrozen));

  assert.throws(() => createCharacterCandidateBatch(input, { candidates: records.slice(0, 3) }));
  assert.throws(() => createCharacterCandidateBatch(input, { candidates: [...records, records[0]] }));
  for (const field of ['uid', 'assetVersionUid', 'logicalUri', 'contentSha256']) {
    const duplicate = structuredClone(records);
    duplicate[3][field] = duplicate[0][field];
    assert.throws(() => createCharacterCandidateBatch(input, { candidates: duplicate }), field);
  }
  const quadGrid = structuredClone(records);
  quadGrid[0].presentation = 'quad_grid';
  assert.throws(() => createCharacterCandidateBatch(input, { candidates: quadGrid }));
});

test('local batch service validates the complete output before exposing any result', async () => {
  const {
    createCharacterCandidateBatchService,
    isCharacterCandidateError,
  } = require('../src/assets/characterCandidateBatch');
  const batchUid = uid(12030);
  const calls = [];
  const service = createCharacterCandidateBatchService({
    createUid: () => batchUid,
    localGenerator: {
      scope: 'local',
      async generateCharacterCandidates(input) {
        calls.push(input);
        return { candidates: candidates(input) };
      },
    },
  });
  const input = request();
  delete input.batchUid;
  const batch = await service.generate(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].batchUid, batchUid);
  assert.equal(batch.batchUid, batchUid);

  const broken = createCharacterCandidateBatchService({
    createUid: () => uid(12031),
    localGenerator: {
      scope: 'local',
      async generateCharacterCandidates(generatorRequest) {
        return { candidates: candidates(generatorRequest).slice(0, 3) };
      },
    },
  });
  await assert.rejects(
    broken.generate(input),
    (error) => isCharacterCandidateError(error)
      && error.code === 'CHARACTER_CANDIDATE_OUTPUT_INVALID',
  );
  const failed = createCharacterCandidateBatchService({
    createUid: () => uid(12032),
    localGenerator: {
      scope: 'local',
      async generateCharacterCandidates() {
        throw new Error('SYNTHETIC_PRIVATE_PROVIDER_DETAIL');
      },
    },
  });
  await assert.rejects(
    failed.generate(input),
    (error) => error.code === 'CHARACTER_CANDIDATE_GENERATION_FAILED'
      && !error.message.includes('SYNTHETIC_PRIVATE_PROVIDER_DETAIL'),
  );
  assert.throws(() => createCharacterCandidateBatchService({
    localGenerator: { scope: 'remote', generateCharacterCandidates() {} },
  }));
});

test('local batch service rejects hostile thenables without assimilation and bounds native promises', async () => {
  const {
    createCharacterCandidateBatchService,
    isCharacterCandidateError,
  } = require('../src/assets/characterCandidateBatch');
  const input = request();
  delete input.batchUid;

  let proxyThenReads = 0;
  const proxyService = createCharacterCandidateBatchService({
    createUid: () => uid(12033),
    localGenerator: {
      scope: 'local',
      generateCharacterCandidates(generatorRequest) {
        return new Proxy({ candidates: candidates(generatorRequest) }, {
          get(target, key, receiver) {
            if (key === 'then') proxyThenReads += 1;
            return Reflect.get(target, key, receiver);
          },
        });
      },
    },
  });
  await assert.rejects(
    proxyService.generate(input),
    (error) => isCharacterCandidateError(error)
      && error.code === 'CHARACTER_CANDIDATE_OUTPUT_INVALID',
  );
  assert.equal(proxyThenReads, 0);

  let getterReads = 0;
  const getterService = createCharacterCandidateBatchService({
    createUid: () => uid(12034),
    localGenerator: {
      scope: 'local',
      generateCharacterCandidates(generatorRequest) {
        const output = { candidates: candidates(generatorRequest) };
        Object.defineProperty(output, 'then', {
          enumerable: true,
          get() {
            getterReads += 1;
            return undefined;
          },
        });
        return output;
      },
    },
  });
  await assert.rejects(
    getterService.generate(input),
    (error) => error.code === 'CHARACTER_CANDIDATE_OUTPUT_INVALID',
  );
  assert.equal(getterReads, 0);

  let thenCalls = 0;
  const thenableService = createCharacterCandidateBatchService({
    createUid: () => uid(12035),
    localGenerator: {
      scope: 'local',
      generateCharacterCandidates(generatorRequest) {
        return {
          candidates: candidates(generatorRequest),
          then(resolve) {
            thenCalls += 1;
            resolve({ candidates: candidates(generatorRequest) });
          },
        };
      },
    },
  });
  await assert.rejects(
    thenableService.generate(input),
    (error) => error.code === 'CHARACTER_CANDIDATE_OUTPUT_INVALID',
  );
  assert.equal(thenCalls, 0);

  const nativePromiseService = createCharacterCandidateBatchService({
    createUid: () => uid(12036),
    generationTimeoutMs: 100,
    localGenerator: {
      scope: 'local',
      generateCharacterCandidates(generatorRequest) {
        return Promise.resolve({ candidates: candidates(generatorRequest) });
      },
    },
  });
  assert.equal((await nativePromiseService.generate(input)).candidates.length, 4);

  let constructorReads = 0;
  const ownConstructorService = createCharacterCandidateBatchService({
    createUid: () => uid(12038),
    localGenerator: {
      scope: 'local',
      generateCharacterCandidates(generatorRequest) {
        const promise = Promise.resolve({ candidates: candidates(generatorRequest) });
        Object.defineProperty(promise, 'constructor', {
          configurable: true,
          get() {
            constructorReads += 1;
            return Promise;
          },
        });
        return promise;
      },
    },
  });
  await assert.rejects(
    ownConstructorService.generate(input),
    (error) => error.code === 'CHARACTER_CANDIDATE_GENERATION_FAILED',
  );
  assert.equal(constructorReads, 0);

  let subclassConstructions = 0;
  let speciesReads = 0;
  class HostilePromise extends Promise {
    constructor(executor) {
      subclassConstructions += 1;
      super(executor);
    }

    static get [Symbol.species]() {
      speciesReads += 1;
      return Promise;
    }
  }
  const subclassService = createCharacterCandidateBatchService({
    createUid: () => uid(12039),
    localGenerator: {
      scope: 'local',
      generateCharacterCandidates(generatorRequest) {
        return new HostilePromise((resolve) => {
          resolve({ candidates: candidates(generatorRequest) });
        });
      },
    },
  });
  await assert.rejects(
    subclassService.generate(input),
    (error) => error.code === 'CHARACTER_CANDIDATE_GENERATION_FAILED',
  );
  assert.equal(speciesReads, 0);
  assert.equal(subclassConstructions, 1);

  const neverSettles = createCharacterCandidateBatchService({
    createUid: () => uid(12037),
    generationTimeoutMs: 20,
    localGenerator: {
      scope: 'local',
      generateCharacterCandidates() {
        return new Promise(() => {});
      },
    },
  });
  const timeoutOutcome = await Promise.race([
    neverSettles.generate(input).then(
      () => ({ kind: 'resolved' }),
      (error) => ({ kind: 'rejected', error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'still-pending' }), 75)),
  ]);
  assert.equal(timeoutOutcome.kind, 'rejected');
  assert.equal(timeoutOutcome.error.code, 'CHARACTER_CANDIDATE_GENERATION_FAILED');
});

test('request and result runtime contracts align with strict v5 schemas', () => {
  const {
    createCharacterCandidateBatch,
    createCharacterCandidateRequest,
  } = require('../src/assets/characterCandidateBatch');
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateRequest = ajv.compile(JSON.parse(fs.readFileSync(requestSchemaPath, 'utf8')));
  const validateBatch = ajv.compile(JSON.parse(fs.readFileSync(batchSchemaPath, 'utf8')));
  const input = createCharacterCandidateRequest(request());
  const batch = createCharacterCandidateBatch(input, { candidates: candidates(input) });
  assert.equal(validateRequest(input), true, JSON.stringify(validateRequest.errors));
  assert.equal(validateBatch(batch), true, JSON.stringify(validateBatch.errors));
  const sparse = new Array(4);
  assert.throws(() => createCharacterCandidateBatch(input, { candidates: sparse }));
});

test('workflow runtime and schema require four only for character candidate nodes', () => {
  const { normalizeWorkflowNodeConfig } = require('../src/workflows/nodeConfig');
  const workflowSchema = JSON.parse(fs.readFileSync(path.join(
    __dirname, '..', '..', 'schemas', 'v4', 'workflow-execution-plan.schema.json',
  ), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(workflowSchema);
  const validateNode = ajv.compile({ $ref: `${workflowSchema.$id}#/$defs/node` });
  const node = {
    uid: uid(12050),
    nodeType: 'asset.character_candidates',
    position: { x: 0, y: 0 },
    config: { candidateCount: 4 },
    domainRef: null,
    enabled: true,
  };
  assert.equal(
    normalizeWorkflowNodeConfig('asset.character_candidates', node.config).candidateCount,
    4,
  );
  assert.equal(validateNode(node), true, JSON.stringify(validateNode.errors));
  for (const candidateCount of [1, 3, 5, 16]) {
    assert.throws(() => normalizeWorkflowNodeConfig(
      'asset.character_candidates',
      { candidateCount },
    ));
    assert.equal(validateNode({ ...node, config: { candidateCount } }), false);
  }
  assert.throws(() => normalizeWorkflowNodeConfig('asset.character_candidates', {}));
  assert.equal(validateNode({ ...node, config: {} }), false);
  assert.equal(
    normalizeWorkflowNodeConfig('asset.scene', { candidateCount: 3 }).candidateCount,
    3,
  );
});

test('localhost route accepts only a complete local four-candidate result', async (t) => {
  const characterCandidateRoutes = require('../src/routes/v2/characterCandidates');
  const events = [];
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use(characterCandidateRoutes({ error: (event, detail) => events.push({ event, detail }) }, {
    createUid: () => uid(12040),
    localGenerator: {
      scope: 'local',
      async generateCharacterCandidates(input) {
        return { candidates: candidates(input) };
      },
    },
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const body = {
    prompt_semantic_uid: uid(12002),
    profile_uid: uid(12003),
    manifest_uid: uid(12004),
    width: 1024,
    height: 1024,
    seed: 42,
    candidate_count: 4,
  };
  const accepted = await fetch(
    `http://127.0.0.1:${address.port}/characters/${uid(12001)}/candidate-batches`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).data.candidates.length, 4);

  const rejected = await fetch(
    `http://127.0.0.1:${address.port}/characters/${uid(12001)}/candidate-batches`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, candidate_count: 3 }),
    },
  );
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, 'CHARACTER_CANDIDATE_INPUT_INVALID');
  assert.deepEqual(events, []);
});

test('localhost route keeps unavailable and invalid generator details behind fixed errors', async (t) => {
  const characterCandidateRoutes = require('../src/routes/v2/characterCandidates');
  const body = {
    prompt_semantic_uid: uid(12002),
    profile_uid: uid(12003),
    manifest_uid: uid(12004),
    width: 1024,
    height: 1024,
    seed: 42,
    candidate_count: 4,
  };
  async function start(runtime) {
    const app = express();
    app.use(express.json());
    app.use(characterCandidateRoutes(null, runtime));
    return new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
  }
  const unavailable = await start({ createUid: () => uid(12060) });
  const invalidOutput = await start({
    createUid: () => uid(12061),
    localGenerator: {
      scope: 'local',
      async generateCharacterCandidates(input) {
        return { candidates: candidates(input).slice(0, 3), privateDetail: 'SYNTHETIC_SECRET' };
      },
    },
  });
  t.after(() => Promise.all([unavailable, invalidOutput].map(
    (server) => new Promise((resolve) => server.close(resolve)),
  )));

  for (const [server, status, code] of [
    [unavailable, 503, 'CHARACTER_CANDIDATE_GENERATOR_UNAVAILABLE'],
    [invalidOutput, 502, 'CHARACTER_CANDIDATE_OUTPUT_INVALID'],
  ]) {
    const result = await fetch(
      `http://127.0.0.1:${server.address().port}/characters/${uid(12001)}/candidate-batches`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    assert.equal(result.status, status);
    const text = await result.text();
    assert.equal(JSON.parse(text).error.code, code);
    assert.equal(text.includes('SYNTHETIC_SECRET'), false);
  }
});
