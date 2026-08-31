'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  createComfyUiClient,
  isComfyUiClientError,
} = require('../src/integrations/comfyui/client');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test('formal Comfy client exposes bounded immutable capability snapshots', async () => {
  const calls = [];
  const client = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/system_stats')) {
        return jsonResponse({ system: { comfyui_version: '0.3.50' }, devices: [] });
      }
      if (url.endsWith('/object_info')) {
        return jsonResponse({ SaveImage: { input: { required: {} } } });
      }
      return jsonResponse({ queue_running: [], queue_pending: [] });
    },
  });

  const stats = await client.systemStats();
  const objects = await client.objectInfo();
  const queue = await client.queueSnapshot();
  assert.equal(stats.system.comfyui_version, '0.3.50');
  assert.equal(Object.isFrozen(stats), true);
  assert.equal(Object.isFrozen(stats.system), true);
  assert.equal(Object.isFrozen(objects), true);
  assert.equal(Object.isFrozen(queue.queue_running), true);
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    '/system_stats', '/object_info', '/queue',
  ]);
  assert.equal(calls.every(({ options }) => options.redirect === 'error'), true);

  let optionReads = 0;
  const hostileOptions = {};
  Object.defineProperty(hostileOptions, 'signal', {
    enumerable: true,
    get() {
      optionReads += 1;
      return undefined;
    },
  });
  assert.throws(() => client.systemStats(hostileOptions));
  assert.equal(optionReads, 0);

  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'system', {
    enumerable: true,
    get() {
      reads += 1;
      return {};
    },
  });
  const hostileClient = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    fetchImpl: async () => jsonResponse(hostile),
  });
  await assert.rejects(hostileClient.systemStats(), (error) => (
    isComfyUiClientError(error) && error.code === 'COMFY_RESPONSE_INVALID'
  ));
  assert.equal(reads, 0);
});

test('response proxy and accessors are rejected before product property reads', async () => {
  let proxyReads = 0;
  const proxiedResponse = new Proxy(jsonResponse({}), {
    get(target, property, receiver) {
      if (property !== 'then') proxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const proxyClient = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    fetchImpl: () => Promise.resolve(proxiedResponse),
  });
  await assert.rejects(proxyClient.systemStats(), (error) => (
    isComfyUiClientError(error) && error.code === 'COMFY_RESPONSE_INVALID'
  ));
  assert.equal(proxyReads, 0);

  let getterReads = 0;
  const accessorResponse = {
    status: 200,
    async json() { return {}; },
  };
  Object.defineProperty(accessorResponse, 'ok', {
    enumerable: true,
    get() {
      getterReads += 1;
      return true;
    },
  });
  const accessorClient = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    fetchImpl: async () => accessorResponse,
  });
  await assert.rejects(accessorClient.systemStats(), (error) => (
    isComfyUiClientError(error) && error.code === 'COMFY_RESPONSE_INVALID'
  ));
  assert.equal(getterReads, 0);

  const nativeResponseClient = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    fetchImpl: async () => new Response(JSON.stringify({ system: { comfyui_version: 'native' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  assert.equal((await nativeResponseClient.systemStats()).system.comfyui_version, 'native');

  function streamResponse(chunk) {
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }),
    };
  }

  async function rejectsChunk(chunk) {
    const client = createComfyUiClient({
      baseUrl: 'http://127.0.0.1:18188',
      fetchImpl: async () => streamResponse(chunk),
    });
    await assert.rejects(client.systemStats(), (error) => (
      isComfyUiClientError(error) && error.code === 'COMFY_RESPONSE_INVALID'
    ));
  }

  let chunkGetterReads = 0;
  const accessorChunk = new TextEncoder().encode('{}');
  Object.defineProperty(accessorChunk, 'byteLength', {
    get() {
      chunkGetterReads += 1;
      return 2;
    },
  });
  await rejectsChunk(accessorChunk);
  assert.equal(chunkGetterReads, 0);

  class Uint8ArraySubclass extends Uint8Array {}
  await rejectsChunk(new Uint8ArraySubclass(new TextEncoder().encode('{}')));

  const alteredPrototypeChunk = new TextEncoder().encode('{}');
  Object.setPrototypeOf(alteredPrototypeChunk, Object.create(null));
  await rejectsChunk(alteredPrototypeChunk);

  if (typeof SharedArrayBuffer === 'function') {
    const sharedChunk = new Uint8Array(new SharedArrayBuffer(2));
    sharedChunk.set(new TextEncoder().encode('{}'));
    await rejectsChunk(sharedChunk);
  }
});

test('prompt submission and history return exact normalized state and safe outputs', async () => {
  const calls = [];
  const client = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    sleepImpl: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/prompt')) {
        return jsonResponse({ prompt_id: 'prompt-1', number: 1, node_errors: {} });
      }
      return jsonResponse({
        'prompt-1': {
          status: { completed: true, status_str: 'success' },
          outputs: {
            9: {
              images: [{ filename: 'shot_00001_.png', subfolder: 'jobs/task-1', type: 'output' }],
              gifs: [{ filename: 'shot_00001_.mp4', subfolder: 'jobs/task-1', type: 'output' }],
            },
          },
        },
      });
    },
  });

  const submitted = await client.submitPrompt({
    1: { class_type: 'EmptyImage', inputs: { width: 64, height: 64 } },
  }, { clientId: 'desktop-client' });
  assert.deepEqual(submitted, { promptId: 'prompt-1' });
  assert.equal(Object.isFrozen(submitted), true);
  const state = await client.getPromptState('prompt-1');
  assert.deepEqual(state, {
    promptId: 'prompt-1',
    state: 'succeeded',
    outputs: [
      {
        nodeId: '9',
        mediaKind: 'image',
        fileName: 'shot_00001_.png',
        subfolder: 'jobs/task-1',
        storageType: 'output',
      },
      {
        nodeId: '9',
        mediaKind: 'video',
        fileName: 'shot_00001_.mp4',
        subfolder: 'jobs/task-1',
        storageType: 'output',
      },
    ],
  });
  assert.equal(Object.isFrozen(state.outputs), true);
  assert.deepEqual(await client.waitForPrompt('prompt-1', { timeoutMs: 100, pollIntervalMs: 0 }), state);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    prompt: { 1: { class_type: 'EmptyImage', inputs: { width: 64, height: 64 } } },
    client_id: 'desktop-client',
  });
});

test('submission, execution, response, and HTTP failures use fixed non-leaking errors', async () => {
  const sentinel = 'synthetic-upstream-detail-must-not-leak';
  const cases = [
    {
      client: createComfyUiClient({
        baseUrl: 'http://127.0.0.1:18188',
        fetchImpl: async () => jsonResponse({ node_errors: { 1: { details: sentinel } } }),
      }),
      run: (client) => client.submitPrompt({ 1: { class_type: 'EmptyImage', inputs: {} } }),
      code: 'COMFY_SUBMISSION_REJECTED',
    },
    {
      client: createComfyUiClient({
        baseUrl: 'http://127.0.0.1:18188',
        fetchImpl: async () => jsonResponse({}, 400),
      }),
      run: (client) => client.submitPrompt({ 1: { class_type: 'EmptyImage', inputs: {} } }),
      code: 'COMFY_SUBMISSION_REJECTED',
    },
    {
      client: createComfyUiClient({
        baseUrl: 'http://127.0.0.1:18188',
        fetchImpl: async () => jsonResponse({
          'prompt-2': { status: { completed: true, status_str: 'error', messages: [sentinel] } },
        }),
      }),
      run: (client) => client.waitForPrompt('prompt-2', { timeoutMs: 100, pollIntervalMs: 0 }),
      code: 'COMFY_EXECUTION_FAILED',
    },
    {
      client: createComfyUiClient({
        baseUrl: 'http://127.0.0.1:18188',
        fetchImpl: async () => jsonResponse({
          'prompt-3': {
            status: { completed: true, status_str: 'success' },
            outputs: { 1: { images: [{ filename: '../escape.png', subfolder: '', type: 'output' }] } },
          },
        }),
      }),
      run: (client) => client.getPromptState('prompt-3'),
      code: 'COMFY_RESPONSE_INVALID',
    },
    {
      client: createComfyUiClient({
        baseUrl: 'http://127.0.0.1:18188',
        fetchImpl: async () => jsonResponse({
          'prompt-4': {
            status: { completed: true, status_str: 'success' },
            outputs: { 1: { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] } },
          },
        }),
      }),
      run: (client) => client.getPromptState('prompt-4'),
      code: 'COMFY_RESPONSE_INVALID',
    },
    {
      client: createComfyUiClient({
        baseUrl: 'http://127.0.0.1:18188',
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          async json() { return { detail: sentinel }; },
        }),
      }),
      run: (client) => client.systemStats(),
      code: 'COMFY_HTTP_ERROR',
    },
  ];

  for (const item of cases) {
    await assert.rejects(item.run(item.client), (error) => {
      assert.equal(isComfyUiClientError(error), true);
      assert.equal(error.code, item.code);
      assert.equal(error.message.includes(sentinel), false);
      assert.equal(JSON.stringify(error).includes(sentinel), false);
      return true;
    });
  }
});

test('request timeout and caller cancellation settle with fixed abort errors', async () => {
  const client = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true });
    }),
  });
  await assert.rejects(client.systemStats(), (error) => (
    isComfyUiClientError(error) && error.code === 'COMFY_REQUEST_ABORTED'
  ));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.objectInfo({ signal: controller.signal }), (error) => (
    isComfyUiClientError(error) && error.code === 'COMFY_REQUEST_ABORTED'
  ));
});

test('non-cooperative fetch, response body, and polling sleep cannot defeat deadlines', async () => {
  async function outcome(promise, windowMs = 80) {
    return Promise.race([
      promise.then(
        () => ({ settled: true, code: null }),
        (error) => ({ settled: true, code: error.code }),
      ),
      new Promise((resolve) => setTimeout(() => resolve({ settled: false }), windowMs)),
    ]);
  }

  const never = () => new Promise(() => {});
  const neverFetch = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    requestTimeoutMs: 5,
    fetchImpl: never,
  });
  assert.deepEqual(await outcome(neverFetch.systemStats()), {
    settled: true,
    code: 'COMFY_REQUEST_ABORTED',
  });

  const neverBody = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    requestTimeoutMs: 5,
    fetchImpl: async () => ({ ok: true, status: 200, json: never }),
  });
  assert.deepEqual(await outcome(neverBody.objectInfo()), {
    settled: true,
    code: 'COMFY_REQUEST_ABORTED',
  });

  const neverStream = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    requestTimeoutMs: 5,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({ pull: never }),
    }),
  });
  assert.deepEqual(await outcome(neverStream.queueSnapshot()), {
    settled: true,
    code: 'COMFY_REQUEST_ABORTED',
  });

  const neverSleep = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    sleepImpl: never,
    fetchImpl: async () => jsonResponse({}),
  });
  assert.deepEqual(await outcome(neverSleep.waitForPrompt('prompt-wait', {
    timeoutMs: 5,
    pollIntervalMs: 1,
  })), {
    settled: true,
    code: 'COMFY_PROMPT_TIMEOUT',
  });

  const controller = new AbortController();
  const cancelled = neverSleep.waitForPrompt('prompt-cancel', {
    timeoutMs: 1000,
    pollIntervalMs: 1,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 5);
  assert.deepEqual(await outcome(cancelled), {
    settled: true,
    code: 'COMFY_REQUEST_ABORTED',
  });
});

test('late rejections are absorbed and custom thenables are never assimilated', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    let rejectFetch;
    const lateFetch = createComfyUiClient({
      baseUrl: 'http://127.0.0.1:18188',
      requestTimeoutMs: 5,
      fetchImpl: () => new Promise((_resolve, reject) => { rejectFetch = reject; }),
    });
    await assert.rejects(lateFetch.systemStats(), (error) => (
      isComfyUiClientError(error) && error.code === 'COMFY_REQUEST_ABORTED'
    ));
    rejectFetch(new Error('synthetic late fetch rejection'));

    let rejectSleep;
    let markSleepStarted;
    const sleepStarted = new Promise((resolve) => { markSleepStarted = resolve; });
    const lateSleep = createComfyUiClient({
      baseUrl: 'http://127.0.0.1:18188',
      fetchImpl: async () => jsonResponse({}),
      sleepImpl: () => new Promise((_resolve, reject) => {
        rejectSleep = reject;
        markSleepStarted();
      }),
    });
    const lateSleepOutcome = lateSleep.waitForPrompt('prompt-late', {
      timeoutMs: 100,
      pollIntervalMs: 1,
    }).then(
      () => ({ settled: true, code: null }),
      (error) => ({ settled: true, code: error?.code }),
    );
    await sleepStarted;
    assert.deepEqual(await lateSleepOutcome, {
      settled: true,
      code: 'COMFY_PROMPT_TIMEOUT',
    });
    rejectSleep(new Error('synthetic late sleep rejection'));

    let thenReads = 0;
    const thenable = {};
    Object.defineProperty(thenable, 'then', {
      get() {
        thenReads += 1;
        return () => {};
      },
    });
    const hostileFetch = createComfyUiClient({
      baseUrl: 'http://127.0.0.1:18188',
      fetchImpl: () => thenable,
    });
    await assert.rejects(hostileFetch.systemStats(), (error) => (
      isComfyUiClientError(error) && error.code === 'COMFY_CONNECTION_FAILED'
    ));
    assert.equal(thenReads, 0);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('native Promise observation does not execute inherited constructor or species accessors', () => {
  const modulePath = require.resolve('../src/integrations/comfyui/asyncControl');
  const script = `
    'use strict';
    const { raceNativePromise } = require(${JSON.stringify(modulePath)});
    (async () => {
      let constructorReads = 0;
      let speciesReads = 0;
      const pending = Promise.resolve(1);
      const constructorDescriptor = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor');
      const speciesDescriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
      Object.defineProperty(Promise.prototype, 'constructor', {
        configurable: true,
        get() { constructorReads += 1; return Promise; },
      });
      Object.defineProperty(Promise, Symbol.species, {
        configurable: true,
        get() { speciesReads += 1; return Promise; },
      });
      try {
        const value = await raceNativePromise(pending, { timeoutMs: 50 });
        process.stdout.write(JSON.stringify({ value, constructorReads, speciesReads }));
      } finally {
        Object.defineProperty(Promise.prototype, 'constructor', constructorDescriptor);
        Object.defineProperty(Promise, Symbol.species, speciesDescriptor);
      }
    })();
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    value: 1,
    constructorReads: 0,
    speciesReads: 0,
  });
});

test('input upload uses an exact safe multipart contract', async () => {
  let submitted;
  const client = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    maxUploadBytes: 16,
    fetchImpl: async (url, options) => {
      submitted = { url, options };
      return jsonResponse({ name: 'reference.png', subfolder: 'jobs/task-1', type: 'input' });
    },
  });
  const sourceBytes = Buffer.from('safe-image-bytes');
  const uploaded = await client.uploadInput({
    fileName: 'reference.png',
    subfolder: 'jobs/task-1',
    bytes: sourceBytes,
    overwrite: false,
  });
  sourceBytes.fill(0);
  assert.deepEqual(uploaded, {
    fileName: 'reference.png',
    subfolder: 'jobs/task-1',
    storageType: 'input',
  });
  assert.equal(new URL(submitted.url).pathname, '/upload/image');
  assert.equal(submitted.options.body instanceof FormData, true);
  assert.equal(Buffer.from(
    await submitted.options.body.get('image').arrayBuffer(),
  ).toString('utf8'), 'safe-image-bytes');
  assert.equal(submitted.options.headers.Accept, 'application/json');
  assert.equal(Object.hasOwn(submitted.options.headers, 'Content-Type'), false);
  assert.throws(() => client.uploadInput({
    fileName: '../escape.png', subfolder: '', bytes: Buffer.from('x'), overwrite: false,
  }));
  assert.throws(() => client.uploadInput({
    fileName: 'large.png', subfolder: '', bytes: Buffer.alloc(17), overwrite: false,
  }));

  let proxyReads = 0;
  const proxiedBytes = new Proxy(Buffer.from('x'), {
    get(target, property, receiver) {
      proxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => client.uploadInput({
    fileName: 'proxy.png', subfolder: '', bytes: proxiedBytes, overwrite: false,
  }), /invalid/u);
  assert.equal(proxyReads, 0);

  const alteredPrototypeBytes = Buffer.from('x');
  Object.setPrototypeOf(alteredPrototypeBytes, Object.create(Buffer.prototype));
  assert.throws(() => client.uploadInput({
    fileName: 'subclass.png', subfolder: '', bytes: alteredPrototypeBytes, overwrite: false,
  }), /invalid/u);

  let lengthReads = 0;
  const accessorBytes = Buffer.from('x');
  Object.defineProperty(accessorBytes, 'length', {
    get() {
      lengthReads += 1;
      return 1;
    },
  });
  assert.throws(() => client.uploadInput({
    fileName: 'accessor.png', subfolder: '', bytes: accessorBytes, overwrite: false,
  }), /invalid/u);
  assert.equal(lengthReads, 0);

  if (typeof SharedArrayBuffer === 'function') {
    const sharedBytes = Buffer.from(new SharedArrayBuffer(1));
    assert.throws(() => client.uploadInput({
      fileName: 'shared.png', subfolder: '', bytes: sharedBytes, overwrite: false,
    }), /invalid/u);
  }
});
