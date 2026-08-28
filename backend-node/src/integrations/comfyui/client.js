'use strict';

const {
  clientConfiguration,
  normalizeBaseUrl,
  parsePromptState,
  parseSubmissionResponse,
  parseUploadResponse,
  promptGraph,
  promptId,
  requestOptions,
  submissionOptions,
  signalAborted,
  uploadInput: uploadInputContract,
  waitOptions,
} = require('./contracts');
const {
  ComfyUiClientError,
  createComfyUiClientError,
  isComfyUiClientError,
} = require('./errors');
const { createComfyHttpTransport } = require('./httpTransport');
const {
  isComfyAsyncControlError,
  raceNativePromise,
} = require('./asyncControl');

function defaultSleep(milliseconds, signal) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function createComfyUiClient(value = {}) {
  const configuration = clientConfiguration(value);
  const baseUrl = configuration.baseUrl;
  const fetchImpl = configuration.fetchImpl === undefined ? globalThis.fetch : configuration.fetchImpl;
  const requestTimeoutMs = configuration.requestTimeoutMs === undefined
    ? 30_000
    : configuration.requestTimeoutMs;
  const sleepImpl = configuration.sleepImpl === undefined ? defaultSleep : configuration.sleepImpl;
  const maxUploadBytes = configuration.maxUploadBytes === undefined
    ? 64 * 1024 * 1024
    : configuration.maxUploadBytes;
  if (typeof sleepImpl !== 'function' || !Number.isSafeInteger(maxUploadBytes)
    || maxUploadBytes < 1 || maxUploadBytes > 256 * 1024 * 1024) {
    throw new TypeError('ComfyUI client dependencies are invalid');
  }
  const transport = createComfyHttpTransport({ baseUrl, fetchImpl, requestTimeoutMs });

  function systemStats(options) {
    return transport.requestJson('/system_stats', requestOptions(options));
  }

  function objectInfo(options) {
    return transport.requestJson('/object_info', requestOptions(options));
  }

  function queueSnapshot(options) {
    return transport.requestJson('/queue', requestOptions(options));
  }

  async function submitPrompt(prompt, options) {
    const submittedOptions = submissionOptions(options);
    const body = Object.create(null);
    try {
      body.prompt = promptGraph(prompt);
      if (submittedOptions.clientId !== undefined) body.client_id = submittedOptions.clientId;
    } catch {
      throw new TypeError('ComfyUI prompt submission input is invalid');
    }
    try {
      const response = await transport.requestJson('/prompt', {
        method: 'POST',
        jsonBody: Object.freeze(body),
        signal: submittedOptions.signal,
        maxResponseBytes: 2 * 1024 * 1024,
      });
      return parseSubmissionResponse(response);
    } catch (error) {
      if (isComfyUiClientError(error) && error.code === 'COMFY_HTTP_ERROR'
        && (error.status === 400 || error.status === 422)) {
        throw createComfyUiClientError('COMFY_SUBMISSION_REJECTED');
      }
      throw error;
    }
  }

  function history(prompt, options) {
    const normalizedPromptId = promptId(prompt);
    return transport.requestJson(
      `/history/${encodeURIComponent(normalizedPromptId)}`,
      requestOptions(options),
    );
  }

  async function getPromptState(prompt, options) {
    const normalizedPromptId = promptId(prompt);
    const response = await history(normalizedPromptId, options);
    return parsePromptState(response, normalizedPromptId);
  }

  async function waitForPrompt(prompt, options) {
    const normalizedPromptId = promptId(prompt);
    const waiting = waitOptions(options);
    const deadline = Date.now() + waiting.timeoutMs;
    while (true) {
      if (waiting.signal && signalAborted(waiting.signal)) {
        throw createComfyUiClientError('COMFY_REQUEST_ABORTED');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw createComfyUiClientError('COMFY_PROMPT_TIMEOUT');
      let state;
      const requestController = new AbortController();
      try {
        state = await raceNativePromise(
          getPromptState(normalizedPromptId, { signal: requestController.signal }),
          {
            signal: waiting.signal,
            timeoutMs: remaining,
            onAbort: () => requestController.abort(),
            onTimeout: () => requestController.abort(),
          },
        );
      } catch (error) {
        if (isComfyAsyncControlError(error, 'COMFY_ASYNC_ABORTED')) {
          throw createComfyUiClientError('COMFY_REQUEST_ABORTED');
        }
        if (isComfyAsyncControlError(error, 'COMFY_ASYNC_TIMEOUT')) {
          throw createComfyUiClientError('COMFY_PROMPT_TIMEOUT');
        }
        throw error;
      }
      if (state.state === 'succeeded') return state;
      if (state.state === 'failed') throw createComfyUiClientError('COMFY_EXECUTION_FAILED');
      if (Date.now() >= deadline) throw createComfyUiClientError('COMFY_PROMPT_TIMEOUT');
      const sleepRemaining = deadline - Date.now();
      if (sleepRemaining <= 0) throw createComfyUiClientError('COMFY_PROMPT_TIMEOUT');
      let sleeping;
      const sleepController = new AbortController();
      try { sleeping = sleepImpl(waiting.pollIntervalMs, sleepController.signal); } catch {
        throw createComfyUiClientError('COMFY_CONNECTION_FAILED');
      }
      try {
        await raceNativePromise(sleeping, {
          signal: waiting.signal,
          timeoutMs: sleepRemaining,
          onAbort: () => sleepController.abort(),
          onTimeout: () => sleepController.abort(),
        });
      } catch (error) {
        if (isComfyAsyncControlError(error, 'COMFY_ASYNC_ABORTED')) {
          throw createComfyUiClientError('COMFY_REQUEST_ABORTED');
        }
        if (isComfyAsyncControlError(error, 'COMFY_ASYNC_TIMEOUT')) {
          throw createComfyUiClientError('COMFY_PROMPT_TIMEOUT');
        }
        throw createComfyUiClientError('COMFY_CONNECTION_FAILED');
      }
    }
  }

  function uploadInput(value) {
    const input = uploadInputContract(value, maxUploadBytes);
    const form = new FormData();
    form.append('image', new Blob([input.bytes]), input.fileName);
    form.append('subfolder', input.subfolder);
    form.append('type', 'input');
    form.append('overwrite', input.overwrite ? 'true' : 'false');
    return transport.requestJson('/upload/image', {
      method: 'POST',
      formBody: form,
      maxResponseBytes: 1024 * 1024,
    }).then(parseUploadResponse, (error) => {
      if (isComfyUiClientError(error) && error.code === 'COMFY_HTTP_ERROR') {
        throw createComfyUiClientError('COMFY_UPLOAD_FAILED', { status: error.status });
      }
      throw error;
    });
  }

  return Object.freeze({
    baseUrl: transport.origin,
    getPromptState,
    health: systemStats,
    history,
    objectInfo,
    queue: queueSnapshot,
    queueSnapshot,
    submitPrompt,
    systemStats,
    uploadInput,
    waitForPrompt,
  });
}

module.exports = {
  ComfyUiClientError,
  createComfyUiClient,
  isComfyUiClientError,
  normalizeBaseUrl,
};
