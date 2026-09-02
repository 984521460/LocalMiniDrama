'use strict';

const { types: { isProxy } } = require('node:util');
const express = require('express');

const {
  createProviderCredentialCleanupView,
  createProviderCredentialRemovedView,
  createProviderCredentialStoreRequest,
  createProviderCredentialView,
  parseProviderCredentialRef,
} = require('../../credentials/providerCredential');
const {
  isComfyAsyncControlError,
  raceNativePromise,
} = require('../../integrations/comfyui/asyncControl');
const {
  getWindowsCredentialErrorCode,
  getWindowsCredentialErrorCredentialRef,
} = require('../../adapters/v2/credentials/windowsCredentialVault');
const response = require('../../response');

const DEFAULT_TIMEOUT_MS = 30_000;

function dataProperty(value, name) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || isProxy(value)) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function dataMethod(value, name) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || isProxy(value)) {
    return null;
  }
  let target = value;
  for (let depth = 0; target && depth < 4; depth += 1) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(target, name); } catch { return null; }
    if (descriptor) {
      return Object.hasOwn(descriptor, 'value')
        && typeof descriptor.value === 'function'
        && !isProxy(descriptor.value) ? descriptor.value : null;
    }
    try { target = Object.getPrototypeOf(target); } catch { return null; }
  }
  return null;
}

function loopback(address) {
  return typeof address === 'string' && (
    address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.')
  );
}

function providerCredentialRoutes(log, runtime = {}) {
  const router = express.Router();
  const vault = dataProperty(runtime, 'credentialVault');
  const configuredTimeout = dataProperty(runtime, 'timeoutMs');
  const timeoutMs = configuredTimeout === undefined ? DEFAULT_TIMEOUT_MS : configuredTimeout;
  const methods = Object.freeze({
    store: dataMethod(vault, 'store'),
    inspect: dataMethod(vault, 'inspect'),
    remove: dataMethod(vault, 'remove'),
  });
  const available = vault && methods.store && methods.inspect && methods.remove
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300_000;

  function unavailable(res) {
    return response.error(
      res, 503, 'PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE', 'Provider credential vault is unavailable',
    );
  }

  function handleError(res, error, event) {
    const code = getWindowsCredentialErrorCode(error);
    if (code === 'CREDENTIAL_VALUE_INVALID') {
      return response.error(res, 400, 'PROVIDER_CREDENTIAL_INPUT_INVALID', 'Provider credential request is invalid');
    }
    if (code === 'CREDENTIAL_NOT_FOUND') {
      return response.error(res, 404, 'PROVIDER_CREDENTIAL_NOT_FOUND', 'Provider credential was not found');
    }
    if (code === 'CREDENTIAL_STORE_INDETERMINATE') {
      const ref = getWindowsCredentialErrorCredentialRef(error);
      if (ref !== null) {
        return response.error(
          res,
          409,
          'PROVIDER_CREDENTIAL_CLEANUP_REQUIRED',
          'Provider credential storage outcome requires cleanup',
          createProviderCredentialCleanupView({ ref, cleanupRequired: true }),
        );
      }
      return unavailable(res);
    }
    if (code === 'CREDENTIAL_REFERENCE_CONFLICT') {
      return response.error(res, 409, 'PROVIDER_CREDENTIAL_CONFLICT', 'Provider credential state conflict');
    }
    if (code === 'CREDENTIAL_VAULT_IO_FAILED' || isComfyAsyncControlError(error)) {
      return unavailable(res);
    }
    try { log?.error?.(event, { code: 'PROVIDER_CREDENTIAL_UNEXPECTED' }); } catch { /* fixed */ }
    return response.error(
      res, 500, 'PROVIDER_CREDENTIAL_UNEXPECTED', 'Provider credential operation failed',
    );
  }

  function invoke(name, args) {
    let operation;
    try { operation = Reflect.apply(methods[name], vault, args); } catch (error) { throw error; }
    return raceNativePromise(operation, { timeoutMs });
  }

  router.use((req, res, next) => {
    if (!loopback(req.socket?.remoteAddress)) {
      return response.error(res, 403, 'PROVIDER_CREDENTIAL_LOCAL_ONLY', 'Provider credentials are local-only');
    }
    return next();
  });

  router.post('/provider-credentials', async (req, res) => {
    if (!available) return unavailable(res);
    let request;
    try { request = createProviderCredentialStoreRequest(req.body); } catch {
      return response.error(res, 400, 'PROVIDER_CREDENTIAL_INPUT_INVALID', 'Provider credential request is invalid');
    }
    try {
      const descriptor = await invoke('store', [request]);
      return response.created(res, createProviderCredentialView(descriptor));
    } catch (error) {
      return handleError(res, error, 'provider-credential-store');
    }
  });

  router.get('/provider-credentials/:credentialRef', async (req, res) => {
    if (!available) return unavailable(res);
    let expected;
    try {
      expected = parseProviderCredentialRef(req.params.credentialRef);
    } catch {
      return response.error(res, 400, 'PROVIDER_CREDENTIAL_INPUT_INVALID', 'Provider credential request is invalid');
    }
    try {
      const descriptor = await invoke('inspect', [expected]);
      let view;
      try { view = createProviderCredentialView(descriptor); } catch {
        return response.error(res, 404, 'PROVIDER_CREDENTIAL_NOT_FOUND', 'Provider credential was not found');
      }
      return response.success(res, view);
    } catch (error) {
      return handleError(res, error, 'provider-credential-inspect');
    }
  });

  router.delete('/provider-credentials/:credentialRef', async (req, res) => {
    if (!available) return unavailable(res);
    let ref;
    try {
      ref = createProviderCredentialRemovedView({
        ref: req.params.credentialRef, removed: true,
      }).ref;
    } catch {
      return response.error(res, 400, 'PROVIDER_CREDENTIAL_INPUT_INVALID', 'Provider credential request is invalid');
    }
    try {
      const descriptor = await invoke('inspect', [ref]);
      try { createProviderCredentialView(descriptor); } catch {
        return response.error(res, 404, 'PROVIDER_CREDENTIAL_NOT_FOUND', 'Provider credential was not found');
      }
      const removed = await invoke('remove', [ref]);
      if (removed !== true) {
        return response.error(res, 404, 'PROVIDER_CREDENTIAL_NOT_FOUND', 'Provider credential was not found');
      }
      return response.success(res, createProviderCredentialRemovedView({ ref, removed: true }));
    } catch (error) {
      return handleError(res, error, 'provider-credential-remove');
    }
  });

  return router;
}

module.exports = providerCredentialRoutes;
