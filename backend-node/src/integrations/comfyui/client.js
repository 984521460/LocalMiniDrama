'use strict';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

class ComfyUiClientError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'ComfyUiClientError';
    if (status !== undefined) this.status = status;
    if (code !== undefined) this.code = code;
  }
}

function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (_) {
    throw new TypeError('ComfyUI baseUrl must be a valid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('ComfyUI baseUrl must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('ComfyUI baseUrl must not contain credentials');
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new TypeError('ComfyUI baseUrl must target a loopback SSH tunnel');
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new TypeError('ComfyUI baseUrl must not contain a path, query, or fragment');
  }
  return parsed.origin;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requirePromptId(value) {
  const promptId = String(value || '').trim();
  if (!promptId) throw new TypeError('promptId is required');
  return promptId;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createComfyUiClient({
  baseUrl,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 30_000,
  sleepImpl = defaultSleep,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof sleepImpl !== 'function') throw new TypeError('sleepImpl must be a function');
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TypeError('requestTimeoutMs must be positive');
  }

  async function requestJson(pathname, { method = 'GET', body, signal } = {}) {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetchImpl(new URL(pathname, `${normalizedBaseUrl}/`).toString(), {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      if (!response || typeof response.ok !== 'boolean') {
        throw new ComfyUiClientError(`ComfyUI returned an invalid response for ${method} ${pathname}`);
      }
      if (!response.ok) {
        throw new ComfyUiClientError(`ComfyUI request failed: ${method} ${pathname} (${response.status})`, {
          status: response.status,
          code: 'HTTP_ERROR',
        });
      }

      let payload;
      try {
        payload = await response.json();
      } catch (_) {
        throw new ComfyUiClientError(`ComfyUI returned invalid JSON for ${method} ${pathname}`, {
          status: response.status,
          code: 'INVALID_JSON',
        });
      }
      return requirePlainObject(payload, 'ComfyUI response');
    } catch (error) {
      if (error instanceof ComfyUiClientError) throw error;
      if (controller.signal.aborted) {
        throw new ComfyUiClientError(`ComfyUI request timed out or was aborted: ${method} ${pathname}`, {
          code: 'ABORTED',
        });
      }
      throw new ComfyUiClientError(`ComfyUI request could not be completed: ${method} ${pathname}`, {
        code: 'NETWORK_ERROR',
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortFromCaller);
    }
  }

  async function health(options) {
    return requestJson('/system_stats', options);
  }

  async function queue(options) {
    return requestJson('/queue', options);
  }

  async function submitPrompt(prompt, { clientId, extraData, signal } = {}) {
    requirePlainObject(prompt, 'prompt');
    if (Object.keys(prompt).length === 0) throw new TypeError('prompt must not be empty');

    const body = { prompt };
    if (clientId !== undefined) {
      const normalizedClientId = String(clientId).trim();
      if (!normalizedClientId) throw new TypeError('clientId must not be empty');
      body.client_id = normalizedClientId;
    }
    if (extraData !== undefined) body.extra_data = requirePlainObject(extraData, 'extraData');
    return requestJson('/prompt', { method: 'POST', body, signal });
  }

  async function history(promptId, options) {
    return requestJson(`/history/${encodeURIComponent(requirePromptId(promptId))}`, options);
  }

  async function waitForPrompt(promptId, {
    timeoutMs = 10 * 60_000,
    pollIntervalMs = 1_000,
    signal,
  } = {}) {
    const normalizedPromptId = requirePromptId(promptId);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
      throw new TypeError('pollIntervalMs must not be negative');
    }
    const deadline = Date.now() + timeoutMs;

    while (true) {
      if (signal?.aborted) {
        throw new ComfyUiClientError('ComfyUI prompt wait was aborted', { code: 'ABORTED' });
      }
      const records = await history(normalizedPromptId, { signal });
      const record = records[normalizedPromptId];
      if (record) {
        const status = record.status || {};
        const statusText = String(status.status_str || '').toLowerCase();
        if (status.completed && statusText === 'success') return record;
        if (statusText === 'error' || statusText === 'failed' || (status.completed && statusText !== 'success')) {
          throw new ComfyUiClientError(`ComfyUI prompt failed: ${normalizedPromptId}`, {
            code: 'PROMPT_FAILED',
          });
        }
      }
      if (Date.now() >= deadline) {
        throw new ComfyUiClientError(`Timed out waiting for ComfyUI prompt: ${normalizedPromptId}`, {
          code: 'PROMPT_TIMEOUT',
        });
      }
      await sleepImpl(pollIntervalMs);
    }
  }

  return Object.freeze({
    baseUrl: normalizedBaseUrl,
    health,
    queue,
    submitPrompt,
    history,
    waitForPrompt,
  });
}

module.exports = {
  ComfyUiClientError,
  createComfyUiClient,
  normalizeBaseUrl,
};
