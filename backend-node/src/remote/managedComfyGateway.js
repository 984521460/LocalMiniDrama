'use strict';

const { types: { isProxy } } = require('node:util');

const { raceNativePromise } = require('../integrations/comfyui/asyncControl');
const { createComfyUiClient } = require('../integrations/comfyui/client');
const {
  parseRemoteConnectionUid,
  remoteConnectionEvidenceSha256,
} = require('./connectionProfile');
const { createComfyDependencyChecker } = require('./comfyDependencyChecker');

const DEFAULT_TIMEOUT_MS = 30_000;
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u;

function configuration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Managed ComfyUI gateway configuration is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(['sessionService', 'tunnelManager', 'clientFactory', 'timeoutMs']);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('Managed ComfyUI gateway configuration is invalid');
  }
  const sessionService = descriptors.sessionService?.value;
  const tunnelManager = descriptors.tunnelManager?.value;
  const clientFactory = descriptors.clientFactory?.value ?? createComfyUiClient;
  const timeoutMs = descriptors.timeoutMs?.value ?? DEFAULT_TIMEOUT_MS;
  const openSession = sessionService && Object.getOwnPropertyDescriptor(sessionService, 'openSession')?.value;
  const openTunnel = tunnelManager && Object.getOwnPropertyDescriptor(tunnelManager, 'open')?.value;
  if (typeof openSession !== 'function' || isProxy(openSession)
    || typeof openTunnel !== 'function' || isProxy(openTunnel)
    || typeof clientFactory !== 'function' || isProxy(clientFactory)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new TypeError('Managed ComfyUI gateway configuration is invalid');
  }
  return Object.freeze({
    sessionService,
    openSession,
    tunnelManager,
    openTunnel,
    clientFactory,
    timeoutMs,
  });
}

function openedSession(value, connectionUid, expectedEvidenceSha256) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Managed ComfyUI session is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const connection = descriptors.connection?.value;
  const session = descriptors.session?.value;
  if (!connection || !session || typeof connection !== 'object' || typeof session !== 'object'
    || isProxy(connection) || isProxy(session)) throw new TypeError('Managed ComfyUI session is invalid');
  const uid = Object.getOwnPropertyDescriptor(connection, 'uid')?.value;
  const comfyPort = Object.getOwnPropertyDescriptor(connection, 'comfyPort')?.value;
  const close = Object.getOwnPropertyDescriptor(session, 'close')?.value;
  if (uid !== connectionUid || !Number.isInteger(comfyPort) || comfyPort < 1 || comfyPort > 65535
    || remoteConnectionEvidenceSha256(connection) !== expectedEvidenceSha256
    || typeof close !== 'function' || isProxy(close)) {
    throw new TypeError('Managed ComfyUI session is invalid');
  }
  return Object.freeze({ session, close, comfyPort });
}

function tunnelHandle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Managed ComfyUI tunnel is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const host = descriptors.host?.value;
  const port = descriptors.port?.value;
  const origin = descriptors.origin?.value;
  const close = descriptors.close?.value;
  const match = typeof origin === 'string' ? LOOPBACK_ORIGIN.exec(origin) : null;
  if (Reflect.ownKeys(descriptors).length !== 4 || host !== '127.0.0.1'
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !match || Number(match[1]) !== port || typeof close !== 'function' || isProxy(close)) {
    throw new TypeError('Managed ComfyUI tunnel is invalid');
  }
  return Object.freeze({ target: value, close, origin });
}

async function boundedClose(target, close, timeoutMs) {
  const pending = Reflect.apply(close, target, []);
  if (pending === undefined) return;
  await raceNativePromise(pending, { timeoutMs });
}

function createManagedComfyGateway(options) {
  const configured = configuration(options);

  async function withClient(connectionUidValue, expectedEvidenceSha256, operation) {
    const connectionUid = parseRemoteConnectionUid(connectionUidValue);
    if (typeof expectedEvidenceSha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(expectedEvidenceSha256)) {
      throw new TypeError('Managed ComfyUI connection evidence is invalid');
    }
    let opened;
    try {
      opened = openedSession(await raceNativePromise(
        Reflect.apply(configured.openSession, configured.sessionService, [
          connectionUid,
          expectedEvidenceSha256,
        ]),
        { timeoutMs: configured.timeoutMs },
      ), connectionUid, expectedEvidenceSha256);
    } catch {
      throw new TypeError('Managed ComfyUI session failed');
    }

    let tunnel;
    try {
      tunnel = tunnelHandle(await raceNativePromise(
        Reflect.apply(configured.openTunnel, configured.tunnelManager, [{
          session: opened.session,
          remotePort: opened.comfyPort,
        }]),
        { timeoutMs: configured.timeoutMs },
      ));
    } catch {
      try { await boundedClose(opened.session, opened.close, configured.timeoutMs); } catch { /* fixed */ }
      throw new TypeError('Managed ComfyUI tunnel failed');
    }

    let failed = false;
    try {
      const client = configured.clientFactory({
        baseUrl: tunnel.origin,
        requestTimeoutMs: configured.timeoutMs,
      });
      return await operation(client);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await boundedClose(tunnel.target, tunnel.close, configured.timeoutMs);
      } catch {
        if (!failed) throw new TypeError('Managed ComfyUI tunnel cleanup failed');
      }
    }
  }

  return Object.freeze({
    requireReady(connectionUid, connectionEvidenceSha256, manifest) {
      return withClient(connectionUid, connectionEvidenceSha256, (client) => createComfyDependencyChecker({
        client,
        timeoutMs: configured.timeoutMs,
      }).requireReady(manifest));
    },
    submitPrompt(connectionUid, connectionEvidenceSha256, prompt, submitOptions) {
      return withClient(connectionUid, connectionEvidenceSha256, (client) => (
        client.submitPrompt(prompt, submitOptions)
      ));
    },
    getPromptState(connectionUid, connectionEvidenceSha256, promptId) {
      return withClient(connectionUid, connectionEvidenceSha256, (client) => (
        client.getPromptState(promptId)
      ));
    },
    queueSnapshot(connectionUid, connectionEvidenceSha256) {
      return withClient(connectionUid, connectionEvidenceSha256, (client) => client.queueSnapshot());
    },
    waitForPrompt(connectionUid, connectionEvidenceSha256, promptId, waitOptions) {
      return withClient(
        connectionUid,
        connectionEvidenceSha256,
        (client) => client.waitForPrompt(promptId, waitOptions),
      );
    },
  });
}

module.exports = Object.freeze({ createManagedComfyGateway });
