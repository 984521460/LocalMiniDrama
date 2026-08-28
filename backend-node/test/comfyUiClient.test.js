'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ComfyUiClientError,
  createComfyUiClient,
} = require('../src/integrations/comfyui/client');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test('ComfyUI client accepts loopback tunnels and rejects remote or credentialed URLs', () => {
  assert.doesNotThrow(() => createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    fetchImpl: async () => jsonResponse({}),
  }));
  assert.throws(() => createComfyUiClient({
    baseUrl: 'http://localhost:8188/',
    fetchImpl: async () => jsonResponse({}),
  }), /invalid/i);

  assert.throws(
    () => createComfyUiClient({ baseUrl: 'http://192.0.2.10:8188', fetchImpl: async () => jsonResponse({}) }),
    /invalid/i
  );
  assert.throws(
    () => createComfyUiClient({ baseUrl: 'http://user:pass@127.0.0.1:8188', fetchImpl: async () => jsonResponse({}) }),
    /invalid/i
  );
});

test('ComfyUI client maps health, queue, prompt and history to the native API', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/system_stats')) return jsonResponse({ system: { comfyui_version: '0.33.0' } });
    if (url.endsWith('/queue')) return jsonResponse({ queue_running: [], queue_pending: [] });
    if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1', node_errors: {} });
    if (url.endsWith('/history/prompt-1')) {
      return jsonResponse({ 'prompt-1': { status: { completed: true, status_str: 'success' } } });
    }
    return jsonResponse({}, 404);
  };
  const client = createComfyUiClient({ baseUrl: 'http://127.0.0.1:18188/', fetchImpl });

  assert.equal((await client.health()).system.comfyui_version, '0.33.0');
  assert.deepEqual({ ...await client.queue() }, { queue_running: [], queue_pending: [] });
  assert.equal((await client.submitPrompt({ 1: { class_type: 'EmptyImage', inputs: {} } }, { clientId: 'test-client' })).promptId, 'prompt-1');
  assert.equal((await client.history('prompt-1'))['prompt-1'].status.completed, true);

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    '/system_stats',
    '/queue',
    '/prompt',
    '/history/prompt-1',
  ]);
  assert.equal(calls.every((call) => call.options.redirect === 'error'), true);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    prompt: { 1: { class_type: 'EmptyImage', inputs: {} } },
    client_id: 'test-client',
  });
});

test('waitForPrompt polls history until success and reports execution failures', async () => {
  let historyCalls = 0;
  const successClient = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      if (!url.includes('/history/')) return jsonResponse({});
      historyCalls += 1;
      if (historyCalls === 1) return jsonResponse({});
      return jsonResponse({
        'prompt-2': { status: { completed: true, status_str: 'success' }, outputs: { 9: { images: [] } } },
      });
    },
  });

  const record = await successClient.waitForPrompt('prompt-2', { timeoutMs: 100, pollIntervalMs: 1 });
  assert.equal(record.state, 'succeeded');
  assert.equal(historyCalls, 2);

  const failedClient = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    sleepImpl: async () => {},
    fetchImpl: async () => jsonResponse({
      'prompt-3': { status: { completed: false, status_str: 'error' } },
    }),
  });
  await assert.rejects(
    failedClient.waitForPrompt('prompt-3', { timeoutMs: 100, pollIntervalMs: 1 }),
    (error) => error instanceof ComfyUiClientError && /failed/i.test(error.message)
  );
});

test('HTTP failures do not copy upstream response bodies into errors', async () => {
  const client = createComfyUiClient({
    baseUrl: 'http://127.0.0.1:18188',
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async json() {
        return { detail: 'sensitive-upstream-body' };
      },
    }),
  });

  await assert.rejects(client.health(), (error) => {
    assert.equal(error instanceof ComfyUiClientError, true);
    assert.equal(error.status, 500);
    assert.equal(error.message.includes('sensitive-upstream-body'), false);
    return true;
  });
});
