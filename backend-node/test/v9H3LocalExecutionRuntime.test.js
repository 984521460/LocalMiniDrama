'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const {
  createH3LocalExecutionService,
  parseH3LocalExecutionResult,
} = require('../src/h3/localExecutionService');

const NATIVE_PROMISE_THEN = Object.getOwnPropertyDescriptor(
  Promise.prototype, 'then',
).value;

function uid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function fixture() {
  const ids = Object.freeze({
    task: uid(1), intent: uid(2), run: uid(3), history: uid(4), asset: uid(5),
    version: uid(6), node: uid(7), manifest: uid(9), drama: uid(11),
  });
  const intent = Object.freeze({
    schemaVersion: 'h3-local-execution-intent.v1',
    uid: ids.intent,
    taskUid: ids.task,
    generationRunUid: ids.run,
    historyUid: ids.history,
    assetUid: ids.asset,
    promptSemantic: Object.freeze({ uid: uid(8), dramaUid: ids.drama }),
    generationSpec: Object.freeze({ mode: 't2v', seed: 42 }),
    manifestUid: ids.manifest,
    parentVersionUid: null,
    filenamePrefix: 'video/h3',
    taskPromptSha256: 'a'.repeat(64),
    planEvidenceSha256: 'b'.repeat(64),
    createdAtEpochMs: 0,
  });
  const state = {
    task: Object.freeze({
      uid: ids.task,
      stage: 'prepared',
      status: 'queued',
      workflowRunUid: uid(10),
      workflowManifestUid: ids.manifest,
      idempotencyKey: `remote-task:v1:${ids.node}`,
      outputAssetVersionUid: null,
      stateVersion: 0,
    }),
    run: null,
    history: null,
    version: null,
    node: null,
  };
  let coordinatorCalls = 0;
  const repositories = Object.freeze({
    assets: Object.freeze({ getVersion() { return state.version; } }),
    generationHistory: Object.freeze({ get() { return state.history; } }),
    h3GenerationIntents: Object.freeze({ getByTask(taskUid) {
      if (taskUid !== ids.task) throw new Error('not found');
      return intent;
    } }),
    remote: Object.freeze({ getFormalTask() { return state.task; } }),
    runs: Object.freeze({
      getGeneration() { return state.run; },
      getNode() { return state.node; },
    }),
  });
  const coordinator = Object.freeze({
    async execute(taskUid) {
      coordinatorCalls += 1;
      assert.equal(taskUid, ids.task);
      state.task = Object.freeze({
        uid: ids.task,
        stage: 'completed',
        status: 'succeeded',
        workflowRunUid: uid(10),
        workflowManifestUid: ids.manifest,
        idempotencyKey: `remote-task:v1:${ids.node}`,
        outputAssetVersionUid: ids.version,
        stateVersion: 9,
      });
      state.run = Object.freeze({
        uid: ids.run,
        status: 'succeeded',
        ownerType: 'drama',
        ownerUid: intent.promptSemantic.dramaUid,
        provider: 'local-comfy',
        model: 'MiniMax-H3',
        seed: intent.generationSpec.seed,
        promptVersionUid: intent.promptSemantic.uid,
        outputAssetVersionUid: ids.version,
      });
      state.history = Object.freeze({
        uid: ids.history,
        runUid: ids.run,
        dramaUid: intent.promptSemantic.dramaUid,
        assetUid: ids.asset,
        status: 'succeeded',
        manifestUid: ids.manifest,
        promptSemanticUid: intent.promptSemantic.uid,
        outputVersionUid: ids.version,
      });
      state.version = Object.freeze({
        uid: ids.version,
        assetUid: ids.asset,
        status: 'ready',
      });
      state.node = Object.freeze({
        uid: ids.node,
        workflowRunUid: uid(10),
        status: 'succeeded',
        output: Object.freeze({ assetVersionUid: ids.version, remoteTaskUid: ids.task }),
      });
      return Object.freeze({
        task: state.task,
        assetVersion: state.version,
        node: state.node,
        generationHistory: state.history,
      });
    },
  });
  return Object.freeze({
    ids,
    intent,
    repositories,
    coordinator,
    state,
    coordinatorCalls: () => coordinatorCalls,
  });
}

test('local H3 execution returns a minimal receipt only after durable evidence matches', async () => {
  const current = fixture();
  const service = createH3LocalExecutionService({
    repositories: current.repositories,
    coordinator: current.coordinator,
  });
  assert.equal(service.get(current.ids.task), null);
  const result = await service.execute(current.ids.task, Object.freeze({ request: 'opaque' }));

  assert.deepEqual({ ...result }, {
    schemaVersion: 'h3-local-execution-result.v2',
    taskUid: current.ids.task,
    taskStateVersion: 9,
    workflowRunUid: uid(10),
    generationRunUid: current.ids.run,
    historyUid: current.ids.history,
    assetUid: current.ids.asset,
    assetVersionUid: current.ids.version,
    nodeRunUid: current.ids.node,
    status: 'succeeded',
  });
  assert.deepEqual(service.get(current.ids.task), result);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(current.coordinatorCalls(), 1);

  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v9/h3-local-execution-result.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.deepEqual(parseH3LocalExecutionResult({ ...result }), result);
});

test('local H3 execution rejects custom thenables without executing them', async () => {
  const current = fixture();
  let thenCalls = 0;
  const coordinator = Object.freeze({
    execute() {
      return Object.freeze({
        then() {
          thenCalls += 1;
        },
      });
    },
  });
  const service = createH3LocalExecutionService({
    repositories: current.repositories,
    coordinator,
  });

  await assert.rejects(
    service.execute(current.ids.task, {}),
    { name: 'H3ContractError', code: 'H3_HISTORY_CONFLICT' },
  );
  assert.equal(thenCalls, 0);
});

test('local H3 execution observes a native coordinator Promise without reading its constructor', async () => {
  const current = fixture();
  const pending = current.coordinator.execute(current.ids.task, {});
  let constructorReads = 0;
  Object.defineProperty(pending, 'constructor', {
    configurable: true,
    get() {
      constructorReads += 1;
      throw new Error('synthetic-constructor-sentinel');
    },
  });
  const service = createH3LocalExecutionService({
    repositories: current.repositories,
    coordinator: Object.freeze({ execute() { return pending; } }),
  });

  const result = await service.execute(current.ids.task, {});
  assert.equal(result.status, 'succeeded');
  assert.equal(constructorReads, 0);
});

test('local H3 execution shields its public Promise from inherited constructor and species hooks', async () => {
  const originalConstructor = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor');
  const originalSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species);

  function routeAwaitProbe(operation) {
    let reads = 0;
    let routePromise;
    let chainedPromise;
    Object.defineProperty(Promise.prototype, 'constructor', {
      configurable: true,
      get() {
        reads += 1;
        throw new Error('synthetic-inherited-constructor-sentinel');
      },
    });
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      get() {
        reads += 1;
        throw new Error('synthetic-species-sentinel');
      },
    });
    try {
      routePromise = (async () => await operation)();
      chainedPromise = Reflect.apply(NATIVE_PROMISE_THEN, operation, [
        (value) => value,
        (error) => error,
      ]);
    } finally {
      Object.defineProperty(Promise.prototype, 'constructor', originalConstructor);
      Object.defineProperty(Promise, Symbol.species, originalSpecies);
    }
    return Object.freeze({ routePromise, chainedPromise, reads });
  }

  const success = fixture();
  const successService = createH3LocalExecutionService({
    repositories: success.repositories,
    coordinator: success.coordinator,
  });
  const acceptedProbe = routeAwaitProbe(successService.execute(success.ids.task, {}));
  const accepted = await acceptedProbe.routePromise;
  const acceptedFromChain = await acceptedProbe.chainedPromise;
  assert.equal(acceptedProbe.reads, 0);
  assert.equal(accepted.status, 'succeeded');
  assert.equal(acceptedFromChain.status, 'succeeded');

  const rejected = fixture();
  const rejectedService = createH3LocalExecutionService({
    repositories: rejected.repositories,
    coordinator: rejected.coordinator,
  });
  const deniedProbe = routeAwaitProbe(rejectedService.execute(uid(999), {}));
  assert.equal(deniedProbe.reads, 0);
  const chainedError = await deniedProbe.chainedPromise;
  assert.equal(chainedError.code, 'H3_HISTORY_CONFLICT');
  await assert.rejects(
    deniedProbe.routePromise,
    { name: 'H3ContractError', code: 'H3_HISTORY_CONFLICT' },
  );
});

test('local H3 execution rejects invalid or missing intent before coordinator side effects', async () => {
  const current = fixture();
  const service = createH3LocalExecutionService({
    repositories: current.repositories,
    coordinator: current.coordinator,
  });

  await assert.rejects(
    service.execute('not-a-uuid', {}),
    { name: 'H3ContractError', code: 'H3_GENERATION_INPUT_INVALID' },
  );
  await assert.rejects(
    service.execute(uid(999), {}),
    { name: 'H3ContractError', code: 'H3_HISTORY_CONFLICT' },
  );
  assert.equal(current.coordinatorCalls(), 0);
});

test('local H3 execution rejects post-execution durable history drift', async () => {
  const current = fixture();
  const coordinator = Object.freeze({
    async execute(taskUid, request) {
      const result = await current.coordinator.execute(taskUid, request);
      current.state.history = Object.freeze({
        ...current.state.history,
        outputVersionUid: uid(998),
      });
      return result;
    },
  });
  const service = createH3LocalExecutionService({
    repositories: current.repositories,
    coordinator,
  });

  await assert.rejects(
    service.execute(current.ids.task, {}),
    { name: 'H3ContractError', code: 'H3_HISTORY_CONFLICT' },
  );
});

test('local H3 execution result parser is exact and accessor safe', () => {
  const current = fixture();
  const valid = {
    schemaVersion: 'h3-local-execution-result.v2',
    taskUid: current.ids.task,
    taskStateVersion: 1,
    workflowRunUid: uid(10),
    generationRunUid: current.ids.run,
    historyUid: current.ids.history,
    assetUid: current.ids.asset,
    assetVersionUid: current.ids.version,
    nodeRunUid: current.ids.node,
    status: 'succeeded',
  };
  assert.throws(
    () => parseH3LocalExecutionResult({ ...valid, extra: true }),
    { name: 'H3ContractError', code: 'H3_HISTORY_CONFLICT' },
  );
  let reads = 0;
  Object.defineProperty(valid, 'status', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('synthetic-status-sentinel');
    },
  });
  assert.throws(
    () => parseH3LocalExecutionResult(valid),
    { name: 'H3ContractError', code: 'H3_HISTORY_CONFLICT' },
  );
  assert.equal(reads, 0);
});
