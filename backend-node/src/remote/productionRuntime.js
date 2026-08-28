'use strict';

const { types: { isProxy } } = require('node:util');

const { WindowsCredentialVault } = require('../adapters/v2/credentials');
const { createV2Repositories } = require('../repositories/v2');
const { createManagedComfyGateway } = require('./managedComfyGateway');
const { createRemoteExecutionCoordinator } = require('./remoteExecutionCoordinator');
const { createRemoteEnvironmentService } = require('./remoteEnvironmentService');
const { createRemoteSessionService } = require('./remoteSessionService');
const { createRemoteTaskService } = require('./remoteTaskService');
const { createSftpTransfer } = require('./sftpTransfer');
const { createSshEnvironmentAdapter } = require('./sshEnvironmentAdapter');
const { createSshTransport } = require('./sshTransport');
const { createSshTunnelManager } = require('./sshTunnel');

const DEPENDENCY_KEYS = Object.freeze([
  'credentialVault', 'sshTransport', 'tunnelManager', 'comfyClientFactory',
  'remoteTimeoutMs', 'executionTimeoutMs',
]);

function dependencySnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Production remote runtime dependencies are invalid');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError('Production remote runtime dependencies are invalid');
  }
  if (prototype !== Object.prototype && prototype !== null
    || Reflect.ownKeys(descriptors).some((key) => (
      typeof key !== 'string' || !DEPENDENCY_KEYS.includes(key)
    ))) throw new TypeError('Production remote runtime dependencies are invalid');
  const snapshot = Object.create(null);
  for (const key of DEPENDENCY_KEYS) {
    if (!Object.hasOwn(descriptors, key)) continue;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Production remote runtime dependencies are invalid');
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function createProductionRemoteRuntime({ database, localRoot, dependencies = {} } = {}) {
  const configured = dependencySnapshot(dependencies);
  const repositories = createV2Repositories(database);
  const credentialVault = configured.credentialVault ?? new WindowsCredentialVault();
  const sshTransport = configured.sshTransport ?? createSshTransport();
  const tunnelManager = configured.tunnelManager ?? createSshTunnelManager();
  const remoteSessionService = createRemoteSessionService({
    repository: repositories.remote,
    vault: credentialVault,
    sshTransport,
    tunnelManager,
  });
  const environmentAdapter = createSshEnvironmentAdapter({
    sessionService: remoteSessionService,
  });
  const remoteEnvironment = createRemoteEnvironmentService({
    ...environmentAdapter,
    nowEpochMs: Date.now,
    modelCatalog: [],
  });
  const remoteClient = createManagedComfyGateway({
    sessionService: remoteSessionService,
    tunnelManager,
    ...(configured.comfyClientFactory !== undefined
      ? { clientFactory: configured.comfyClientFactory }
      : {}),
    ...(configured.remoteTimeoutMs !== undefined
      ? { timeoutMs: configured.remoteTimeoutMs }
      : {}),
  });
  const remoteTasks = createRemoteTaskService({
    repository: repositories.remote,
    manifestRepository: repositories.comfyManifests,
    remoteClient,
    ...(configured.remoteTimeoutMs !== undefined
      ? { timeoutMs: configured.remoteTimeoutMs }
      : {}),
  });
  const transfer = createSftpTransfer({ localRoot });
  const remoteCoordinator = createRemoteExecutionCoordinator({
    repositories,
    taskService: remoteTasks,
    sessionService: remoteSessionService,
    transfer,
    remoteClient,
    localRoot,
    ...(configured.executionTimeoutMs !== undefined
      ? { timeoutMs: configured.executionTimeoutMs }
      : {}),
  });

  return Object.freeze({
    remoteConnections: Object.freeze({
      credentialVault,
      remoteSessionService,
      sshTransport,
      tunnelManager,
    }),
    remoteExecution: Object.freeze({
      remoteCoordinator,
      remoteEnvironment,
      remoteTasks,
    }),
  });
}

module.exports = Object.freeze({ createProductionRemoteRuntime });
