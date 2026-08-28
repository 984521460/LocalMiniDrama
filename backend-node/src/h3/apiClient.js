'use strict';

const { types: { isProxy } } = require('node:util');

const { raceNativePromise } = require('../integrations/comfyui/asyncControl');
const { readBoundedResponseText } = require('./apiResponseBody');
const { fail } = require('./errors');

const OFFICIAL_ORIGINS = Object.freeze(new Set([
  'https://api.minimax.io',
  'https://api.minimaxi.com',
]));
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const STATUS = Object.freeze(new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']));
const responseOkGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'ok').get;
const responseStatusGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'status').get;
const responseBodyGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'body').get;

function officialOrigin(value) {
  if (typeof value !== 'string' || value !== value.trim()) fail('H3_API_UNAVAILABLE');
  let parsed;
  try { parsed = new URL(value); } catch { return fail('H3_API_UNAVAILABLE'); }
  const origin = parsed.origin;
  if (!OFFICIAL_ORIGINS.has(origin) || parsed.href !== `${origin}/`
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('H3_API_UNAVAILABLE');
  }
  return origin;
}

function apiKey(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192
    || value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) {
    fail('H3_API_UNAVAILABLE');
  }
  return value;
}

function taskId(value, code = 'H3_API_RESPONSE_INVALID') {
  if (typeof value !== 'string' || !TASK_ID.test(value)) fail(code);
  return value;
}

function adaptResponse(value) {
  if (value === null || typeof value !== 'object' || isProxy(value)) {
    fail('H3_API_RESPONSE_INVALID');
  }
  let prototype;
  try { prototype = Object.getPrototypeOf(value); } catch {
    return fail('H3_API_RESPONSE_INVALID');
  }
  if (prototype !== Response.prototype) fail('H3_API_RESPONSE_INVALID');
  try {
    return Object.freeze({
      ok: responseOkGetter.call(value),
      status: responseStatusGetter.call(value),
      body: responseBodyGetter.call(value),
    });
  } catch {
    return fail('H3_API_RESPONSE_INVALID');
  }
}

async function responseJson(response, signal) {
  let text;
  try {
    text = await readBoundedResponseText(response.body, signal, 256 * 1024);
  } catch {
    if (signal.aborted) fail('H3_API_REQUEST_ABORTED');
    return fail('H3_API_RESPONSE_INVALID');
  }
  try { return JSON.parse(text); } catch { return fail('H3_API_RESPONSE_INVALID'); }
}

function outputUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192
    || value !== value.trim() || /[\u0000-\u0020\u007f\\]/u.test(value)) {
    fail('H3_API_RESPONSE_INVALID');
  }
  let parsed;
  try { parsed = new URL(value); } catch { return fail('H3_API_RESPONSE_INVALID'); }
  if (!value.startsWith('https://') || parsed.protocol !== 'https:'
    || parsed.href !== value || parsed.username || parsed.password || parsed.hash) {
    fail('H3_API_RESPONSE_INVALID');
  }
  return value;
}

function publicTask(id, status, url = null) {
  return Object.freeze({
    schemaVersion: 'h3-api-task.v1',
    provider: 'minimax-api',
    model: 'MiniMax-H3',
    taskId: id,
    status,
    outputUrl: url,
  });
}

function createMinimaxH3ApiClient({ origin, apiKey: secret, fetchImpl, timeoutMs }) {
  const base = officialOrigin(origin);
  const key = apiKey(secret);
  if (typeof fetchImpl !== 'function' || isProxy(fetchImpl)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new TypeError('MiniMax H3 API client configuration is invalid');
  }

  async function request(pathname, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        const pending = Reflect.apply(fetchImpl, undefined, [
          `${base}${pathname}`,
          { ...options, redirect: 'error', signal: controller.signal },
        ]);
        response = adaptResponse(await raceNativePromise(pending, { signal: controller.signal }));
      } catch {
        if (controller.signal.aborted) fail('H3_API_REQUEST_ABORTED');
        return fail('H3_API_RESPONSE_INVALID');
      }
      const payload = await responseJson(response, controller.signal);
      if (!response.ok) fail('H3_API_UPSTREAM_FAILED');
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async submit(requestBody) {
      const payload = await request('/v2/video_generation', {
        method: 'POST',
        headers: Object.freeze({
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        }),
        body: JSON.stringify(requestBody),
      });
      return publicTask(taskId(payload?.task_id), 'queued');
    },

    async query(value) {
      const expectedId = taskId(value, 'H3_API_REQUEST_INVALID');
      const payload = await request(
        `/v2/query/video_generation/${encodeURIComponent(expectedId)}`,
        {
          method: 'GET',
          headers: Object.freeze({
            Accept: 'application/json',
            Authorization: `Bearer ${key}`,
          }),
        },
      );
      const task = payload?.task;
      if (!task || typeof task !== 'object' || Array.isArray(task)
        || taskId(task.id) !== expectedId || task.model !== 'MiniMax-H3'
        || typeof task.status !== 'string' || !STATUS.has(task.status)) {
        fail('H3_API_RESPONSE_INVALID');
      }
      const url = task.status === 'succeeded' ? outputUrl(task.content?.url) : null;
      return publicTask(expectedId, task.status, url);
    },
  });
}

module.exports = Object.freeze({
  createMinimaxH3ApiClient,
  createPublicH3ApiTask: publicTask,
});
